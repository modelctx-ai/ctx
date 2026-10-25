import type { LanguageModel, ModelMessage, UserContent } from 'ai';

import type { PreparedCall, WindowOptions } from './context.ts';
import type { Entry } from './session.ts';
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
  readonly settings?: CallSettings;
}

/** 模型名的字符串写法：进程内的 `LanguageModel` 记成 `<provider>/<modelId>`。 */
export function modelName(model: ModelRef): string {
  if (typeof model === 'string') return model;
  return `${model.provider}/${model.modelId}`;
}

/** `AgentSpec` 的可序列化部分，`ctx.run.started` 的 `data.agent` 用它。 */
export function agentSpecToJson(spec: AgentSpec): JsonObject {
  const out: Record<string, unknown> = { model: modelName(spec.model) };
  if (spec.name !== undefined) out['name'] = spec.name;
  if (spec.instructions !== undefined) out['instructions'] = spec.instructions;
  if (spec.tools !== undefined) out['tools'] = spec.tools;
  if (spec.maxSteps !== undefined) out['maxSteps'] = spec.maxSteps;
  if (spec.window !== undefined) out['window'] = spec.window;
  if (spec.settings !== undefined) out['settings'] = spec.settings;
  return out as JsonObject;
}

export interface RunRequest {
  readonly session: string;
  readonly agent: AgentSpec;
  /** 这一轮用户新说的话。记录时在调用模型前写进日志。 */
  readonly input?: UserContent;
  /** 输入的幂等键：失败后用同一个键重试，不会再记一遍。 */
  readonly inputKey?: string;
  /** 放在最后的临时用户消息，不写日志。 */
  readonly prompt?: UserContent;
  /** 把输入、产出和 `ctx.run.*` 写进日志，缺省写。 */
  readonly record?: boolean;
  /** 不给就由 harness 生成。 */
  readonly runId?: string;
  readonly signal?: AbortSignal;
}

/**
 * 一轮为什么停：`end_turn` 模型自己停下，`max_steps` 到了步数上限，`max_tokens` 输出被 `maxOutputTokens` 截断，
 * `aborted` 被取消，`error` 出错。
 */
export type StopReason = 'end_turn' | 'max_steps' | 'max_tokens' | 'aborted' | 'error';

export interface Usage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
}

export interface RunResult {
  readonly runId: string;
  /** 最后一步的文字。 */
  readonly text: string;
  /** 这一轮模型产出的消息（含工具调用和结果）。 */
  readonly messages: ModelMessage[];
  /** 实际写进日志的条目。 */
  readonly recorded: readonly Entry[];
  readonly stopReason: StopReason;
  readonly usage?: Usage;
  /** `stopReason` 是 `error` 时的原因。 */
  readonly error?: ErrorInfo;
}

/** 流式运行的事件。`text.delta` 不落日志，其余各有对应的日志条目。 */
export type RunEvent =
  | { readonly type: 'run.started'; readonly runId: string; readonly session: string }
  | { readonly type: 'model.started'; readonly runId: string; readonly step: number }
  | { readonly type: 'text.delta'; readonly runId: string; readonly text: string }
  | { readonly type: 'tool.called'; readonly runId: string; readonly call: ToolCall }
  | { readonly type: 'tool.returned'; readonly runId: string; readonly callId: string; readonly output: ToolOutput }
  | { readonly type: 'model.ended'; readonly runId: string; readonly step: number; readonly usage?: Usage }
  | { readonly type: 'run.ended'; readonly runId: string; readonly result: Omit<RunResult, 'messages' | 'recorded'> }
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
