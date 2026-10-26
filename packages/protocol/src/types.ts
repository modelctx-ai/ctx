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
 * `type` 是机器可读的类别（例如 `not_found`、`timeout`），`message` 写给人看。
 */
export interface ErrorInfo {
  readonly message: string;
  readonly type?: string;
  readonly retryable?: boolean;
}
