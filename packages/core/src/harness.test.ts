import assert from 'node:assert/strict';

import { CTX_EVENTS, type Entry, type RunEvent, type SessionStore } from '@modelctx-ai/ctx-protocol';
import { tool } from 'ai';
import { z } from 'zod';
import { describe, test } from 'vite-plus/test';

import { createContextBuilder } from './builder.ts';
import { createFunctionExecutor } from './executor.ts';
import { createHarness, type HarnessOptions } from './harness.ts';
import { createMemoryStore } from './store.ts';
import { createScriptedModel } from './testing.ts';
import { createToolRegistry } from './tools.ts';

function kinds(entries: readonly Entry[]): string[] {
  return entries.map((entry) =>
    entry.type === 'event' ? entry.kind : entry.type === 'message' ? entry.message.role : entry.type,
  );
}

function setup(extra: Partial<HarnessOptions> = {}) {
  const store = extra.store ?? createMemoryStore();
  const tools = createToolRegistry().addTool(
    'weather',
    tool({
      description: '查天气',
      inputSchema: z.object({ city: z.string(), unit: z.enum(['c', 'f']).default('c') }),
      execute: async ({ city, unit }) => `${city}晴，25${unit === 'c' ? '℃' : '℉'}`,
    }),
  );
  const harness = createHarness({ store, context: createContextBuilder({ store }), tools, ...extra });
  return { store, tools, harness };
}

describe('harness', () => {
  test('工具经注册表自带的函数执行环境执行：zod 校验和默认值照常生效', async () => {
    const { store, harness } = setup();
    const model = createScriptedModel(
      [
        { type: 'tool-call', id: 'c1', input: { city: '台北' } },
        { type: 'text', text: '台北晴。' },
      ],
      { tool: 'weather' },
    );
    const result = await harness.run({ session: 's', agent: { model, instructions: '你是助手' }, input: '天气？' });
    assert.equal(result.text, '台北晴。');
    assert.deepEqual(kinds(await store.list('s')), [
      CTX_EVENTS.runStarted,
      'user',
      'assistant',
      'tool',
      'assistant',
      CTX_EVENTS.runEnded,
    ]);
    const second = model.doGenerateCalls[1]!;
    assert.deepEqual(second.prompt[0], { role: 'system', content: '你是助手' });
    assert.match(JSON.stringify(second.prompt.at(-1)), /台北晴，25℃/);
    assert.ok(model.doGenerateCalls[0]!.tools?.some((item) => item.name === 'weather'));
  });

  test('beforeTool 拒绝时模型看到原因，这一轮继续；afterTool 能改写结果', async () => {
    const seen: string[] = [];
    const { harness } = setup({
      hooks: {
        beforeTool: (call) => {
          seen.push(call.name);
          return (call.input as { city?: string }).city === '禁区' ? { allow: false, reason: '主人没同意' } : undefined;
        },
        afterTool: (_call, output) =>
          output.type === 'text' ? { type: 'text', text: `${output.text}（已截断）` } : undefined,
      },
    });
    const denied = createScriptedModel(
      [
        { type: 'tool-call', id: 'c1', input: { city: '禁区' } },
        { type: 'text', text: '不能查。' },
      ],
      { tool: 'weather' },
    );
    const result = await harness.run({ session: 's', agent: { model: denied }, input: '查禁区' });
    assert.equal(result.stopReason, 'end_turn');
    assert.match(JSON.stringify(denied.doGenerateCalls[1]!.prompt.at(-1)), /not allowed: 主人没同意/);

    const allowed = createScriptedModel(
      [
        { type: 'tool-call', id: 'c2', input: { city: '台北' } },
        { type: 'text', text: '好' },
      ],
      { tool: 'weather' },
    );
    await harness.run({ session: 's', agent: { model: allowed }, input: '查台北' });
    assert.match(JSON.stringify(allowed.doGenerateCalls[1]!.prompt.at(-1)), /台北晴，25℃（已截断）/);
    assert.deepEqual(seen, ['weather', 'weather']);
  });

  test('beforeModel 能换掉这次的调用；agent.tools 筛选工具', async () => {
    const { harness } = setup({
      hooks: { beforeModel: (call) => ({ ...call, instructions: `${call.instructions ?? ''}（钩子加的）` }) },
    });
    const model = createScriptedModel([{ type: 'text', text: '好' }]);
    await harness.run({ session: 's', agent: { model, instructions: '原来的', tools: false }, input: '在吗' });
    const call = model.doGenerateCalls[0]!;
    assert.deepEqual(call.prompt[0], { role: 'system', content: '原来的（钩子加的）' });
    assert.equal(call.tools, undefined);
  });

  test('模型出错：返回 error，日志里有 ctx.error 和 ctx.run.ended；执行环境找不到时模型看到错误', async () => {
    const { store, harness } = setup();
    const failing = createScriptedModel([{ type: 'error', message: '401 Unauthorized' }]);
    const result = await harness.run({
      session: 's',
      agent: { model: failing, settings: { maxRetries: 0 } },
      input: '在吗',
    });
    assert.equal(result.stopReason, 'error');
    assert.equal(result.error?.message, '401 Unauthorized');
    assert.deepEqual(kinds(await store.list('s')), [
      CTX_EVENTS.runStarted,
      'user',
      CTX_EVENTS.error,
      CTX_EVENTS.runEnded,
    ]);

    const registry = createToolRegistry().add({ name: 'remote', inputSchema: { type: 'object' }, executor: 'nowhere' });
    const orphan = createHarness({ store, context: createContextBuilder({ store }), tools: registry });
    const model = createScriptedModel(
      [
        { type: 'tool-call', id: 'c1', input: {} },
        { type: 'text', text: '好' },
      ],
      { tool: 'remote' },
    );
    assert.equal((await orphan.run({ session: 'o', agent: { model }, input: 'x' })).stopReason, 'end_turn');
    assert.match(
      JSON.stringify(model.doGenerateCalls[1]!.prompt.at(-1)),
      /executor \\"nowhere\\", which is not available/,
    );
  });

  test('模型名经 models 解析；没给 models 时以 error 结束', async () => {
    const store = createMemoryStore();
    const context = createContextBuilder({ store });
    const model = createScriptedModel([{ type: 'text', text: '好' }]);
    const named = createHarness({ store, context, models: (name) => (name === 'mock/m' ? model : assert.fail(name)) });
    assert.equal((await named.run({ session: 's', agent: { model: 'mock/m' }, input: '在吗' })).text, '好');

    const bare = createHarness({ store, context });
    const result = await bare.run({ session: 't', agent: { model: 'mock/m' }, input: '在吗' });
    assert.equal(result.stopReason, 'error');
    assert.match(result.error?.message ?? '', /pass `models`/);
  });

  test('写日志失败时 run reject', async () => {
    const base = createMemoryStore();
    let writes = 0;
    const store: SessionStore = {
      ...base,
      append: async (session, entries) => {
        writes += 1;
        if (writes > 2) throw new Error('disk full');
        return base.append(session, entries);
      },
    };
    const { harness } = setup({ store });
    const model = createScriptedModel([{ type: 'text', text: '好' }]);
    await assert.rejects(harness.run({ session: 's', agent: { model }, input: '在吗' }), /disk full/);
  });

  test('stream：事件顺序、文字增量、usage；record: false 也有事件但不写日志', async () => {
    const { store, harness } = setup();
    const model = createScriptedModel(
      [
        { type: 'tool-call', id: 'c1', input: { city: '台北' } },
        { type: 'text', text: '台北晴。' },
        { type: 'text', text: '不记' },
      ],
      { tool: 'weather' },
    );
    const events: RunEvent[] = [];
    for await (const event of harness.stream({ session: 's', agent: { model }, input: '天气？' })) events.push(event);
    assert.deepEqual(
      events.map((event) => event.type),
      [
        'run.started',
        'model.started',
        'tool.called',
        'tool.returned',
        'model.ended',
        'model.started',
        'text.delta',
        'model.ended',
        'run.ended',
      ],
    );
    const called = events.find((event) => event.type === 'tool.called');
    assert.deepEqual(called?.type === 'tool.called' && called.call, {
      id: 'c1',
      name: 'weather',
      input: { city: '台北' },
    });
    const returned = events.find((event) => event.type === 'tool.returned');
    assert.deepEqual(returned?.type === 'tool.returned' && returned.output, { type: 'text', text: '台北晴，25℃' });
    const ended = events.at(-1);
    assert.equal(ended?.type === 'run.ended' && ended.result.text, '台北晴。');
    assert.equal(ended?.type === 'run.ended' && ended.result.usage?.inputTokens, 2);
    assert.equal(kinds(await store.list('s')).length, 6);

    const quiet: string[] = [];
    for await (const event of harness.stream({ session: 'q', agent: { model }, input: '嗨', record: false })) {
      quiet.push(event.type);
    }
    assert.deepEqual(quiet, ['run.started', 'model.started', 'text.delta', 'model.ended', 'run.ended']);
    assert.deepEqual(await store.list('q'), []);
  });

  test('stream：调用方提前不读时取消模型调用，照样写 ctx.run.ended', async () => {
    const { store, harness } = setup();
    const model = createScriptedModel([{ type: 'text', text: '很长的一段话' }]);
    for await (const event of harness.stream({ session: 's', agent: { model }, input: '在吗' })) {
      if (event.type === 'run.started') break;
    }
    const log = await store.list('s');
    assert.equal(kinds(log).at(-1), CTX_EVENTS.runEnded);
    const ended = log.at(-1);
    assert.equal(ended?.type === 'event' && (ended.data as { stopReason?: string }).stopReason, 'aborted');
  });

  test('执行环境数组和对象两种写法都行，按名字找', async () => {
    const store = createMemoryStore();
    const remote = createFunctionExecutor('remote').register({ name: 'ping', inputSchema: { type: 'object' } }, () => ({
      type: 'text',
      text: 'pong',
    }));
    const registry = createToolRegistry().add(remote.definition('ping')!);
    for (const executors of [[remote], { remote }]) {
      const harness = createHarness({ store, context: createContextBuilder({ store }), tools: registry, executors });
      const model = createScriptedModel(
        [
          { type: 'tool-call', id: 'c1', input: {} },
          { type: 'text', text: '好' },
        ],
        { tool: 'ping' },
      );
      await harness.run({ session: 's', agent: { model }, record: false, input: 'x' });
      assert.match(JSON.stringify(model.doGenerateCalls[1]!.prompt.at(-1)), /pong/);
    }
  });
});
