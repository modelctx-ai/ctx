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
