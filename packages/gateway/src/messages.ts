import type { Message, ToolFileData, ToolOutput } from '@modelctx-ai/ctx-protocol';

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

function isImage(mediaType: string | undefined): boolean {
  const type = mediaType?.toLowerCase();
  return type === 'image' || type?.startsWith('image/') === true;
}

/** data URL 里的类型：`image`、`image/*` 这种只到大类的写法用 image/png。 */
function imageType(mediaType: string | undefined): string {
  return mediaType && /^image\/[^*\s]+$/i.test(mediaType) ? mediaType : 'image/png';
}

/**
 * 文件数据转成 OpenAI 能收的地址：地址原样（`data:` 和 `http(s):` 之外的当相对地址，也原样），
 * base64 变成 data URL。服务商侧的文件引用和内联文字对方不认，返回 undefined。
 */
function urlOf(data: ToolFileData, mediaType: string | undefined): string | undefined {
  if (data.type === 'url') return data.url;
  if (data.type === 'data') return `data:${imageType(mediaType)};base64,${data.data}`;
  return undefined;
}

function imagePart(data: ToolFileData, mediaType: string | undefined): ChatContentPart | undefined {
  const url = urlOf(data, mediaType);
  return url === undefined ? undefined : { type: 'image_url', image_url: { url } };
}

function outputText(output: ToolOutput): string {
  switch (output.type) {
    case 'text':
      return output.text;
    case 'json':
      return JSON.stringify(output.value);
    case 'error':
      return output.message;
    default:
      return output.parts.map((part) => (part.type === 'text' ? part.text : '')).join('');
  }
}

/** ctx 的消息转成 OpenAI Chat Completions 的消息。推理过程、审批等对方不认的部分丢掉。 */
export function toChatMessages(messages: readonly Message[]): ChatMessage[] {
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
          const image = isImage(part.mediaType) ? imagePart(part.data, part.mediaType) : undefined;
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
              id: part.id,
              type: 'function',
              function: { name: part.name, arguments: JSON.stringify(part.input ?? {}) },
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
          out.push({ role: 'tool', tool_call_id: part.id, content: outputText(part.output) });
        }
        break;
    }
  }
  return out;
}
