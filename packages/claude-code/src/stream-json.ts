// Claude Code 无界面模式（`claude -p --output-format stream-json`）的消息，和它们怎么换成协议的消息、用量、结果。
// 字段对照 Claude Code 2.1.326 的实际输出核实过（见 README「验证」）；只列适配器用到的。
import {
  CONTEXT_OVERFLOW,
  errorOutput,
  isContextOverflowText,
  type AssistantMessage,
  type AssistantPart,
  type ErrorInfo,
  type JsonObject,
  type JsonValue,
  type MessageContent,
  type ToolContentPart,
  type ToolOutput,
  type Usage,
} from '@modelctx-ai/ctx-protocol';

/** Anthropic Messages API 的内容块（Claude Code 原样转出）。 */
export interface AnthropicBlock {
  readonly type: string;
  readonly text?: string;
  readonly thinking?: string;
  readonly signature?: string;
  readonly data?: string;
  readonly id?: string;
  readonly name?: string;
  readonly input?: unknown;
  readonly tool_use_id?: string;
  readonly content?: string | readonly AnthropicBlock[];
  readonly is_error?: boolean;
  readonly source?: {
    readonly type: string;
    readonly media_type?: string;
    readonly data?: string;
    readonly url?: string;
  };
}

export interface AnthropicUsage {
  readonly input_tokens?: number;
  readonly output_tokens?: number;
  readonly cache_read_input_tokens?: number;
  readonly cache_creation_input_tokens?: number;
  readonly output_tokens_details?: { readonly thinking_tokens?: number } | null;
}

export interface AnthropicMessage {
  readonly id: string;
  readonly model?: string;
  readonly content: readonly AnthropicBlock[];
  readonly usage?: AnthropicUsage;
}

/** 流式的原始事件（`--include-partial-messages` 时以 `stream_event` 转出）。 */
export type AnthropicEvent =
  | { readonly type: 'message_start'; readonly message: AnthropicMessage }
  | {
      readonly type: 'content_block_delta';
      readonly index: number;
      readonly delta: { readonly type: string; readonly text?: string; readonly thinking?: string };
    }
  | {
      readonly type: 'message_delta';
      readonly delta: { readonly stop_reason?: string | null };
      readonly usage?: AnthropicUsage;
    }
  | { readonly type: 'message_stop' }
  | { readonly type: 'content_block_start' | 'content_block_stop' | 'ping' };

export interface InitLine {
  readonly type: 'system';
  readonly subtype: 'init';
  readonly session_id: string;
  readonly model?: string;
  readonly tools?: readonly string[];
  readonly mcp_servers?: readonly { readonly name: string; readonly status: string }[];
  readonly claude_code_version?: string;
}

export interface StreamEventLine {
  readonly type: 'stream_event';
  readonly event: AnthropicEvent;
  readonly parent_tool_use_id?: string | null;
}

export interface AssistantLine {
  readonly type: 'assistant';
  readonly message: AnthropicMessage;
  readonly parent_tool_use_id?: string | null;
  /** Claude Code 把接口错误包成一条合成的助手消息（`model: '<synthetic>'`），不是模型说的话。 */
  readonly is_api_error_message?: boolean;
  readonly api_error_status?: number | null;
}

export interface UserLine {
  readonly type: 'user';
  readonly message: { readonly role: 'user'; readonly content: string | readonly AnthropicBlock[] };
  readonly parent_tool_use_id?: string | null;
  /** Claude Code 自己补的用户消息（输出被截断后让模型接着写、催它调结构化输出的工具）。 */
  readonly isSynthetic?: boolean;
  /** 工具结果的原始形状；MCP 工具的是 `{ content, structuredContent? }`。 */
  readonly tool_use_result?: unknown;
}

export interface ResultLine {
  readonly type: 'result';
  /** `success`、`error_max_turns`、`error_during_execution`、`error_max_budget_usd`…… */
  readonly subtype: string;
  readonly is_error?: boolean;
  readonly result?: string;
  readonly stop_reason?: string | null;
  /** `completed`、`api_error`、`max_turns`、`aborted_streaming`…… */
  readonly terminal_reason?: string;
  readonly usage?: AnthropicUsage;
  readonly structured_output?: unknown;
  readonly errors?: readonly string[] | null;
  readonly api_error_status?: number | null;
  readonly session_id?: string;
}

export interface ControlResponseLine {
  readonly type: 'control_response';
  readonly response: { readonly subtype: string; readonly request_id: string; readonly error?: string };
}

export type ClaudeLine =
  | InitLine
  | StreamEventLine
  | AssistantLine
  | UserLine
  | ResultLine
  | ControlResponseLine
  | { readonly type: 'system'; readonly subtype: string };

/** 一行输出；不是 JSON 对象、没有 `type` 的返回 `undefined`（Claude Code 偶尔在 stdout 打别的）。 */
export function parseLine(line: string): ClaudeLine | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return undefined;
  try {
    const value = JSON.parse(trimmed) as unknown;
    return typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'string'
      ? (value as ClaudeLine)
      : undefined;
  } catch {
    return undefined;
  }
}

/** Anthropic 的用量换成协议的：输入含缓存读到和写进缓存的，缓存和推理三项是 0 时不写。 */
export function usageOf(usage: AnthropicUsage | undefined): Usage | undefined {
  if (!usage) return undefined;
  const read = usage.cache_read_input_tokens ?? 0;
  const write = usage.cache_creation_input_tokens ?? 0;
  const input = (usage.input_tokens ?? 0) + read + write;
  const output = usage.output_tokens ?? 0;
  const reasoning = usage.output_tokens_details?.thinking_tokens ?? 0;
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

/** Anthropic 的 `stop_reason` 换成 AI SDK 的 `finishReason` 写法（`StepMeta.finishReason`）。 */
export function finishReasonOf(stop: string | null | undefined): string | undefined {
  switch (stop) {
    case 'end_turn':
    case 'stop_sequence':
      return 'stop';
    case 'tool_use':
      return 'tool-calls';
    case 'max_tokens':
      return 'length';
    case 'refusal':
      return 'content-filter';
    case null:
    case undefined:
      return undefined;
    default:
      return 'other';
  }
}

/** MCP 工具在 Claude Code 里的名字：`mcp__<服务器>__<工具>`。 */
export function mcpToolName(server: string, tool: string): string {
  return `mcp__${server}__${tool}`;
}

/** 一条助手消息的内容块换成协议的部件；`toolName` 把 MCP 的名字换回 ctx 的工具名。 */
export function assistantMessageOf(
  blocks: readonly AnthropicBlock[],
  toolName: (name: string) => string,
): AssistantMessage {
  const parts: AssistantPart[] = [];
  for (const block of blocks) {
    if (block.type === 'text') {
      if (block.text) parts.push({ type: 'text', text: block.text });
    } else if (block.type === 'thinking') {
      parts.push({
        type: 'reasoning',
        text: block.thinking ?? '',
        ...(block.signature ? { providerOptions: { anthropic: { signature: block.signature } } } : {}),
      });
    } else if (block.type === 'redacted_thinking') {
      parts.push({ type: 'reasoning', text: '', providerOptions: { anthropic: { redactedData: block.data ?? '' } } });
    } else if (block.type === 'tool_use' && block.id && block.name) {
      parts.push({
        type: 'tool-call',
        id: block.id,
        name: toolName(block.name),
        input: (block.input ?? {}) as JsonValue,
      });
    } else {
      // 服务端工具（`server_tool_use`、搜索结果这类）：只留个记号，内容在 Claude Code 自己的记录里。
      parts.push({ type: 'custom', kind: `claude-code.${block.type}` });
    }
  }
  return { role: 'assistant', content: parts };
}

/** 助手消息里的文字，连起来。 */
export function textOfBlocks(blocks: readonly AnthropicBlock[]): string {
  return blocks.flatMap((block) => (block.type === 'text' && block.text ? [block.text] : [])).join('');
}

/**
 * 一个 `tool_result` 块换成协议的 `ToolOutput`。MCP 工具的结果带着 `structuredContent` 时还原成 `json`
 * （ctx 的执行环境回 `json` 时 `createMcpServer` 这样转），否则文字是 `text`，带图的是 `content`，出错是 `error`。
 */
export function toolOutputOf(block: AnthropicBlock, raw: unknown): ToolOutput {
  const content = block.content;
  const blocks: readonly AnthropicBlock[] =
    typeof content === 'string' ? [{ type: 'text', text: content }] : (content ?? []);
  const text = textOfBlocks(blocks);
  if (block.is_error) return errorOutput(text || 'The tool failed.');
  const structured =
    typeof raw === 'object' && raw !== null ? (raw as { structuredContent?: unknown }).structuredContent : undefined;
  if (typeof structured === 'object' && structured !== null && !Array.isArray(structured)) {
    return { type: 'json', value: structured as JsonObject };
  }
  const parts: ToolContentPart[] = [];
  for (const item of blocks) {
    if (item.type === 'text') parts.push({ type: 'text', text: item.text ?? '' });
    else if (item.type === 'image' && item.source?.type === 'base64' && item.source.data) {
      parts.push({
        type: 'file',
        mediaType: item.source.media_type ?? 'image/png',
        data: { type: 'data', data: item.source.data },
      });
    } else if (item.source?.type === 'url' && item.source.url) {
      parts.push({
        type: 'file',
        mediaType: item.source.media_type ?? 'application/octet-stream',
        data: { type: 'url', url: item.source.url },
      });
    }
  }
  if (parts.every((part) => part.type === 'text')) return { type: 'text', text };
  return { type: 'content', parts };
}

/** 用户输入（`MessageContent`）换成 Anthropic 的内容块：文字、图片、PDF；别的文件内联成文字或说明。 */
export function userBlocksOf(content: MessageContent | undefined): AnthropicBlock[] {
  if (content === undefined) return [];
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  const out: AnthropicBlock[] = [];
  for (const part of content) {
    if (part.type === 'text') {
      out.push({ type: 'text', text: part.text });
      continue;
    }
    const { mediaType, data } = part;
    const kind = mediaType.startsWith('image/') ? 'image' : mediaType === 'application/pdf' ? 'document' : undefined;
    if (data.type === 'text') out.push({ type: 'text', text: data.text });
    else if (kind && data.type === 'data') {
      out.push({ type: kind, source: { type: 'base64', media_type: mediaType, data: data.data } });
    } else if (kind && data.type === 'url') out.push({ type: kind, source: { type: 'url', url: data.url } });
    else
      out.push({
        type: 'text',
        text: `[${mediaType} file${part.filename ? ` ${part.filename}` : ''} not passed to Claude Code]`,
      });
  }
  return out;
}

/**
 * 一轮出错时的 `ErrorInfo`：接口错误按状态码定能不能重试（429、5xx、529 能），上下文过长是 `context_overflow`，
 * 续接的会话不在是 `not_found`，别的是 `claude_code`。
 */
export function errorOfResult(
  line: ResultLine,
  apiError?: { readonly status?: number; readonly message: string },
): ErrorInfo {
  const status = line.api_error_status ?? apiError?.status ?? undefined;
  const message =
    (line.errors && line.errors.length > 0 ? line.errors.join('; ') : undefined) ??
    apiError?.message ??
    (line.result ||
      `Claude Code ended with ${line.subtype}${line.terminal_reason ? ` (${line.terminal_reason})` : ''}.`);
  if (isContextOverflowText(message, status)) {
    return {
      message,
      type: CONTEXT_OVERFLOW,
      retryable: false,
      ...(status !== undefined ? { statusCode: status } : {}),
    };
  }
  if (/No conversation found/i.test(message)) return { message, type: 'not_found', retryable: false };
  if (status !== undefined) {
    return {
      message,
      type: 'api_call',
      retryable: status === 408 || status === 409 || status === 429 || status >= 500,
      statusCode: status,
    };
  }
  return { message, type: 'claude_code' };
}
