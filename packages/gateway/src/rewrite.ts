import type { Awaitable, ContextBuilder, Message } from '@modelctx-ai/ctx-protocol';

import { toChatMessages, type ChatCompletionRequest, type ChatContentPart, type ChatMessage } from './messages.ts';

/** 在请求转发到上游之前改写它。 */
export type Rewrite = (request: ChatCompletionRequest) => Awaitable<ChatCompletionRequest>;

export interface ReplaceHistoryOptions {
  /** 保留调用方的系统提示（system / developer），缺省保留。 */
  readonly keepSystem?: boolean;
}

function isSystem(message: ChatMessage): boolean {
  return message.role === 'system' || message.role === 'developer';
}

/**
 * 内容的归一形式，比较两条消息说的是不是同一句话用：字符串和分段写法（`[{ type: 'text', text }]`）算一样，
 * 相邻的文字段并成一段，空文字不算；图片只看地址。不少 OpenAI 客户端总用分段写法，日志里存的多半是字符串。
 */
function contentKey(content: ChatMessage['content']): string {
  if (typeof content === 'string') return JSON.stringify(content === '' ? [] : [content]);
  if (!Array.isArray(content)) return '[]';
  const out: unknown[] = [];
  for (const part of content as readonly (ChatContentPart | null)[]) {
    if (typeof part !== 'object' || part === null) continue;
    if (part.type === 'text' && typeof part.text === 'string') {
      if (part.text === '') continue;
      const last = out.at(-1);
      if (typeof last === 'string') out[out.length - 1] = last + part.text;
      else out.push(part.text);
    } else if (part.type === 'image_url') {
      const image = part.image_url as { url?: unknown } | undefined;
      out.push({ image: image?.url });
    } else out.push(part);
  }
  return JSON.stringify(out);
}

/**
 * 工具调用和结果配对：没有结果的调用去掉（助手消息因此什么都不剩时整条去掉），找不到调用的结果去掉。
 * 上游对没配对的 `tool_calls` 多半回 400（没有对真实服务验证）；历史以没做完的工具调用结尾时就是这种情况。
 */
function pairToolCalls(messages: readonly ChatMessage[]): ChatMessage[] {
  const answered = new Set<string>();
  for (const message of messages) {
    if (message.role === 'tool' && typeof message.tool_call_id === 'string') answered.add(message.tool_call_id);
  }
  const called = new Set<string>();
  const out: ChatMessage[] = [];
  for (const message of messages) {
    if (message.role === 'tool') {
      if (typeof message.tool_call_id === 'string' && called.has(message.tool_call_id)) out.push(message);
      continue;
    }
    if (message.role !== 'assistant' || !Array.isArray(message.tool_calls)) {
      out.push(message);
      continue;
    }
    const calls = message.tool_calls.filter((call) => answered.has(call.id));
    for (const call of calls) called.add(call.id);
    if (calls.length === message.tool_calls.length) {
      out.push(message);
      continue;
    }
    const { tool_calls: _dropped, ...rest } = message;
    if (calls.length > 0) out.push({ ...rest, tool_calls: calls });
    else if (contentKey(message.content) !== '[]') out.push(rest);
  }
  return out;
}

/**
 * 丢掉调用方自己截过的历史，换上 `history()` 给的全文。
 * 调用方的系统提示保留；从它最后一句用户话起的尾巴（之后的工具调用、工具结果、预填的助手话）原样接在后面。
 * 调用方没有用户话时，只留它最后一条预填的助手话。
 * 全文最后一条已经是这句用户话（内容相同：字符串和分段写法算一样，图片也算）时，这句不重复带。
 * 全文里没配对的工具调用、工具结果先去掉，再接尾巴。
 */
export function replaceHistory(
  history: () => Awaitable<readonly Message[]>,
  options: ReplaceHistoryOptions = {},
): Rewrite {
  return async (request) => {
    const incoming: ChatMessage[] = Array.isArray(request.messages) ? request.messages : [];
    const system = options.keepSystem === false ? [] : incoming.filter(isSystem);
    const start = incoming.findLastIndex((message) => message.role === 'user');
    const prefill = incoming.at(-1)?.role === 'assistant' ? incoming.slice(-1) : [];
    const tail = start < 0 ? prefill : incoming.slice(start).filter((message) => !isSystem(message));
    const session = pairToolCalls(toChatMessages(await history()).filter((message) => message.role !== 'system'));
    const last = session.at(-1);
    const repeated =
      last?.role === 'user' && tail[0]?.role === 'user' && contentKey(last.content) === contentKey(tail[0].content);
    return { ...request, messages: [...system, ...session, ...(repeated ? tail.slice(1) : tail)] };
  };
}

/** 绑定了会话、能直接给出当前视图的东西，例如 `@modelctx-ai/ctx` 的 `createContext()`。 */
export interface SessionView {
  view(): Promise<{ readonly messages: readonly Message[] }>;
}

/** 按会话名给出视图的东西：协议的 `ContextBuilder` 就是。 */
export type ViewSource = Pick<ContextBuilder, 'view'>;

/**
 * 用一个会话的当前视图作为历史：`withContext(context)` 给绑定了会话的上下文，
 * `withContext(builder, session)` 给一个 `ContextBuilder` 和会话名。
 */
export function withContext(context: SessionView, options?: ReplaceHistoryOptions): Rewrite;
export function withContext(builder: ViewSource, session: string, options?: ReplaceHistoryOptions): Rewrite;
export function withContext(
  source: SessionView | ViewSource,
  second?: string | ReplaceHistoryOptions,
  third?: ReplaceHistoryOptions,
): Rewrite {
  if (typeof second === 'string') {
    const builder = source as ViewSource;
    return replaceHistory(async () => (await builder.view(second)).messages, third);
  }
  const context = source as SessionView;
  return replaceHistory(async () => (await context.view()).messages, second);
}
