import assert from 'node:assert/strict';

import { CTX_EVENTS, pendingToolCalls, type Entry, type RunEvent } from '@modelctx-ai/ctx-protocol';
import { describe, test } from 'vite-plus/test';

import { createContextBuilder } from './builder.ts';
import { createFunctionExecutor } from './executor.ts';
import { createHarness } from './harness.ts';
import { runPendingTools } from './pending.ts';
import { createMemoryStore } from './store.ts';
import { createScriptedModel } from './testing.ts';
import { createToolRegistry } from './tools.ts';

function kinds(entries: readonly Entry[]): string[] {
  return entries.map((entry) =>
    entry.type === 'event' ? entry.kind : entry.type === 'message' ? entry.message.role : entry.type,
  );
}

/** `lookup` 绑在执行环境 `worker` 上，harness 这一侧没有它的实例。 */
function setup() {
  const store = createMemoryStore();
  const tools = createToolRegistry().add({
    name: 'lookup',
    description: '查内网的订单',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
    executor: 'worker',
  });
  const harness = createHarness({ store, context: createContextBuilder({ store }), tools, external: ['worker'] });
  const calls: string[] = [];
  const worker = createFunctionExecutor('worker').register(
    { name: 'lookup', inputSchema: { type: 'object' } },
    (input) => {
      calls.push(JSON.stringify(input));
      return { type: 'text', text: '订单 42 已发货' };
    },
  );
  return { store, harness, worker, calls };
}

const script = [
  { type: 'tool-call', id: 'c1', input: { id: '42' } },
  { type: 'text', text: '订单 42 已经发货了' },
] as const;

describe('工具调用经日志往返', () => {
  test('绑到外部执行环境的工具：写下调用、以 requires_action 结束；worker 追加结果；下一轮不带输入接着跑', async () => {
    const { store, harness, worker, calls } = setup();
    const model = createScriptedModel(script, { tool: 'lookup' });
    const first = await harness.run({ session: 's', agent: { model }, input: '订单 42 到哪了？' });
    assert.equal(first.stopReason, 'requires_action');
    assert.deepEqual(first.pending, [{ id: 'c1', name: 'lookup', input: { id: '42' } }]);
    assert.deepEqual(kinds(await store.list('s')), [CTX_EVENTS.runStarted, 'user', 'assistant', CTX_EVENTS.runEnded]);
    assert.deepEqual(
      pendingToolCalls(await store.list('s')).map((item) => item.call.id),
      ['c1'],
    );

    // 两个 worker 同时领：都执行了，结果只记一条（幂等键）。
    const [one, two] = await Promise.all([
      runPendingTools(store, 's', { executor: worker }),
      runPendingTools(store, 's', { executor: worker }),
    ]);
    assert.equal(one.executed.length + two.executed.length, 2);
    assert.equal(calls.length, 2);
    const log = await store.list('s');
    assert.deepEqual(kinds(log).slice(-1), ['tool']);
    assert.equal(log.at(-1)?.source, 'worker');
    assert.deepEqual(pendingToolCalls(log), []);
    assert.deepEqual(await runPendingTools(store, 's', { executor: worker }), { executed: [], remaining: [] });

    const second = await harness.run({ session: 's', agent: { model } });
    assert.equal(second.stopReason, 'end_turn');
    assert.equal(second.text, '订单 42 已经发货了');
    assert.match(JSON.stringify(model.doGenerateCalls[1]!.prompt), /订单 42 已发货/);
    assert.equal(calls.length, 2, 'harness 这一侧没有执行');
  });

  test('stream 也一样；不归这个执行环境的调用留在 remaining', async () => {
    const { store, harness } = setup();
    const events: RunEvent[] = [];
    for await (const event of harness.stream({
      session: 's',
      agent: { model: createScriptedModel(script, { tool: 'lookup' }) },
      input: '订单 42？',
    })) {
      events.push(event);
    }
    const ended = events.at(-1);
    assert.equal(ended?.type === 'run.ended' && ended.result.stopReason, 'requires_action');
    assert.deepEqual(ended?.type === 'run.ended' && ended.result.pending?.map((call) => call.id), ['c1']);
    const other = createFunctionExecutor('other').register({ name: 'ping', inputSchema: { type: 'object' } }, () => ({
      type: 'text',
      text: 'pong',
    }));
    const result = await runPendingTools(store, 's', { executor: other });
    assert.deepEqual(result.executed, []);
    assert.deepEqual(
      result.remaining.map((item) => item.call.name),
      ['lookup'],
    );
  });

  test('deny 优先：绑到外部执行环境、权限是 deny 的工具不等别处执行，模型看到拒绝，这一轮继续', async () => {
    const { store, harness, calls } = setup();
    const model = createScriptedModel(script, { tool: 'lookup' });
    const result = await harness.run({
      session: 's',
      agent: { model, permissions: { tools: { lookup: 'deny' } } },
      input: '订单 42？',
    });
    assert.equal(result.stopReason, 'end_turn');
    assert.equal(result.pending, undefined);
    assert.match(JSON.stringify(model.doGenerateCalls[1]!.prompt), /denied by the agent's permissions/);
    assert.deepEqual(pendingToolCalls(await store.list('s')), []);
    assert.deepEqual(calls, []);
  });

  test('结果没来，下一轮照常跑完：之前等着的不再算等待中', async () => {
    const { store, harness } = setup();
    const model = createScriptedModel([...script.slice(0, 1), { type: 'text', text: '查不到' }], { tool: 'lookup' });
    await harness.run({ session: 's', agent: { model }, input: '订单 42？' });
    const next = await harness.run({ session: 's', agent: { model }, input: '算了' });
    assert.equal(next.stopReason, 'end_turn');
    assert.deepEqual(pendingToolCalls(await store.list('s')), []);
  });
});
