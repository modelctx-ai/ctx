import type {
  AssistantPart,
  FilePart,
  Message,
  MessageProviderOptions,
  ReasoningFilePart,
  ToolPart,
  UserPart,
} from './message.ts';
import { encodeBase64, toolOutputFromAiSdk, type AiSdkToolOutput, type ToolFileData } from './tools.ts';
import { CtxError, type JsonValue } from './types.ts';

/**
 * AI SDK 的 `ModelMessage` 形状转成 `Message`。输入按 `unknown` 收：存储里 0 版的行存的就是这个形状的 JSON
 * （二进制和 URL 已经还原成 base64 字符串和 `URL`），`fromModelMessages` 传进来的是 AI SDK 的值。
 * 遇到不认识的角色或部件（只可能是 AI SDK 以后新加的）抛 `unsupported_part`，不静默丢。
 */

function unsupported(what: string): never {
  throw new CtxError('unsupported_part', `Unsupported message ${what}; ctx cannot convert it yet.`);
}

type Loose = Record<string, unknown>;

function isRecord(value: unknown): value is Loose {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function bytesOf(value: unknown): Uint8Array | undefined {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return undefined;
}

function stringOf(value: unknown, what: string): string {
  return typeof value === 'string' ? value : unsupported(`${what} (expected a string)`);
}

/** 裸字符串是地址还是 base64：`http(s):`、`data:` 开头的是地址，其余当 base64（base64 里没有冒号）。 */
const URL_LIKE = /^(https?:|data:)/i;

function referenceOf(value: Loose): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) out[key] = stringOf(item, 'file reference');
  return out;
}

/**
 * AI SDK 的文件数据转成 `ToolFileData`：带标签的 `{ type }` 原样对应；裸写法按内容判断：
 * 字节（`Uint8Array`、`ArrayBuffer`、`Buffer`）→ `data`（base64），`URL` → `url`，
 * 字符串 → 地址或 base64（见 `URL_LIKE`），没有 `type` 的对象 → 服务商文件引用。
 */
export function fileDataFromLoose(data: unknown): ToolFileData {
  if (typeof data === 'string') return URL_LIKE.test(data) ? { type: 'url', url: data } : { type: 'data', data };
  if (data instanceof URL) return { type: 'url', url: data.href };
  const bytes = bytesOf(data);
  if (bytes) return { type: 'data', data: encodeBase64(bytes) };
  if (!isRecord(data)) return unsupported('file data');
  switch (data['type']) {
    case 'data': {
      const inner = data['data'];
      if (typeof inner === 'string') return { type: 'data', data: inner };
      const raw = bytesOf(inner);
      return raw ? { type: 'data', data: encodeBase64(raw) } : unsupported('file data (expected bytes or base64)');
    }
    case 'url': {
      const original = data['originalUrl'];
      if (typeof original === 'string') return { type: 'url', url: original };
      const url = data['url'];
      return { type: 'url', url: url instanceof URL ? url.href : stringOf(url, 'file url') };
    }
    case 'reference':
      return isRecord(data['reference'])
        ? { type: 'reference', reference: referenceOf(data['reference']) }
        : unsupported('file reference');
    case 'text':
      return { type: 'text', text: stringOf(data['text'], 'file text') };
    case undefined:
      return { type: 'reference', reference: referenceOf(data) };
    default:
      return unsupported(`file data type "${String(data['type'])}"`);
  }
}

function providerOptionsOf(part: Loose): { providerOptions?: MessageProviderOptions } {
  return part['providerOptions'] === undefined
    ? {}
    : { providerOptions: part['providerOptions'] as MessageProviderOptions };
}

function optional<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return value === undefined ? {} : ({ [key]: value } as { [P in K]?: V });
}

function filePart(part: Loose): FilePart {
  return {
    type: 'file',
    mediaType: stringOf(part['mediaType'], 'file part mediaType'),
    data: fileDataFromLoose(part['data']),
    ...optional('filename', part['filename'] as string | undefined),
    ...providerOptionsOf(part),
  };
}

function reasoningFilePart(part: Loose): ReasoningFilePart {
  const data = fileDataFromLoose(part['data']);
  if (data.type !== 'data' && data.type !== 'url') unsupported(`reasoning-file data type "${data.type}"`);
  return {
    type: 'reasoning-file',
    mediaType: stringOf(part['mediaType'], 'reasoning-file mediaType'),
    data,
    ...providerOptionsOf(part),
  };
}

function textPart(part: Loose) {
  return { type: 'text' as const, text: stringOf(part['text'], 'text part'), ...providerOptionsOf(part) };
}

function toolResultPart(part: Loose) {
  return {
    type: 'tool-result' as const,
    id: stringOf(part['toolCallId'], 'tool-result toolCallId'),
    name: stringOf(part['toolName'], 'tool-result toolName'),
    output: toolOutputFromAiSdk(part['output'] as AiSdkToolOutput),
    ...providerOptionsOf(part),
  };
}

function userPart(part: unknown): UserPart {
  if (!isRecord(part)) return unsupported('user part');
  switch (part['type']) {
    case 'text':
      return textPart(part);
    case 'file':
      return filePart(part);
    // 已弃用的 `image`：并入 `file`，`mediaType` 缺省写 `image`（大类）。
    case 'image':
      return {
        type: 'file',
        mediaType: typeof part['mediaType'] === 'string' ? part['mediaType'] : 'image',
        data: fileDataFromLoose(part['image']),
        ...providerOptionsOf(part),
      };
    default:
      return unsupported(`user part "${String(part['type'])}"`);
  }
}

function assistantPart(part: unknown): AssistantPart {
  if (!isRecord(part)) return unsupported('assistant part');
  switch (part['type']) {
    case 'text':
      return textPart(part);
    case 'file':
      return filePart(part);
    case 'reasoning':
      return { type: 'reasoning', text: stringOf(part['text'], 'reasoning part'), ...providerOptionsOf(part) };
    case 'reasoning-file':
      return reasoningFilePart(part);
    case 'custom':
      return { type: 'custom', kind: stringOf(part['kind'], 'custom part kind'), ...providerOptionsOf(part) };
    case 'tool-call':
      return {
        type: 'tool-call',
        id: stringOf(part['toolCallId'], 'tool-call toolCallId'),
        name: stringOf(part['toolName'], 'tool-call toolName'),
        input: (part['input'] ?? null) as JsonValue,
        ...optional('providerExecuted', part['providerExecuted'] as boolean | undefined),
        ...providerOptionsOf(part),
      };
    case 'tool-result':
      return toolResultPart(part);
    case 'tool-approval-request':
      return {
        type: 'tool-approval-request',
        approvalId: stringOf(part['approvalId'], 'tool-approval-request approvalId'),
        callId: stringOf(part['toolCallId'], 'tool-approval-request toolCallId'),
        ...optional('reason', part['reason'] as string | undefined),
        ...optional('isAutomatic', part['isAutomatic'] as boolean | undefined),
        ...optional('signature', part['signature'] as string | undefined),
        ...optional('inputSchemaInput', part['inputSchemaInput'] as JsonValue | undefined),
      };
    default:
      return unsupported(`assistant part "${String(part['type'])}"`);
  }
}

function toolPart(part: unknown): ToolPart {
  if (!isRecord(part)) return unsupported('tool part');
  switch (part['type']) {
    case 'tool-result':
      return toolResultPart(part);
    case 'tool-approval-response':
      return {
        type: 'tool-approval-response',
        approvalId: stringOf(part['approvalId'], 'tool-approval-response approvalId'),
        approved: part['approved'] === true,
        ...optional('reason', part['reason'] as string | undefined),
        ...optional('providerExecuted', part['providerExecuted'] as boolean | undefined),
      };
    default:
      return unsupported(`tool part "${String(part['type'])}"`);
  }
}

function listOf(content: unknown, role: string): unknown[] {
  return Array.isArray(content) ? content : unsupported(`${role} content`);
}

/** 用户内容：字符串原样，分段逐个转。`createContext()` 在边界上也用它转 AI SDK 的 `UserContent`。 */
export function contentFromLoose(content: unknown): string | UserPart[] {
  return typeof content === 'string' ? content : listOf(content, 'user').map(userPart);
}

export function messageFromModelMessage(raw: unknown): Message {
  if (!isRecord(raw)) return unsupported('message');
  const options = providerOptionsOf(raw);
  switch (raw['role']) {
    case 'system':
      return { role: 'system', content: stringOf(raw['content'], 'system content'), ...options };
    case 'user':
      return { role: 'user', content: contentFromLoose(raw['content']), ...options };
    case 'assistant':
      return {
        role: 'assistant',
        content:
          typeof raw['content'] === 'string' ? raw['content'] : listOf(raw['content'], 'assistant').map(assistantPart),
        ...options,
      };
    case 'tool':
      return { role: 'tool', content: listOf(raw['content'], 'tool').map(toolPart), ...options };
    default:
      return unsupported(`role "${String(raw['role'])}"`);
  }
}
