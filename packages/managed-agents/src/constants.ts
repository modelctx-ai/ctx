// 适配器写进日志的名字（`harness.name`、条目的 `source`、事件的 `kind`）和几句固定的说法。

/** 写进 `ctx.run.started` 的 `harness.name`，也是 Managed Agents 那边执行的工具的结果条目的 `source`。 */
export const MANAGED_AGENTS_HARNESS = 'managed-agents';

/** 适配器照着写的接口版本（`anthropic-beta` 头），记进 `harness.version`。 */
export const MANAGED_AGENTS_BETA = 'managed-agents-2026-04-01';

/** 适配器写的事件的 `kind`。 */
export const MANAGED_AGENTS_EVENTS = {
  /** Managed Agents 压缩了自己的上下文（`agent.thread_context_compacted`）。ctx 的日志不压缩，不写摘要。 */
  compacted: 'managed-agents.compacted',
} as const;

/** 写入冲突后最多重试几次。 */
export const MAX_CONFLICTS = 20;

/** 事件流断了最多连着重连几次（每次连上都和历史对一遍，按事件 `id` 去重；连上后读到事件就重新算）。 */
export const MAX_RECONNECTS = 5;

/** 工具调用没等到结果这一轮就结束了：补给它的错误结果（和参考实现的说法一样）。 */
export const INTERRUPTED = 'The run ended before this tool call returned; its result is unknown.';

/** 会话停在等结果的调用上、日志里没有它的结果也没有决定：交给 Managed Agents 的说法（同投影给缺结果的调用补的）。 */
export const MISSING_RESULT = 'No result was recorded for this tool call.';
