/**
 * 线上的 JSON：服务端和客户端共用。不用 `node:` 模块，任何运行时都能跑。
 *
 * 协议的值大多是纯 JSON，只有消息里的二进制和 `URL` 不是。序列化之前把它们换成带标记的对象，解析时只认恰好是
 * 这个形状的对象（和 `ctx-sqlite` 存盘时的写法一样）：
 *
 * - `Uint8Array`、`Buffer`、`ArrayBuffer` 和其他 TypedArray → `{"\u0000ctx": "bytes", "base64": "…"}`，读回来是 `Uint8Array`；
 * - `URL` → `{"\u0000ctx": "url", "href": "…"}`，读回来还是 `URL`。
 */
import type { ErrorInfo, RunRequest } from '@modelctx-ai/ctx-protocol';

/** 编码标记用的键，正常数据里不会出现。 */
const TAG = '\u0000ctx';

function toBase64(view: ArrayBufferView | ArrayBuffer): string {
  const bytes =
    view instanceof ArrayBuffer ? new Uint8Array(view) : new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * 必须在 `JSON.stringify` 之前做：它会先调 `toJSON`，Buffer 和 URL 到了 replacer 里已经变了样。
 * `undefined` 的字段照 JSON 的规矩丢掉。
 */
function encode(value: unknown, parents: Set<object>): unknown {
  if (value instanceof URL) return { [TAG]: 'url', href: value.href };
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return { [TAG]: 'bytes', base64: toBase64(value) };
  if (value === null || typeof value !== 'object' || typeof (value as { toJSON?: unknown }).toJSON === 'function') {
    return value;
  }
  if (parents.has(value)) throw new TypeError('Cannot send a circular structure.');
  parents.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => encode(item, parents));
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = encode(item, parents);
    return out;
  } finally {
    parents.delete(value);
  }
}

/** 只认恰好是编码结果的对象；别的对象（包括 `{ $url }`、`{ $bytes }` 这种）原样返回。 */
function reviver(_key: string, value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const tagged = value as Record<string, unknown>;
  const keys = Object.keys(tagged);
  if (keys.length !== 2 || !keys.includes(TAG)) return value;
  if (tagged[TAG] === 'bytes' && typeof tagged['base64'] === 'string') return fromBase64(tagged['base64']);
  if (tagged[TAG] === 'url' && typeof tagged['href'] === 'string' && URL.canParse(tagged['href'])) {
    return new URL(tagged['href']);
  }
  return value;
}

export function stringify(value: unknown): string {
  return JSON.stringify(encode(value, new Set()));
}

/** 解析出来的值不经校验，调用方按约定的形状用。 */
export function parse(text: string): unknown {
  return JSON.parse(text, reviver);
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
