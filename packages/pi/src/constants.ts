// 适配器写进日志的名字（`harness.name`、条目的 `source`、事件的 `kind`）和几句固定的话。

/** 写进 `ctx.run.started` 的 `harness.name`，也是 pi 自带的工具的结果条目的 `source`。 */
export const PI_HARNESS = 'pi';

/** pi 那边的 MCP 服务器名：ctx 的工具在它那里叫 `mcp__ctx__<名字>`。 */
export const PI_MCP_SERVER = 'ctx';

/** 适配器写的事件的 `kind`。 */
export const PI_EVENTS = {
  /**
   * pi 压缩了自己的上下文：`text` 是它写的摘要，`data` 是起因（`reason`）、压缩前的 token 数（`tokensBefore`）、估计的压缩后的
   * token 数（`estimatedTokensAfter`）和留下的第一条（`firstKeptEntryId`）。ctx 的日志不压缩，不写 `summary`。
   */
  compacted: 'pi.compacted',
} as const;

/** 写入冲突后最多重试几次。 */
export const MAX_CONFLICTS = 20;

/** 工具调用没等到结果这一轮就结束了：补给它的错误结果（和参考实现的说法一样）。 */
export const INTERRUPTED = 'The run ended before this tool call returned; its result is unknown.';
