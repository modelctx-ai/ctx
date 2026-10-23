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
