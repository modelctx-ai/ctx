import assert from 'node:assert/strict';

import type { Harness, RunRequest, RunResult } from '@modelctx-ai/ctx-protocol';
import { describe, test } from 'vite-plus/test';

import { createContextBuilder } from './builder.ts';
import { createHarness } from './harness.ts';
import { createOrchestrator } from './orchestrator.ts';
import { createMemoryStore } from './store.ts';
import { createScriptedModel } from './testing.ts';

const agent = { model: 'fake' };

/** 每一轮都卡住，直到测试放行或被取消；记下开始的顺序。 */
function gatedHarness() {
  const started: string[] = [];
  const gates = new Map<string, () => void>();
  const harness: Harness = {
    async run(request: RunRequest): Promise<RunResult> {
      started.push(request.input as string);
      const base = { runId: request.runId!, text: '', messages: [], recorded: [] };
      return new Promise((resolve) => {
        gates.set(request.input as string, () => resolve({ ...base, stopReason: 'end_turn' }));
        request.signal?.addEventListener('abort', () => resolve({ ...base, stopReason: 'aborted' }), { once: true });
      });
    },
  };
  const release = (input: string) => gates.get(input)?.();
  return { harness, started, release };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe('orchestrator', () => {
  test('同一会话串行，不同会话并行', async () => {
    const { harness, started, release } = gatedHarness();
    const orchestrator = createOrchestrator({ harness });
    const a1 = await orchestrator.submit({ session: 'a', agent, input: 'a1' });
    const a2 = await orchestrator.submit({ session: 'a', agent, input: 'a2' });
    const b1 = await orchestrator.submit({ session: 'b', agent, input: 'b1' });
    await tick();
    assert.deepEqual(started, ['a1', 'b1'], 'a2 等 a1，b1 不等');
    assert.equal(await orchestrator.status(a2.runId), 'queued');
    release('a1');
    await a1.done;
    await tick();
    assert.deepEqual(started, ['a1', 'b1', 'a2']);
    release('a2');
    release('b1');
    await Promise.all([a2.done, b1.done]);
    assert.equal(await orchestrator.status(b1.runId), 'completed');
    await orchestrator.close();
    await assert.rejects(orchestrator.submit({ session: 'a', agent, input: 'late' }), /closed/);
  });

  test('cancel 运行中的一轮：harness 收到 signal，状态是 cancelled；调用方的 signal 也能取消', async () => {
    const { harness } = gatedHarness();
    const orchestrator = createOrchestrator({ harness });
    const running = await orchestrator.submit({ session: 's', agent, input: '一' });
    await tick();
    assert.equal(await orchestrator.status(running.runId), 'running');
    assert.equal(await orchestrator.cancel(running.runId), true);
    assert.equal((await running.done).stopReason, 'aborted');
    assert.equal(await orchestrator.status(running.runId), 'cancelled');

    const controller = new AbortController();
    const queued = await orchestrator.submit({ session: 's', agent, input: '二', signal: controller.signal });
    controller.abort();
    assert.equal((await queued.done).stopReason, 'aborted');
    assert.equal(await orchestrator.status(queued.runId), 'cancelled');
    await orchestrator.close();
  });

  test('长期复用同一个 signal：每轮结束后不在上面留 abort 监听', async () => {
    const { harness, release } = gatedHarness();
    const orchestrator = createOrchestrator({ harness });
    const controller = new AbortController();
    const { signal } = controller;
    let active = 0;
    const add = signal.addEventListener.bind(signal);
    const remove = signal.removeEventListener.bind(signal);
    signal.addEventListener = (type, listener, options) => {
      if (type === 'abort') active += 1;
      add(type, listener, options);
    };
    signal.removeEventListener = (type, listener, options) => {
      if (type === 'abort') active -= 1;
      remove(type, listener, options);
    };

    for (const input of ['1', '2', '3']) {
      const handle = await orchestrator.submit({ session: 's', agent, input, signal });
      await tick();
      release(input);
      await handle.done;
      await tick();
    }
    assert.equal(active, 0);

    // 排队中被取消的一轮同样摘掉。
    const running = await orchestrator.submit({ session: 's', agent, input: 'r', signal });
    const queued = await orchestrator.submit({ session: 's', agent, input: 'q', signal });
    await tick();
    await orchestrator.cancel(queued.runId);
    await queued.done;
    release('r');
    await running.done;
    await tick();
    assert.equal(active, 0);
    await orchestrator.close();
  });

  test('harness 抛错时状态是 failed，done reject', async () => {
    const harness: Harness = {
      run: async () => {
        throw new Error('disk full');
      },
    };
    const orchestrator = createOrchestrator({ harness });
    const handle = await orchestrator.submit({ session: 's', agent, input: 'x' });
    await assert.rejects(handle.done, /disk full/);
    assert.equal(await orchestrator.status(handle.runId), 'failed');
    await orchestrator.close();
  });

  test('模型出错的一轮状态是 failed', async () => {
    const store = createMemoryStore();
    const harness = createHarness({ store, context: createContextBuilder({ store }) });
    const orchestrator = createOrchestrator({ harness, store });
    const model = createScriptedModel([{ type: 'error', message: 'boom' }]);
    const handle = await orchestrator.submit({
      session: 's',
      agent: { model, settings: { maxRetries: 0 } },
      input: 'x',
    });
    assert.equal((await handle.done).stopReason, 'error');
    assert.equal(await orchestrator.status(handle.runId), 'failed');
    await orchestrator.close();
  });

  test('recover 跳过自己正在跑的；没有 store 时没有 recover', async () => {
    const store = createMemoryStore();
    const { harness, release } = gatedHarness();
    const orchestrator = createOrchestrator({ harness, store });
    const handle = await orchestrator.submit({ session: 's', agent, input: '一', runId: 'live' });
    await store.append('s', [
      { type: 'event', kind: 'ctx.run.started', data: { runId: 'live', agent: { model: 'fake' } } },
      { type: 'event', kind: 'ctx.run.started', data: { runId: 'dead', agent: { model: 'fake' } } },
    ]);
    assert.deepEqual(await orchestrator.recover?.(), [{ session: 's', runId: 'dead' }]);
    release('一');
    await handle.done;
    await orchestrator.close();
    assert.ok(!('recover' in createOrchestrator({ harness })));
  });
});
