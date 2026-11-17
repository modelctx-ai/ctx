import assert from 'node:assert/strict';

import { CTX_EVENTS, type Entry, type SessionStore } from '@modelctx-ai/ctx-protocol';
import { tool } from 'ai';
import { z } from 'zod';
import { describe, test } from 'vite-plus/test';

import { createContextBuilder } from './builder.ts';
import { createHarness } from './harness.ts';
import { createOrchestrator } from './orchestrator.ts';
import { createMemoryStore } from './store.ts';
import { createScriptedModel } from './testing.ts';
import { createToolRegistry } from './tools.ts';

function kinds(entries: readonly Entry[]): string[] {
  return entries.map((entry) =>
    entry.type === 'event' ? entry.kind : entry.type === 'message' ? entry.message.role : entry.type,
  );
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(check(), '等到了');
}

/** 永远不返回的工具：模拟进程在工具执行时崩掉。 */
const never = new Promise<never>(() => {});

/**
 * 一个做第 `n` 步的工具；`hangAt` 那一步不返回（`abortable` 时被取消才以错误返回）。每次执行时记下日志里已经有什么。
 */
function steps(store: SessionStore, hangAt?: number, abortable = false) {
  const executed: number[] = [];
  const seen: string[][] = [];
  const tools = createToolRegistry().addTool(
    'step',
    tool({
      description: '做一步',
      inputSchema: z.object({ n: z.number() }),
      execute: async ({ n }, { abortSignal }) => {
        executed.push(n);
        seen.push(kinds(await store.list('s')));
        if (n === hangAt && abortable && abortSignal) {
          return new Promise<never>((_, reject) => {
            abortSignal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
          });
        }
        if (n === hangAt) return never;
        return `第${n}步完成`;
      },
    }),
  );
  return { tools, executed, seen };
}

const twoSteps = [
  { type: 'tool-call', id: 'c1', input: { n: 1 } },
  { type: 'tool-call', id: 'c2', input: { n: 2 } },
  { type: 'text', text: '两步都做完了' },
] as const;

const BEFORE_FIRST = [CTX_EVENTS.runStarted, 'user', 'assistant'];
const BEFORE_SECOND = [...BEFORE_FIRST, 'tool', 'assistant'];

describe('每一步即时落日志', () => {
  for (const mode of ['run', 'stream'] as const) {
    test(`${mode}：工具执行前日志里已经有这次调用，前一步的结果也在`, async () => {
      const store = createMemoryStore();
      const { tools, seen } = steps(store);
      const harness = createHarness({ store, context: createContextBuilder({ store }), tools });
      const agent = { model: createScriptedModel(twoSteps, { tool: 'step' }) };
      if (mode === 'run') {
        assert.equal((await harness.run({ session: 's', agent, input: '做两步' })).stopReason, 'end_turn');
      } else {
        const types: string[] = [];
        for await (const event of harness.stream({ session: 's', agent, input: '做两步' })) types.push(event.type);
        assert.equal(types.at(-1), 'run.ended');
      }
      assert.deepEqual(seen, [BEFORE_FIRST, BEFORE_SECOND]);
      assert.deepEqual(kinds(await store.list('s')), [...BEFORE_SECOND, 'tool', 'assistant', CTX_EVENTS.runEnded]);
    });
  }

  test('工具执行时取消：调用和工具报的错都在日志里，再写 ctx.run.ended（aborted）', async () => {
    const store = createMemoryStore();
    const { tools, executed } = steps(store, 1, true);
    const harness = createHarness({ store, context: createContextBuilder({ store }), tools });
    const controller = new AbortController();
    const running = harness.run({
      session: 's',
      agent: { model: createScriptedModel(twoSteps, { tool: 'step' }) },
      input: '做两步',
      signal: controller.signal,
    });
    await until(() => executed.length === 1);
    controller.abort(new Error('用户取消'));
    const result = await running;
    assert.equal(result.stopReason, 'aborted');
    const log = await store.list('s');
    assert.deepEqual(kinds(log), [...BEFORE_FIRST, 'tool', CTX_EVENTS.runEnded]);
    assert.match(JSON.stringify(log[3]), /cancelled/);
  });

  test('模型在第二步出错：第一步的调用和结果留在日志里', async () => {
    const store = createMemoryStore();
    const { tools } = steps(store);
    const harness = createHarness({ store, context: createContextBuilder({ store }), tools });
    const model = createScriptedModel(
      [
        { type: 'tool-call', id: 'c1', input: { n: 1 } },
        { type: 'error', message: 'model exploded' },
      ],
      { tool: 'step' },
    );
    const result = await harness.run({ session: 's', agent: { model, settings: { maxRetries: 0 } }, input: '做' });
    assert.equal(result.stopReason, 'error');
    assert.deepEqual(kinds(await store.list('s')), [...BEFORE_FIRST, 'tool', CTX_EVENTS.error, CTX_EVENTS.runEnded]);
  });
});

describe('崩溃后续跑', () => {
  test('第二次工具执行时进程没了：recover 补上结果并续跑到 end_turn，第一次的工具不重复执行', async () => {
    const store = createMemoryStore();
    // 进程一：第二步的工具不返回，这一轮永远不结束。
    const crashed = steps(store, 2);
    const first = createHarness({ store, context: createContextBuilder({ store }), tools: crashed.tools });
    void first.run({
      session: 's',
      agent: { model: createScriptedModel(twoSteps, { tool: 'step' }), name: 'worker' },
      input: '做两步',
    });
    await until(() => crashed.executed.length === 2);
    assert.deepEqual(kinds(await store.list('s')), BEFORE_SECOND);

    // 进程二：同一个库，新的 harness 和编排器。
    const restarted = steps(store);
    const model = createScriptedModel([{ type: 'text', text: '第二步结果未知，先停在这里' }], { tool: 'step' });
    const resumed: string[] = [];
    const orchestrator = createOrchestrator({
      harness: createHarness({ store, context: createContextBuilder({ store }), tools: restarted.tools }),
      store,
      resume: (run) => {
        resumed.push(`${run.agent['name'] as string}:${run.interrupted}`);
        return { model };
      },
    });
    const [recovered, ...others] = await orchestrator.recover!();
    assert.deepEqual(others, []);
    assert.equal(recovered?.session, 's');
    assert.equal(typeof recovered?.resumed, 'string');
    assert.deepEqual(resumed, ['worker:1']);
    await orchestrator.close();

    const log = await store.list('s');
    assert.deepEqual(kinds(log), [
      ...BEFORE_SECOND,
      'tool',
      CTX_EVENTS.runEnded,
      CTX_EVENTS.runStarted,
      'assistant',
      CTX_EVENTS.runEnded,
    ]);
    const ended = log.flatMap((entry) =>
      entry.type === 'event' && entry.kind === CTX_EVENTS.runEnded ? [entry.data as Record<string, unknown>] : [],
    );
    assert.deepEqual(
      ended.map((data) => data['stopReason']),
      ['error', 'end_turn'],
    );
    assert.equal(ended[1]?.['runId'], recovered?.resumed);
    assert.deepEqual(restarted.executed, [], '续跑没有再执行工具');
    const prompt = JSON.stringify(model.doGenerateCalls[0]!.prompt);
    assert.match(prompt, /第1步完成/);
    assert.match(prompt, /its result is unknown/);
    assert.deepEqual(await orchestrator.recover!(), []);
  });

  test('不给 resume：只补结果和 ctx.run.ended，不续跑', async () => {
    const store = createMemoryStore();
    const crashed = steps(store, 1);
    void createHarness({ store, context: createContextBuilder({ store }), tools: crashed.tools }).run({
      session: 's',
      agent: { model: createScriptedModel(twoSteps, { tool: 'step' }) },
      input: '做两步',
    });
    await until(() => crashed.executed.length === 1);
    const orchestrator = createOrchestrator({
      harness: createHarness({ store, context: createContextBuilder({ store }) }),
      store,
    });
    const [recovered] = await orchestrator.recover!();
    assert.equal(recovered?.resumed, undefined);
    assert.deepEqual(kinds(await store.list('s')), [...BEFORE_FIRST, 'tool', CTX_EVENTS.runEnded]);
    await orchestrator.close();
  });
});
