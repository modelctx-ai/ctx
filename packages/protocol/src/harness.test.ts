import assert from 'node:assert/strict';

import { MockLanguageModelV4 } from 'ai/test';
import { describe, test } from 'vite-plus/test';

import {
  afterConflict,
  agentSpecToJson,
  approvalDeniedOutput,
  createSessionQueue,
  endedInFailure,
  isFenced,
  modelName,
  pendingToolCalls,
  readPendingToolCalls,
  REDACTED_HEADER,
  repeatsFailedInput,
  stepMetaOf,
  stepMetaToJson,
  streamRun,
  toolApprovalEntry,
  toolResultEntry,
  type RunEvent,
  type RunPosition,
  type RunRequest,
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
  summaryEntry,
  userEntry,
  type Entry,
  type ListOptions,
  type NewEntry,
  type SessionStore,
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

function storeOf(entries: readonly NewEntry[]): SessionStore {
  const log = stored(entries);
  return { list: async (_session: string, options?: ListOptions) => filterEntries(log, options) } as SessionStore;
}

const started = (runId: string) => eventEntry(CTX_EVENTS.runStarted, { data: { runId, agent: { model: 'm' } } });
const ended = (runId: string, stopReason: string) => eventEntry(CTX_EVENTS.runEnded, { data: { runId, stopReason } });
const calls = (...ids: string[]) =>
  messageEntry({
    role: 'assistant',
    content: ids.map((id) => ({ type: 'tool-call' as const, id, name: 'lookup', input: { id } })),
  });

describe('pendingToolCalls', () => {
  test('带上 ctx.run.ended 记下的外部执行环境；没记的、记的不是字符串的没有', () => {
    const log = stored([
      started('r1'),
      calls('c1', 'c2', 'constructor'),
      eventEntry(CTX_EVENTS.runEnded, {
        data: { runId: 'r1', stopReason: 'requires_action', executors: { c1: 'worker', c2: 7 } },
      }),
    ]);
    assert.deepEqual(
      pendingToolCalls(log).map((item) => [item.call.id, item.executor]),
      [
        ['c1', 'worker'],
        ['c2', undefined],
        ['constructor', undefined],
      ],
    );
    assert.ok(!('executor' in pendingToolCalls(log)[1]!), '没记的不带这个键');
  });

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

  test('等确认的调用带着确认请求和后来追加的决定；同一个请求只认先到的决定，对不上的、自动的不算', () => {
    const log = stored([
      started('r1'),
      messageEntry({
        role: 'assistant',
        content: [
          { type: 'tool-call', id: 'a', name: 'lookup', input: { id: 'a' } },
          { type: 'tool-call', id: 'b', name: 'lookup', input: { id: 'b' } },
          { type: 'tool-call', id: 'c', name: 'lookup', input: { id: 'c' } },
          { type: 'tool-approval-request', approvalId: 'p-a', callId: 'a', reason: '要删文件' },
          { type: 'tool-approval-request', approvalId: 'p-b', callId: 'b' },
          { type: 'tool-approval-request', approvalId: 'p-c', callId: 'c', isAutomatic: true },
        ],
      }),
      ended('r1', 'requires_action'),
      toolApprovalEntry('p-a', { approved: false, reason: '不行' }),
      toolApprovalEntry('p-a', { approved: true }),
      toolApprovalEntry('p-x', { approved: true }),
    ]);
    assert.deepEqual(
      pendingToolCalls(log).map(({ call, approval }) => ({ id: call.id, approval })),
      [
        { id: 'a', approval: { approvalId: 'p-a', reason: '要删文件', decision: { approved: false, reason: '不行' } } },
        { id: 'b', approval: { approvalId: 'p-b' } },
        { id: 'c', approval: undefined },
      ],
    );
    const decided = stored([
      ...log,
      toolResultEntry({ id: 'a', name: 'lookup' }, approvalDeniedOutput({ name: 'lookup' })),
    ]);
    assert.deepEqual(
      pendingToolCalls(decided).map((item) => item.call.id),
      ['b', 'c'],
      '有了结果就不再等',
    );
  });

  test('toolApprovalEntry 带幂等键；approvalDeniedOutput 带上原因', () => {
    const entry = toolApprovalEntry('p-a', { approved: true, reason: '可以' });
    assert.equal(entry.key, 'ctx.tool-approval:p-a');
    assert.deepEqual(entry.message, {
      role: 'tool',
      content: [{ type: 'tool-approval-response', approvalId: 'p-a', approved: true, reason: '可以' }],
    });
    assert.deepEqual(approvalDeniedOutput({ name: 'rm' }, '太危险'), {
      type: 'error',
      message: 'Tool call "rm" was not approved: 太危险',
    });
    assert.deepEqual(approvalDeniedOutput({ name: 'rm' }), {
      type: 'error',
      message: 'Tool call "rm" was not approved.',
    });
  });

  test('readPendingToolCalls：最后一轮以 requires_action 结束时读它起的条目，否则没有', async () => {
    const waiting = storeOf([
      started('r0'),
      calls('x'),
      ended('r0', 'requires_action'),
      started('r1'),
      calls('a'),
      ended('r1', 'requires_action'),
    ]);
    assert.deepEqual(
      (await readPendingToolCalls(waiting, 's')).map((item) => item.call.id),
      ['a'],
    );
    const running = storeOf([started('r1'), calls('a'), ended('r1', 'requires_action'), started('r2')]);
    assert.deepEqual(await readPendingToolCalls(running, 's'), [], '下一轮已经开始了');
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

describe('失败的重试', () => {
  test('endedInFailure：最后一个生命周期事件是停在 error 或 aborted 的 ended', () => {
    assert.equal(endedInFailure(stored([started('r1'), ended('r1', 'error')])), true);
    assert.equal(endedInFailure(stored([started('r1'), ended('r1', 'aborted')])), true);
    assert.equal(endedInFailure(stored([started('r1'), ended('r1', 'end_turn')])), false);
    assert.equal(endedInFailure(stored([ended('r1', 'error'), started('r2')])), false, '下一轮已经开始');
    assert.equal(endedInFailure([]), false);
  });

  test('repeatsFailedInput：往回跳过框架事件和没盖住它的摘要，第一条别的是同样的用户消息', () => {
    const failed = stored([
      started('r1'),
      userEntry('再试一次'),
      ended('r1', 'error'),
      started('r2'),
      ended('r2', 'error'),
    ]);
    assert.equal(repeatsFailedInput(failed, '再试一次'), true, '连着失败几轮也认');
    assert.equal(repeatsFailedInput(failed, '换一句'), false);
    const answered = stored([userEntry('再试一次'), assistantEntry('半句'), ended('r1', 'error')]);
    assert.equal(repeatsFailedInput(answered, '再试一次'), false, '它后面有别的内容');
    const covering = stored([userEntry('再试一次'), summaryEntry('摘要', 1)]);
    assert.equal(repeatsFailedInput(covering, '再试一次'), false, '摘要盖住了它');
    const below = stored([userEntry('早先'), userEntry('再试一次'), summaryEntry('摘要', 1)]);
    assert.equal(repeatsFailedInput(below, '再试一次'), true, '摘要只盖住了更早的');
  });

  test('repeatsFailedInput：外部 harness 自己的事件也跳过；给了 key 只看键', () => {
    const log = stored([userEntry('再试一次', { key: 'k1' }), eventEntry('pi.compacted'), ended('r1', 'error')]);
    assert.equal(repeatsFailedInput(log, '再试一次'), false, '别人的事件不跳过');
    assert.equal(repeatsFailedInput(log, '再试一次', { harness: 'pi' }), true);
    assert.equal(repeatsFailedInput(log, '随便', { key: 'k1' }), true);
    assert.equal(repeatsFailedInput(log, '再试一次', { key: 'k2' }), false);
  });
});

describe('createSessionQueue', () => {
  test('同一个会话一个接一个，别的会话不等', async () => {
    const queue = createSessionQueue();
    const order: string[] = [];
    const first = await queue.enter('s');
    const second = queue.enter('s').then((release) => {
      order.push('second');
      return release;
    });
    const other = await queue.enter('t');
    order.push('other');
    assert.deepEqual(order, ['other'], '第二个还在等');
    first?.();
    (await second)?.();
    other?.();
    assert.deepEqual(order, ['other', 'second']);
  });

  test('排队时 signal 中止：返回 undefined，也不挡后面的；前面没人时不看 signal', async () => {
    const queue = createSessionQueue();
    const first = await queue.enter('s', AbortSignal.abort());
    assert.ok(first, '前面没人，直接开始');
    const controller = new AbortController();
    const second = queue.enter('s', controller.signal);
    const turns: string[] = [];
    const third = queue.enter('s').then((release) => {
      turns.push('third');
      return release;
    });
    controller.abort();
    assert.equal(await second, undefined);
    assert.deepEqual(turns, [], '第三个还在等第一个');
    first();
    const release = await third;
    assert.ok(release);
    release();
    release();
    assert.ok(await queue.enter('s'), '后面的照常排上');
  });

  test('排队时中止的退出以后，新来的还排在正在跑的那一个后面', async () => {
    const queue = createSessionQueue();
    const first = await queue.enter('s');
    assert.ok(first);
    const controller = new AbortController();
    const second = queue.enter('s', controller.signal);
    controller.abort();
    assert.equal(await second, undefined);
    let entered = false;
    const late = queue.enter('s').then((release) => {
      entered = true;
      return release;
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(entered, false, '第一个还没结束');
    first();
    (await late)?.();
    assert.equal(entered, true);
  });
});

describe('streamRun', () => {
  const request: RunRequest = { session: 's', agent: { model: 'm' } };

  test('事件按顺序交出，run 抛的错在最后抛', async () => {
    const seen: string[] = [];
    const stream = streamRun(request, async (_request, emit) => {
      emit({ type: 'run.started', runId: 'r', session: 's' });
      await Promise.resolve();
      emit({ type: 'text.delta', runId: 'r', text: '你好' });
      throw new Error('写日志失败');
    });
    await assert.rejects(async () => {
      for await (const event of stream) seen.push(event.type);
    }, /写日志失败/);
    assert.deepEqual(seen, ['run.started', 'text.delta']);
  });

  test('调用方提前不读了：中止这一轮，等它结束', async () => {
    let finished = false;
    const outer = new AbortController();
    const stream = streamRun({ ...request, signal: outer.signal }, async (inner, emit) => {
      emit({ type: 'run.started', runId: 'r', session: 's' });
      await new Promise((resolve) => inner.signal?.addEventListener('abort', resolve, { once: true }));
      finished = true;
    });
    const events: RunEvent[] = [];
    for await (const event of stream) {
      events.push(event);
      break;
    }
    assert.equal(events.length, 1);
    assert.equal(finished, true);
    assert.equal(outer.signal.aborted, false, '调用方的 signal 不动');
  });
});
