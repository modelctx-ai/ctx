import type { Awaitable, ContextBuilder, Message } from '@modelctx-ai/ctx-protocol';

import { toChatMessages, type ChatCompletionRequest, type ChatMessage } from './messages.ts';

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
 * 丢掉调用方自己截过的历史，换上 `history()` 给的全文。
 * 调用方的系统提示保留；从它最后一句用户话起的尾巴（之后的工具调用、工具结果、预填的助手话）原样接在后面。
 * 全文最后一条已经是这句用户话（内容逐字相同，图片也算）时，这句不重复带。
 */
export function replaceHistory(
  history: () => Awaitable<readonly Message[]>,
  options: ReplaceHistoryOptions = {},
): Rewrite {
  return async (request) => {
    const incoming: ChatMessage[] = Array.isArray(request.messages) ? request.messages : [];
    const system = options.keepSystem === false ? [] : incoming.filter(isSystem);
    const start = incoming.findLastIndex((message) => message.role === 'user');
    const tail = start < 0 ? [] : incoming.slice(start).filter((message) => !isSystem(message));
    const session = toChatMessages(await history()).filter((message) => message.role !== 'system');
    const last = session.at(-1);
    const repeated =
      last?.role === 'user' &&
      tail[0] !== undefined &&
      JSON.stringify(last.content) === JSON.stringify(tail[0].content);
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
