// 适配器写进日志的名字（`harness.name`、条目的 `source`、事件的 `kind`）和父会话、子会话共用的说法。

/** 写进 `ctx.run.started` 的 `harness.name`，也是 Claude Code 自带的工具的结果条目的 `source`。 */
export const CLAUDE_CODE_HARNESS = 'claude-code';

/** Claude Code 那边的 MCP 服务器名：ctx 的工具在它那里叫 `mcp__ctx__<名字>`。 */
export const CLAUDE_CODE_MCP_SERVER = 'ctx';

/** 适配器写的事件的 `kind`。 */
export const CLAUDE_CODE_EVENTS = {
  /** Claude Code 自己补的用户消息（输出截断后让模型接着写、催它调结构化输出的工具、中断）：`text` 是那段话。 */
  synthetic: 'claude-code.synthetic',
  /** Claude Code 压缩了自己的上下文：`data` 是它给的 `compact_metadata`。ctx 的日志不压缩，不写摘要。 */
  compacted: 'claude-code.compacted',
} as const;

/** 写入冲突后最多重试几次。 */
export const MAX_CONFLICTS = 20;

/** 工具调用没等到结果这一轮就结束了：补给它的错误结果（和参考实现的说法一样）。 */
export const INTERRUPTED = 'The run ended before this tool call returned; its result is unknown.';
