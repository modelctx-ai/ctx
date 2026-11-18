// 每一轮交给 pi 的扩展（`-e <文件>`）：pi 的扩展是一个 ES 模块，默认导出一个拿到 `pi`（扩展的接口）的函数。适配器把这一轮的
// 配置写进模块里、写进只有自己读得到的临时文件，跑完就删；令牌不出现在命令行里。

export interface ExtensionConfig {
  /** ctx 的工具所在的 MCP 服务器：pi 里的名字、地址和一次性的令牌。这一轮没有 ctx 的工具时不给。 */
  readonly server?: { readonly name: string; readonly url: string; readonly token: string };
  /** ctx 的工具在 pi 里的名字（`mcp__ctx__<名字>`）：它们的参数按 ctx 的规则查。 */
  readonly tools: readonly string[];
  /** 不许调的工具：pi 里的名字 → 拒绝时说的名字（ctx 的工具是它在 ctx 里的名字）。 */
  readonly deny: Readonly<Record<string, string>>;
  /** 第几步之后不再调模型：这一步调了工具，结果照常回来，然后中断。 */
  readonly maxSteps: number;
  readonly maxTotalTokens?: number;
  readonly maxDurationMs?: number;
  /** 退回用的命令名（`/<名字> <条目 id>`）：只在这一轮要退回时注册，名字每轮随机，用户的输入撞不上。 */
  readonly rewind?: string;
}

/**
 * 扩展的源码：
 *
 * - `registerMcpServer`：ctx 的工具直接交给模型（`exposure: 'direct'`），叫 `mcp__<服务器>__<名字>`；
 * - `tool_call`：`deny` 的调用拦下，模型拿到和参考实现一样的拒绝。ctx 的工具的参数换回模型给的原样：pi 执行之前把对不上
 *   schema 的参数转一遍（`42` 当字符串、可选属性的 `null` 当没给……），ctx 的规则是不合 `inputSchema` 的不执行，由 ctx 的
 *   MCP 服务器查出来、作为错误回给模型（同参考实现），日志里记的调用也就是执行的那一个；
 * - `turn_end`：调了工具的一步结束时，步数到了 `maxSteps` 或超了预算就 `ctx.abort()`，pi 不再调模型；出错、被中断的那一步
 *   不算；
 * - `rewind`：`ctx.navigateTree(id, { summarize: false })`，下一句话接在那一条后面，记录文件里分出一支，原来的不改。
 */
export function extensionSource(config: ExtensionConfig): string {
  return `// ctx 的 pi 适配器为这一轮生成的扩展，这一轮结束就删。
const config = ${JSON.stringify(config)};

export default function ctx(pi) {
  if (config.server) {
    pi.registerMcpServer(config.server.name, {
      url: config.server.url,
      headers: { Authorization: 'Bearer ' + config.server.token },
      exposure: 'direct',
    });
  }

  // 模型给的参数（助手消息收齐时），按调用的 id。
  const raw = new Map();
  pi.on('message_end', (event) => {
    const message = event.message;
    if (!message || message.role !== 'assistant' || !Array.isArray(message.content)) return undefined;
    for (const part of message.content) {
      if (part && part.type === 'toolCall' && part.arguments && typeof part.arguments === 'object') {
        raw.set(part.id, part.arguments);
      }
    }
    return undefined;
  });

  pi.on('tool_call', (event) => {
    const original = raw.get(event.toolCallId);
    raw.delete(event.toolCallId);
    if (Object.hasOwn(config.deny, event.toolName)) {
      const name = config.deny[event.toolName];
      return { block: true, reason: 'Tool call "' + name + '" was denied by the agent\\'s permissions.' };
    }
    const input = event.input;
    if (original !== undefined && config.tools.includes(event.toolName) && input && typeof input === 'object') {
      // 原地改：pi 执行的就是这个对象。
      for (const key of Object.keys(input)) delete input[key];
      Object.assign(input, structuredClone(original));
    }
    return undefined;
  });

  const started = Date.now();
  let steps = 0;
  let tokens = 0;
  pi.on('turn_end', (event, ctx) => {
    const message = event.message;
    if (!message || message.role !== 'assistant') return undefined;
    if (message.stopReason === 'error' || message.stopReason === 'aborted') return undefined;
    steps += 1;
    tokens += (message.usage && message.usage.totalTokens) || 0;
    if (!event.toolResults || event.toolResults.length === 0) return undefined;
    const overBudget =
      (config.maxTotalTokens !== undefined && tokens > config.maxTotalTokens) ||
      (config.maxDurationMs !== undefined && Date.now() - started > config.maxDurationMs);
    if (steps >= config.maxSteps || overBudget) ctx.abort();
    return undefined;
  });

  if (config.rewind) {
    pi.registerCommand(config.rewind, {
      description: 'ctx: continue this session from an earlier entry',
      handler: async (args, ctx) => {
        await ctx.navigateTree(args.trim(), { summarize: false });
      },
    });
  }
}
`;
}
