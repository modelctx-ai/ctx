import assert from 'node:assert/strict';

import type { ExecutorSessionOptions } from '@modelctx-ai/ctx-protocol';
import { describe, test } from 'vite-plus/test';

import { createContextBuilder } from './builder.ts';
import { createFunctionExecutor } from './executor.ts';
import { createHarness } from './harness.ts';
import { createMemoryStore } from './store.ts';
import { createScriptedModel } from './testing.ts';
import { closeExecutorSessions, createToolRegistry } from './tools.ts';

/** 绑在执行环境 `box` 上的回显工具；`open` 记下每次调用，`failOpen` 时抛错。 */
function setup(failOpen = false) {
  const store = createMemoryStore();
  const box = createFunctionExecutor('box').register({ name: 'echo', inputSchema: { type: 'object' } }, (input) => ({
    type: 'json',
    value: input,
  }));
  const opens: { session: string; options?: ExecutorSessionOptions }[] = [];
  const open = box.open!.bind(box);
  box.open = async (session, options) => {
    opens.push({ session, ...(options ? { options } : {}) });
    if (failOpen) throw new Error('no such image');
    await open(session, options);
  };
  const tools = createToolRegistry().add(box.definition('echo')!);
  const harness = createHarness({ store, context: createContextBuilder({ store }), tools, executors: [box] });
  return { harness, box, opens };
}

const twice = () =>
  createScriptedModel(
    [
      { type: 'tool-call', id: 'c1', input: { n: 1 } },
      { type: 'tool-call', id: 'c2', input: { n: 2 } },
      { type: 'text', text: '好了' },
    ],
    { tool: 'echo' },
  );

describe('每会话的执行环境', () => {
  test('一轮里第一次交给执行环境之前 open 一次，带上 AgentSpec.environment', async () => {
    const { harness, box, opens } = setup();
    const environment = { image: 'python:3.12', network: { allow: ['pypi.org'] } };
    const result = await harness.run({ session: 's', agent: { model: twice(), environment }, input: '跑两次' });
    assert.equal(result.stopReason, 'end_turn');
    assert.equal(opens.length, 1, '两次调用只 open 一次');
    assert.equal(opens[0]?.session, 's');
    assert.deepEqual(opens[0]?.options?.environment, environment);
    assert.deepEqual(box.openSessions(), ['s']);
  });

  test('open 失败：这个执行环境的调用都回错误，模型看得到原因，这一轮照常结束', async () => {
    const { harness } = setup(true);
    const model = twice();
    const result = await harness.run({ session: 's', agent: { model }, input: '跑' });
    assert.equal(result.stopReason, 'end_turn');
    assert.match(JSON.stringify(model.doGenerateCalls[1]!.prompt), /could not prepare session \\"s\\".*no such image/);
  });

  test('closeExecutorSessions：没有 close 的跳过，一个失败不挡别的', async () => {
    const { box } = setup();
    await box.open!('s');
    const execute = box.execute.bind(box);
    const broken = { name: 'broken', execute, close: () => Promise.reject(new Error('gone')) };
    const plain = { name: 'plain', execute };
    const report = await closeExecutorSessions([box, broken, plain], 's');
    assert.deepEqual(report.closed, ['box']);
    assert.deepEqual(
      report.failed.map((item) => item.executor),
      ['broken'],
    );
    assert.deepEqual(box.openSessions(), []);
  });
});
