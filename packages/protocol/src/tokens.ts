import type { Message } from './message.ts';
import type { ToolFileData, ToolOutput } from './tools.ts';

/** 每条消息的格式开销，按常见聊天模板粗估。 */
const MESSAGE_OVERHEAD = 4;
/** 大小不知道的附件（地址、服务商的文件引用）和小图，按一张小图粗估。 */
const ATTACHMENT_TOKENS = 256;
/** 大图：服务商会先缩到一两千像素宽再算，各家的上限在一千多 token。 */
const LARGE_IMAGE_TOKENS = 1600;
/** base64 解出来超过这么多字节的图片算大图。 */
const LARGE_IMAGE_BYTES = 64 * 1024;
/** PDF 这类文档每多少字节约一个 token：按文字加版面粗估，只为让大文件不被当成一张小图。 */
const DOCUMENT_BYTES_PER_TOKEN = 20;

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
 * 不依赖分词器的估算：中日韩文字一个字约一个 token，ASCII 约四个字符一个，
 * 其余文字（西里尔、阿拉伯、泰文、表情……）约两个字符一个，补充平面的表情一个算两个。
 * 用来做预算和裁剪，不用来计费。
 */
export function estimateTextTokens(text: string): number {
  let wide = 0;
  let ascii = 0;
  let other = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (isWide(code)) wide += 1;
    else if (code < 0x80) ascii += 1;
    else other += code > 0xffff ? 4 : 1;
  }
  return wide + Math.ceil(ascii / 4) + Math.ceil(other / 2);
}

/**
 * 附件的估算。内联文字按字数；base64 按解出来的大小：图片分小图、大图两档，文本类按字节，
 * 别的文档按 `DOCUMENT_BYTES_PER_TOKEN`；地址和服务商的文件引用不知道大小，按一张小图。
 */
export function estimateFileTokens(mediaType: string, data: ToolFileData): number {
  if (data.type === 'text') return estimateTextTokens(data.text);
  if (data.type !== 'data') return ATTACHMENT_TOKENS;
  const padding = data.data.endsWith('==') ? 2 : data.data.endsWith('=') ? 1 : 0;
  const bytes = Math.max(0, Math.floor((data.data.length * 3) / 4) - padding);
  const type = mediaType.toLowerCase();
  if (type.startsWith('image')) return bytes > LARGE_IMAGE_BYTES ? LARGE_IMAGE_TOKENS : ATTACHMENT_TOKENS;
  if (type.startsWith('text/') || type.includes('json') || type.includes('xml')) return Math.ceil(bytes / 4);
  return Math.max(ATTACHMENT_TOKENS, Math.ceil(bytes / DOCUMENT_BYTES_PER_TOKEN));
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

/** 工具结果里的图片、文件按 `estimateFileTokens` 算。 */
function estimateOutput(output: ToolOutput): number {
  switch (output.type) {
    case 'text':
      return estimateTextTokens(output.text);
    case 'json':
      return estimateValue(output.value);
    case 'error':
      return estimateTextTokens(output.message) + estimateValue(output.data);
    default: {
      let total = 0;
      for (const part of output.parts)
        total += part.type === 'text' ? estimateTextTokens(part.text) : estimateFileTokens(part.mediaType, part.data);
      return total;
    }
  }
}

export function estimateTokens(message: Message): number {
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
        total += estimateTextTokens(part.name) + estimateValue(part.input);
        break;
      case 'tool-result':
        total += estimateTextTokens(part.name) + estimateOutput(part.output);
        break;
      case 'file':
      case 'reasoning-file':
        total += estimateFileTokens(part.mediaType, part.data);
        break;
      default:
        total += ATTACHMENT_TOKENS;
    }
  }
  return total;
}
