import { isContextOverflow } from '@modelctx-ai/ctx-protocol';
import { APICallError, RetryError } from 'ai';

export interface ErrorDescription {
  readonly message: string;
  /** 上游接口的 HTTP 状态码（有的话）。 */
  readonly status?: number;
  /** 上游返回的正文片段，已去掉密钥、截短。 */
  readonly detail?: string;
}

/** 把出现在文本里的密钥换成 `***`。 */
export function redact(text: string, secrets: readonly (string | undefined)[] = []): string {
  let out = text;
  for (const secret of secrets) {
    if (secret && secret.length >= 4) out = out.replaceAll(secret, '***');
  }
  return out;
}

/** 给日志和界面用的错误摘要：重试错误取最后一次，接口错误带上状态码和正文片段。 */
export function describeError(
  error: unknown,
  options: { readonly secrets?: readonly (string | undefined)[]; readonly max?: number } = {},
): ErrorDescription {
  const max = options.max ?? 180;
  const clean = (text: string): string => redact(text, options.secrets).replace(/\s+/g, ' ').trim().slice(0, max);
  const root = RetryError.isInstance(error) ? error.lastError : error;
  if (APICallError.isInstance(root)) {
    const detail = clean(root.responseBody ?? '');
    return {
      message: clean(root.message),
      ...(root.statusCode !== undefined ? { status: root.statusCode } : {}),
      ...(detail ? { detail } : {}),
    };
  }
  if (root instanceof Error) return { message: clean(root.message) };
  return { message: clean(String(root)) };
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

function stringOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

/**
 * 这个错误是不是「上下文超过了模型的窗口」。认三种：已经标成 `context_overflow` 的（`CtxError`、`ErrorInfo`、
 * 远端客户端转出来的错误）；HTTP 413；消息、响应正文或解析出来的错误数据里有各服务商常见的写法。
 * 重试错误看最后一次。401、403、404、429 一律不算。**各服务商的错误形状没有对真实服务验证。**
 */
export function isContextOverflowError(error: unknown): boolean {
  const root = RetryError.isInstance(error) ? error.lastError : error;
  if (isContextOverflow(root)) return true;
  let text: string;
  if (APICallError.isInstance(root)) {
    if (root.statusCode !== undefined && NOT_OVERFLOW_STATUS.has(root.statusCode)) return false;
    if (root.statusCode === 413) return true;
    text = `${root.message}\n${root.responseBody ?? ''}\n${stringOf(root.data)}`;
  } else if (root instanceof Error) {
    text = root.message;
  } else {
    return false;
  }
  return OVERFLOW_PATTERNS.some((pattern) => pattern.test(text));
}
