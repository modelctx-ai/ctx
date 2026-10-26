import {
  contentFromLoose,
  fileDataToAiSdk,
  messageFromModelMessage,
  toolOutputToAiSdk,
  type AssistantPart,
  type FilePart,
  type JsonObject,
  type Message,
  type MessageContent,
  type MessageProviderOptions,
  type ReasoningFilePart,
  type ToolPart,
  type UserPart,
} from '@modelctx-ai/ctx-protocol';
import type { AssistantContent, ModelMessage, ToolContent, ToolResultPart, UserContent } from 'ai';

/**
 * AI SDK 的消息部件类型，每一种都有对应的转换。`Record<AiSdkPartType, string>` 的类型标注是编译期的穷尽检查（缺一种或多一种都编译不过）：
 * AI SDK 以后在 `UserContent`、`AssistantContent`、`ToolContent` 里加了新部件，这里就编译不过，
 * 提醒在 `@modelctx-ai/ctx-protocol` 的 `messageFromModelMessage` 和下面的 `toModelMessages` 里加上转换。
 * 运行时遇到没有转换的部件，`fromModelMessages` 抛 `unsupported_part`。
 */
type AiSdkPartType = (AiUserPart | AiAssistantPart | ToolContent[number])['type'];

export const AI_SDK_PART_TYPES: Readonly<Record<AiSdkPartType, string>> = {
  text: 'user, assistant',
  image: 'user',
  file: 'user, assistant',
  reasoning: 'assistant',
  'reasoning-file': 'assistant',
  custom: 'assistant',
  'tool-call': 'assistant',
  'tool-result': 'assistant, tool',
  'tool-approval-request': 'assistant',
  'tool-approval-response': 'tool',
};

function providerOptionsOf(source: { readonly providerOptions?: MessageProviderOptions }): {
  providerOptions?: Record<string, JsonObject>;
} {
  return source.providerOptions === undefined ? {} : { providerOptions: { ...source.providerOptions } };
}

function filename(part: FilePart): { filename?: string } {
  return part.filename === undefined ? {} : { filename: part.filename };
}

type AiUserPart = Exclude<UserContent, string>[number];
type AiAssistantPart = Exclude<AssistantContent, string>[number];
type AiFilePart = Extract<AiUserPart, { type: 'file' }>;

function fileFrom(part: FilePart): AiFilePart {
  return {
    type: 'file',
    mediaType: part.mediaType,
    data: fileDataToAiSdk(part.data),
    ...filename(part),
    ...providerOptionsOf(part),
  };
}

function reasoningFileFrom(part: ReasoningFilePart): AiAssistantPart {
  return {
    type: 'reasoning-file',
    mediaType: part.mediaType,
    data: fileDataToAiSdk(part.data) as Extract<ReturnType<typeof fileDataToAiSdk>, { type: 'data' | 'url' }>,
    ...providerOptionsOf(part),
  };
}

function toolResultFrom(part: Extract<ToolPart, { type: 'tool-result' }>): ToolResultPart {
  return {
    type: 'tool-result',
    toolCallId: part.id,
    toolName: part.name,
    output: toolOutputToAiSdk(part.output) as ToolResultPart['output'],
    ...providerOptionsOf(part),
  };
}

function userPartFrom(part: UserPart): AiUserPart {
  switch (part.type) {
    case 'text':
      return { type: 'text', text: part.text, ...providerOptionsOf(part) };
    default:
      return fileFrom(part);
  }
}

function assistantPartFrom(part: AssistantPart): AiAssistantPart {
  switch (part.type) {
    case 'text':
      return { type: 'text', text: part.text, ...providerOptionsOf(part) };
    case 'file':
      return fileFrom(part);
    case 'reasoning':
      return { type: 'reasoning', text: part.text, ...providerOptionsOf(part) };
    case 'reasoning-file':
      return reasoningFileFrom(part);
    case 'custom':
      return { type: 'custom', kind: part.kind as `${string}.${string}`, ...providerOptionsOf(part) };
    case 'tool-call':
      return {
        type: 'tool-call',
        toolCallId: part.id,
        toolName: part.name,
        input: part.input,
        ...(part.providerExecuted !== undefined ? { providerExecuted: part.providerExecuted } : {}),
        ...providerOptionsOf(part),
      };
    case 'tool-result':
      return toolResultFrom(part);
    default:
      return {
        type: 'tool-approval-request',
        approvalId: part.approvalId,
        toolCallId: part.callId,
        ...(part.reason !== undefined ? { reason: part.reason } : {}),
        ...(part.isAutomatic !== undefined ? { isAutomatic: part.isAutomatic } : {}),
        ...(part.signature !== undefined ? { signature: part.signature } : {}),
        ...(part.inputSchemaInput !== undefined ? { inputSchemaInput: part.inputSchemaInput } : {}),
      };
  }
}

function toolPartFrom(part: ToolPart): ToolContent[number] {
  switch (part.type) {
    case 'tool-result':
      return toolResultFrom(part);
    default:
      return {
        type: 'tool-approval-response',
        approvalId: part.approvalId,
        approved: part.approved,
        ...(part.reason !== undefined ? { reason: part.reason } : {}),
        ...(part.providerExecuted !== undefined ? { providerExecuted: part.providerExecuted } : {}),
      };
  }
}

/** ctx 的消息转成 AI SDK 的 `ModelMessage`。总能转：`Message` 是 AI SDK 部件的一个子集，二进制以带标签的 `FileData` 交出去。 */
export function toModelMessage(message: Message): ModelMessage {
  const options = providerOptionsOf(message);
  switch (message.role) {
    case 'system':
      return { role: 'system', content: message.content, ...options };
    case 'user':
      return { role: 'user', content: toUserContent(message.content), ...options };
    case 'assistant':
      return {
        role: 'assistant',
        content: typeof message.content === 'string' ? message.content : message.content.map(assistantPartFrom),
        ...options,
      };
    default:
      return { role: 'tool', content: message.content.map(toolPartFrom), ...options };
  }
}

export function toModelMessages(messages: readonly Message[]): ModelMessage[] {
  return messages.map(toModelMessage);
}

/**
 * AI SDK 的 `ModelMessage` 转成 ctx 的消息：`image` 并入 `file`，字节变 base64，`URL` 变字符串，
 * `toolCallId`/`toolName` 改 `id`/`name`，工具结果的 `output` 经 `toolOutputFromAiSdk`（`providerOptions` 和
 * `custom` 内容分段在那里被有意丢掉）。遇到子集之外的部件抛 `unsupported_part`。
 */
export function fromModelMessage(message: ModelMessage): Message {
  return messageFromModelMessage(message);
}

export function fromModelMessages(messages: readonly ModelMessage[]): Message[] {
  return messages.map(fromModelMessage);
}

/** 用户输入的内容：`createContext()` 在边界上把 AI SDK 的 `UserContent` 转成协议的 `MessageContent`。 */
export function fromUserContent(content: UserContent): MessageContent {
  return contentFromLoose(content);
}

export function toUserContent(content: MessageContent): UserContent {
  return typeof content === 'string' ? content : content.map(userPartFrom);
}
