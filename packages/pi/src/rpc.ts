// pi 的 RPC 模式（`pi --mode rpc`）：stdin 一行一个命令，stdout 一行一个响应或事件。这里是用到的那些记录的形状，和 pi 的
// 消息、用量、错误换成 ctx 的协议的写法。形状照 pi 1.5.2（`@earendil-works/pi-coding-agent`）核实过。
import {
  CONTEXT_OVERFLOW,
  errorOutput,
  isContextOverflowText,
  type AssistantMessage,
  type AssistantPart,
  type ErrorInfo,
  type JsonObject,
  type MessageContent,
  type ToolContentPart,
  type ToolOutput,
  type Usage,
} from '@modelctx-ai/ctx-protocol';

export interface PiText {
  readonly type: 'text';
  readonly text: string;
}

export interface PiThinking {
  readonly type: 'thinking';
  readonly thinking: string;
  /** 服务商给的签名或加密的推理（`redacted` 时推理的内容在这里）：接着聊时要原样交回去。 */
  readonly thinkingSignature?: string;
  readonly redacted?: boolean;
}

export interface PiImage {
  readonly type: 'image';
  /** base64。 */
  readonly data: string;
  readonly mimeType: string;
}

export interface PiToolCall {
  readonly type: 'toolCall';
  readonly id: string;
  readonly name: string;
  readonly arguments?: JsonObject;
}

export interface PiUsage {
  /** 不含缓存读到的和写进缓存的。 */
  readonly input?: number;
  /** 含推理的。 */
  readonly output?: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
  readonly totalTokens?: number;
  /** 输出里推理用掉的（服务商报了才有）。 */
  readonly reasoning?: number;
}

/** `pending` 是还在流式输出；`deferred` 是交给批处理、以后再取的回答。 */
export type PiStopReason = 'pending' | 'stop' | 'length' | 'toolUse' | 'error' | 'aborted' | 'deferred';

export interface PiAssistantMessage {
  readonly role: 'assistant';
  readonly content: readonly (PiText | PiThinking | PiToolCall)[];
  readonly provider?: string;
  readonly model?: string;
  readonly usage?: PiUsage;
  readonly stopReason?: PiStopReason;
  readonly errorMessage?: string;
}

export interface PiToolResultMessage {
  readonly role: 'toolResult';
  readonly toolCallId: string;
  readonly toolName: string;
  readonly content?: readonly (PiText | PiImage)[];
  readonly isError?: boolean;
}

/** 系统、用户、助手、工具结果，和扩展加的消息：只认前两种以外的助手和工具结果。 */
export interface PiMessage {
  readonly role: string;
}

/** `tool_execution_end` 的 `result`：MCP 工具的 `structuredContent` 是 MCP 的整个 `CallToolResult`。 */
export interface PiToolResult {
  readonly content?: readonly (PiText | PiImage)[];
  readonly details?: unknown;
  readonly structuredContent?: unknown;
}

/** stdout 的一行：`type` 是 `response` 的是命令的响应，别的是事件。用到的字段在各自的类型里。 */
export interface PiRecord {
  readonly type: string;
  readonly [key: string]: unknown;
}

export interface PiResponse extends PiRecord {
  readonly type: 'response';
  readonly id?: string;
  readonly command: string;
  readonly success: boolean;
  readonly data?: unknown;
  readonly error?: string;
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 一行 JSON；不是对象、没有 `type` 的不认。pi 按 LF 分行（JSON 字符串里可以有 U+2028）。 */
export function parseRecord(line: string): PiRecord | undefined {
  const trimmed = line.endsWith('\r') ? line.slice(0, -1) : line;
  if (!trimmed.startsWith('{')) return undefined;
  try {
    const value = JSON.parse(trimmed) as unknown;
    return isObject(value) && typeof value['type'] === 'string' ? (value as PiRecord) : undefined;
  } catch {
    return undefined;
  }
}

export function isAssistant(message: unknown): message is PiAssistantMessage {
  return isObject(message) && message['role'] === 'assistant' && Array.isArray(message['content']);
}

/** pi 的用量换成协议的：输入含缓存读到和写进缓存的，缓存和推理三项是 0 时不写。 */
export function usageOf(usage: PiUsage | undefined): Usage | undefined {
  if (!usage) return undefined;
  const read = usage.cacheRead ?? 0;
  const write = usage.cacheWrite ?? 0;
  const input = (usage.input ?? 0) + read + write;
  const output = usage.output ?? 0;
  const reasoning = usage.reasoning ?? 0;
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: input + output,
    ...(read > 0 ? { cacheReadTokens: read } : {}),
    ...(write > 0 ? { cacheWriteTokens: write } : {}),
    ...(reasoning > 0 ? { reasoningTokens: reasoning } : {}),
  };
}

/** 两次用量相加，没有的项不出现。 */
export function addUsages(a: Usage | undefined, b: Usage | undefined): Usage | undefined {
  if (!a) return b;
  if (!b) return a;
  const keys = ['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens'];
  const out: Record<string, number> = {};
  for (const key of keys as (keyof Usage)[]) {
    const sum = (a[key] ?? 0) + (b[key] ?? 0);
    if (a[key] !== undefined || b[key] !== undefined) out[key] = sum;
  }
  return out;
}

/** pi 的 `stopReason` 换成 AI SDK 的 `finishReason` 写法（`StepMeta.finishReason`）。 */
export function finishReasonOf(stop: PiStopReason | undefined): string | undefined {
  switch (stop) {
    case 'stop':
      return 'stop';
    case 'toolUse':
      return 'tool-calls';
    case 'length':
      return 'length';
    case 'error':
      return 'error';
    case undefined:
    case 'pending':
      return undefined;
    default:
      return 'other';
  }
}

/** 一条助手消息换成协议的：空的文字不要；推理的签名放进 `providerOptions.pi`；`toolName` 把 MCP 的名字换回 ctx 的工具名。 */
export function assistantMessageOf(message: PiAssistantMessage, toolName: (name: string) => string): AssistantMessage {
  const parts: AssistantPart[] = [];
  for (const part of message.content) {
    if (part.type === 'text') {
      if (part.text) parts.push({ type: 'text', text: part.text });
    } else if (part.type === 'thinking') {
      const options = {
        ...(part.thinkingSignature !== undefined ? { thinkingSignature: part.thinkingSignature } : {}),
        ...(part.redacted ? { redacted: true } : {}),
      };
      parts.push({
        type: 'reasoning',
        text: part.thinking ?? '',
        ...(Object.keys(options).length > 0 ? { providerOptions: { pi: options } } : {}),
      });
    } else if (part.type === 'toolCall') {
      parts.push({ type: 'tool-call', id: part.id, name: toolName(part.name), input: part.arguments ?? {} });
    }
  }
  return { role: 'assistant', content: parts };
}

/** 助手消息里的文字，连起来。 */
export function textOf(message: PiAssistantMessage): string {
  return message.content.flatMap((part) => (part.type === 'text' && part.text ? [part.text] : [])).join('');
}

/** 助手消息里的工具调用。 */
export function toolCallsOf(message: PiAssistantMessage): PiToolCall[] {
  return message.content.filter((part): part is PiToolCall => part.type === 'toolCall');
}

/**
 * 一次工具调用的结果换成协议的 `ToolOutput`：出错是 `error`；ctx 的工具（`mcp`）的结果带着对象的 `structuredContent` 时还原成
 * `json`（ctx 的执行环境回 `json` 时 `createMcpServer` 这样转，截断了就只有文字）；别的文字是 `text`，带图的是 `content`。
 */
export function toolOutputOf(result: PiToolResult | undefined, isError: boolean, mcp: boolean): ToolOutput {
  const content = result?.content ?? [];
  const text = content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('');
  if (isError) return errorOutput(text || 'The tool failed.');
  if (mcp) {
    // pi 把 MCP 的整个结果放在 `structuredContent` 里，结果自己的 `structuredContent` 在它下面。
    const raw = result?.structuredContent;
    const value = isObject(raw) && Array.isArray(raw['content']) ? raw['structuredContent'] : raw;
    if (isObject(value)) return { type: 'json', value: value as JsonObject };
  }
  const parts: ToolContentPart[] = content.flatMap((part): ToolContentPart[] => {
    if (part.type === 'text') return [{ type: 'text', text: part.text }];
    if (part.type === 'image') {
      return [{ type: 'file', mediaType: part.mimeType, data: { type: 'data', data: part.data } }];
    }
    return [];
  });
  if (parts.every((part) => part.type === 'text')) return { type: 'text', text };
  return { type: 'content', parts };
}

/**
 * 一次模型调用失败时 pi 给的 `errorMessage` 换成 `ErrorInfo`：开头是 HTTP 状态码的（`500 {"type":"error",…}`），按状态码定能
 * 不能重试（408、409、429、5xx 能），响应体是 JSON 的取里面的 `message`；上下文过长的是 `context_overflow`；别的是 `pi`。
 */
export function errorOfMessage(text: string): ErrorInfo {
  const match = /^(\d{3})\s+([\s\S]*)$/.exec(text.trim());
  const status = match ? Number(match[1]) : undefined;
  let message = text;
  if (match) {
    try {
      const body = JSON.parse(match[2]!) as unknown;
      const inner = isObject(body) ? (isObject(body['error']) ? body['error']['message'] : body['message']) : undefined;
      if (typeof inner === 'string' && inner) message = inner;
    } catch {
      message = match[2]! || text;
    }
  }
  if (isContextOverflowText(text, status)) {
    return {
      message,
      type: CONTEXT_OVERFLOW,
      retryable: false,
      ...(status !== undefined ? { statusCode: status } : {}),
    };
  }
  if (status !== undefined) {
    return {
      message,
      type: 'api_call',
      retryable: status === 408 || status === 409 || status === 429 || status >= 500,
      statusCode: status,
    };
  }
  return { message, type: 'pi' };
}

/** 交给 pi 的一句话：`prompt` 命令的 `message` 和 `images`。 */
export interface PiPrompt {
  readonly message: string;
  readonly images: readonly PiImage[];
}

/**
 * 用户输入（`MessageContent`，可以有几段）换成 pi 的提示：文字按顺序用空行连起来，内联的图片放进 `images`；文字文件内联成文字，
 * 别的文件（PDF、给的是地址的图片……）pi 的提示放不下，换成一句说明。
 */
export function promptOf(...contents: readonly (MessageContent | undefined)[]): PiPrompt {
  const texts: string[] = [];
  const images: PiImage[] = [];
  for (const content of contents) {
    if (content === undefined) continue;
    if (typeof content === 'string') {
      if (content) texts.push(content);
      continue;
    }
    for (const part of content) {
      if (part.type === 'text') {
        if (part.text) texts.push(part.text);
        continue;
      }
      const { mediaType, data } = part;
      if (data.type === 'text') texts.push(data.text);
      else if (mediaType.startsWith('image/') && data.type === 'data') {
        images.push({ type: 'image', data: data.data, mimeType: mediaType });
      } else texts.push(`[${mediaType} file${part.filename ? ` ${part.filename}` : ''} not passed to pi]`);
    }
  }
  return { message: texts.join('\n\n'), images };
}
