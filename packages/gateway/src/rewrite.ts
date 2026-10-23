import type { Awaitable, Context, ModelMessage } from '@modelctx-ai/ctx';

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
  history: () => Awaitable<readonly ModelMessage[]>,
  options: ReplaceHistoryOptions = {},
): Rewrite {
  return async (request) => {
    const incoming: ChatMessage[] = Array.isArray(request.messages) ? request.messages : [];
    const system = options.keepSystem === false ? [] : incoming.filter(isSystem);
    const start = incoming.findLastIndex((message) => message.role === 'user');
    const tail = start < 0 ? [] : incoming.slice(start).filter((message) => !isSystem(message));
    const thread = toChatMessages(await history()).filter((message) => message.role !== 'system');
    const last = thread.at(-1);
    const repeated =
      last?.role === 'user' &&
      tail[0] !== undefined &&
      JSON.stringify(last.content) === JSON.stringify(tail[0].content);
    return { ...request, messages: [...system, ...thread, ...(repeated ? tail.slice(1) : tail)] };
  };
}

/** 用一个 ctx 上下文的当前视图作为历史。 */
export function withContext(context: Context, options?: ReplaceHistoryOptions): Rewrite {
  return replaceHistory(async () => (await context.view()).messages, options);
}
