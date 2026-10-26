import type { ToolFileData, ToolOutput } from './tools.ts';
import type { JsonObject, JsonValue } from './types.ts';

/**
 * ctx 自己的消息格式：JSON 的子集，不依赖 AI SDK。二进制是 base64 字符串，URL 是字符串，所以 `JSON.stringify`
 * 后原样读回，存储和线上都不需要为它写编码。和 AI SDK 的 `ModelMessage` 互转在 `@modelctx-ai/ctx`
 * （`toModelMessages`、`fromModelMessages`）。
 */

/** 按服务商名分组、原样保存，用来带推理签名这类必须回传给服务商的字段。 */
export type MessageProviderOptions = Readonly<Record<string, JsonObject>>;

export interface TextPart {
  readonly type: 'text';
  readonly text: string;
  readonly providerOptions?: MessageProviderOptions;
}

/** 文件、图片。`mediaType` 可以只写大类（`image`）。 */
export interface FilePart {
  readonly type: 'file';
  readonly mediaType: string;
  readonly data: ToolFileData;
  readonly filename?: string;
  readonly providerOptions?: MessageProviderOptions;
}

export interface ReasoningPart {
  readonly type: 'reasoning';
  readonly text: string;
  /** 带推理签名，回传给服务商时必须原样保留。 */
  readonly providerOptions?: MessageProviderOptions;
}

/** 推理过程里产生的文件。和 AI SDK 一样只有字节和地址两种。 */
export interface ReasoningFilePart {
  readonly type: 'reasoning-file';
  readonly mediaType: string;
  readonly data: Extract<ToolFileData, { readonly type: 'data' | 'url' }>;
  readonly providerOptions?: MessageProviderOptions;
}

/** 服务商自定义的内容，没有标准载荷，只有 `kind`（`{provider}.{type}`）和 `providerOptions`。 */
export interface CustomPart {
  readonly type: 'custom';
  readonly kind: string;
  readonly providerOptions?: MessageProviderOptions;
}

/** 字段名同 `ToolCall`。 */
export interface ToolCallPart {
  readonly type: 'tool-call';
  readonly id: string;
  readonly name: string;
  readonly input: JsonValue;
  readonly providerExecuted?: boolean;
  readonly providerOptions?: MessageProviderOptions;
}

export interface ToolResultPart {
  readonly type: 'tool-result';
  /** 对应 `tool-call` 的 `id`。 */
  readonly id: string;
  readonly name: string;
  readonly output: ToolOutput;
  readonly providerOptions?: MessageProviderOptions;
}

export interface ToolApprovalRequestPart {
  readonly type: 'tool-approval-request';
  readonly approvalId: string;
  /** 它指向的 `tool-call` 的 `id`。 */
  readonly callId: string;
  readonly reason?: string;
  readonly isAutomatic?: boolean;
  /** 把这次批准绑定到工具调用上的签名；改了就验不过，所以原样保存。 */
  readonly signature?: string;
  /** 工具输入在校验、转换之前的样子。 */
  readonly inputSchemaInput?: JsonValue;
}

export interface ToolApprovalResponsePart {
  readonly type: 'tool-approval-response';
  readonly approvalId: string;
  readonly approved: boolean;
  readonly reason?: string;
  readonly providerExecuted?: boolean;
}

export type UserPart = TextPart | FilePart;
export type AssistantPart =
  | TextPart
  | FilePart
  | ReasoningPart
  | ReasoningFilePart
  | CustomPart
  | ToolCallPart
  | ToolResultPart
  | ToolApprovalRequestPart;
export type ToolPart = ToolResultPart | ToolApprovalResponsePart;

/** 用户这一句的内容：文字，或文字和文件的分段。`RunRequest.input`、`prompt` 用它。 */
export type MessageContent = string | readonly UserPart[];

export interface SystemMessage {
  readonly role: 'system';
  readonly content: string;
  readonly providerOptions?: MessageProviderOptions;
}

export interface UserMessage {
  readonly role: 'user';
  readonly content: MessageContent;
  readonly providerOptions?: MessageProviderOptions;
}

export interface AssistantMessage {
  readonly role: 'assistant';
  readonly content: string | readonly AssistantPart[];
  readonly providerOptions?: MessageProviderOptions;
}

export interface ToolMessage {
  readonly role: 'tool';
  readonly content: readonly ToolPart[];
  readonly providerOptions?: MessageProviderOptions;
}

export type Message = SystemMessage | UserMessage | AssistantMessage | ToolMessage;

/** 消息里能直接读出来的文字。工具调用、文件等非文字部分不算。 */
export function textOf(message: Message): string {
  const { content } = message;
  if (typeof content === 'string') return content;
  let text = '';
  for (const part of content) {
    if (part.type === 'text') text += part.text;
  }
  return text;
}
