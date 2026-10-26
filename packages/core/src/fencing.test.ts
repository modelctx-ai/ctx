import assert from 'node:assert/strict';

import {
  CTX_EVENTS,
  eventEntry,
  userEntry,
  type Entry,
  type NewEntry,
  type SessionStore,
} from '@modelctx-ai/ctx-protocol';
import { MockLanguageModelV4 } from 'ai/test';
import { describe, test } from 'vite-plus/test';

import { createContextBuilder } from './builder.ts';
import { createHarness } from './harness.ts';
import { createOrchestrator } from './orchestrator.ts';
import { createMemoryStore } from './store.ts';

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

/** 模型调用卡在这里，直到 `release()`：测试趁这段时间在日志里动手脚。 */
function gatedModel() {
  const gate = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const model = new MockLanguageModelV4({
    doGenerate: async () => {
      entered.resolve();
      await gate.promise;
      return {
        content: [{ type: 'text' as const, text: '好' }],
        finishReason: { unified: 'stop' as const, raw: 'stop' },
        usage,
        warnings: [],
      };
    },
    doStream: async () => {
      entered.resolve();
      await gate.promise;
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'stream-start', warnings: [] });
            controller.enqueue({ type: 'text-start', id: '1' });
            controller.enqueue({ type: 'text-delta', id: '1', delta: '好' });
            controller.enqueue({ type: 'text-end', id: '1' });
            controller.enqueue({ type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage });
            controller.close();
          },
        }),
      };
    },
  });
  return { model, entered: entered.promise, release: () => gate.resolve() };
}

function setup(store: SessionStore = createMemoryStore()) {
  return { store, harness: createHarness({ store, context: createContextBuilder({ store }) }) };
}

function lifecycleOf(entries: readonly Entry[], kind: string): { runId: unknown; stopReason?: unknown }[] {
  return entries.flatMap((entry) =>
    entry.type === 'event' && entry.kind === kind ? [entry.data as { runId: unknown; stopReason?: unknown }] : [],
  );
}

function roles(entries: readonly Entry[]): string[] {
  return entries.map((entry) =>
    entry.type === 'message' ? entry.message.role : entry.type === 'event' ? entry.kind : entry.type,
  );
}

function answerModel() {
  return new MockLanguageModelV4({
    doGenerate: {
      content: [{ type: 'text', text: '好' }],
      finishReason: { unified: 'stop', raw: 'stop' },
      usage,
      warnings: [],
    },
  });
}

function startedEntry(runId: string, owner?: string): NewEntry {
  return eventEntry(CTX_EVENTS.runStarted, { data: { runId, agent: { model: 'm' }, ...(owner ? { owner } : {}) } });
}

describe('围栏：被 recover 结束的运行', () => {
  test('下一次写入时停下，stopReason 是 aborted，不重复写 ended，也不写模型的产出', async () => {
    const { store, harness } = setup();
    const { model, entered, release } = gatedModel();
    const running = harness.run({ session: 's', agent: { model }, input: '在吗', runId: 'r1' });
    await entered;
    // 另一个进程的编排器把它当作断掉的运行收走了（同一个 owner）。
    const rescuer = createOrchestrator({ harness, store });
    assert.deepEqual(await rescuer.recover?.(), [{ session: 's', runId: 'r1' }]);
    release();
    const result = await running;
    assert.equal(result.stopReason, 'aborted');
    assert.equal(result.error, undefined);
    const log = await store.list('s');
    assert.deepEqual(roles(log), [CTX_EVENTS.runStarted, 'user', CTX_EVENTS.runEnded]);
    assert.deepEqual(lifecycleOf(log, CTX_EVENTS.runEnded), [{ runId: 'r1', stopReason: 'error' }]);
    await rescuer.close();
  });

  test('stream 一样：停下、不重复写 ended', async () => {
    const { store, harness } = setup();
    const { model, entered, release } = gatedModel();
    const types: string[] = [];
    let stopReason: string | undefined;
    const reading = (async () => {
      for await (const event of harness.stream({ session: 's', agent: { model }, input: '在吗', runId: 'r1' })) {
        types.push(event.type);
        if (event.type === 'run.ended') stopReason = event.result.stopReason;
      }
    })();
    await entered;
    const rescuer = createOrchestrator({ harness, store });
    assert.deepEqual(await rescuer.recover?.(), [{ session: 's', runId: 'r1' }]);
    release();
    await reading;
    assert.equal(stopReason, 'aborted');
    assert.equal(types.at(-1), 'run.ended');
    assert.deepEqual(lifecycleOf(await store.list('s'), CTX_EVENTS.runEnded), [{ runId: 'r1', stopReason: 'error' }]);
    await rescuer.close();
  });

  test('模型出错后写 ended 时才发现被围栏：同样不重复写', async () => {
    const { store, harness } = setup();
    const gate = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        entered.resolve();
        await gate.promise;
        throw new Error('boom');
      },
    });
    const running = harness.run({
      session: 's',
      agent: { model, settings: { maxRetries: 0 } },
      input: '在吗',
      runId: 'r1',
    });
    await entered.promise;
    const rescuer = createOrchestrator({ harness, store });
    await rescuer.recover?.();
    gate.resolve();
    assert.equal((await running).stopReason, 'aborted');
    const log = await store.list('s');
    assert.deepEqual(lifecycleOf(log, CTX_EVENTS.runEnded), [{ runId: 'r1', stopReason: 'error' }]);
    assert.ok(!roles(log).includes(CTX_EVENTS.error), '被围栏以后不再写 ctx.error');
    await rescuer.close();
  });

  test('别人只是写了应用事件（没有 ended）：用新的末尾重试，运行照常完成', async () => {
    const { store, harness } = setup();
    const { model, entered, release } = gatedModel();
    const running = harness.run({ session: 's', agent: { model }, input: '在吗', runId: 'r1' });
    await entered;
    await store.append('s', [eventEntry('app.note', { text: '别的进程写的' })]);
    release();
    const result = await running;
    assert.equal(result.stopReason, 'end_turn');
    assert.deepEqual(roles(await store.list('s')), [
      CTX_EVENTS.runStarted,
      'user',
      'app.note',
      'assistant',
      CTX_EVENTS.runEnded,
    ]);
  });
});

describe('owner', () => {
  test('写进 ctx.run.started；请求自己带的 owner 优先', async () => {
    const { store, harness } = setup();
    const orchestrator = createOrchestrator({ harness, store, owner: 'yoyo' });
    await (
      await orchestrator.submit({ session: 'a', agent: { model: answerModel() }, input: '1' })
    ).done;
    await (
      await orchestrator.submit({ session: 'b', agent: { model: answerModel() }, input: '2', owner: 'cli' })
    ).done;
    const owner = async (session: string) =>
      (lifecycleOf(await store.list(session), CTX_EVENTS.runStarted)[0] as { owner?: unknown }).owner;
    assert.equal(await owner('a'), 'yoyo');
    assert.equal(await owner('b'), 'cli');
    await orchestrator.close();
  });

  test('两个编排器配不同 owner 共用一个库：互不收对方的运行', async () => {
    const { store, harness } = setup();
    const a = createOrchestrator({ harness, store, owner: 'a' });
    const b = createOrchestrator({ harness, store, owner: 'b' });
    const none = createOrchestrator({ harness, store });
    await store.append('x', [startedEntry('rx', 'a')]);
    await store.append('y', [startedEntry('ry', 'b')]);
    await store.append('z', [startedEntry('rz')]);
    assert.deepEqual(await a.recover?.(), [{ session: 'x', runId: 'rx' }]);
    assert.deepEqual(await b.recover?.(), [{ session: 'y', runId: 'ry' }]);
    assert.deepEqual(await none.recover?.(), [{ session: 'z', runId: 'rz' }], '都没配置也算相同');
    for (const orchestrator of [a, b, none]) assert.deepEqual(await orchestrator.recover?.(), []);
    await Promise.all([a.close(), b.close(), none.close()]);
  });

  test('两个编排器都在跑各自的运行时，recover 谁的也不收', async () => {
    const { store, harness } = setup();
    const a = createOrchestrator({ harness, store, owner: 'a' });
    const b = createOrchestrator({ harness, store, owner: 'b' });
    const first = gatedModel();
    const second = gatedModel();
    const one = await a.submit({ session: 'x', agent: { model: first.model }, input: '1' });
    const two = await b.submit({ session: 'y', agent: { model: second.model }, input: '2' });
    await Promise.all([first.entered, second.entered]);
    assert.deepEqual(await a.recover?.(), []);
    assert.deepEqual(await b.recover?.(), []);
    first.release();
    second.release();
    assert.equal((await one.done).stopReason, 'end_turn');
    assert.equal((await two.done).stopReason, 'end_turn');
    await Promise.all([a.close(), b.close()]);
  });
});

describe('recover 的前提', () => {
  test('读和写之间会话有了新条目：说明那个运行在动，跳过；下次再看', async () => {
    const base = createMemoryStore();
    let injected = false;
    const store: SessionStore = {
      ...base,
      append: async (session, entries, options) => {
        // 趁 recover 读完、写 ended 之前，那个运行写了一条。
        if (!injected && entries.some((entry) => entry.type === 'event' && entry.kind === CTX_EVENTS.runEnded)) {
          injected = true;
          await base.append(session, [userEntry('还活着')]);
        }
        return base.append(session, entries, options);
      },
    };
    const { harness } = setup(store);
    const orchestrator = createOrchestrator({ harness, store });
    await base.append('s', [eventEntry(CTX_EVENTS.runStarted, { data: { runId: 'r', agent: { model: 'm' } } })]);
    assert.deepEqual(await orchestrator.recover?.(), [], '跳过');
    assert.deepEqual(lifecycleOf(await base.list('s'), CTX_EVENTS.runEnded), []);
    assert.deepEqual(await orchestrator.recover?.(), [{ session: 's', runId: 'r' }], '这次没人动，收走');
    await orchestrator.close();
  });
});
