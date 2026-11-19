import {
  DEFAULT_MAX_TOOL_OUTPUT_CHARS,
  limitToolOutput,
  readPendingToolCalls,
  toolResultEntry,
  type Executor,
  type PendingToolCall,
  type SessionStore,
} from '@modelctx-ai/ctx-protocol';

export interface RunPendingToolsOptions {
  /** 执行这些调用的执行环境。出错返回 `{ type: 'error' }` 的照常记成结果；抛出的不记，留给下一次。 */
  readonly executor: Executor;
  /** 它负责哪些工具。不给就用 `executor.tools()` 报的名字；它也不报时，等待中的调用全部交给它。 */
  readonly tools?: readonly string[];
  /** 结果条目的 `source`，缺省是执行环境的名字。 */
  readonly source?: string;
  /** 结果最多多少字符，缺省 `DEFAULT_MAX_TOOL_OUTPUT_CHARS`；0 或 Infinity 不限。 */
  readonly maxOutputChars?: number;
  readonly signal?: AbortSignal;
}

export interface PendingToolsResult {
  /** 这一次执行并记下结果的调用。 */
  readonly executed: readonly PendingToolCall[];
  /** 还等着的调用：不归这个执行环境、在等人确认或者被拒绝了（拒绝由下一轮的 harness 写上），或者执行时抛错了。 */
  readonly remaining: readonly PendingToolCall[];
}

/**
 * 执行方的一步：读会话里等待中的工具调用（`readPendingToolCalls`：最后一轮以 `requires_action` 结束时留下的），
 * 归这个执行环境的逐个执行，每个结果写一条 `toolResultEntry`（带幂等键，两个执行方都执行了也只记先到的）。
 * 等确认的调用只在确认以后执行：还没决定的、被拒绝的不碰。执行方只需要能读写会话存储：在内网的 worker 用
 * `ctx-remote` 的远端存储，只有出站连接。结果都齐了以后，由应用不带输入再跑一轮（`submit({ session, agent })`），
 * 模型从日志接着走。
 */
export async function runPendingTools(
  store: SessionStore,
  session: string,
  options: RunPendingToolsOptions,
): Promise<PendingToolsResult> {
  const pending = await readPendingToolCalls(store, session);
  if (pending.length === 0) return { executed: [], remaining: [] };
  const { executor } = options;
  const names = options.tools ?? (await executor.tools?.())?.map((tool) => tool.name);
  const mine = (item: PendingToolCall): boolean =>
    (names === undefined || names.includes(item.call.name)) &&
    (item.approval === undefined || item.approval.decision?.approved === true);
  const executed: PendingToolCall[] = [];
  const remaining: PendingToolCall[] = pending.filter((item) => !mine(item));
  const limit = options.maxOutputChars ?? DEFAULT_MAX_TOOL_OUTPUT_CHARS;
  for (const item of pending.filter(mine)) {
    options.signal?.throwIfAborted();
    let output;
    try {
      output = await executor.execute(item.call, {
        session,
        runId: item.runId,
        ...(options.signal ? { signal: options.signal } : {}),
      });
    } catch {
      remaining.push(item);
      continue;
    }
    await store.append(session, [
      toolResultEntry(item.call, limitToolOutput(output, limit), { source: options.source ?? executor.name }),
    ]);
    executed.push(item);
  }
  return { executed, remaining };
}
