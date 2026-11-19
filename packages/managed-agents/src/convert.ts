// Managed Agents 的内容块、用量、错误和协议的互换。字段照 `@anthropic-ai/sdk` 1.10.0 的类型写，
// 没有对真实服务验证（见 README「验证」）。
import {
  CONTEXT_OVERFLOW,
  errorOutput,
  isContextOverflowText,
  type ErrorInfo,
  type MessageContent,
  type ToolContentPart,
  type ToolOutput,
  type Usage,
} from '@modelctx-ai/ctx-protocol';
import type {
  BetaManagedAgentsDocumentBlock,
  BetaManagedAgentsImageBlock,
  BetaManagedAgentsSearchResultBlock,
  BetaManagedAgentsSessionErrorEvent,
  BetaManagedAgentsSpanModelUsage,
  BetaManagedAgentsTextBlock,
} from '@anthropic-ai/sdk/resources/beta/sessions/events';

/** `user.message` 的内容块。 */
export type UserBlock = BetaManagedAgentsTextBlock | BetaManagedAgentsImageBlock | BetaManagedAgentsDocumentBlock;

/** 工具结果（`agent.tool_result`、`user.custom_tool_result`）的内容块。 */
export type ResultBlock =
  | BetaManagedAgentsTextBlock
  | BetaManagedAgentsImageBlock
  | BetaManagedAgentsDocumentBlock
  | BetaManagedAgentsSearchResultBlock;

/** 一段文件内容换成图片或文档块；换不了的（别的类型、服务商的文件引用）返回 `undefined`。 */
function fileBlock(
  mediaType: string,
  data: ToolContentPart & { type: 'file' },
): BetaManagedAgentsImageBlock | BetaManagedAgentsDocumentBlock | undefined {
  const file = data.data;
  if (mediaType.startsWith('image/')) {
    if (file.type === 'data')
      return { type: 'image', source: { type: 'base64', media_type: mediaType, data: file.data } };
    if (file.type === 'url') return { type: 'image', source: { type: 'url', url: file.url } };
    return undefined;
  }
  if (mediaType === 'application/pdf') {
    if (file.type === 'data') {
      return { type: 'document', source: { type: 'base64', media_type: mediaType, data: file.data } };
    }
    if (file.type === 'url') return { type: 'document', source: { type: 'url', url: file.url } };
  }
  return undefined;
}

/** 文件说明：交不过去的文件，模型至少知道有过一个。 */
function fileNote(mediaType: string, filename: string | undefined): string {
  return `[${mediaType} file${filename ? ` ${filename}` : ''} not passed to Managed Agents]`;
}

/** 用户输入（`MessageContent`）换成 `user.message` 的内容块：文字、图片、PDF；内联的文字文件是文字，别的写一句说明。 */
export function userBlocksOf(content: MessageContent | undefined): UserBlock[] {
  if (content === undefined) return [];
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  const out: UserBlock[] = [];
  for (const part of content) {
    if (part.type === 'text') {
      if (part.text) out.push({ type: 'text', text: part.text });
      continue;
    }
    if (part.data.type === 'text') {
      out.push({ type: 'text', text: part.data.text });
      continue;
    }
    const block = fileBlock(part.mediaType, { type: 'file', mediaType: part.mediaType, data: part.data });
    out.push(block ?? { type: 'text', text: fileNote(part.mediaType, part.filename) });
  }
  return out;
}

/** 内容块里的文字，连起来。 */
export function textOfBlocks(blocks: readonly { readonly type: string; readonly text?: string }[]): string {
  return blocks.flatMap((block) => (block.type === 'text' && block.text ? [block.text] : [])).join('');
}

/**
 * Managed Agents 那边执行的工具的结果（`agent.tool_result`、`agent.mcp_tool_result`）换成 `ToolOutput`：
 * 出错是 `error`，只有文字是 `text`，带图片、文档的是 `content`，搜索结果取它的文字。
 */
export function toolOutputOf(
  content: readonly ResultBlock[] | undefined,
  isError: boolean | null | undefined,
): ToolOutput {
  const blocks = content ?? [];
  const text = blocks
    .map((block) =>
      block.type === 'text'
        ? block.text
        : block.type === 'search_result'
          ? block.content.map((item) => item.text).join('\n')
          : '',
    )
    .join('');
  if (isError) return errorOutput(text || 'The tool failed.');
  const parts: ToolContentPart[] = [];
  for (const block of blocks) {
    if (block.type === 'text') parts.push({ type: 'text', text: block.text });
    else if (block.type === 'search_result') {
      parts.push({ type: 'text', text: block.content.map((item) => item.text).join('\n') });
    } else if (block.source.type === 'base64') {
      parts.push({ type: 'file', mediaType: block.source.media_type, data: { type: 'data', data: block.source.data } });
    } else if (block.source.type === 'url') {
      parts.push({
        type: 'file',
        mediaType: block.type === 'image' ? 'image/*' : 'application/pdf',
        data: { type: 'url', url: block.source.url },
      });
    } else if (block.source.type === 'text') {
      parts.push({ type: 'text', text: block.source.data });
    } else {
      parts.push({ type: 'text', text: `[${block.type} ${block.source.file_id}]` });
    }
  }
  if (parts.every((part) => part.type === 'text')) return { type: 'text', text };
  return { type: 'content', parts };
}

/**
 * ctx 执行的工具的结果换成 `user.custom_tool_result` 的内容块和 `is_error`：`json` 序列化成文字，`content` 的图片、
 * PDF 原样交，别的文件写一句说明。空的结果不带内容块。
 */
export function resultBlocksOf(output: ToolOutput): { content: ResultBlock[]; isError: boolean } {
  switch (output.type) {
    case 'text':
      return { content: output.text ? [{ type: 'text', text: output.text }] : [], isError: false };
    case 'json':
      return { content: [{ type: 'text', text: JSON.stringify(output.value) ?? 'null' }], isError: false };
    case 'error':
      return { content: [{ type: 'text', text: output.message || 'The tool failed.' }], isError: true };
    default: {
      const content: ResultBlock[] = [];
      for (const part of output.parts) {
        if (part.type === 'text') {
          if (part.text) content.push({ type: 'text', text: part.text });
        } else if (part.data.type === 'text') content.push({ type: 'text', text: part.data.text });
        else
          content.push(
            fileBlock(part.mediaType, part) ?? { type: 'text', text: fileNote(part.mediaType, part.filename) },
          );
      }
      return { content, isError: false };
    }
  }
}

/** 一次模型请求的用量（`span.model_request_end.model_usage`）换成协议的：输入含缓存读到和写进缓存的，缓存两项是 0 时不写。 */
export function usageOf(usage: BetaManagedAgentsSpanModelUsage | undefined): Usage | undefined {
  if (!usage) return undefined;
  const read = usage.cache_read_input_tokens ?? 0;
  const write = usage.cache_creation_input_tokens ?? 0;
  const input = (usage.input_tokens ?? 0) + read + write;
  const output = usage.output_tokens ?? 0;
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: input + output,
    ...(read > 0 ? { cacheReadTokens: read } : {}),
    ...(write > 0 ? { cacheWriteTokens: write } : {}),
  };
}

/** 两次用量相加，没有的项不出现。 */
export function addUsages(a: Usage | undefined, b: Usage | undefined): Usage | undefined {
  if (!a) return b;
  if (!b) return a;
  const keys: readonly (keyof Usage)[] = [
    'inputTokens',
    'outputTokens',
    'totalTokens',
    'cacheReadTokens',
    'cacheWriteTokens',
    'reasoningTokens',
  ];
  const out: Record<string, number> = {};
  for (const key of keys) {
    if (a[key] !== undefined || b[key] !== undefined) out[key] = (a[key] ?? 0) + (b[key] ?? 0);
  }
  return out;
}

/** 限流、过载重试得过来；上下文过长、计费、MCP 和仓库的错误不行。 */
const RETRYABLE_ERRORS = new Set(['model_overloaded_error', 'model_rate_limited_error', 'unknown_error']);

/**
 * `session.error` 换成 `ErrorInfo`：上下文过长（`isContextOverflowText` 认出它的说法）是 `context_overflow`，
 * 别的是 `managed_agents`，消息前面带上它的 `error.type`；会话要结束（`terminal`）的重试不了。
 */
export function errorOfEvent(event: BetaManagedAgentsSessionErrorEvent): ErrorInfo {
  const { error } = event;
  const message = `${error.type}: ${error.message}`;
  if (isContextOverflowText(error.message)) return { message, type: CONTEXT_OVERFLOW, retryable: false };
  const terminal = error.retry_status.type === 'terminal';
  return { message, type: 'managed_agents', retryable: !terminal && RETRYABLE_ERRORS.has(error.type) };
}
