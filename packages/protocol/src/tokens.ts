import type { AssistantPart, Message, ToolPart, UserPart } from './message.ts';
import type { ToolContentPart, ToolFileData, ToolOutput } from './tools.ts';

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

// ---- 截短 ----

/** 中间省略了多少，写给模型看。 */
function omissionNote(omitted: number): string {
  return `\n[… ${omitted} characters omitted to fit the context window …]\n`;
}

/** 留头和尾各一段，中间换成说明；不把一对代理项切成两半。`keep` 是留下的字符数（UTF-16 码元）。 */
function clipMiddle(text: string, keep: number): string {
  let head = Math.ceil((keep * 2) / 3);
  let tail = text.length - (keep - head);
  const before = text.charCodeAt(head - 1);
  if (head > 0 && before >= 0xd800 && before <= 0xdbff) head -= 1;
  const after = text.charCodeAt(tail);
  if (tail < text.length && after >= 0xdc00 && after <= 0xdfff) tail += 1;
  return `${text.slice(0, head)}${omissionNote(tail - head)}${text.slice(tail)}`;
}

/**
 * 把一段文字截到估算不超过 `maxTokens`：留头（约三分之二）和尾，中间换成一句写明省略了多少字符的说明。
 * 没超的原样返回。预算小到连说明都放不下时只剩说明，这时结果仍可能超过 `maxTokens`。
 * `estimate` 缺省是 `estimateTextTokens`；截短一条消息里的一段时，可以传「换上这段文字之后整条消息多大」。
 */
export function truncateText(
  text: string,
  maxTokens: number,
  estimate: (text: string) => number = estimateTextTokens,
): string {
  if (estimate(text) <= maxTokens) return text;
  let low = 0;
  let high = Math.max(0, text.length - 1);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (estimate(clipMiddle(text, middle)) <= maxTokens) low = middle;
    else high = middle - 1;
  }
  return clipMiddle(text, low);
}

/** 内联的文件（base64、文字）换成的那句说明；地址和服务商引用本来就不占地方，不换。 */
function omittedFile(mediaType: string): string {
  return `[${mediaType} file omitted: too large for the context window]`;
}

function isInlineFile(data: ToolFileData): boolean {
  return data.type === 'data' || data.type === 'text';
}

type AnyPart = UserPart | AssistantPart | ToolPart;

/** 一个部件里能截的文字有多少（估算），不能截的是 0。用来挑先截哪个。 */
function shrinkable(part: AnyPart): number {
  switch (part.type) {
    case 'text':
      return estimateTextTokens(part.text);
    case 'file':
      return isInlineFile(part.data) ? estimateFileTokens(part.mediaType, part.data) : 0;
    case 'tool-result':
      return estimateOutput(part.output);
    default:
      return 0;
  }
}

/** 工具结果里内联的文件换成说明，文字留着。 */
function withoutInlineFiles(parts: readonly ToolContentPart[]): ToolContentPart[] {
  return parts.map((part) =>
    part.type === 'file' && isInlineFile(part.data) ? { type: 'text', text: omittedFile(part.mediaType) } : part,
  );
}

/** 工具结果写成一段文字，截短时用。 */
function outputAsText(output: ToolOutput): string {
  switch (output.type) {
    case 'text':
      return output.text;
    case 'json':
      return JSON.stringify(output.value) ?? 'null';
    case 'error':
      return output.message;
    default:
      return withoutInlineFiles(output.parts)
        .map((part) => (part.type === 'text' ? part.text : `[${part.mediaType} file]`))
        .join('\n');
  }
}

/**
 * 把一条消息截到 `estimate(message)` 不超过 `maxTokens`，尽力而为：从最大的部件截起，文字留头尾，工具结果
 * 先把内联的文件换成说明、再把内容写成文字截短（错误结果只截信息、去掉 `data`），内联的文件换成一句说明。
 * 推理、工具调用的输入、服务商自定义内容、批准请求不动：截了它们，签名对不上或者调用不再合法。
 * 所以结果仍可能超过 `maxTokens`。没超的原样返回（同一个对象）。
 */
export function truncateMessage(
  message: Message,
  maxTokens: number,
  estimate: (message: Message) => number = estimateTokens,
): Message {
  if (estimate(message) <= maxTokens) return message;
  if (typeof message.content === 'string') {
    const fit = (text: string): number => estimate({ ...message, content: text } as Message);
    return { ...message, content: truncateText(message.content, maxTokens, fit) } as Message;
  }
  const parts: AnyPart[] = [...message.content];
  const rebuilt = (): Message => ({ ...message, content: parts }) as Message;
  const done = new Set<number>();
  while (estimate(rebuilt()) > maxTokens) {
    let index = -1;
    let size = 0;
    for (let i = 0; i < parts.length; i += 1) {
      const candidate = done.has(i) ? 0 : shrinkable(parts[i]!);
      if (candidate > size) {
        size = candidate;
        index = i;
      }
    }
    if (index < 0) break;
    done.add(index);
    const part = parts[index]!;
    const replaced = (next: AnyPart): number => {
      const copy = [...parts];
      copy[index] = next;
      return estimate({ ...message, content: copy } as Message);
    };
    if (part.type === 'text') {
      parts[index] = { ...part, text: truncateText(part.text, maxTokens, (text) => replaced({ ...part, text })) };
    } else if (part.type === 'file') {
      parts[index] = { type: 'text', text: omittedFile(part.mediaType) };
    } else if (part.type === 'tool-result') {
      const { output } = part;
      if (output.type === 'content') {
        // 先只去掉内联的文件：够了就不动文字。
        const lighter: ToolOutput = { type: 'content', parts: withoutInlineFiles(output.parts) };
        if (replaced({ ...part, output: lighter }) <= maxTokens) {
          parts[index] = { ...part, output: lighter };
          continue;
        }
      }
      const wrap = (text: string): ToolOutput =>
        output.type === 'error'
          ? { type: 'error', message: text, ...(output.retryable !== undefined ? { retryable: output.retryable } : {}) }
          : { type: 'text', text };
      const text = truncateText(outputAsText(output), maxTokens, (candidate) =>
        replaced({ ...part, output: wrap(candidate) }),
      );
      parts[index] = { ...part, output: wrap(text) };
    }
  }
  return rebuilt();
}
