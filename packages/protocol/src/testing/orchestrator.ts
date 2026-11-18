import assert from 'node:assert/strict';

import type { AgentSpec } from '../harness.ts';
import type { Orchestrator, OrchestratorEvent } from '../orchestrator.ts';
import { CTX_EVENTS, eventEntry, messageEntry, runIdOf, userEntry, type SessionStore } from '../session.ts';

import type { ContractTestApi } from './api.ts';
import type { ModelScript } from './harness.ts';
import { eventData, kinds, lifecycle } from './shared.ts';

export interface OrchestratorFixture {
  readonly orchestrator: Orchestrator;
  /** 编排器底下的 harness 写日志用的存储。 */
  readonly store: SessionStore;
  /** 一个能跑的 agent，模型按剧本回答。 */
  readonly agent: AgentSpec;
}

/** 每个用例调一次，拿到一个空的存储和按这份剧本回答的模型。用例结束时会调 `close`。 */
export type OrchestratorFactory = (setup: ModelScript) => OrchestratorFixture | Promise<OrchestratorFixture>;

async function withOrchestrator(
  factory: OrchestratorFactory,
  setup: ModelScript,
  fn: (fixture: OrchestratorFixture) => Promise<void>,
): Promise<void> {
  const fixture = await factory(setup);
  try {
    await fn(fixture);
  } finally {
    await fixture.orchestrator.close();
  }
}

/** 剧本：按顺序回答 `回答0`、`回答1`…… */
function answers(count: number): ModelScript {
  return { script: Array.from({ length: count }, (_, i) => ({ type: 'text', text: `回答${i}` }) as const) };
}

export function describeOrchestratorContract(
  name: string,
  factory: OrchestratorFactory,
  { describe, test }: ContractTestApi,
): void {
  describe(`Orchestrator contract: ${name}`, () => {
    test('submit 返回句柄，跑完后 status 是 completed', async () => {
      await withOrchestrator(factory, answers(1), async ({ orchestrator, agent }) => {
        const handle = await orchestrator.submit({ session: 's', agent, input: '在吗', runId: 'run-1' });
        assert.equal(handle.runId, 'run-1');
        assert.equal(handle.session, 's');
        const result = await handle.done;
        assert.equal(result.runId, 'run-1');
        assert.equal(result.stopReason, 'end_turn');
        assert.equal(await orchestrator.status('run-1'), 'completed');
        assert.equal(await orchestrator.status('missing'), undefined);
      });
    });

    test('同一会话串行：后一轮的 ctx.run.started 在前一轮的 ctx.run.ended 之后', async () => {
      await withOrchestrator(factory, answers(3), async ({ orchestrator, store, agent }) => {
        const handles = await Promise.all(
          ['一', '二', '三'].map((input) => orchestrator.submit({ session: 's', agent, input })),
        );
        await Promise.all(handles.map((handle) => handle.done));
        const order = (await store.list('s')).flatMap((entry) =>
          entry.type === 'event' && (entry.kind === CTX_EVENTS.runStarted || entry.kind === CTX_EVENTS.runEnded)
            ? [`${entry.kind === CTX_EVENTS.runStarted ? 'start' : 'end'}:${runIdOf(entry)}`]
            : [],
        );
        assert.deepEqual(
          order,
          handles.flatMap((handle) => [`start:${handle.runId}`, `end:${handle.runId}`]),
        );
      });
    });

    test('cancel 排队中的一轮：不跑，done 给出 aborted，status 是 cancelled', async () => {
      await withOrchestrator(factory, answers(2), async ({ orchestrator, store, agent }) => {
        const first = await orchestrator.submit({ session: 's', agent, input: '一' });
        const second = await orchestrator.submit({ session: 's', agent, input: '二' });
        assert.equal(await orchestrator.cancel(second.runId), true);
        assert.equal((await second.done).stopReason, 'aborted');
        assert.equal(await orchestrator.status(second.runId), 'cancelled');
        assert.equal((await first.done).stopReason, 'end_turn');
        assert.equal(await orchestrator.cancel(first.runId), false, '跑完的取消不了');
        assert.equal(await orchestrator.cancel('missing'), false);
        const started = eventData(await store.list('s'), CTX_EVENTS.runStarted).map((data) => data['runId']);
        assert.deepEqual(started, [first.runId]);
      });
    });

    test('events（有时）：给出 queued → running → completed', async () => {
      await withOrchestrator(factory, answers(1), async ({ orchestrator, agent }) => {
        if (!orchestrator.events) return;
        const controller = new AbortController();
        const seen: OrchestratorEvent[] = [];
        const reading = (async () => {
          for await (const event of orchestrator.events!({ signal: controller.signal })) {
            seen.push(event);
            if (event.type === 'run.completed') controller.abort();
          }
        })();
        // 让订阅先挂上。
        await new Promise((resolve) => setTimeout(resolve, 10));
        const handle = await orchestrator.submit({ session: 's', agent, input: '在吗' });
        await handle.done;
        await reading;
        assert.deepEqual(
          seen.filter((event) => event.runId === handle.runId).map((event) => event.type),
          ['run.queued', 'run.running', 'run.completed'],
        );
      });
    });

    test('recover（有时）：给有 started 没有 ended 的运行补 ctx.run.ended（error），再调一次不重复', async () => {
      await withOrchestrator(factory, answers(0), async ({ orchestrator, store }) => {
        if (!orchestrator.recover) return;
        await store.append('crashed', [
          eventEntry(CTX_EVENTS.runStarted, { data: { runId: 'lost', agent: { model: 'm' } } }),
          userEntry('在吗'),
        ]);
        await store.append('fine', [
          eventEntry(CTX_EVENTS.runStarted, { data: { runId: 'ok', agent: { model: 'm' } } }),
          eventEntry(CTX_EVENTS.runEnded, { data: { runId: 'ok', stopReason: 'end_turn' } }),
        ]);
        assert.deepEqual(await orchestrator.recover(), [{ session: 'crashed', runId: 'lost' }]);
        const ended = eventData(await store.list('crashed'), CTX_EVENTS.runEnded);
        assert.deepEqual(
          ended.map((data) => [data['runId'], data['stopReason']]),
          [['lost', 'error']],
        );
        assert.deepEqual(await orchestrator.recover(), []);
      });
    });

    test('recover（有时）：写下了调用、没有结果的工具调用补一条错误结果，再补 ctx.run.ended', async () => {
      await withOrchestrator(factory, answers(0), async ({ orchestrator, store }) => {
        if (!orchestrator.recover) return;
        await store.append('crashed', [
          lifecycle(CTX_EVENTS.runStarted, 'lost'),
          userEntry('两件事'),
          messageEntry({
            role: 'assistant',
            content: [
              { type: 'tool-call', id: 'done', name: 'echo', input: {} },
              { type: 'tool-call', id: 'hung', name: 'echo', input: {} },
            ],
          }),
          messageEntry({
            role: 'tool',
            content: [{ type: 'tool-result', id: 'done', name: 'echo', output: { type: 'text', text: '好了' } }],
          }),
        ]);
        assert.deepEqual(
          (await orchestrator.recover()).map(({ session, runId }) => ({ session, runId })),
          [{ session: 'crashed', runId: 'lost' }],
        );
        const log = await store.list('crashed');
        assert.deepEqual(kinds(log).slice(4), ['tool', CTX_EVENTS.runEnded]);
        const patched = log[4];
        assert.ok(patched?.type === 'message' && patched.message.role === 'tool');
        assert.deepEqual(
          patched.message.content.map((part) => (part.type === 'tool-result' ? [part.id, part.output.type] : [])),
          [['hung', 'error']],
        );
      });
    });

    test('recover（有时）：只收 owner 相同的运行，别的实例的断点不动', async () => {
      await withOrchestrator(factory, answers(0), async ({ orchestrator, store }) => {
        if (!orchestrator.recover) return;
        // 夹具里的编排器没配 owner：没有 owner 的算自己的，写了别的 owner 的不是。
        await store.append('mine', [lifecycle(CTX_EVENTS.runStarted, 'mine-1')]);
        await store.append('theirs', [
          eventEntry(CTX_EVENTS.runStarted, {
            data: { runId: 'theirs-1', agent: { model: 'm' }, owner: 'someone-else' },
          }),
        ]);
        assert.deepEqual(await orchestrator.recover(), [{ session: 'mine', runId: 'mine-1' }]);
        assert.deepEqual(eventData(await store.list('theirs'), CTX_EVENTS.runEnded), [], '别人的运行没被动');
        assert.deepEqual(await orchestrator.recover(), []);
      });
    });

    test('recover（有时）：会话多于一页时每个断掉的运行都补，只看最后一个生命周期事件', async () => {
      await withOrchestrator(factory, answers(0), async ({ orchestrator, store }) => {
        if (!orchestrator.recover) return;
        const crashed = ['s010', 's101', 's199', 's249'];
        for (let i = 0; i < 250; i += 1) {
          const session = `s${String(i).padStart(3, '0')}`;
          const runId = `run-${i}`;
          const entries = [userEntry('在吗'), lifecycle(CTX_EVENTS.runStarted, runId)];
          if (!crashed.includes(session)) entries.push(lifecycle(CTX_EVENTS.runEnded, runId));
          await store.append(session, entries);
        }
        const recovered = await orchestrator.recover();
        assert.deepEqual(recovered.map((run) => run.session).toSorted(), crashed);
        for (const session of crashed) {
          const ended = eventData(await store.list(session), CTX_EVENTS.runEnded);
          assert.deepEqual(
            ended.map((data) => data['stopReason']),
            ['error'],
          );
        }
        assert.deepEqual(await orchestrator.recover(), []);
      });
    });

    test('close 之后不收新运行', async () => {
      const { orchestrator, agent } = await factory(answers(0));
      await orchestrator.close();
      await assert.rejects(Promise.resolve().then(() => orchestrator.submit({ session: 's', agent, input: '在吗' })));
    });
  });
}
