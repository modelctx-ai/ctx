export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type Awaitable<T> = T | PromiseLike<T>;

/** 框架只在这两处出声：可选的调试信息，和不打断流程的告警。 */
export interface Logger {
  debug?(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
}

export const silentLogger: Logger = { warn() {} };

/**
 * 跨进程边界时错误的形状：`{ error: ErrorInfo }`。进程内照常抛 `Error`。
 * `type` 是机器可读的类别（例如 `not_found`、`timeout`、`context_overflow`），`message` 写给人看。错误来自上游的 HTTP 接口时，
 * `statusCode` 是上游响应的状态码，`responseBody` 是响应正文原文（不解析，可能很长，只当诊断信息用）。
 */
export interface ErrorInfo {
  readonly message: string;
  readonly type?: string;
  readonly retryable?: boolean;
  readonly statusCode?: number;
  readonly responseBody?: string;
}

/**
 * 协议层认得的错误：`type` 是机器可读的类别，和 `ErrorInfo.type` 同一套（例如 `unsupported_version`、
 * `unsupported_part`）。`name` 也设成它，harness 把错误写进 `ctx.error` 和 `RunResult.error` 时沿用。
 */
export class CtxError extends Error {
  readonly type: string;
  /** 重试可能成功（例如 `conflict`、`session_busy`）；harness 写进 `ErrorInfo.retryable`。 */
  readonly retryable?: boolean;

  constructor(type: string, message: string, options: { readonly retryable?: boolean } = {}) {
    super(message);
    this.name = type;
    this.type = type;
    if (options.retryable !== undefined) this.retryable = options.retryable;
  }
}

/** 上下文超过了模型的窗口：`ErrorInfo.type`、`CtxError.type` 的值。 */
export const CONTEXT_OVERFLOW = 'context_overflow';

/**
 * 是不是 `context_overflow`：本地的 `CtxError`、`RunResult.error`（`ErrorInfo`）和远端客户端转出来的错误都认
 * （只看 `type`）。服务商原始的错误认不认得是 harness 实现的事。
 */
export function isContextOverflow(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { type?: unknown }).type === CONTEXT_OVERFLOW;
}

/**
 * 各服务商说「上下文过长」的常见写法（错误码和消息）。AI SDK 没有专门的错误类型，只能看文字。
 * **没有对真实服务验证**：是按各家文档和常见的报错整理的，认不出来的照旧是普通的接口错误。
 */
const OVERFLOW_PATTERNS: readonly RegExp[] = [
  // OpenAI、Azure OpenAI、Groq 等的 `error.code`
  /context[_ ]length[_ ]exceeded/i,
  // 代理层（LiteLLM 等）的错误名、Anthropic 的 `model_context_window_exceeded`
  /context[_ ]?window[_ ]?exceeded/i,
  // OpenAI 兼容接口、OpenRouter、Mistral、vLLM：「This model's maximum context length is N tokens」
  /maximum context length/i,
  // 「exceeds the context window」「exceed context limit」「exceeds the available context size」
  /exceed(s|ed|ing)?\b[^.\n]{0,60}\bcontext[ _](window|length|size|limit)/i,
  /context[ _](window|length|size|limit)[^.\n]{0,60}\bexceed/i,
  // Anthropic：「prompt is too long: N tokens > M maximum」
  /prompt is too long/i,
  // Amazon Bedrock：「Input is too long for requested model」
  /input is too long/i,
  // Google：「The input token count (N) exceeds the maximum number of tokens allowed (M)」
  /input token count[^.\n]{0,40}exceeds/i,
  // xAI：「This model's maximum prompt length is N but the request contains M tokens」
  /maximum prompt length/i,
  // Cohere：「too many tokens」
  /too many (input )?tokens/i,
  // OpenAI、Groq：「Please reduce the length of the messages」
  /reduce the length of (the|your) (messages|prompt|input)/i,
  // Anthropic 的 413
  /request_too_large/i,
];

/** 状态码说明这不是长度的问题：鉴权、找不到、限流（「too many tokens per minute」是限流，不是超窗）。 */
const NOT_OVERFLOW_STATUS: ReadonlySet<number> = new Set([401, 403, 404, 429]);

/**
 * 服务商的报错文字（和 HTTP 状态码）是不是在说「上下文超过了模型的窗口」：413 算；401、403、404、429 不算；其余看文字里
 * 有没有各家常见的写法。harness 和适配器拿上游的原始错误时用它定 `context_overflow`。
 * **各服务商的写法没有对真实服务验证。**
 */
export function isContextOverflowText(text: string, status?: number): boolean {
  if (status !== undefined && NOT_OVERFLOW_STATUS.has(status)) return false;
  if (status === 413) return true;
  return OVERFLOW_PATTERNS.some((pattern) => pattern.test(text));
}
