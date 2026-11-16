import type { LanguageModel } from 'ai';

import type { Message, MessageContent } from './message.ts';
import type { ContextSpec, PreparedCall, WindowOptions } from './context.ts';
import { CTX_EVENTS, messageEntry, type Entry, type EntryOptions, type NewMessageEntry } from './session.ts';
import type { ExecutionContext, ToolCall, ToolOutput, ToolSelection } from './tools.ts';
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
  readonly signal?: AbortSignal;
}

/**
 * 一轮为什么停：`end_turn` 模型自己停下，`max_steps` 到了步数上限，`max_tokens` 输出被 `maxOutputTokens` 截断，
 * `requires_action` 留下了要在别处执行的工具调用（`RunResult.pending`），等结果追加进日志后不带输入再跑一轮接着走，
 * `aborted` 被取消，`error` 出错。
 */
export type StopReason = 'end_turn' | 'max_steps' | 'max_tokens' | 'requires_action' | 'aborted' | 'error';

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
}

/** 条目 `meta.step` 里的 `StepMeta`；不是 harness 写的步骤消息时返回 `undefined`。 */
export function stepMetaOf(entry: Entry): StepMeta | undefined {
  const step = entry.meta?.['step'];
  if (typeof step !== 'object' || step === null || Array.isArray(step)) return undefined;
  const { runId, step: index } = step as Record<string, unknown>;
  return typeof runId === 'string' && typeof index === 'number' ? (step as unknown as StepMeta) : undefined;
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
    if (entry.type === 'event' && (entry.kind === CTX_EVENTS.runStarted || entry.kind === CTX_EVENTS.runEnded)) {
      const data = (entry.data ?? {}) as { runId?: unknown; stopReason?: unknown };
      if (typeof data.runId !== 'string') continue;
      if (entry.kind === CTX_EVENTS.runStarted) {
        run = { runId: data.runId, calls: new Map() };
        continue;
      }
      // 这一轮停下来等结果：它留下的调用等待中；别的结束方式让之前等着的都作废。
      open = data.stopReason === 'requires_action' && run?.runId === data.runId ? new Map(run.calls) : new Map();
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
