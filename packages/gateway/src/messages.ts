import type { MessageEntry } from '@modelctx-ai/ctx-protocol';

type ModelMessage = MessageEntry['message'];

/** OpenAI Chat Completions 消息里网关会碰到的部分，其余字段原样透传。 */
export type ChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: string } }
  | { type: string; [key: string]: unknown };

export interface ChatToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: 'system' | 'developer' | 'user' | 'assistant' | 'tool';
  content?: string | ChatContentPart[] | null;
  name?: string;
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
  [key: string]: unknown;
}

export interface ChatCompletionRequest {
  model?: string;
  messages: ChatMessage[];
  stream?: boolean;
  [key: string]: unknown;
}

/** 消息里的纯文字：字符串原样，分段只取文字段。 */
export function chatText(content: ChatMessage['content']): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => (part.type === 'text' && typeof part.text === 'string' ? part.text : '')).join('');
}

function base64(data: Uint8Array | ArrayBuffer): string {
  return Buffer.from(data instanceof ArrayBuffer ? new Uint8Array(data) : data).toString('base64');
}

type InlineData = string | Uint8Array | ArrayBuffer | URL;

/**
 * 取出能内联的数据：裸数据、URL，或者 AI SDK v7 带标签的 `{ type: 'data' }`、`{ type: 'url' }`。
 * 服务商侧的文件引用（上传后的 id）对方不认，返回 undefined。
 */
function inlineOf(data: unknown): InlineData | undefined {
  if (typeof data === 'string' || data instanceof Uint8Array || data instanceof ArrayBuffer || data instanceof URL) {
    return data;
  }
  if (!data || typeof data !== 'object') return undefined;
  const tagged = data as { type?: unknown; data?: unknown; url?: unknown };
  if (tagged.type === 'data') {
    const inner = tagged.data;
    return typeof inner === 'string' || inner instanceof Uint8Array || inner instanceof ArrayBuffer ? inner : undefined;
  }
  if (tagged.type === 'url') {
    if (tagged.url instanceof URL) return tagged.url;
    if (typeof tagged.url === 'string' && URL.canParse(tagged.url)) return new URL(tagged.url);
  }
  return undefined;
}

function isImage(mediaType: string | undefined): boolean {
  const type = mediaType?.toLowerCase();
  return type === 'image' || type?.startsWith('image/') === true;
}

/** data URL 里的类型：`image`、`image/*` 这种只到大类的写法用 image/png。 */
function imageType(mediaType: string | undefined): string {
  return mediaType && /^image\/[^*\s]+$/i.test(mediaType) ? mediaType : 'image/png';
}

/** AI SDK 的图片/文件数据转成 OpenAI 能收的地址：URL 原样，二进制和 base64 变成 data URL。 */
function urlOf(data: InlineData, mediaType: string | undefined): string {
  if (data instanceof URL) return data.href;
  if (typeof data === 'string') {
    if (/^(https?:|data:)/i.test(data)) return data;
    return `data:${imageType(mediaType)};base64,${data}`;
  }
  return `data:${imageType(mediaType)};base64,${base64(data)}`;
}

function imagePart(data: unknown, mediaType: string | undefined): ChatContentPart | undefined {
  const inline = inlineOf(data);
  return inline === undefined ? undefined : { type: 'image_url', image_url: { url: urlOf(inline, mediaType) } };
}

/** 标量转成文字；null、undefined 和函数之类转不出有意义文字的给空串，对象交给调用方。 */
function scalarText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  return '';
}

function outputText(output: unknown): string {
  if (!output || typeof output !== 'object') return scalarText(output);
  const typed = output as { type?: string; value?: unknown; reason?: string };
  switch (typed.type) {
    case 'text':
    case 'error-text':
      return typeof typed.value === 'object' && typed.value !== null
        ? JSON.stringify(typed.value)
        : scalarText(typed.value);
    case 'json':
    case 'error-json':
      return JSON.stringify(typed.value);
    case 'content':
      return Array.isArray(typed.value)
        ? typed.value
            .map((part: { type?: string; text?: string }) => (part.type === 'text' ? (part.text ?? '') : ''))
            .join('')
        : '';
    case 'execution-denied':
      return typed.reason ? `Tool execution denied: ${typed.reason}` : 'Tool execution denied.';
    default:
      return JSON.stringify(output);
  }
}

/** AI SDK 的消息转成 OpenAI Chat Completions 的消息。推理过程、审批等对方不认的部分丢掉。 */
export function toChatMessages(messages: readonly ModelMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const message of messages) {
    switch (message.role) {
      case 'system':
        out.push({ role: 'system', content: message.content });
        break;
      case 'user': {
        if (typeof message.content === 'string') {
          out.push({ role: 'user', content: message.content });
          break;
        }
        const parts: ChatContentPart[] = [];
        for (const part of message.content) {
          if (part.type === 'text') {
            parts.push({ type: 'text', text: part.text });
            continue;
          }
          const image =
            part.type === 'image'
              ? imagePart(part.image, part.mediaType)
              : part.type === 'file' && isImage(part.mediaType)
                ? imagePart(part.data, part.mediaType)
                : undefined;
          if (image) parts.push(image);
        }
        if (parts.length > 0) out.push({ role: 'user', content: parts });
        break;
      }
      case 'assistant': {
        if (typeof message.content === 'string') {
          out.push({ role: 'assistant', content: message.content });
          break;
        }
        let text = '';
        const calls: ChatToolCall[] = [];
        for (const part of message.content) {
          if (part.type === 'text') text += part.text;
          else if (part.type === 'tool-call' && !part.providerExecuted) {
            calls.push({
              id: part.toolCallId,
              type: 'function',
              function: { name: part.toolName, arguments: JSON.stringify(part.input ?? {}) },
            });
          }
        }
        if (!text && calls.length === 0) break;
        out.push({ role: 'assistant', content: text || null, ...(calls.length > 0 ? { tool_calls: calls } : {}) });
        break;
      }
      case 'tool':
        for (const part of message.content) {
          if (part.type !== 'tool-result') continue;
          out.push({ role: 'tool', tool_call_id: part.toolCallId, content: outputText(part.output) });
        }
        break;
    }
  }
  return out;
}
