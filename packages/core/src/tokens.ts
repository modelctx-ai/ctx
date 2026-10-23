import type { ModelMessage, ToolResultPart } from 'ai';

/** 每条消息的格式开销，按常见聊天模板粗估。 */
const MESSAGE_OVERHEAD = 4;
/** 图片、文件这类非文字内容，按一张中等图片粗估。 */
const ATTACHMENT_TOKENS = 256;

function isWide(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x20000 && code <= 0x3fffd)
  );
}

/**
 * 不依赖分词器的估算：中日韩文字一个字约一个 token，其余字符约四个一个。
 * 用来做预算和裁剪，不用来计费。
 */
export function estimateTextTokens(text: string): number {
  let wide = 0;
  let other = 0;
  for (const char of text) {
    if (isWide(char.codePointAt(0) ?? 0)) wide += 1;
    else other += 1;
  }
  return wide + Math.ceil(other / 4);
}

function estimateValue(value: unknown): number {
  if (value === undefined) return 0;
  if (typeof value === 'string') return estimateTextTokens(value);
  try {
    return estimateTextTokens(JSON.stringify(value) ?? '');
  } catch {
    return 0;
  }
}

/** 工具结果里的图片、文件按附件定额算，不去数 base64。 */
function estimateOutput(output: ToolResultPart['output']): number {
  if (output.type !== 'content' || !Array.isArray(output.value)) return estimateValue(output);
  let total = 0;
  for (const part of output.value) {
    if (part.type === 'text') total += estimateTextTokens(part.text);
    else if (part.type !== 'custom') total += ATTACHMENT_TOKENS;
  }
  return total;
}

export function estimateTokens(message: ModelMessage): number {
  const { content } = message;
  if (typeof content === 'string') return MESSAGE_OVERHEAD + estimateTextTokens(content);
  let total = MESSAGE_OVERHEAD;
  for (const part of content) {
    switch (part.type) {
      case 'text':
      case 'reasoning':
        total += estimateTextTokens(part.text);
        break;
      case 'tool-call':
        total += estimateTextTokens(part.toolName) + estimateValue(part.input);
        break;
      case 'tool-result':
        total += estimateTextTokens(part.toolName) + estimateOutput(part.output);
        break;
      default:
        total += ATTACHMENT_TOKENS;
    }
  }
  return total;
}
