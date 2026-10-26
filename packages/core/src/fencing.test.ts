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

describe('同一进程内每会话串行', () => {
  test('同一个 harness 并发两个记录型运行：都成功，两组 started/ended 不交错', async () => {
    const { store, harness } = setup();
    const [a, b] = await Promise.all([
      harness.run({ session: 's', agent: { model: answerModel() }, input: '一', runId: 'r1' }),
      harness.run({ session: 's', agent: { model: answerModel() }, input: '二', runId: 'r2' }),
    ]);
    assert.equal(a.stopReason, 'end_turn');
    assert.equal(b.stopReason, 'end_turn');
    assert.deepEqual(roles(await store.list('s')), [
      CTX_EVENTS.runStarted,
      'user',
      'assistant',
      CTX_EVENTS.runEnded,
      CTX_EVENTS.runStarted,
      'user',
      'assistant',
      CTX_EVENTS.runEnded,
    ]);
  });

  test('stream 和 run 混着并发也是一个接一个；record: false 不排队', async () => {
    const { store, harness } = setup();
    const first = gatedModel();
    const running = harness.run({ session: 's', agent: { model: first.model }, input: '一', runId: 'r1' });
    await first.entered;
    const streamed = (async () => {
      const types: string[] = [];
      for await (const event of harness.stream({
        session: 's',
        agent: { model: answerModel() },
        input: '二',
        runId: 'r2',
      })) {
        types.push(event.type);
      }
      return types;
    })();
    // 不记录的运行不受影响，前一个还卡着也能跑。
    const quiet = await harness.run({ session: 's', agent: { model: answerModel() }, input: '不记', record: false });
    assert.equal(quiet.stopReason, 'end_turn');
    assert.equal((await store.list('s')).length, 2, '第二个记录型运行还没开始');
    first.release();
    await running;
    assert.equal((await streamed).at(-1), 'run.ended');
    assert.deepEqual(
      lifecycleOf(await store.list('s'), CTX_EVENTS.runEnded).map((data) => data.runId),
      ['r1', 'r2'],
    );
  });

  test('两个 harness 实例共用一个 store 并发：第二个拿到 session_busy', async () => {
    const store = createMemoryStore();
    const one = setup(store).harness;
    const two = setup(store).harness;
    const { model, entered, release } = gatedModel();
    const running = one.run({ session: 's', agent: { model }, input: '一', runId: 'r1' });
    await entered;
    const blocked = await two.run({ session: 's', agent: { model: answerModel() }, input: '二', runId: 'r2' });
    assert.equal(blocked.stopReason, 'error');
    assert.equal(blocked.error?.type, 'session_busy');
    release();
    assert.equal((await running).stopReason, 'end_turn');
    assert.deepEqual(
      lifecycleOf(await store.list('s'), CTX_EVENTS.runStarted).map((data) => data.runId),
      ['r1'],
    );
  });

  test('排队时 signal 中止：以 aborted 结束，什么都不写，也不挡住后面的运行', async () => {
    const { store, harness } = setup();
    const { model, entered, release } = gatedModel();
    const running = harness.run({ session: 's', agent: { model }, input: '一', runId: 'r1' });
    await entered;
    const controller = new AbortController();
    const queued = harness.run({
      session: 's',
      agent: { model: answerModel() },
      input: '二',
      runId: 'r2',
      signal: controller.signal,
    });
    const third = harness.run({ session: 's', agent: { model: answerModel() }, input: '三', runId: 'r3' });
    controller.abort();
    const result = await queued;
    assert.equal(result.stopReason, 'aborted');
    assert.deepEqual(result.recorded, []);
    assert.equal((await store.list('s')).length, 2, '只有 r1 的 started 和 user');
    release();
    assert.equal((await running).stopReason, 'end_turn');
    assert.equal((await third).stopReason, 'end_turn');
    assert.deepEqual(
      lifecycleOf(await store.list('s'), CTX_EVENTS.runEnded).map((data) => data.runId),
      ['r1', 'r3'],
    );
  });

  test('排队等过的运行：等完就摘掉 signal 上的 abort 监听', async () => {
    const { harness } = setup();
    const { model, entered, release } = gatedModel();
    const running = harness.run({ session: 's', agent: { model }, input: '一', runId: 'r1' });
    await entered;
    const { signal } = new AbortController();
    let queueListeners = 0;
    const add = signal.addEventListener.bind(signal);
    const remove = signal.removeEventListener.bind(signal);
    // 只数排队时挂的那一个：它在 run 开始之前挂上，模型调用还没开始。
    let counting = true;
    signal.addEventListener = (type, listener, options) => {
      if (type === 'abort' && counting) queueListeners += 1;
      add(type, listener, options);
    };
    signal.removeEventListener = (type, listener, options) => {
      if (type === 'abort' && counting) queueListeners -= 1;
      remove(type, listener, options);
    };
    const queued = harness.run({ session: 's', agent: { model: answerModel() }, input: '二', runId: 'r2', signal });
    await Promise.resolve();
    assert.equal(queueListeners, 1, '排队时挂了一个');
    release();
    await running;
    await new Promise((resolve) => setTimeout(resolve, 0));
    counting = false;
    assert.equal(queueListeners, 0, '轮到它时已经摘掉');
    assert.equal((await queued).stopReason, 'end_turn');
  });

  test('排队时 signal 已经中止（stream）：直接 aborted，不写', async () => {
    const { store, harness } = setup();
    const { model, entered, release } = gatedModel();
    const running = harness.run({ session: 's', agent: { model }, input: '一' });
    await entered;
    let stopReason: string | undefined;
    for await (const event of harness.stream({
      session: 's',
      agent: { model: answerModel() },
      input: '二',
      signal: AbortSignal.abort(),
    })) {
      if (event.type === 'run.ended') stopReason = event.result.stopReason;
    }
    assert.equal(stopReason, 'aborted');
    release();
    await running;
    assert.equal(lifecycleOf(await store.list('s'), CTX_EVENTS.runStarted).length, 1);
  });

  test('编排器的队列和 harness 的队列叠在一起不冲突', async () => {
    const { store, harness } = setup();
    const orchestrator = createOrchestrator({ harness, store });
    const handles = await Promise.all(
      ['一', '二', '三'].map((input) => orchestrator.submit({ session: 's', agent: { model: answerModel() }, input })),
    );
    for (const handle of handles) assert.equal((await handle.done).stopReason, 'end_turn');
    assert.equal(lifecycleOf(await store.list('s'), CTX_EVENTS.runEnded).length, 3);
    await orchestrator.close();
  });
});
