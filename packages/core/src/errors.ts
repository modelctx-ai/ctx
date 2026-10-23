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
