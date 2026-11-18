import assert from 'node:assert/strict';

import { MockLanguageModelV4 } from 'ai/test';
import { describe, test } from 'vite-plus/test';

import {
  afterConflict,
  agentSpecToJson,
  isFenced,
  modelName,
  pendingToolCalls,
  REDACTED_HEADER,
  stepMetaOf,
  stepMetaToJson,
  toolResultEntry,
  type RunPosition,
  type StepMeta,
} from './harness.ts';
import {
  assistantEntry,
  CTX_EVENTS,
  erasedEntry,
  eventEntry,
  filterEntries,
  messageEntry,
  runEndedEntry,
  runStartedEntry,
  userEntry,
  type Entry,
  type ListOptions,
  type NewEntry,
} from './session.ts';

describe('agent spec', () => {
  test('模型对象记成 provider/modelId，名字原样', () => {
    assert.equal(modelName('anthropic/claude-sonnet-5'), 'anthropic/claude-sonnet-5');
    assert.equal(modelName(new MockLanguageModelV4({ provider: 'mock', modelId: 'm1' })), 'mock/m1');
  });

  test('settings.headers 只留名字，值不进日志', () => {
    const json = agentSpecToJson({
      model: 'm',
      settings: { temperature: 0, headers: { authorization: 'Bearer sk-secret', 'x-org': 'acme' } },
    });
    assert.deepEqual(json, {
      model: 'm',
      settings: { temperature: 0, headers: { authorization: REDACTED_HEADER, 'x-org': REDACTED_HEADER } },
    });
    assert.ok(!JSON.stringify(json).includes('sk-secret'));
  });

  test('可序列化部分只带给了的字段', () => {
    const json = agentSpecToJson({
      name: 'pet',
      model: new MockLanguageModelV4({ provider: 'mock', modelId: 'm1' }),
      tools: { tags: ['read'] },
      settings: { temperature: 0.2, stopSequences: ['\n\n'] },
    });
    assert.deepEqual(json, {
      model: 'mock/m1',
      name: 'pet',
      tools: { tags: ['read'] },
      settings: { temperature: 0.2, stopSequences: ['\n\n'] },
    });
    assert.deepEqual(JSON.parse(JSON.stringify(json)), json);
  });
});

/** 给新条目补上存储会填的字段。 */
function stored(entries: readonly NewEntry[]): Entry[] {
  return entries.map((entry, index) => ({ ...entry, id: `e${index}`, session: 's', seq: index + 1, at: index, v: 1 }));
}

const started = (runId: string) => eventEntry(CTX_EVENTS.runStarted, { data: { runId, agent: { model: 'm' } } });
const ended = (runId: string, stopReason: string) => eventEntry(CTX_EVENTS.runEnded, { data: { runId, stopReason } });
const calls = (...ids: string[]) =>
  messageEntry({
    role: 'assistant',
    content: ids.map((id) => ({ type: 'tool-call' as const, id, name: 'lookup', input: { id } })),
  });

describe('pendingToolCalls', () => {
  test('以 requires_action 结束的一轮留下的调用，去掉已经有结果的', () => {
    const log = stored([
      started('r1'),
      calls('a', 'b'),
      ended('r1', 'requires_action'),
      toolResultEntry({ id: 'a', name: 'lookup' }, { type: 'text', text: '好' }),
    ]);
    assert.deepEqual(pendingToolCalls(log), [
      { call: { id: 'b', name: 'lookup', input: { id: 'b' } }, runId: 'r1', seq: 2 },
    ]);
  });

  test('之后又有一轮以别的原因结束：之前等着的作废；没停下等的运行留下的悬空调用不算', () => {
    assert.deepEqual(
      pendingToolCalls(
        stored([started('r1'), calls('a'), ended('r1', 'requires_action'), started('r2'), ended('r2', 'end_turn')]),
      ),
      [],
    );
    assert.deepEqual(pendingToolCalls(stored([started('r1'), calls('a'), ended('r1', 'error')])), []);
    assert.deepEqual(pendingToolCalls(stored([started('r1'), calls('a')])), [], '还在跑的不算');
  });

  test('toolResultEntry 带幂等键', () => {
    assert.equal(toolResultEntry({ id: 'a', name: 'lookup' }, { type: 'text', text: '好' }).key, 'ctx.tool-result:a');
  });
});

/** `meta.step` 随便写的步骤消息，读出来的 `StepMeta`。 */
function readStep(step: unknown): StepMeta | undefined {
  return stepMetaOf(stored([assistantEntry('好', { meta: { step: step as never } })])[0]!);
}

/** r1 这一轮（started 在 seq 1，写了 2、3）之后又追加了 `entries`：从 started 起的事件。 */
function lifecycle(...entries: NewEntry[]): Entry[] {
  return stored([runStartedEntry({ runId: 'r1', agent: {} }), userEntry('x'), userEntry('x'), ...entries]).filter(
    (entry) => entry.type === 'event',
  );
}

describe('StepMeta', () => {
  test('stepMetaToJson 写、stepMetaOf 读回来；没给的字段不出现，字段的顺序不变', () => {
    const meta: StepMeta = {
      runId: 'r1',
      step: 0,
      provider: 'mock',
      modelId: undefined,
      finishReason: 'stop',
      usage: { inputTokens: 10, outputTokens: undefined },
      estimatedInputTokens: 9,
    };
    const json = stepMetaToJson(meta);
    assert.deepEqual(json, {
      runId: 'r1',
      step: 0,
      provider: 'mock',
      finishReason: 'stop',
      usage: { inputTokens: 10 },
      estimatedInputTokens: 9,
    });
    assert.deepEqual(Object.keys(json), ['runId', 'step', 'provider', 'finishReason', 'usage', 'estimatedInputTokens']);
    const [entry] = stored([assistantEntry('好', { meta: { step: json } })]);
    assert.deepEqual(stepMetaOf(entry!), json);
  });

  test('stepMetaOf：runId、step 不对返回 undefined，可选字段只留类型对的', () => {
    assert.equal(readStep({ step: 0 }), undefined);
    assert.equal(readStep({ runId: 'r1', step: '0' }), undefined);
    assert.equal(readStep('r1'), undefined);
    assert.deepEqual(
      readStep({ runId: 'r1', step: 1, modelId: 3, usage: { inputTokens: 'x', outputTokens: 2 }, calibration: 1.5 }),
      {
        runId: 'r1',
        step: 1,
        usage: { outputTokens: 2 },
        calibration: 1.5,
      },
    );
  });
});

describe('fencing', () => {
  // 这一轮：started 在 seq 1，写了 2、3。
  const run: RunPosition = { runId: 'r1', started: 1, recorded: [{ seq: 1 }, { seq: 2 }, { seq: 3 }] };

  test('别人写了应用事件、删了这一轮之前的历史、别的运行结束了：不算', () => {
    assert.equal(isFenced(lifecycle(), run), false);
    assert.equal(isFenced(lifecycle(eventEntry('pet.whisper')), run), false);
    assert.equal(isFenced(lifecycle(runEndedEntry({ runId: 'r0', stopReason: 'error' })), run), false);
    const earlier: RunPosition = { runId: 'r1', started: 5, recorded: [{ seq: 5 }, { seq: 6 }] };
    const log = stored([
      eventEntry('a'),
      eventEntry('b'),
      eventEntry('c'),
      eventEntry('d'),
      runStartedEntry({ runId: 'r1', agent: {} }),
      userEntry('x'),
      erasedEntry({ op: 'truncate', upTo: 4, count: 4 }),
      erasedEntry({ op: 'remove', seqs: [2], count: 1 }),
    ]).filter((entry) => entry.seq >= 5 && entry.type === 'event');
    assert.equal(isFenced(log, earlier), false);
  });

  test('自己的 ended、自己的 started 不在了、擦除动了自己写的条目：被围栏', () => {
    assert.equal(isFenced(lifecycle(runEndedEntry({ runId: 'r1', stopReason: 'error' })), run), true);
    assert.equal(isFenced([], run), true, 'started 被清掉或删到了');
    assert.equal(isFenced(lifecycle(erasedEntry({ op: 'truncate', upTo: 2, count: 2 })), run), true);
    assert.equal(isFenced(lifecycle(erasedEntry({ op: 'remove', seqs: [3], count: 1 })), run), true);
    assert.equal(isFenced(lifecycle(erasedEntry({ op: 'redact', seqs: [2], count: 1 })), run), true);
  });

  test('afterConflict：先读末尾再按规则判，没写 started 时只读末尾', async () => {
    const log: Entry[] = [];
    const append = (...entries: NewEntry[]): void => {
      for (const entry of entries) log.push(...stored([entry]).map((item) => ({ ...item, seq: log.length + 1 })));
    };
    const store = { list: async (_session: string, options?: ListOptions) => filterEntries(log, options) };
    append(runStartedEntry({ runId: 'r1', agent: {} }), userEntry('x'), userEntry('x'), eventEntry('pet.whisper'));
    assert.equal(await afterConflict(store, 's', run), 4, '别人写了应用事件：带新的末尾重试');
    append(runEndedEntry({ runId: 'r1', stopReason: 'error' }));
    assert.equal(await afterConflict(store, 's', run), undefined, '被收走了');
    assert.equal(await afterConflict(store, 's', { runId: 'r2', recorded: [] }), 5);
  });
});
