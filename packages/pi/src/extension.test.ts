import assert from 'node:assert/strict';

import { describe, test } from 'vite-plus/test';

import { extensionSource, type ExtensionConfig } from './extension.ts';

type Handler = (event: Record<string, unknown>, ctx: Record<string, unknown>) => unknown;

/** 把生成的扩展当模块加载，交给它一个记账的 `pi`。 */
async function load(config: ExtensionConfig) {
  const url = `data:text/javascript;base64,${Buffer.from(extensionSource(config)).toString('base64')}`;
  const factory = ((await import(url)) as { default: (pi: unknown) => void }).default;
  const handlers = new Map<string, Handler[]>();
  const servers: [string, Record<string, unknown>][] = [];
  const commands = new Map<string, { handler: Handler }>();
  factory({
    on: (event: string, handler: Handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
    registerMcpServer: (name: string, options: Record<string, unknown>) => servers.push([name, options]),
    registerCommand: (name: string, command: { handler: Handler }) => commands.set(name, command),
  });
  const emit = async (event: string, data: Record<string, unknown>, ctx: Record<string, unknown> = {}) => {
    let result: unknown;
    for (const handler of handlers.get(event) ?? []) result = (await handler({ type: event, ...data }, ctx)) ?? result;
    return result;
  };
  return { servers, commands, emit };
}

const base: ExtensionConfig = { tools: [], deny: {}, maxSteps: 5 };

function assistant(stopReason: string, toolCalls: { id: string; arguments: unknown }[] = []) {
  return {
    role: 'assistant',
    stopReason,
    usage: { totalTokens: 25 },
    content: toolCalls.map((call) => ({ type: 'toolCall', name: 'mcp__ctx__echo', ...call })),
  };
}

describe('pi 的扩展', () => {
  test('注册 ctx 的 MCP 服务器：直接交给模型，令牌放在请求头里', async () => {
    const { servers } = await load({ ...base, server: { name: 'ctx', url: 'http://127.0.0.1:1/mcp', token: 't0k' } });
    assert.deepEqual(servers, [
      ['ctx', { url: 'http://127.0.0.1:1/mcp', headers: { Authorization: 'Bearer t0k' }, exposure: 'direct' }],
    ]);
    assert.deepEqual((await load(base)).servers, [], '没有 ctx 的工具就不注册');
  });

  test('deny 的调用拦下，理由和参考实现一样；别的放行', async () => {
    const { emit } = await load({ ...base, deny: { mcp__ctx__echo: 'echo' } });
    assert.deepEqual(await emit('tool_call', { toolName: 'mcp__ctx__echo', toolCallId: 'a', input: {} }), {
      block: true,
      reason: `Tool call "echo" was denied by the agent's permissions.`,
    });
    assert.equal(await emit('tool_call', { toolName: 'read', toolCallId: 'b', input: {} }), undefined);
  });

  test('ctx 的工具的参数换回模型给的原样（pi 转过的不算），pi 自带的不动', async () => {
    const { emit } = await load({ ...base, tools: ['mcp__ctx__echo'] });
    await emit('message_end', { message: assistant('toolUse', [{ id: 'a', arguments: { text: 42, extra: null } }]) });
    const input: Record<string, unknown> = { text: '42' };
    assert.equal(await emit('tool_call', { toolName: 'mcp__ctx__echo', toolCallId: 'a', input }), undefined);
    assert.deepEqual(input, { text: 42, extra: null });
    const builtin: Record<string, unknown> = { path: 'a.txt', offset: 10 };
    await emit('message_end', {
      message: { ...assistant('toolUse'), content: [{ type: 'toolCall', id: 'b', name: 'read', arguments: {} }] },
    });
    await emit('tool_call', { toolName: 'read', toolCallId: 'b', input: builtin });
    assert.deepEqual(builtin, { path: 'a.txt', offset: 10 });
  });

  test('调了工具的一步结束时，步数到了 maxSteps 就叫停；出错、被中断的步不算，没调工具的不叫停', async () => {
    const { emit } = await load({ ...base, maxSteps: 2 });
    let aborted = 0;
    const ctx = { abort: () => (aborted += 1) };
    const step = (stopReason: string, tools: number) =>
      emit('turn_end', { message: assistant(stopReason), toolResults: Array.from({ length: tools }) }, ctx);
    await step('toolUse', 1);
    await step('error', 0);
    await step('aborted', 0);
    assert.equal(aborted, 0);
    await step('toolUse', 1);
    assert.equal(aborted, 1, '第二步调了工具：叫停');
    const quiet = await load({ ...base, maxSteps: 1 });
    await quiet.emit('turn_end', { message: assistant('stop'), toolResults: [] }, ctx);
    assert.equal(aborted, 1, '没调工具的一步本来就停了');
  });

  test('超了 maxTotalTokens 就叫停', async () => {
    const { emit } = await load({ ...base, maxTotalTokens: 30 });
    let aborted = 0;
    const ctx = { abort: () => (aborted += 1) };
    await emit('turn_end', { message: assistant('toolUse'), toolResults: [{}] }, ctx);
    assert.equal(aborted, 0, '25 个 token，没超');
    await emit('turn_end', { message: assistant('toolUse'), toolResults: [{}] }, ctx);
    assert.equal(aborted, 1, '50 个 token，超了');
  });

  test('要退回时才注册退回的命令：navigateTree 到那一条，不写摘要', async () => {
    assert.equal((await load(base)).commands.size, 0);
    const { commands } = await load({ ...base, rewind: 'ctx-rewind-abc' });
    const calls: unknown[] = [];
    await commands.get('ctx-rewind-abc')?.handler(' e1f2 ' as never, {
      navigateTree: async (...args: unknown[]) => calls.push(args),
    });
    assert.deepEqual(calls, [['e1f2', { summarize: false }]]);
  });
});
