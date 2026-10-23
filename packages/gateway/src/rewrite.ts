import type { Awaitable, Context, ModelMessage } from '@modelctx-ai/ctx';

import { chatText, toChatMessages, type ChatCompletionRequest, type ChatMessage } from './messages.ts';

/** 在请求转发到上游之前改写它。 */
export type Rewrite = (request: ChatCompletionRequest) => Awaitable<ChatCompletionRequest>;

export interface ReplaceHistoryOptions {
  /** 保留调用方的系统提示（system / developer），缺省保留。 */
  readonly keepSystem?: boolean;
}

/**
 * 丢掉调用方自己截过的历史，换上 `history()` 给的全文。
 * 调用方的系统提示和它最后一句用户话保留；如果全文最后一条已经是同一句，就不重复带。
 */
export function replaceHistory(
  history: () => Awaitable<readonly ModelMessage[]>,
  options: ReplaceHistoryOptions = {},
): Rewrite {
  return async (request) => {
    const incoming: ChatMessage[] = Array.isArray(request.messages) ? request.messages : [];
    const system =
      options.keepSystem === false
        ? []
        : incoming.filter((message) => message.role === 'system' || message.role === 'developer');
    const lastUser = incoming.findLast((message) => message.role === 'user');
    const thread = toChatMessages(await history()).filter((message) => message.role !== 'system');
    const tail = thread.at(-1);
    const repeated =
      tail?.role === 'user' && lastUser !== undefined && chatText(tail.content) === chatText(lastUser.content);
    return { ...request, messages: [...system, ...thread, ...(lastUser && !repeated ? [lastUser] : [])] };
  };
}

/** 用一个 ctx 上下文的当前视图作为历史。 */
export function withContext(context: Context, options?: ReplaceHistoryOptions): Rewrite {
  return replaceHistory(async () => (await context.view()).messages, options);
}
