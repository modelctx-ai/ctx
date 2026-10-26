/**
 * 线上的 JSON：服务端和客户端共用。不用 `node:` 模块，任何运行时都能跑。
 *
 * 协议的值全是纯 JSON（消息里的二进制是 base64 字符串，URL 是字符串），所以直接 `JSON.stringify` / `JSON.parse`，
 * 没有编码。0.2 及以前把二进制和 `URL` 换成带 `\u0000ctx` 标记的对象，新旧版本不能混用：两头要一起升级。
 */
import type { ErrorInfo, RunRequest } from '@modelctx-ai/ctx-protocol';

export function stringify(value: unknown): string {
  return JSON.stringify(value);
}

/** 解析出来的值不经校验，调用方按约定的形状用。 */
export function parse(text: string): unknown {
  return JSON.parse(text);
}

/** 错误正文 `{ error: ErrorInfo }`，HTTP 错误响应和 NDJSON 流里出错的那一行都是它。 */
export interface ErrorBody {
  readonly error: ErrorInfo;
}

export function isErrorBody(value: unknown): value is ErrorBody {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || 'type' in value) return false;
  const error = (value as { error?: unknown }).error;
  return typeof error === 'object' && error !== null && typeof (error as { message?: unknown }).message === 'string';
}

/** 远端返回的错误：协议的 `ErrorInfo` 加 HTTP 状态码。 */
export interface RemoteError extends Error {
  readonly status: number;
  readonly type?: string;
  readonly retryable?: boolean;
  readonly statusCode?: number;
  readonly responseBody?: string;
}

export function remoteError(status: number, info: ErrorInfo): RemoteError {
  const error = new Error(info.message) as Error & {
    status: number;
    type?: string;
    retryable?: boolean;
    statusCode?: number;
    responseBody?: string;
  };
  error.name = 'RemoteError';
  error.status = status;
  if (info.type !== undefined) error.type = info.type;
  if (info.retryable !== undefined) error.retryable = info.retryable;
  if (info.statusCode !== undefined) error.statusCode = info.statusCode;
  if (info.responseBody !== undefined) error.responseBody = info.responseBody;
  return error;
}

export function isRemoteError(error: unknown): error is RemoteError {
  return error instanceof Error && typeof (error as { status?: unknown }).status === 'number';
}

/** `RunRequest` 去掉 `signal`，模型只能是名字；`aborted` 表示调用方的 `signal` 在发出前已经中止。 */
export type WireRunRequest = Omit<RunRequest, 'signal'> & { readonly aborted?: boolean };

/** 一段路径：会话名、执行环境名、runId 都可能含 `/`、`:` 之类，统一转义。 */
export function segment(value: string): string {
  return encodeURIComponent(value);
}
