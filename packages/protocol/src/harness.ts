import type { LanguageModel } from 'ai';

import type { Message, MessageContent } from './message.ts';
import type { ContextSpec, PreparedCall, WindowOptions } from './context.ts';
import { isErased } from './erase.ts';
import {
  CTX_EVENTS,
  ctxEventData,
  headSeq,
  isEvent,
  messageEntry,
  runIdOf,
  type Entry,
  type EntryOptions,
  type NewMessageEntry,
  type RunParent,
  type SessionStore,
} from './session.ts';
import type { EnvironmentSpec, ExecutionContext, ToolCall, ToolOutput, ToolSelection } from './tools.ts';
import { definedFields, isJsonObject, usageFromJson } from './json.ts';
import type { Awaitable, ErrorInfo, JsonObject, JsonValue } from './types.ts';

/**
 * 模型的指代：名字（跨边界时只能是它，由对面按名字造模型），或进程内的 AI SDK 模型对象。
 * AI SDK 的 `LanguageModel` 本身也收网关的模型名，这里放宽成任意字符串。
 */
export type ModelRef = string | Exclude<LanguageModel, string>;

/** 模型调用参数。全部能序列化；`providerOptions` 按服务商名分组，原样交给 AI SDK。 */
export interface CallSettings {
  readonly temperature?: number;
  readonly maxOutputTokens?: number;
  readonly topP?: number;
  readonly topK?: number;
  readonly presencePenalty?: number;
  readonly frequencyPenalty?: number;
  readonly seed?: number;
  readonly stopSequences?: readonly string[];
  readonly maxRetries?: number;
  /** 整轮（含工具步骤）的超时。 */
  readonly timeoutMs?: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly providerOptions?: Readonly<Record<string, JsonObject>>;
}

/**
 * 一个 agent 的配置：用哪个模型、什么指令、哪些工具、什么参数。同一个 harness 跑不同的配置就是不同的 agent。
 * 除了进程内的 `LanguageModel`，都能序列化。
 */
export interface AgentSpec {
  /** 给日志和界面看的名字。 */
  readonly name?: string;
  readonly model: ModelRef;
  readonly instructions?: string;
  /** 从工具目录里挑哪些，缺省全部。 */
  readonly tools?: ToolSelection;
  /** 工具调用最多走几步。缺省：有工具 5 步，没有工具 1 步。 */
  readonly maxSteps?: number;
  readonly window?: WindowOptions;
  /** 这个 agent 的上下文怎么组装：事实用哪些来源、放哪，用哪套投影。见 `ContextSpec`。 */
  readonly context?: ContextSpec;
  readonly settings?: CallSettings;
  /** 应用给这份配置的版本标识（例如 `support@3`、一个 git 提交）。原样记进 `ctx.run.started`，回看时知道这一轮跑的是哪一版。 */
  readonly version?: string;
  /** 结构化输出：最后的回答按这个 JSON Schema 生成并解析，放在 `RunResult.output`。 */
  readonly output?: OutputSpec;
  /** 模型怎么选工具，缺省 `auto`。 */
  readonly toolChoice?: ToolChoice;
  /** 按工具名的权限：直接执行、先停下等确认、拒绝。见 `ToolPermissions`。 */
  readonly permissions?: ToolPermissions;
  /** 整轮的预算：超了在步骤之间停下，`stopReason` 是 `max_budget`。 */
  readonly budget?: RunBudget;
  /** 这个 agent 的工具在什么样的执行环境里跑：harness 交给执行环境的 `open`。见 `EnvironmentSpec`。 */
  readonly environment?: EnvironmentSpec;
}

/** 结构化输出的 schema。只用 JSON Schema，过得了线。 */
export interface OutputSpec {
  readonly schema: JsonObject;
  /** 给模型看的名字和说明，有的服务商会用。 */
  readonly name?: string;
  readonly description?: string;
}

/** `auto` 模型自己定；`none` 不调工具；`required` 必须调一个；`{ tool }` 必须调这个。 */
export type ToolChoice = 'auto' | 'none' | 'required' | { readonly tool: string };

/** 一个工具的权限：`allow` 直接执行，`ask` 先停下等确认（走 `requires_action`），`deny` 不执行、模型看到拒绝。 */
export type ToolPermission = 'allow' | 'ask' | 'deny';

/**
 * 可序列化的权限策略。`tools` 按工具名，`default` 管没列出的（缺省 `allow`）。`ask` 的调用不执行：这一轮写下调用后以
 * `requires_action` 结束，应用确认了就让执行方执行（`runPendingTools`），不确认就追加一条错误结果，再不带输入跑一轮。
 * 和 `Hooks.beforeTool` 叠加：先看权限，`allow` 的再交给钩子。
 */
export interface ToolPermissions {
  readonly default?: ToolPermission;
  readonly tools?: Readonly<Record<string, ToolPermission>>;
}

/** 一个工具在这份策略下的权限。 */
export function toolPermission(permissions: ToolPermissions | undefined, tool: string): ToolPermission {
  return permissions?.tools?.[tool] ?? permissions?.default ?? 'allow';
}

/** 整轮的上限。只在步骤之间检查：正在进行的模型调用和工具不会被打断，要硬上限用 `settings.timeoutMs`。 */
export interface RunBudget {
  /** 这一轮所有步骤加起来的 `totalTokens`（没有时用输入加输出）。 */
  readonly maxTotalTokens?: number;
  /** 从这一轮开始算的墙钟时间。 */
  readonly maxDurationMs?: number;
}

/** 模型名的字符串写法：进程内的 `LanguageModel` 记成 `<provider>/<modelId>`。 */
export function modelName(model: ModelRef): string {
  if (typeof model === 'string') return model;
  return `${model.provider}/${model.modelId}`;
}

/** 记进日志时，请求头的值换成这个：头里常有凭证，日志只追加、读得到会话的人都看得到。 */
export const REDACTED_HEADER = '[redacted]';

/**
 * `AgentSpec` 的可序列化部分，`ctx.run.started` 的 `data.agent` 用它。
 * `settings.headers` 只留名字，值换成 `REDACTED_HEADER`。
 */
export function agentSpecToJson(spec: AgentSpec): JsonObject {
  const out: Record<string, unknown> = { model: modelName(spec.model) };
  if (spec.name !== undefined) out['name'] = spec.name;
  if (spec.instructions !== undefined) out['instructions'] = spec.instructions;
  if (spec.tools !== undefined) out['tools'] = spec.tools;
  if (spec.maxSteps !== undefined) out['maxSteps'] = spec.maxSteps;
  if (spec.window !== undefined) out['window'] = spec.window;
  if (spec.context !== undefined) out['context'] = spec.context;
  if (spec.version !== undefined) out['version'] = spec.version;
  if (spec.output !== undefined) out['output'] = spec.output;
  if (spec.toolChoice !== undefined) out['toolChoice'] = spec.toolChoice;
  if (spec.permissions !== undefined) out['permissions'] = spec.permissions;
  if (spec.budget !== undefined) out['budget'] = spec.budget;
  if (spec.environment !== undefined) out['environment'] = spec.environment;
  if (spec.settings !== undefined) {
    const { headers, ...rest } = spec.settings;
    out['settings'] = headers
      ? { ...rest, headers: Object.fromEntries(Object.keys(headers).map((name) => [name, REDACTED_HEADER])) }
      : rest;
  }
  return out as JsonObject;
}

export interface RunRequest {
  readonly session: string;
  readonly agent: AgentSpec;
  /** 这一轮用户新说的话。记录时在调用模型前写进日志。 */
  readonly input?: MessageContent;
  /** 输入的幂等键：失败后用同一个键重试，不会再记一遍。 */
  readonly inputKey?: string;
  /** 放在最后的临时用户消息，不写日志。 */
  readonly prompt?: MessageContent;
  /** 把输入、产出和 `ctx.run.*` 写进日志，缺省写。 */
  readonly record?: boolean;
  /** 不给就由 harness 生成。 */
  readonly runId?: string;
  /** 写进 `ctx.run.started` 的 `owner`：这一轮属于哪个编排器实例，`recover` 据此只收自己的运行。编排器按自己的 `owner` 填。 */
  readonly owner?: string;
  /** 这一轮是别的 agent 派来的：记进 `ctx.run.started`，回看子会话时知道它从哪来。见 `RunParent`。 */
  readonly parent?: RunParent;
  readonly signal?: AbortSignal;
}

/**
 * 一轮为什么停：`end_turn` 模型自己停下，`max_steps` 到了步数上限，`max_tokens` 输出被 `maxOutputTokens` 截断，
 * `max_budget` 超了 `AgentSpec.budget`（在步骤之间停下），
 * `requires_action` 留下了要在别处执行的工具调用（`RunResult.pending`），等结果追加进日志后不带输入再跑一轮接着走，
 * `aborted` 被取消，`error` 出错。
 */
export type StopReason =
  | 'end_turn'
  | 'max_steps'
  | 'max_tokens'
  | 'max_budget'
  | 'requires_action'
  | 'aborted'
  | 'error';

/** token 用量。服务商不给的项就没有，缓存和推理三项是 0 时也不写；各服务商的字段怎么映射过来，没有对真实服务验证。 */
export interface Usage {
  /** 输入的 token，含缓存读到的和写进缓存的。 */
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
  /** 输入里从提示缓存读到的。 */
  readonly cacheReadTokens?: number;
  /** 输入里写进提示缓存的。 */
  readonly cacheWriteTokens?: number;
  /** 输出里推理用掉的。 */
  readonly reasoningTokens?: number;
}

/**
 * harness 写进每一步助手消息 `meta.step` 的内容：这是哪一轮的第几步，服务商实际用的模型，这一步的用量。
 * 整轮的合计在 `ctx.run.ended` 的 `usage`。用 `stepMetaOf(entry)` 读。
 */
export interface StepMeta {
  readonly runId: string;
  /** 从 0 数。 */
  readonly step: number;
  readonly provider?: string;
  /** 服务商在响应里给的模型标识；走了回落、别名解析到具体版本时和请求的不一样。 */
  readonly modelId?: string;
  /** AI SDK 的 `finishReason`：`stop`、`tool-calls`、`length` 等。 */
  readonly finishReason?: string;
  readonly usage?: Usage;
  /**
   * 只有第一步有：这一步请求的估算输入 token（`PreparedCall.tokens`，校准过的话是校准之后的）。和 `usage.inputTokens`
   * 一比就知道估算偏了多少；参考实现的 builder 拿它校准下一轮的窗口。
   */
  readonly estimatedInputTokens?: number;
  /** 只有第一步有：`estimatedInputTokens` 里乘上的校准倍数（`PreparedCall.calibration`）。没校准时不出现。 */
  readonly calibration?: number;
}

/**
 * 条目 `meta.step` 里的 `StepMeta`；不是 harness 写的步骤消息（`runId` 不是字符串、`step` 不是数）时返回 `undefined`。
 * 可选字段只留类型对的。
 */
export function stepMetaOf(entry: Entry): StepMeta | undefined {
  const meta = entry.meta?.['step'];
  if (!isJsonObject(meta)) return undefined;
  const { runId, step, provider, modelId, finishReason, usage, estimatedInputTokens, calibration } = meta;
  if (typeof runId !== 'string' || typeof step !== 'number') return undefined;
  return {
    runId,
    step,
    ...(typeof provider === 'string' ? { provider } : {}),
    ...(typeof modelId === 'string' ? { modelId } : {}),
    ...(typeof finishReason === 'string' ? { finishReason } : {}),
    ...(isJsonObject(usage) ? { usage: usageFromJson(usage) } : {}),
    ...(typeof estimatedInputTokens === 'number' ? { estimatedInputTokens } : {}),
    ...(typeof calibration === 'number' ? { calibration } : {}),
  };
}

/** `StepMeta` 写成条目 `meta.step` 的 JSON，没给的字段不出现：`messageEntry(message, { meta: { step: stepMetaToJson(meta) } })`。 */
export function stepMetaToJson(meta: StepMeta): JsonObject {
  return definedFields({ ...meta, usage: meta.usage && definedFields(meta.usage) });
}

export interface RunResult {
  readonly runId: string;
  /** 最后一步的文字。 */
  readonly text: string;
  /** 这一轮模型产出的消息（含工具调用和结果）。 */
  readonly messages: Message[];
  /** 实际写进日志的条目。 */
  readonly recorded: readonly Entry[];
  readonly stopReason: StopReason;
  readonly usage?: Usage;
  /** 给了 `AgentSpec.output` 时，按那份 schema 解析出来的回答。没能解析（模型没给出合法的 JSON）时这一轮以 `error` 结束。 */
  readonly output?: JsonValue;
  /** `stopReason` 是 `requires_action` 时，等着别处执行、还没有结果的工具调用。 */
  readonly pending?: readonly ToolCall[];
  /** `stopReason` 是 `error` 时的原因。 */
  readonly error?: ErrorInfo;
}

/**
 * 流式运行的事件。`text.delta`、`reasoning.delta` 不落日志，其余各有对应的日志条目。带 `seq` 的三种是和日志对齐的点：
 * 发出它的时候，日志已经写到这个 `seq`（`run.started` 是 `ctx.run.started`，`model.ended` 是这一步最后一条，
 * `run.ended` 是 `ctx.run.ended`）。流断了，从最后收到的 `seq` 起 `watch` 或 `list({ after })` 就能接上。
 * 不写日志（`record: false`）时没有 `seq`。
 */
export type RunEvent =
  | { readonly type: 'run.started'; readonly runId: string; readonly session: string; readonly seq?: number }
  | { readonly type: 'model.started'; readonly runId: string; readonly step: number }
  | { readonly type: 'text.delta'; readonly runId: string; readonly text: string }
  | { readonly type: 'reasoning.delta'; readonly runId: string; readonly text: string }
  | { readonly type: 'tool.called'; readonly runId: string; readonly call: ToolCall }
  | { readonly type: 'tool.returned'; readonly runId: string; readonly callId: string; readonly output: ToolOutput }
  | {
      readonly type: 'model.ended';
      readonly runId: string;
      readonly step: number;
      readonly usage?: Usage;
      readonly seq?: number;
    }
  | {
      readonly type: 'run.ended';
      readonly runId: string;
      readonly result: Omit<RunResult, 'messages' | 'recorded'>;
      readonly seq?: number;
    }
  | { readonly type: 'error'; readonly runId: string; readonly message: string };

export type RunEventType = RunEvent['type'];

export interface ModelHookContext {
  readonly runId: string;
  readonly session: string;
  /** 从 0 数。 */
  readonly step: number;
  readonly signal?: AbortSignal;
}

/** `beforeTool` 的决定。拒绝时工具结果是一条带原因的错误，模型会看到它，这一轮继续。 */
export type ToolDecision =
  | { readonly allow: true; readonly input?: JsonValue }
  | { readonly allow: false; readonly reason: string };

/** harness 给应用的切入点。权限确认、输入改写、输出截断都是钩子，不进协议本体。返回空表示不改。 */
export interface Hooks {
  /** 调模型前，可以换掉这次的调用。 */
  beforeModel?(call: PreparedCall, context: ModelHookContext): Awaitable<PreparedCall | void>;
  /** 执行工具前，可以拒绝或改写输入。 */
  beforeTool?(call: ToolCall, context: ExecutionContext): Awaitable<ToolDecision | void>;
  /** 执行工具后，可以改写结果（例如截断大输出）。 */
  afterTool?(call: ToolCall, output: ToolOutput, context: ExecutionContext): Awaitable<ToolOutput | void>;
}

/**
 * Harness：跑一轮的循环。`ctx.run.started` → 记输入 → `ContextBuilder.build` → 调模型 → 每个工具调用
 * `beforeTool` → 绑定的执行环境 `execute` → `afterTool` → 结果回到模型，直到停下 → 记产出 → `ctx.run.ended`。
 * 模型出错、被取消也写 `ctx.run.ended`，`run` 照常返回，`stopReason` 和 `error` 说明原因；只有写日志本身失败才 reject。
 */
export interface Harness {
  run(request: RunRequest): Promise<RunResult>;
  stream?(request: RunRequest): AsyncIterable<RunEvent>;
}

/** 等着别处执行的一次工具调用：哪一轮留下的，调用写在哪条条目里。 */
export interface PendingToolCall {
  readonly call: ToolCall;
  readonly runId: string;
  /** 带这次调用的助手消息的 `seq`。 */
  readonly seq: number;
}

/**
 * 会话里等着别处执行、还没有结果的工具调用：以 `requires_action` 结束的那一轮留下的调用，去掉后面已经追加了结果的。
 * 之后又有运行以别的原因结束（结果没等来，下一轮照常跑了），之前留下的就不再算等待中。条目按 `seq` 排好。
 * 服务商执行的调用不算。
 */
export function pendingToolCalls(entries: readonly Entry[]): PendingToolCall[] {
  let open = new Map<string, PendingToolCall>();
  let run: { runId: string; calls: Map<string, PendingToolCall> } | undefined;
  for (const entry of entries) {
    if (isEvent(entry, CTX_EVENTS.runStarted) || isEvent(entry, CTX_EVENTS.runEnded)) {
      const runId = runIdOf(entry);
      if (runId === undefined) continue;
      if (entry.kind === CTX_EVENTS.runStarted) {
        run = { runId, calls: new Map() };
        continue;
      }
      // 这一轮停下来等结果：它留下的调用等待中；别的结束方式让之前等着的都作废。
      const waiting = ctxEventData(entry, CTX_EVENTS.runEnded)?.stopReason === 'requires_action';
      open = waiting && run?.runId === runId ? new Map(run.calls) : new Map();
      run = undefined;
      continue;
    }
    if (entry.type !== 'message' || typeof entry.message.content === 'string') continue;
    for (const part of entry.message.content) {
      if (part.type === 'tool-call' && part.providerExecuted !== true && run) {
        run.calls.set(part.id, {
          call: { id: part.id, name: part.name, input: part.input },
          runId: run.runId,
          seq: entry.seq,
        });
      } else if (part.type === 'tool-result') {
        open.delete(part.id);
        run?.calls.delete(part.id);
      }
    }
  }
  return [...open.values()];
}

/** `toolResultEntry` 用的幂等键前缀：同一次调用的结果只记一次，两个 worker 都执行了也只留先到的。 */
export const TOOL_RESULT_KEY_PREFIX = 'ctx.tool-result:';

/** 别处执行完一次工具调用，追加回会话的 `tool` 消息。带幂等键 `ctx.tool-result:<id>`。 */
export function toolResultEntry(
  call: Pick<ToolCall, 'id' | 'name'>,
  output: ToolOutput,
  options: EntryOptions = {},
): NewMessageEntry {
  return messageEntry(
    { role: 'tool', content: [{ type: 'tool-result', id: call.id, name: call.name, output }] },
    { key: `${TOOL_RESULT_KEY_PREFIX}${call.id}`, ...options },
  );
}

// ---- 写日志：围栏 ----

/** 一轮在日志里留下的位置：`isFenced`、`afterConflict` 按它认。 */
export interface RunPosition {
  readonly runId: string;
  /** 这一轮的 `ctx.run.started` 的 `seq`；还没写进去时没有。 */
  readonly started?: number;
  /** 这一轮写进日志的条目（只看 `seq`）。 */
  readonly recorded: readonly Pick<Entry, 'seq'>[];
}

/**
 * 围栏：`lifecycle` 是这一轮的 `ctx.run.started` 起的生命周期事件和擦除记录（`kinds: [ctx.run.started, ctx.run.ended,
 * ctx.erased]`）。自己的 `runId` 已经有 `ctx.run.ended`（被当作断掉的运行收走了）、自己的 `ctx.run.started` 不在了
 * （会话被清掉，或者删到了它）、有 `ctx.erased` 动了这一轮写的条目（`isErased`，`redact` 也算），都是被围栏：这一轮停下，
 * 不再写 `ctx.run.ended`、`ctx.error` 和产出。
 */
export function isFenced(lifecycle: readonly Entry[], run: RunPosition): boolean {
  const mine = lifecycle.filter((entry) => runIdOf(entry) === run.runId);
  if (mine.some((entry) => isEvent(entry, CTX_EVENTS.runEnded))) return true;
  if (run.started !== undefined && !mine.some((entry) => entry.seq === run.started)) return true;
  return lifecycle.some((entry) => {
    const erased = ctxEventData(entry, CTX_EVENTS.erased);
    return erased !== undefined && run.recorded.some((written) => isErased(erased, written.seq));
  });
}

/**
 * 这一轮带 `expectSeq` 的写入冲突了：先读末尾，再读这一轮的 `ctx.run.started` 起的生命周期事件和擦除记录。被围栏
 * （`isFenced`）返回 `undefined`；否则返回新的末尾，带着它重试——别人只是写了应用事件，或者删的是这一轮之前的历史。
 * 两次读之间又有人写，下一次写入会再冲突，再查一遍。`started` 还没有时没有能围栏的，只读末尾。
 */
export async function afterConflict(
  store: Pick<SessionStore, 'list'>,
  session: string,
  run: RunPosition,
): Promise<number | undefined> {
  const head = await headSeq(store, session);
  if (run.started === undefined) return head;
  const lifecycle = await store.list(session, {
    after: run.started - 1,
    kinds: [CTX_EVENTS.runStarted, CTX_EVENTS.runEnded, CTX_EVENTS.erased],
  });
  return isFenced(lifecycle, run) ? undefined : head;
}

// ---- 父子运行 ----

/** 一次子运行在哪：子会话和子运行的 `runId`。 */
export interface ChildRunRef {
  readonly session: string;
  readonly runId: string;
}

/**
 * 派子 agent 的那次工具调用的结果（JSON 输出的 `value`；子运行出错或被取消时是错误输出的 `data`）。`child` 指向子运行，
 * 其余是子运行结果里能序列化、父 agent 用得上的部分。`usage` 是子运行自己的，不含它再派出去的。
 */
export interface ChildRunResult {
  readonly child: ChildRunRef;
  readonly stopReason: StopReason;
  readonly text?: string;
  readonly output?: JsonValue;
  readonly usage?: Usage;
  readonly error?: { readonly message: string; readonly type?: string };
}

/** 父会话那一侧的工具结果：子运行正常结束是 `json`，以 `error` 或 `aborted` 结束是 `error`，两种都带 `ChildRunResult`。 */
export function childRunOutput(child: ChildRunRef, result: Omit<RunResult, 'messages' | 'recorded'>): ToolOutput {
  const value: ChildRunResult = {
    child: { session: child.session, runId: child.runId },
    stopReason: result.stopReason,
    ...(result.text !== '' ? { text: result.text } : {}),
    ...(result.output !== undefined ? { output: result.output } : {}),
    ...(result.usage !== undefined ? { usage: result.usage } : {}),
    ...(result.error !== undefined
      ? {
          error: {
            message: result.error.message,
            ...(result.error.type !== undefined ? { type: result.error.type } : {}),
          },
        }
      : {}),
  };
  if (result.stopReason !== 'error' && result.stopReason !== 'aborted') return { type: 'json', value: toJson(value) };
  const reason = result.error?.message ?? result.stopReason;
  return {
    type: 'error',
    message: `The subagent run in session "${child.session}" ended with ${result.stopReason}: ${reason}`,
    data: toJson(value),
  };
}

function toJson(value: ChildRunResult): JsonValue {
  return value as unknown as JsonValue;
}

function childRunResultOf(value: unknown): ChildRunResult | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { child, stopReason } = value as { child?: unknown; stopReason?: unknown };
  if (typeof child !== 'object' || child === null || typeof stopReason !== 'string') return undefined;
  const { session, runId } = child as { session?: unknown; runId?: unknown };
  if (typeof session !== 'string' || typeof runId !== 'string') return undefined;
  return value as ChildRunResult;
}

/** 父会话里一次派出去的子运行：哪次工具调用、在哪条条目里，和那次调用记下的结果。 */
export interface ChildRun extends ChildRunResult {
  readonly toolCallId: string;
  readonly toolName: string;
  /** 记下这个结果的 `tool` 消息的 `seq`。 */
  readonly seq: number;
}

/** 父会话的条目里派出去的子运行，按出现的顺序。认的是 `childRunOutput` 的形状：`child.session`、`child.runId`、`stopReason`。 */
export function childRunsOf(entries: readonly Entry[]): ChildRun[] {
  const found: ChildRun[] = [];
  for (const entry of entries) {
    if (entry.type !== 'message' || typeof entry.message.content === 'string') continue;
    for (const part of entry.message.content) {
      if (part.type !== 'tool-result') continue;
      const output = part.output;
      const result = childRunResultOf(
        output.type === 'json' ? output.value : output.type === 'error' ? output.data : undefined,
      );
      if (result) found.push({ ...result, toolCallId: part.id, toolName: part.name, seq: entry.seq });
    }
  }
  return found;
}

const USAGE_KEYS = [
  'inputTokens',
  'outputTokens',
  'totalTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'reasoningTokens',
] as const;

/** 把几份用量逐项加起来；哪一项都没有的就不写。父运行连同子运行的总用量：`addUsage(parent.usage, ...childRunsOf(entries).map((run) => run.usage))`。 */
export function addUsage(...usages: readonly (Usage | undefined)[]): Usage {
  const sum: Partial<Record<(typeof USAGE_KEYS)[number], number>> = {};
  for (const usage of usages) {
    if (!usage) continue;
    for (const key of USAGE_KEYS) {
      const value = usage[key];
      if (typeof value === 'number') sum[key] = (sum[key] ?? 0) + value;
    }
  }
  return sum;
}
