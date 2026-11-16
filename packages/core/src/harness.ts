import {
  agentSpecToJson,
  CONTEXT_OVERFLOW,
  CTX_EVENTS,
  checkJsonSchema,
  CtxError,
  ctxErrorEntry,
  estimateTextTokens,
  estimateTokens,
  headSeq,
  isConflict,
  isErased,
  isFrameworkKind,
  errorOutput,
  messageEntry,
  runEndedEntry,
  runParentProblem,
  runStartedEntry,
  silentLogger,
  toolPermission,
  userEntry,
  type BuildRequest,
  type CompactOptions,
  type ContextBuilder,
  type Entry,
  type ErasedData,
  type ErrorInfo,
  type Executor,
  type Harness,
  type Hooks,
  type InheritSpec,
  type JsonObject,
  type JsonValue,
  type RunBudget,
  type Logger,
  type Message,
  type MessageContent,
  type ModelHookContext,
  type NewEntry,
  type OverflowSpec,
  type PreparedCall,
  type RunEvent,
  type RunRequest,
  type RunResult,
  type SessionStore,
  type StepMeta,
  type StopReason,
  type ToolCall,
  type ToolDefinition,
  type ToolOutput,
  type ToolRegistry,
  type Usage,
} from '@modelctx-ai/ctx-protocol';
import {
  APICallError,
  generateText,
  jsonSchema,
  NoObjectGeneratedError,
  Output,
  RetryError,
  stepCountIs,
  streamText,
  type ContentPart,
  type FinishReason,
  type LanguageModel,
  type LanguageModelUsage,
  type ModelMessage,
  type ToolSet,
} from 'ai';

import { isEmptyContent, resolveModel } from './builder.ts';
import { isContextOverflowError } from './errors.ts';
import { fromModelMessages, toModelMessages } from './messages.ts';
import {
  dispatchTo,
  executorMap,
  toToolSet,
  type Executors,
  type LocalToolRegistry,
  type ToolDispatch,
} from './tools.ts';

export type GenerateTextResult = Awaited<ReturnType<typeof generateText>>;
export type StreamTextResult = ReturnType<typeof streamText>;

export interface HarnessOptions {
  readonly store: SessionStore;
  readonly context: ContextBuilder;
  readonly tools?: ToolRegistry;
  /**
   * 工具绑定的执行环境。`tools` 是 `createToolRegistry()` 建的注册表时，它自带的函数执行环境会自动加进来
   * （同名的以这里给的为准）。
   */
  readonly executors?: Executors;
  /** `AgentSpec.model` 是名字时怎么造模型。不给时名字没法用，这一轮以 `error` 结束。 */
  readonly models?: (name: string) => LanguageModel;
  readonly hooks?: Hooks;
  readonly logger?: Logger;
  /** 用户输入写进日志、又没写 `source` 时记成谁写的。 */
  readonly source?: string;
  /**
   * 执行前按 `inputSchema` 查模型给的工具输入，不合就把问题回给模型、不执行。缺省查（`addTool` 加的工具除外，
   * 它们按自己原来的 schema 校验）；`false` 关掉，`true` 连 `addTool` 的也查。
   */
  readonly validateToolInput?: boolean;
  /**
   * 一次工具结果（过了 `afterTool` 之后）最多多少字符，超过的截断并注明。缺省 `DEFAULT_MAX_TOOL_OUTPUT_CHARS`；
   * 0 或 Infinity 不限。
   */
  readonly maxToolOutputChars?: number;
  /**
   * 在别处执行的执行环境的名字：绑定到它们的工具交给模型，但不在这里执行。模型调用了它们，这一轮写下调用后以
   * `requires_action` 结束（`RunResult.pending`），不占会话；执行方把结果追加进日志（`toolResultEntry`，
   * 或 `runPendingTools`），下一轮不带输入接着跑。这里列了的名字，不给 `executors` 也不告警。
   */
  readonly external?: readonly string[];
}

/** `createContext` 用的额外开关，不在协议里。 */
export interface RunExtras {
  /** 是否收集来源，透传给 `BuildRequest.facts`。 */
  readonly facts?: boolean;
  /** 流式出错时怎么报。不给就记一条 `logger.warn`。 */
  readonly onError?: (error: unknown) => void;
}

export interface RunOutcome {
  readonly result: RunResult;
  /** 正常结束时 AI SDK 的原始结果（只有 `run`）。 */
  readonly raw?: GenerateTextResult;
  /** `stopReason` 是 `error` 或 `aborted` 时的原始错误。 */
  readonly cause?: unknown;
}

export interface StartedStream {
  readonly runId: string;
  /** 这一轮 `ctx.run.started` 的 `seq`；没写（不记录、会话忙）时没有。 */
  readonly seq?: number;
  /** 第 `step` 步写完时日志的末尾 `seq`；这一步没写下时是 `undefined`。只在流里那一步的 `finish-step` 之后等它。 */
  stepSeq?(step: number): Promise<number | undefined>;
  /** 组装失败时没有流，`done()` 直接给出结果。 */
  readonly result?: StreamTextResult;
  /** 产出写进日志以后给出结果；第一次调用时才开始等（等的时候会让流跑完）。只在写日志失败时 reject。 */
  done(): Promise<RunOutcome>;
}

/** harness 的进程内入口：`createContext` 要拿到 AI SDK 的原始结果和流，用它；协议只看 `harness`。 */
export interface HarnessRuntime {
  readonly harness: Harness & { stream(request: RunRequest): AsyncIterable<RunEvent> };
  run(request: RunRequest, extras?: RunExtras): Promise<RunOutcome>;
  startStream(request: RunRequest, extras?: RunExtras): Promise<StartedStream>;
}

interface RunState {
  readonly runId: string;
  readonly request: RunRequest;
  readonly record: boolean;
  readonly recorded: Entry[];
  /** 本轮最后一次写入之后会话的末尾 `seq`，下一次写入拿它当 `expectSeq`；还没写过时是 `undefined`。 */
  head: number | undefined;
  /** 本轮 `ctx.run.started` 的 `seq`；还没写时是 `undefined`。 */
  started?: number;
  /** 写日志失败过：这时 run 要 reject，不能当成模型出错。 */
  logFailed: boolean;
  /** 会话里上一轮以 `error` 或 `aborted` 结束：这一轮可能是它的重试，记输入之前先看它留下的输入（见 `repeatsFailedInput`）。 */
  afterFailure: boolean;
  /** 模型产出（AI SDK 的 `responseMessages`）里已经按步写进日志的条数；`finish` 只补后面的。 */
  logged: number;
  /** 这一步的助手消息在工具执行前已经写下：步骤结束时跳过它，只写工具结果。 */
  early: boolean;
  /** 已经写下、还没有结果的工具调用（`id` → 工具名）：这一轮半路结束时给它们补错误结果。 */
  readonly open: Map<string, string>;
  /** 本轮的写入一个接一个：步骤回调和结束时的写入不交错。 */
  writing: Promise<void>;
  /** 步骤回调里写日志失败（或被围栏）：AI SDK 吞掉回调的异常，这里记下，再中止这一轮。 */
  stepError?: unknown;
  /** 已经写完的步数，也是下一步的序号。 */
  step: number;
  /** 这一轮开始的时刻，`budget.maxDurationMs` 从这里算。 */
  readonly startedAt: number;
  /** `budget` 让循环在步骤之间停下了。 */
  overBudget: boolean;
  /** 每一步写完时日志的末尾 `seq`，流式的 `model.ended` 等它；这一步没写下（不记录、出错）时是 `undefined`。 */
  readonly stepSeqs: Map<number, PromiseWithResolvers<number | undefined>>;
}

/** 第 `index` 步写完时的末尾 `seq`。 */
function stepSeq(state: RunState, index: number): PromiseWithResolvers<number | undefined> {
  let entry = state.stepSeqs.get(index);
  if (!entry) {
    entry = Promise.withResolvers<number | undefined>();
    state.stepSeqs.set(index, entry);
  }
  return entry;
}

interface Setup {
  readonly model: LanguageModel;
  readonly prepared: PreparedCall;
  readonly tools: ToolSet;
  readonly toolCount: number;
  readonly maxSteps: number;
}

interface Produced {
  readonly text: string;
  readonly messages: readonly Message[];
  readonly finishReason: FinishReason;
  readonly steps: number;
  readonly usage: LanguageModelUsage | undefined;
  /** 最后一步里没有结果的工具调用：交给别处执行的。 */
  readonly pending: readonly ToolCall[];
}

/** `AgentSpec.budget` 的停止条件：在步骤之间看用掉的 token 和时间，超了就停，记下是预算让它停的。 */
function budgetStop(state: RunState, budget: RunBudget) {
  return ({ steps }: { readonly steps: ReadonlyArray<{ readonly usage: LanguageModelUsage }> }): boolean => {
    const used = steps.reduce(
      (sum, step) => sum + (step.usage.totalTokens ?? (step.usage.inputTokens ?? 0) + (step.usage.outputTokens ?? 0)),
      0,
    );
    const over =
      (budget.maxTotalTokens !== undefined && used >= budget.maxTotalTokens) ||
      (budget.maxDurationMs !== undefined && Date.now() - state.startedAt >= budget.maxDurationMs);
    if (over) state.overBudget = true;
    return over;
  };
}

const PERMISSIONS = new Set(['allow', 'ask', 'deny']);

/** 线上来的 `AgentSpec` 字段：形状不对就当请求不对，不猜。 */
function checkAgentExtras(agent: RunRequest['agent'], offered: readonly string[]): void {
  const { budget, permissions, toolChoice, output } = agent;
  for (const key of ['maxTotalTokens', 'maxDurationMs'] as const) {
    const value = budget?.[key];
    if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)) {
      throw new CtxError('invalid_request', `AgentSpec.budget.${key} must be a positive number.`);
    }
  }
  const values = [permissions?.default, ...Object.values(permissions?.tools ?? {})];
  if (values.some((value) => value !== undefined && !PERMISSIONS.has(value))) {
    throw new CtxError('invalid_request', 'AgentSpec.permissions values must be "allow", "ask" or "deny".');
  }
  if (typeof toolChoice === 'object' && !offered.includes(toolChoice.tool)) {
    throw new CtxError(
      'invalid_request',
      `AgentSpec.toolChoice names tool "${toolChoice.tool}", which is not offered.`,
    );
  }
  if (output !== undefined && (typeof output.schema !== 'object' || output.schema === null)) {
    throw new CtxError('invalid_request', 'AgentSpec.output.schema must be a JSON Schema object.');
  }
}

/** `RunRequest.parent` 和 `AgentSpec.context.inherit` 的形状。在 `build` 之前查：`inherit` 不对就不该去读别的会话。 */
function checkLineage(parent: RunRequest['parent'], inherit: InheritSpec | undefined): void {
  const problem = runParentProblem(parent);
  if (problem !== undefined) throw new CtxError('invalid_request', `${problem}.`);
  if (inherit === undefined) return;
  if (typeof inherit.session !== 'string' || inherit.session === '') {
    throw new CtxError('invalid_request', 'AgentSpec.context.inherit.session must be a non-empty string.');
  }
  if (inherit.upTo !== undefined && (!Number.isInteger(inherit.upTo) || inherit.upTo < 0)) {
    throw new CtxError('invalid_request', 'AgentSpec.context.inherit.upTo must be a non-negative integer (a seq).');
  }
}

/** 结构化输出：最后的回答按 `schema` 解析、校验。不合就抛 `invalid_output`。 */
function parseOutput(text: string, schema: JsonObject): JsonValue {
  let value: JsonValue;
  try {
    value = JSON.parse(text) as JsonValue;
  } catch {
    throw new CtxError('invalid_output', 'The final answer is not valid JSON for AgentSpec.output.');
  }
  const issues = checkJsonSchema(schema, value);
  if (issues.length > 0) {
    throw new CtxError(
      'invalid_output',
      `The final answer does not match AgentSpec.output.schema: ${issues.join('; ')}.`,
    );
  }
  return value;
}

/** 一步的内容里有调用、没有结果的工具调用（服务商执行的不算）。 */
function pendingOf(content: ReadonlyArray<ContentPart<ToolSet>> | undefined): ToolCall[] {
  if (!content) return [];
  const answered = new Set(
    content.flatMap((part) => (part.type === 'tool-result' || part.type === 'tool-error' ? [part.toolCallId] : [])),
  );
  return content.flatMap((part) =>
    part.type === 'tool-call' && part.providerExecuted !== true && !answered.has(part.toolCallId)
      ? [{ id: part.toolCallId, name: part.toolName, input: (part.input ?? null) as ToolCall['input'] }]
      : [],
  );
}

/**
 * AI SDK 的用量转成协议的：缓存和推理取 `inputTokenDetails`、`outputTokenDetails`。这三项是 0 时不写：服务商没给明细时
 * AI SDK 的适配也常填 0，分不出「没有」和「没给」，不写更省日志，读的人按 0 算。
 */
function usageOf(usage: LanguageModelUsage | undefined): Usage | undefined {
  if (!usage) return undefined;
  const out: { -readonly [K in keyof Usage]: Usage[K] } = {};
  if (usage.inputTokens !== undefined) out.inputTokens = usage.inputTokens;
  if (usage.outputTokens !== undefined) out.outputTokens = usage.outputTokens;
  if (usage.totalTokens !== undefined) out.totalTokens = usage.totalTokens;
  const cacheRead = usage.inputTokenDetails?.cacheReadTokens;
  const cacheWrite = usage.inputTokenDetails?.cacheWriteTokens;
  const reasoning = usage.outputTokenDetails?.reasoningTokens;
  if (cacheRead) out.cacheReadTokens = cacheRead;
  if (cacheWrite) out.cacheWriteTokens = cacheWrite;
  if (reasoning) out.reasoningTokens = reasoning;
  return Object.keys(out).length > 0 ? out : undefined;
}

/** 一步的 `meta.step`。 */
function stepMeta(
  state: RunState,
  info: {
    readonly provider: string;
    readonly modelId: string;
    readonly finishReason: FinishReason;
    readonly usage: LanguageModelUsage;
  },
): JsonObject {
  const usage = usageOf(info.usage);
  const meta: StepMeta = {
    runId: state.runId,
    step: state.step,
    provider: info.provider,
    modelId: info.modelId,
    finishReason: info.finishReason,
    ...(usage ? { usage } : {}),
  };
  return { step: meta as unknown as JsonObject };
}

function stopReasonOf(finishReason: FinishReason, steps: number, maxSteps: number): StopReason {
  if (finishReason === 'length') return 'max_tokens';
  if (finishReason === 'tool-calls' && steps >= maxSteps) return 'max_steps';
  if (finishReason === 'error') return 'error';
  return 'end_turn';
}

/**
 * 给 `RunResult.error` 和 `ctx.error` 用：重试错误取最后一次，接口错误标出能不能重试。
 * 服务商说上下文过长的（`isContextOverflowError`）`type` 是 `context_overflow`、`retryable: false`：
 * 原样再发一遍还是放不下，要先压缩或裁剪。结构化输出没能解析的是 `invalid_output`。
 */
export function errorInfo(error: unknown): ErrorInfo {
  const root = RetryError.isInstance(error) ? error.lastError : error;
  const overflow = isContextOverflowError(root);
  // `generateText` 自己解析 `AgentSpec.output` 时，回答不合就抛它；和 harness 自己解析（流式）的一样叫 `invalid_output`。
  if (NoObjectGeneratedError.isInstance(root)) {
    return { message: root.message, type: 'invalid_output', retryable: false };
  }
  if (APICallError.isInstance(root)) {
    return {
      message: root.message,
      type: overflow ? CONTEXT_OVERFLOW : 'api_call',
      retryable: overflow ? false : root.isRetryable,
      ...(root.statusCode !== undefined ? { statusCode: root.statusCode } : {}),
      ...(root.responseBody !== undefined ? { responseBody: root.responseBody } : {}),
    };
  }
  if (root instanceof Error) {
    if (overflow) return { message: root.message, type: CONTEXT_OVERFLOW, retryable: false };
    const retryable = (root as { retryable?: unknown }).retryable;
    return {
      message: root.message,
      ...(root.name && root.name !== 'Error' ? { type: root.name } : {}),
      ...(typeof retryable === 'boolean' ? { retryable } : {}),
    };
  }
  return { message: String(root) };
}

/** builder 没给 `PreparedCall.tokens` 时，harness 用缺省的估算自己算整次调用：指令、消息、交给模型的工具定义。 */
function estimateCall(call: PreparedCall, tools: readonly ToolDefinition[]): number {
  const names = new Set(call.tools);
  const offered = tools.filter((tool) => names.has(tool.name));
  return (
    estimateTextTokens(call.instructions ?? '') +
    call.messages.reduce((sum, message) => sum + estimateTokens(message), 0) +
    (offered.length > 0 ? estimateTextTokens(JSON.stringify(offered)) : 0)
  );
}

/** 会话里最后一个生命周期事件是 `ctx.run.ended`，而且停在 `error` 或 `aborted`：上一轮失败了，没有产出。 */
function endedInFailure(lifecycle: readonly Entry[]): boolean {
  const last = lifecycle.at(-1);
  if (last?.type !== 'event' || last.kind !== CTX_EVENTS.runEnded) return false;
  const stopReason = (last.data as { stopReason?: unknown } | undefined)?.stopReason;
  return stopReason === 'error' || stopReason === 'aborted';
}

/** 认重试时最多往回读这么多条；失败的那句输入之后写得比这多，就不认了，输入照常记。 */
const RETRY_SCAN = 64;

function hasExecutor(tools: ToolRegistry | undefined): tools is ToolRegistry & { readonly executor: Executor } {
  const candidate = (tools as { executor?: unknown } | undefined)?.executor;
  return typeof candidate === 'object' && candidate !== null && typeof (candidate as Executor).execute === 'function';
}

/**
 * 把调用方的 `signal` 接到一个自己的控制器上：调用方中止或自己提前结束都能取消模型调用。
 * 用 `AbortSignal.any` 合并，不在调用方的 signal 上留监听器，长期复用同一个 signal 也不泄漏。
 */
function linked(signal: AbortSignal | undefined): { readonly signal: AbortSignal; abort(reason?: unknown): void } {
  const controller = new AbortController();
  return {
    signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
    abort: (reason) => controller.abort(reason),
  };
}

function begin(request: RunRequest): RunState {
  return {
    runId: request.runId ?? crypto.randomUUID(),
    request,
    record: request.record !== false,
    recorded: [],
    head: undefined,
    logFailed: false,
    afterFailure: false,
    logged: 0,
    early: false,
    open: new Map(),
    writing: Promise.resolve(),
    step: 0,
    stepSeqs: new Map(),
    startedAt: Date.now(),
    overBudget: false,
  };
}

/** 工具调用没等到结果这一轮就结束了：补给它的错误结果。 */
export const INTERRUPTED_TOOL_RESULT = 'The run ended before this tool call returned; its result is unknown.';

/** 给还没有结果的工具调用补一条错误结果的 `tool` 消息。 */
export function interruptedResults(calls: ReadonlyMap<string, string>): Message {
  return {
    role: 'tool',
    content: [...calls].map(([id, name]) => ({
      type: 'tool-result',
      id,
      name,
      output: errorOutput(INTERRUPTED_TOOL_RESULT),
    })),
  };
}

/**
 * 一次模型调用的产出转成助手消息，和 AI SDK 在步骤结束时生成的那条一样（`toResponseMessages`）。
 * 只在这一步要在本地执行工具时用：工具执行前先把调用写进日志。有服务商执行的工具结果、审批请求这些
 * 照抄不了的部件时返回 `undefined`，这一步照旧在结束时一起写。
 */
function assistantBefore(content: ReadonlyArray<ContentPart<ToolSet>>): ModelMessage | undefined {
  const parts: Exclude<ModelMessage & { role: 'assistant' }, { content: string }>['content'] = [];
  for (const part of content) {
    switch (part.type) {
      case 'source':
        break;
      case 'text':
        if (part.text.length > 0) parts.push({ type: 'text', text: part.text, providerOptions: part.providerMetadata });
        break;
      case 'reasoning':
        parts.push({ type: 'reasoning', text: part.text, providerOptions: part.providerMetadata });
        break;
      case 'custom':
        parts.push({ type: 'custom', kind: part.kind, providerOptions: part.providerMetadata });
        break;
      case 'tool-call':
        parts.push({
          type: 'tool-call',
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          input: part.invalid && typeof part.input !== 'object' ? {} : part.input,
          providerExecuted: part.providerExecuted,
          providerOptions: part.providerMetadata,
        });
        break;
      case 'tool-result':
      case 'tool-error':
        if (part.providerExecuted) return undefined;
        break;
      default:
        return undefined;
    }
  }
  return { role: 'assistant', content: parts };
}

/**
 * 前提冲突时别人已经给这一轮写了 `ctx.run.ended`（被 `recover` 当作断掉的运行收走了），
 * 这一轮的 `ctx.run.started` 不在了（会话被 `clear` 了），或者有 `ctx.erased` 动了这一轮自己写的条目
 * （`truncate`、`remove`、`redact`）：这一轮停下，不再写。
 */
class Fenced extends Error {
  constructor() {
    super('This run was ended by another process (fenced).');
    this.name = 'Fenced';
  }
}

/** 写入冲突后最多重试几次；超过就当写日志失败。冲突只来自应用事件，几次之内必然追上。 */
const MAX_CONFLICTS = 20;

/** 会话里已有未结束的运行：什么都没写，这一轮以 `error` 结束，稍后重试。 */
function busy(state: RunState): RunResult {
  const info = errorInfo(
    new CtxError('session_busy', `Session "${state.request.session}" already has a run in progress.`, {
      retryable: true,
    }),
  );
  return { runId: state.runId, text: '', messages: [], recorded: [], stopReason: 'error', error: info };
}

/** 被围栏：别人已经结束了这一轮，不再写 ended。 */
function fenced(state: RunState): RunResult {
  return { runId: state.runId, text: '', messages: [], recorded: state.recorded, stopReason: 'aborted' };
}

export function createHarnessRuntime(options: HarnessOptions): HarnessRuntime {
  const { store, context, tools, hooks = {} } = options;
  const logger = options.logger ?? silentLogger;
  const executors = executorMap(options.executors);
  const external = new Set(options.external ?? []);
  if (hasExecutor(tools) && !executors.has(tools.executor.name)) executors.set(tools.executor.name, tools.executor);
  const base = dispatchTo([...executors.values()]);
  /** `addTool` 加进注册表的工具自己校验输入。 */
  const selfValidated = (name: string): boolean => {
    const registry = tools as Partial<Pick<LocalToolRegistry, 'validatesInput'>> | undefined;
    return typeof registry?.validatesInput === 'function' && registry.validatesInput(name);
  };
  /** 已经告警过的执行环境名：同一个缺口每个 harness 只说一次。 */
  const warned = new Set<string>();

  /**
   * 工具绑定的执行环境没交给 harness：调用时模型会收到错误，这里在这一轮开始前提醒开发者。
   * 不在构造时抛错：注册表可以在 harness 建好之后才加工具，执行环境也可能晚到。
   */
  function warnMissingExecutors(definitions: readonly ToolDefinition[]): void {
    const missing = new Map<string, string[]>();
    for (const definition of definitions) {
      if (executors.has(definition.executor) || external.has(definition.executor) || warned.has(definition.executor)) {
        continue;
      }
      missing.set(definition.executor, [...(missing.get(definition.executor) ?? []), definition.name]);
    }
    for (const [name, toolNames] of missing) {
      warned.add(name);
      logger.warn(
        `Tools are bound to executor "${name}", which was not passed to createHarness; calls will return an error. ` +
          `Add it to \`executors\`.`,
        { executor: name, tools: toolNames, available: [...executors.keys()] },
      );
    }
  }

  const dispatch: ToolDispatch = async (call, definition, execution) => {
    let actual: ToolCall = call;
    const decision = await hooks.beforeTool?.(call, execution);
    let output: ToolOutput;
    if (decision && !decision.allow) {
      output = errorOutput(`Tool call "${call.name}" was not allowed: ${decision.reason}`);
    } else {
      if (decision?.input !== undefined) actual = { ...call, input: decision.input };
      output = await base(actual, definition, execution);
    }
    return (await hooks.afterTool?.(actual, output, execution)) ?? output;
  };

  /** 追加并记下新的末尾。 */
  async function append(state: RunState, entries: readonly NewEntry[], expectSeq: number | undefined) {
    const written = await store.append(
      state.request.session,
      entries,
      expectSeq === undefined ? undefined : { expectSeq },
    );
    state.recorded.push(...written);
    state.head = written.at(-1)?.seq ?? state.head;
  }

  /**
   * 本轮的写入：带 `expectSeq`（上一次写入返回的末尾）。冲突时先看有没有人给自己的 `runId` 写了 `ended`、
   * 自己的 `started` 还在不在、有没有擦除记录动了自己写的条目：有 `ended`、`started` 没了、或者自己的条目被删被涂改，
   * 就是被围栏了，抛 `Fenced`；都不是只是别人写了应用事件（或者删了更早的历史），用新的末尾重试。
   * 同一轮的写入排成一队，前一次写完（成功或失败）才写下一次。
   */
  function write(state: RunState, entries: readonly NewEntry[]): Promise<void> {
    if (!state.record || entries.length === 0) return state.writing;
    const turn = state.writing.then(() => writeNow(state, entries));
    state.writing = turn.catch(() => {});
    return turn;
  }

  async function writeNow(state: RunState, entries: readonly NewEntry[]): Promise<void> {
    try {
      for (let conflicts = 0; ; conflicts += 1) {
        try {
          return await append(state, entries, state.head);
        } catch (error) {
          if (!isConflict(error) || state.head === undefined || conflicts >= MAX_CONFLICTS) throw error;
          // 先读末尾再读生命周期事件：中间若又有人写，下一次写入会再冲突，再查一遍。
          const head = await headSeq(store, state.request.session);
          const lifecycle = await store.list(state.request.session, {
            after: state.started !== undefined ? state.started - 1 : state.head,
            kinds: [CTX_EVENTS.runStarted, CTX_EVENTS.runEnded, CTX_EVENTS.erased],
          });
          const mine = lifecycle.filter(
            (entry) =>
              (entry.type === 'event' ? (entry.data as { runId?: unknown } | undefined)?.runId : undefined) ===
              state.runId,
          );
          if (mine.some((entry) => entry.type === 'event' && entry.kind === CTX_EVENTS.runEnded)) throw new Fenced();
          // 自己的 started 不在了：会话在这一轮中途被清掉。接着写会把删掉的会话写回来。
          if (state.started !== undefined && !mine.some((entry) => entry.seq === state.started)) throw new Fenced();
          // 这一轮自己写的条目被删或被涂改了：接着写会把针对已删内容的产出记回去。删的是更早的历史就不管。
          const erasures = lifecycle.flatMap((entry) =>
            entry.type === 'event' && entry.kind === CTX_EVENTS.erased && typeof entry.data === 'object' && entry.data
              ? [entry.data as unknown as ErasedData]
              : [],
          );
          if (erasures.some((erased) => state.recorded.some((entry) => isErased(erased, entry.seq)))) {
            throw new Fenced();
          }
          state.head = head;
        }
      }
    } catch (error) {
      if (!(error instanceof Fenced)) state.logFailed = true;
      throw error;
    }
  }

  /**
   * 开始一轮：会话里最后一个生命周期事件是 `started` 就说明有未结束的运行，返回 false，什么都不写；
   * 否则带着刚读到的末尾追加 `ctx.run.started`，冲突就重读重判。`record: false` 不碰日志，总是 true。
   */
  async function writeStarted(state: RunState): Promise<boolean> {
    if (!state.record) return true;
    const { agent, session } = state.request;
    const started = runStartedEntry(
      {
        runId: state.runId,
        agent: agentSpecToJson(agent),
        ...(state.request.owner !== undefined ? { owner: state.request.owner } : {}),
        // 形状不对的不记；`setup` 随后以 `invalid_request` 结束这一轮。
        ...(state.request.parent !== undefined && runParentProblem(state.request.parent) === undefined
          ? { parent: { ...state.request.parent } }
          : {}),
      },
      { source: 'harness' },
    );
    try {
      for (let conflicts = 0; ; conflicts += 1) {
        const head = await headSeq(store, session);
        const lifecycle = await store.list(session, {
          kinds: [CTX_EVENTS.runStarted, CTX_EVENTS.runEnded],
          last: 1,
        });
        const last = lifecycle.at(-1);
        if (last?.type === 'event' && last.kind === CTX_EVENTS.runStarted) return false;
        state.afterFailure = endedInFailure(lifecycle);
        try {
          await append(state, [started], head);
          state.started = state.recorded.at(-1)?.seq;
          return true;
        } catch (error) {
          if (!isConflict(error) || conflicts >= MAX_CONFLICTS) throw error;
        }
      }
    } catch (error) {
      state.logFailed = true;
      throw error;
    }
  }

  /**
   * 这一轮的输入是不是上一轮失败时留下的那句。上一轮以 `error` 或 `aborted` 结束、没有产出，它（或者更早失败的一轮）
   * 记下的输入还在日志里；这一轮带着一模一样的输入来，就是重试：不再记一遍，不然每失败一次历史就长一条
   * （上下文过长时越重试越长）。只在那句输入之后没有别的内容时才认：它后面只有框架事件（`ctx.*`）和没盖住它的摘要。
   * 给了 `inputKey` 的不走这里，由存储按键去重。
   */
  async function repeatsFailedInput(state: RunState, input: MessageContent): Promise<boolean> {
    if (!state.afterFailure) return false;
    const tail = await store.list(state.request.session, { last: RETRY_SCAN });
    let covered = 0;
    // 从末尾往回找最后一条不是框架写的条目：失败的轮次只留下 `ctx.*` 事件，连着失败几轮也一样跳过去。
    for (const entry of tail.toReversed()) {
      if (entry.type === 'event' && isFrameworkKind(entry.kind)) continue;
      if (entry.type === 'summary') {
        covered = Math.max(covered, entry.covers);
        continue;
      }
      return (
        entry.type === 'message' &&
        entry.message.role === 'user' &&
        entry.seq > covered &&
        JSON.stringify(entry.message.content) === JSON.stringify(input)
      );
    }
    return false;
  }

  /** 压缩一次，返回有没有写下摘要。builder 自己没配摘要模型（`no_model`）时用这一轮的模型。 */
  async function compactFor(
    session: string,
    spec: OverflowSpec,
    model: LanguageModel,
    signal: AbortSignal,
  ): Promise<boolean> {
    const compactOptions: CompactOptions = {
      ...spec.compact,
      // 至少留一条：这一轮刚记下的输入不能进摘要，模型要原样看到它。
      ...(spec.compact?.keep !== undefined ? { keep: Math.max(1, spec.compact.keep) } : {}),
      signal,
    };
    try {
      return (await context.compact!(session, compactOptions)) !== null;
    } catch (error) {
      if ((error as { type?: unknown } | null)?.type !== 'no_model') throw error;
      return (await context.compact!(session, { ...compactOptions, model })) !== null;
    }
  }

  /**
   * 超窗兜底（`AgentSpec.context.overflow`）：估算整次调用，超过 `maxTokens` 就先压缩、再裁剪（按 `strategy`），
   * 每一步之后重新 `build`。都做完还超，抛 `context_overflow`，这一轮不调模型。
   * 不写日志的运行（`record` 是 false）不压缩：压缩要追加摘要，而它一条都不该写。
   */
  async function fit(
    first: PreparedCall,
    request: BuildRequest,
    spec: OverflowSpec,
    record: boolean,
    model: LanguageModel,
    signal: AbortSignal,
  ): Promise<PreparedCall> {
    const limit = spec.maxTokens;
    const strategy = spec.strategy ?? 'compact';
    // 配置可能是从线上来的 JSON：不是数、不认识的策略都当请求不对，不猜。
    if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0) {
      throw new CtxError('invalid_request', 'AgentSpec.context.overflow.maxTokens must be a positive number.');
    }
    if (strategy !== 'compact' && strategy !== 'trim' && strategy !== 'error') {
      throw new CtxError(
        'invalid_request',
        'AgentSpec.context.overflow.strategy must be "compact", "trim" or "error".',
      );
    }
    const sizeOf = (call: PreparedCall): number => call.tokens ?? estimateCall(call, request.tools ?? []);
    let prepared = first;
    const before = sizeOf(prepared);
    if (before <= limit) return prepared;
    if (strategy === 'compact' && record && context.compact) {
      try {
        if (await compactFor(request.session, spec, model, signal)) prepared = await context.build(request);
      } catch (error) {
        if (signal.aborted) throw error;
        // 压缩没做成（摘要模型出错、超时）不拦这一轮：接着裁剪。
        logger.warn('compaction failed while the context is over its limit; trimming instead', {
          error: errorInfo(error).message,
        });
      }
    }
    if (strategy !== 'error' && sizeOf(prepared) > limit) {
      const maxTokens = Math.min(request.window?.maxTokens ?? Infinity, limit);
      prepared = await context.build({ ...request, window: { ...request.window, maxTokens, truncate: true } });
    }
    const after = sizeOf(prepared);
    logger.debug?.('context over its limit', { limit, before, after, strategy });
    if (after > limit) {
      throw new CtxError(
        CONTEXT_OVERFLOW,
        `The prepared call is estimated at ${after} tokens, over the limit of ${limit}` +
          (strategy === 'error' ? '.' : ' even after compaction and trimming.'),
        { retryable: false },
      );
    }
    return prepared;
  }

  async function setup(state: RunState, extras: RunExtras, signal: AbortSignal): Promise<Setup> {
    const { request } = state;
    const { agent, session } = request;
    const input = isEmptyContent(request.input) ? undefined : request.input;
    if (state.record && input !== undefined) {
      const source = options.source !== undefined ? { source: options.source } : {};
      const repeated = request.inputKey === undefined && (await repeatsFailedInput(state, input));
      if (!repeated) {
        await write(state, [userEntry(input, { ...source, ...(request.inputKey ? { key: request.inputKey } : {}) })]);
      }
    }
    const model = resolveModel(agent.model, options.models);
    const candidates = tools ? tools.select(agent.tools ?? true) : [];
    const building: BuildRequest = {
      session,
      ...(!state.record && input !== undefined ? { input } : {}),
      ...(agent.instructions !== undefined ? { instructions: agent.instructions } : {}),
      ...(request.prompt !== undefined ? { prompt: request.prompt } : {}),
      tools: candidates,
      ...(agent.window ? { window: agent.window } : {}),
      // `createContext` 自己收了事实时给 `false`，以它为准；否则按 `agent.context` 选事实和投影。
      ...(extras.facts === false
        ? { facts: false }
        : agent.context?.facts !== undefined
          ? { facts: agent.context.facts }
          : extras.facts !== undefined
            ? { facts: extras.facts }
            : {}),
      ...(agent.context?.projection !== undefined ? { projection: agent.context.projection } : {}),
      ...(agent.context?.inherit !== undefined ? { inherit: agent.context.inherit } : {}),
      signal,
    };
    checkLineage(request.parent, agent.context?.inherit);
    let prepared = await context.build(building);
    const overflow = agent.context?.overflow;
    if (overflow) prepared = await fit(prepared, building, overflow, state.record, model, signal);
    const hookContext: ModelHookContext = { runId: state.runId, session, step: 0, signal };
    prepared = (await hooks.beforeModel?.(prepared, hookContext)) ?? prepared;
    // 模型不一定看 abortSignal：已经取消就不调了。
    signal.throwIfAborted();
    const definitions = prepared.tools.flatMap((name) => {
      const found = candidates.find((tool) => tool.name === name) ?? tools?.get(name);
      return found ? [found] : [];
    });
    checkAgentExtras(
      agent,
      definitions.map((definition) => definition.name),
    );
    warnMissingExecutors(
      definitions.filter((definition) => toolPermission(agent.permissions, definition.name) !== 'ask'),
    );
    const { permissions } = agent;
    // `deny` 的不执行，模型看到拒绝；`ask` 的和外部执行环境的一样不在这里执行，这一轮以 `requires_action` 停下。
    const runDispatch: typeof dispatch = permissions
      ? async (call, definition, execution) =>
          toolPermission(permissions, call.name) === 'deny'
            ? errorOutput(`Tool call "${call.name}" was denied by the agent's permissions.`)
            : dispatch(call, definition, execution)
      : dispatch;
    // 一轮里第一次交给某个执行环境之前 `open` 这个会话（ADR 0009）；打不开时这个执行环境的调用都回错误，模型看得到原因。
    const opened = new Map<string, Promise<void>>();
    const environment = agent.environment;
    const openFor = (definition: ToolDefinition): Promise<void> | undefined => {
      const executor = executors.get(definition.executor);
      if (!executor?.open) return undefined;
      let opening = opened.get(definition.executor);
      if (!opening) {
        opening = executor.open(session, { ...(environment ? { environment } : {}), signal });
        opened.set(definition.executor, opening);
      }
      return opening;
    };
    const sessionDispatch: typeof dispatch = async (call, definition, execution) => {
      try {
        await openFor(definition);
      } catch (error) {
        return errorOutput(
          `Executor "${definition.executor}" could not prepare session "${session}" for tool "${call.name}": ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return runDispatch(call, definition, execution);
    };
    const deferred = (definition: ToolDefinition): boolean =>
      external.has(definition.executor) || toolPermission(permissions, definition.name) === 'ask';
    return {
      model,
      prepared,
      tools: toToolSet(definitions, undefined, {
        session,
        runId: state.runId,
        dispatch: sessionDispatch,
        validateInput: options.validateToolInput ?? ((definition) => !selfValidated(definition.name)),
        ...(options.maxToolOutputChars !== undefined ? { maxOutputChars: options.maxToolOutputChars } : {}),
        ...(external.size > 0 || permissions ? { external: deferred } : {}),
      }),
      toolCount: definitions.length,
      maxSteps: agent.maxSteps ?? (definitions.length > 0 ? 5 : 1),
    };
  }

  /**
   * 每一步即时落日志：模型这一步要在本地执行工具时，模型调用一结束（工具执行前）先写助手消息，崩溃后日志里至少有
   * 「调用已发出、结果未知」；步骤结束时写这一步剩下的（工具结果，或者没有工具调用时的助手消息）。
   * AI SDK 等这两个回调写完才执行工具、才走下一步，但吞掉回调的异常：写失败或被围栏时记进 `stepError`，再中止这一轮。
   */
  function stepLogging(state: RunState, abort: (reason: unknown) => void) {
    const stop = (error: unknown): void => {
      state.stepError ??= error;
      abort(error);
    };
    return {
      onLanguageModelCallEnd: async (event: {
        readonly content: ReadonlyArray<ContentPart<ToolSet>>;
        readonly provider: string;
        readonly modelId: string;
        readonly finishReason: FinishReason;
        readonly usage: LanguageModelUsage;
      }) => {
        const { content } = event;
        if (!state.record || state.stepError !== undefined) return;
        const calls = content.flatMap((part) =>
          part.type === 'tool-call' && part.providerExecuted !== true ? [part] : [],
        );
        if (calls.length === 0) return;
        const draft = assistantBefore(content);
        if (!draft) return;
        try {
          // 子集之外的部件在这里抛 `unsupported_part`：这一轮以 `error` 结束，工具不执行。
          const [message] = fromModelMessages([draft]);
          await write(state, [messageEntry(message!, { source: 'model', meta: stepMeta(state, event) })]);
          state.early = true;
          for (const call of calls) state.open.set(call.toolCallId, call.toolName);
        } catch (error) {
          stop(error);
        }
      },
      onStepEnd: async (step: {
        readonly model: { readonly provider: string };
        readonly response: { readonly modelId: string; readonly messages: readonly ModelMessage[] };
        readonly finishReason: FinishReason;
        readonly usage: LanguageModelUsage;
      }) => {
        const index = state.step;
        state.step += 1;
        const done = stepSeq(state, index);
        if (!state.record || state.stepError !== undefined) return done.resolve(undefined);
        try {
          const messages = fromModelMessages(step.response.messages);
          const skip = state.early && messages[0]?.role === 'assistant';
          const meta = stepMeta(
            { ...state, step: index },
            {
              provider: step.model.provider,
              modelId: step.response.modelId,
              finishReason: step.finishReason,
              usage: step.usage,
            },
          );
          await write(
            state,
            messages.flatMap((message, at) =>
              skip && at === 0
                ? []
                : [
                    messageEntry(message, {
                      source: 'model',
                      // 这一步的助手消息带上用量；工具执行前已经写下的那条在写的时候带过了。
                      ...(!skip && at === 0 && message.role === 'assistant' ? { meta } : {}),
                    }),
                  ],
            ),
          );
          state.logged += messages.length;
          state.early = false;
          state.open.clear();
          done.resolve(state.head);
        } catch (error) {
          done.resolve(undefined);
          stop(error);
        }
      },
    };
  }

  /** `generateText` 和 `streamText` 共用的参数。 */
  function callOptions(state: RunState, ready: Setup, controller: ReturnType<typeof linked>) {
    const { signal } = controller;
    const settings = state.request.agent.settings ?? {};
    const { prepared } = ready;
    const beforeModel = hooks.beforeModel?.bind(hooks);
    return {
      ...stepLogging(state, (reason) => controller.abort(reason)),
      model: ready.model,
      ...(prepared.instructions ? { instructions: prepared.instructions } : {}),
      messages: toModelMessages(prepared.messages),
      ...(ready.toolCount > 0 ? { tools: ready.tools } : {}),
      stopWhen: state.request.agent.budget
        ? [stepCountIs(ready.maxSteps), budgetStop(state, state.request.agent.budget)]
        : stepCountIs(ready.maxSteps),
      ...(state.request.agent.output
        ? {
            output: Output.object({
              schema: jsonSchema(state.request.agent.output.schema as Parameters<typeof jsonSchema>[0]),
              ...(state.request.agent.output.name !== undefined ? { name: state.request.agent.output.name } : {}),
              ...(state.request.agent.output.description !== undefined
                ? { description: state.request.agent.output.description }
                : {}),
            }),
          }
        : {}),
      ...(state.request.agent.toolChoice !== undefined && ready.toolCount > 0
        ? {
            toolChoice:
              typeof state.request.agent.toolChoice === 'string'
                ? state.request.agent.toolChoice
                : { type: 'tool' as const, toolName: state.request.agent.toolChoice.tool },
          }
        : {}),
      ...(settings.temperature !== undefined ? { temperature: settings.temperature } : {}),
      ...(settings.maxOutputTokens !== undefined ? { maxOutputTokens: settings.maxOutputTokens } : {}),
      ...(settings.topP !== undefined ? { topP: settings.topP } : {}),
      ...(settings.topK !== undefined ? { topK: settings.topK } : {}),
      ...(settings.presencePenalty !== undefined ? { presencePenalty: settings.presencePenalty } : {}),
      ...(settings.frequencyPenalty !== undefined ? { frequencyPenalty: settings.frequencyPenalty } : {}),
      ...(settings.seed !== undefined ? { seed: settings.seed } : {}),
      ...(settings.stopSequences !== undefined ? { stopSequences: [...settings.stopSequences] } : {}),
      ...(settings.maxRetries !== undefined ? { maxRetries: settings.maxRetries } : {}),
      ...(settings.timeoutMs !== undefined ? { timeout: settings.timeoutMs } : {}),
      ...(settings.headers !== undefined ? { headers: { ...settings.headers } } : {}),
      ...(settings.providerOptions !== undefined
        ? { providerOptions: settings.providerOptions as Record<string, Record<string, never>> }
        : {}),
      abortSignal: signal,
      // 第一步之前已经调过 beforeModel；之后的工具步骤每一步再给它一次机会。
      ...(beforeModel
        ? {
            prepareStep: async ({ stepNumber, messages }: { stepNumber: number; messages: ModelMessage[] }) => {
              if (stepNumber === 0) return undefined;
              const call: PreparedCall = { ...prepared, messages: fromModelMessages(messages) };
              const changed = await beforeModel(call, {
                runId: state.runId,
                session: state.request.session,
                step: stepNumber,
                signal,
              });
              if (!changed || changed === call) return undefined;
              return {
                messages: toModelMessages(changed.messages),
                ...(changed.instructions !== undefined ? { instructions: changed.instructions } : {}),
              };
            },
          }
        : {}),
    };
  }

  /** 正常结束：每一步已经写下了，这里补上还没写的产出（一般没有）和 `ctx.run.ended`。 */
  async function finish(state: RunState, ready: Setup, produced: Produced, signal: AbortSignal): Promise<RunResult> {
    await state.writing;
    if (state.stepError !== undefined) return fail(state, state.stepError, signal);
    const messages = [...produced.messages];
    const { pending } = produced;
    const stopReason: StopReason =
      pending.length > 0
        ? 'requires_action'
        : state.overBudget && produced.finishReason === 'tool-calls'
          ? 'max_budget'
          : stopReasonOf(produced.finishReason, produced.steps, ready.maxSteps);
    const spec = state.request.agent.output;
    let output: JsonValue | undefined;
    if (spec && stopReason === 'end_turn') {
      try {
        output = parseOutput(produced.text, spec.schema);
      } catch (error) {
        return fail(state, error, signal);
      }
    }
    const usage = usageOf(produced.usage);
    await write(state, [
      ...messages.slice(state.logged).map((message) => messageEntry(message, { source: 'model' })),
      runEndedEntry({ runId: state.runId, stopReason, ...(usage ? { usage } : {}) }, { source: 'harness' }),
    ]);
    return {
      runId: state.runId,
      text: produced.text,
      messages,
      recorded: state.recorded,
      stopReason,
      ...(usage ? { usage } : {}),
      ...(output !== undefined ? { output } : {}),
      ...(pending.length > 0 ? { pending } : {}),
    };
  }

  /**
   * 出错或取消：照样写 `ctx.run.ended`，返回结果而不是抛。已经写下的步骤留在日志里；写下了调用、还没等到结果的工具
   * 先补一条错误结果（`INTERRUPTED_TOOL_RESULT`）。步骤回调里写日志失败的，以那个错误为准：被围栏就停下，别的抛出去。
   */
  async function fail(state: RunState, caught: unknown, signal: AbortSignal): Promise<RunResult> {
    await state.writing;
    const error = state.stepError ?? caught;
    if (error instanceof Fenced) return fenced(state);
    if (state.logFailed) throw error;
    // 步骤回调转换产出失败（`unsupported_part`）时中止过这一轮，但这不是调用方取消的。
    const aborted = signal.aborted && state.stepError === undefined;
    const stopReason: StopReason = aborted ? 'aborted' : 'error';
    const info = errorInfo(error);
    if (stopReason === 'error') logger.debug?.('run failed', { runId: state.runId, error: info.message });
    const open = state.open.size > 0 ? [messageEntry(interruptedResults(state.open), { source: 'harness' })] : [];
    try {
      await write(state, [
        ...open,
        ...(stopReason === 'error'
          ? [
              ctxErrorEntry(
                { runId: state.runId, message: info.message, ...(info.type ? { type: info.type } : {}) },
                { source: 'harness' },
              ),
            ]
          : []),
        runEndedEntry({ runId: state.runId, stopReason }, { source: 'harness' }),
      ]);
    } catch (writeError) {
      if (writeError instanceof Fenced) return fenced(state);
      throw writeError;
    }
    return {
      runId: state.runId,
      text: '',
      messages: [],
      recorded: state.recorded,
      stopReason,
      ...(stopReason === 'error' ? { error: info } : {}),
    };
  }

  /** 进程内每会话一条队列，队尾是前一个记录型运行结束的时刻。队列里的 promise 永远 resolve，不会 reject。 */
  const tails = new Map<string, Promise<void>>();

  /**
   * 排进这个会话的队：同一个 harness 里记录型运行（`record` 不为 `false`）一个接一个，第二个等前一个结束再开始，
   * 所以 `session_busy` 只会出现在跨进程（或别的 harness 实例）的时候。`record: false` 不排。
   * 前面有人在跑、自己在排队时 `signal` 中止，就退出队列，返回 `undefined`，调用方以 `aborted` 结束，什么都没写。
   * 返回的 `release` 在运行结束时调；可以重复调。
   */
  async function enter(state: RunState): Promise<(() => void) | undefined> {
    if (!state.record) return () => {};
    const { session } = state.request;
    const { signal } = state.request;
    const queued = tails.has(session);
    const previous = tails.get(session) ?? Promise.resolve();
    const turn = Promise.withResolvers<void>();
    const tail = previous.then(() => turn.promise);
    tails.set(session, tail);
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      turn.resolve();
      void tail.finally(() => {
        if (tails.get(session) === tail) tails.delete(session);
      });
    };
    // 没人排在前面就直接开始：`signal` 已经中止的运行照常写 started 和 ended（见契约）。
    if (!queued) return release;
    if (signal) {
      // 等完就摘掉监听：调用方长期复用同一个 signal 时不会越积越多。
      let onAbort: (() => void) | undefined;
      const aborted = new Promise<void>((resolve) => {
        if (signal.aborted) return resolve();
        onAbort = resolve;
        signal.addEventListener('abort', onAbort, { once: true });
      });
      let waited = false;
      await Promise.race([previous.then(() => (waited = true)), aborted]);
      if (onAbort) signal.removeEventListener('abort', onAbort);
      if (signal.aborted || !waited) {
        release();
        return undefined;
      }
    } else {
      await previous;
    }
    return release;
  }

  async function run(request: RunRequest, extras: RunExtras = {}): Promise<RunOutcome> {
    const state = begin(request);
    const release = await enter(state);
    if (!release) return { result: fenced(state) };
    try {
      return await runLocked(state, extras);
    } finally {
      release();
    }
  }

  async function runLocked(state: RunState, extras: RunExtras): Promise<RunOutcome> {
    const { request } = state;
    const controller = linked(request.signal);
    if (!(await writeStarted(state))) return { result: busy(state) };
    try {
      const ready = await setup(state, extras, controller.signal);
      const raw = await generateText(callOptions(state, ready, controller));
      const result = await finish(
        state,
        ready,
        {
          text: raw.text,
          // 子集之外的部件在这里抛 `unsupported_part`，下面的 catch 把这一轮以 `error` 结束。
          messages: fromModelMessages(raw.responseMessages),
          finishReason: raw.finishReason,
          steps: raw.steps.length,
          usage: raw.usage,
          pending: pendingOf(raw.steps.at(-1)?.content),
        },
        controller.signal,
      );
      return { result, raw };
    } catch (error) {
      if (state.logFailed) throw state.stepError ?? error;
      return { result: await fail(state, error, controller.signal), cause: state.stepError ?? error };
    }
  }

  async function startStream(request: RunRequest, extras: RunExtras = {}): Promise<StartedStream> {
    const state = begin(request);
    const release = await enter(state);
    if (!release) {
      const outcome = Promise.resolve<RunOutcome>({ result: fenced(state) });
      return { runId: state.runId, done: () => outcome };
    }
    try {
      return await startStreamLocked(state, extras, release);
    } catch (error) {
      release();
      throw error;
    }
  }

  /** 流式的一轮；队列的位置在这一轮真正结束（结果落定）时才交出去，由 `release` 负责。 */
  async function startStreamLocked(state: RunState, extras: RunExtras, release: () => void): Promise<StartedStream> {
    const { request } = state;
    const controller = linked(request.signal);
    if (!(await writeStarted(state))) {
      release();
      const outcome = Promise.resolve<RunOutcome>({ result: busy(state) });
      return { runId: state.runId, done: () => outcome };
    }
    let ready: Setup;
    try {
      ready = await setup(state, extras, controller.signal);
    } catch (error) {
      if (state.logFailed) throw error;
      const outcome = fail(state, error, controller.signal).then((result) => ({ result, cause: error }));
      outcome.catch(() => {});
      void outcome.then(release, release);
      return {
        runId: state.runId,
        ...(state.started !== undefined ? { seq: state.started } : {}),
        done: () => outcome,
      };
    }

    const finished = Promise.withResolvers<RunOutcome>();
    // 没人等结果时，写日志失败也不能变成未处理的 rejection。
    finished.promise.catch(() => {});
    void finished.promise.then(release, release);
    let settled = false;
    let failure: unknown;
    const settle = (work: () => Promise<RunResult>, cause?: unknown): void => {
      if (settled) return;
      settled = true;
      work()
        .catch((error: unknown) => {
          // 被围栏：别人已经结束了这一轮，不算写日志失败。
          if (error instanceof Fenced) return fenced(state);
          throw error;
        })
        .then(
          (result) => finished.resolve(cause === undefined ? { result } : { result, cause }),
          (error: unknown) => {
            logger.warn('failed to record run', { runId: state.runId, error: errorInfo(error).message });
            finished.reject(error);
          },
        );
    };
    const report =
      extras.onError ?? ((error: unknown) => logger.warn('stream failed', { error: errorInfo(error).message }));

    const result = streamText({
      ...callOptions(state, ready, controller),
      onError: ({ error }) => {
        failure = error;
        report(error);
      },
      onEnd: (event) => {
        let messages: Message[];
        try {
          messages = fromModelMessages(event.responseMessages);
        } catch (error) {
          // 子集之外的部件：这一轮以 `error` 结束，已经按步写下的留着。
          settle(() => fail(state, error, controller.signal), error);
          return;
        }
        settle(() =>
          finish(
            state,
            ready,
            {
              text: event.text,
              messages,
              finishReason: event.finishReason,
              steps: event.steps.length,
              usage: event.totalUsage,
              pending: pendingOf(event.steps.at(-1)?.content),
            },
            controller.signal,
          ),
        );
      },
      onAbort: () => {
        const reason = controller.signal.reason ?? new Error('Run aborted.');
        settle(() => fail(state, reason, controller.signal), reason);
      },
    });

    let watched = false;
    return {
      runId: state.runId,
      ...(state.started !== undefined ? { seq: state.started } : {}),
      stepSeq: (step) => stepSeq(state, step).promise,
      result,
      done() {
        if (!watched) {
          watched = true;
          // 出错或没有输出时 AI SDK 不调 onEnd，只让结果的 promise reject；读它也会让流跑完。
          result.finishReason.then(undefined, (error: unknown) => {
            const cause = failure ?? error;
            settle(() => fail(state, cause, controller.signal), cause);
          });
        }
        return finished.promise;
      },
    };
  }

  async function* stream(request: RunRequest): AsyncGenerator<RunEvent> {
    const controller = linked(request.signal);
    const started = await startStream({ ...request, signal: controller.signal });
    const { runId } = started;
    let completed = false;
    // 这一轮落定（包括出错）以后，还没写下的步骤不会再写：等步骤的 `seq` 时以它兜底，不会一直等。
    const settled = started.done().then(
      () => undefined,
      () => undefined,
    );
    try {
      yield {
        type: 'run.started',
        runId,
        session: request.session,
        ...(started.seq !== undefined ? { seq: started.seq } : {}),
      };
      if (started.result) {
        let step = 0;
        try {
          for await (const part of started.result.fullStream) {
            switch (part.type) {
              case 'start-step':
                yield { type: 'model.started', runId, step };
                break;
              case 'text-delta':
                if (part.text) yield { type: 'text.delta', runId, text: part.text };
                break;
              case 'reasoning-delta':
                if (part.text) yield { type: 'reasoning.delta', runId, text: part.text };
                break;
              case 'tool-call':
                yield {
                  type: 'tool.called',
                  runId,
                  call: { id: part.toolCallId, name: part.toolName, input: (part.input ?? null) as ToolCall['input'] },
                };
                break;
              case 'tool-result':
                yield { type: 'tool.returned', runId, callId: part.toolCallId, output: part.output as ToolOutput };
                break;
              case 'tool-error':
                yield {
                  type: 'tool.returned',
                  runId,
                  callId: part.toolCallId,
                  output: errorOutput(errorInfo(part.error).message),
                };
                break;
              case 'finish-step': {
                const usage = usageOf(part.usage);
                // 等这一步写进日志：事件里的 `seq` 说的是「日志已经写到这里」。
                const seq = await Promise.race([started.stepSeq?.(step), settled]);
                yield {
                  type: 'model.ended',
                  runId,
                  step,
                  ...(usage ? { usage } : {}),
                  ...(seq !== undefined ? { seq } : {}),
                };
                step += 1;
                break;
              }
              default:
                break;
            }
          }
        } catch {
          // 流本身的错误由 done() 收进结果。
        }
      }
      const { result } = await started.done();
      completed = true;
      if (result.error) yield { type: 'error', runId, message: result.error.message };
      const { messages: _messages, recorded, ...summary } = result;
      const last = recorded.at(-1);
      const ended =
        last?.type === 'event' &&
        last.kind === CTX_EVENTS.runEnded &&
        (last.data as { runId?: unknown } | undefined)?.runId === runId
          ? last.seq
          : undefined;
      yield { type: 'run.ended', runId, result: summary, ...(ended !== undefined ? { seq: ended } : {}) };
    } finally {
      if (!completed) {
        // 调用方提前不读了：取消模型调用，等 ctx.run.ended 写完。
        controller.abort(new Error('Run stream closed by the consumer.'));
        await started.done().catch(() => {});
      }
    }
  }

  return {
    harness: {
      run: async (request) => (await run(request)).result,
      stream,
    },
    run,
    startStream,
  };
}

/**
 * 基于 AI SDK `generateText` / `streamText` 的 harness：`ctx.run.started` → 记输入 → `ContextBuilder.build` →
 * `beforeModel` → 调模型（每个工具调用经 `beforeTool` → 绑定的执行环境 → `afterTool`）→ 记产出 → `ctx.run.ended`。
 * 模型出错、被取消也写 `ctx.run.ended` 并照常返回；只有写日志失败才 reject。`record: false` 时一条都不写。
 */
export function createHarness(options: HarnessOptions): Harness & {
  stream(request: RunRequest): AsyncIterable<RunEvent>;
} {
  return createHarnessRuntime(options).harness;
}
