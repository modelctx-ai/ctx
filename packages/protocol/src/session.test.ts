import assert from 'node:assert/strict';

import { describe, test } from 'vite-plus/test';

import {
  compactedEntry,
  compareEntries,
  ctxErrorEntry,
  ctxEventData,
  CTX_EVENTS,
  erasedEntry,
  eventEntry,
  filterEntries,
  filterSessions,
  isEvent,
  isFrameworkKind,
  lastHarnessRun,
  runEndedEntry,
  runIdOf,
  runStartedEntry,
  summaryEntry,
  userEntry,
  type Entry,
  type NewEntry,
} from './session.ts';
import { textOf } from './message.ts';
import { ENTRY_VERSION } from './version.ts';

function entryAt(seq: number, at: number): Entry {
  return { ...userEntry('x'), id: `e${seq}`, session: 's', seq, at, v: ENTRY_VERSION };
}

describe('compareEntries', () => {
  test('投影顺序：先比 at，同一时刻再比 seq；位置不看 at', () => {
    assert.ok(compareEntries(entryAt(9, 1), entryAt(1, 2)) < 0);
    assert.ok(compareEntries(entryAt(2, 2), entryAt(1, 2)) > 0);
    assert.equal(compareEntries(entryAt(1, 2), entryAt(1, 2)), 0);
  });
});

describe('entries', () => {
  test('构造函数只带给了的字段', () => {
    assert.deepEqual(userEntry('在吗', { key: 'k', source: 'user' }), {
      type: 'message',
      message: { role: 'user', content: '在吗' },
      key: 'k',
      source: 'user',
    });
    assert.deepEqual(eventEntry('pet.whisper'), { type: 'event', kind: 'pet.whisper' });
    assert.deepEqual(summaryEntry('摘要', 2, { source: 'model' }), {
      type: 'summary',
      text: '摘要',
      covers: 2,
      source: 'model',
    });
  });

  test('textOf 只取文字分段', () => {
    assert.equal(textOf({ role: 'user', content: '纯文字' }), '纯文字');
    assert.equal(
      textOf({
        role: 'assistant',
        content: [
          { type: 'text', text: '查' },
          { type: 'tool-call', id: 'c', name: 't', input: {} },
          { type: 'text', text: '一下' },
        ],
      }),
      '查一下',
    );
  });

  test('filterEntries 就是 ListOptions 的语义', () => {
    const entries = [userEntry('1'), eventEntry('pet.whisper', { text: '2' }), userEntry('3')].map((draft, i) => ({
      ...draft,
      id: `e${i}`,
      session: 's',
      seq: i + 1,
      at: 10,
      v: ENTRY_VERSION,
    }));
    assert.equal(filterEntries(entries, { after: 1 }).length, 2);
    assert.equal(filterEntries(entries, { after: 0 }).length, 3);
    assert.equal(filterEntries(entries, { types: ['event'] }).length, 1);
    assert.deepEqual(
      filterEntries(entries, { types: ['message'], last: 1 }).map((entry) => entry.id),
      ['e2'],
    );
    assert.deepEqual(filterEntries(entries, { last: Number.NaN }), []);
    assert.equal(filterEntries(entries, undefined).length, 3);
    assert.deepEqual(
      filterEntries(entries, { kinds: ['pet.whisper'] }).map((entry) => entry.id),
      ['e1'],
    );
    assert.deepEqual(filterEntries(entries, { kinds: [] }), []);
    assert.deepEqual(filterEntries(entries, { kinds: ['pet.whisper'], types: ['message'] }), []);
  });

  test('filterSessions：码点升序，字面前缀，after 不含，limit 向下取整', () => {
    const names = ['b', 'a%b', 'ab', 'a', '😀', 'Ａ', 'a'];
    assert.deepEqual(filterSessions(names, undefined), ['a', 'a', 'a%b', 'ab', 'b', 'Ａ', '😀']);
    assert.deepEqual(filterSessions(names, { prefix: 'a%' }), ['a%b']);
    assert.deepEqual(filterSessions(names, { after: 'ab', limit: 2.5 }), ['b', 'Ａ']);
    assert.deepEqual(filterSessions(names, { limit: 0 }), []);
    assert.deepEqual(filterSessions(names, { limit: Number.NaN }), []);
    assert.equal(filterSessions(names, { limit: Number.POSITIVE_INFINITY }).length, 7);
  });
});

describe('framework events', () => {
  test('kind 是 ctx. 前缀的 {domain}.{action}', () => {
    assert.deepEqual(Object.values(CTX_EVENTS), [
      'ctx.run.started',
      'ctx.run.ended',
      'ctx.compacted',
      'ctx.error',
      'ctx.unreadable',
      'ctx.erased',
      'ctx.redacted',
    ]);
    assert.ok(Object.values(CTX_EVENTS).every(isFrameworkKind));
    assert.equal(isFrameworkKind('pet.whisper'), false);
  });

  test('构造的事件 data 能序列化，没给的可选字段不出现', () => {
    const started = runStartedEntry({ runId: 'r1', agent: { model: 'openai/gpt-5' } }, { key: 'r1:start' });
    assert.deepEqual(started, {
      type: 'event',
      kind: 'ctx.run.started',
      key: 'r1:start',
      data: { runId: 'r1', agent: { model: 'openai/gpt-5' } },
    });
    const ended = runEndedEntry({ runId: 'r1', stopReason: 'end_turn', usage: undefined });
    assert.deepEqual(ended.data, { runId: 'r1', stopReason: 'end_turn' });
    const compacted = compactedEntry({ covers: 2, summaryId: 's1' });
    assert.equal(compacted.kind, CTX_EVENTS.compacted);
    assert.deepEqual(JSON.parse(JSON.stringify(compacted)), compacted);
  });
});

/** 给新条目补上存储会填的字段，`seq` 从 1 数。 */
function stored(entries: readonly NewEntry[]): Entry[] {
  return entries.map((entry, index) => ({ ...entry, id: `e${index}`, session: 's', seq: index + 1, at: index, v: 1 }));
}

/** 一条 `data` 随便写的事件，存好了的样子。 */
function read(kind: string, data: unknown): Entry | undefined {
  return stored([eventEntry(kind, { data: data as never })])[0];
}

function harness(name: string, session?: string): { name: string; session?: string } {
  return { name, ...(session ? { session } : {}) };
}

describe('reading framework events', () => {
  test('isEvent 认 kind，runIdOf 只给字符串的 runId', () => {
    const [started, user, odd] = stored([
      runStartedEntry({ runId: 'r1', agent: {} }),
      userEntry('在吗'),
      eventEntry(CTX_EVENTS.runEnded, { data: { runId: 7, stopReason: 'end_turn' } }),
    ]);
    assert.equal(isEvent(started, CTX_EVENTS.runStarted), true);
    assert.equal(isEvent(started, CTX_EVENTS.runEnded), false);
    assert.equal(isEvent(user, CTX_EVENTS.runStarted), false);
    assert.equal(isEvent(undefined, CTX_EVENTS.runStarted), false);
    assert.equal(runIdOf(started), 'r1');
    assert.equal(runIdOf(user), undefined);
    assert.equal(runIdOf(odd), undefined);
  });

  test('ctxEventData 读回各个构造函数写的 data', () => {
    const cases = [
      [
        CTX_EVENTS.runStarted,
        runStartedEntry({
          runId: 'r1',
          agent: { model: 'm' },
          owner: 'o',
          parent: { session: 'p', runId: 'r0', toolCallId: 'c1' },
          harness: { name: 'pi', version: '1.0.0', session: 'x' },
        }),
      ],
      [CTX_EVENTS.runEnded, runEndedEntry({ runId: 'r1', stopReason: 'end_turn', usage: { inputTokens: 3 } })],
      [CTX_EVENTS.runEnded, runEndedEntry({ runId: 'r1', stopReason: 'requires_action', executors: { c1: 'worker' } })],
      [CTX_EVENTS.compacted, compactedEntry({ covers: 2, summaryId: 's1' })],
      [CTX_EVENTS.error, ctxErrorEntry({ runId: 'r1', message: 'boom', type: 'api_call' })],
      [CTX_EVENTS.erased, erasedEntry({ op: 'remove', seqs: [2, 3], count: 2 })],
      [CTX_EVENTS.redacted, eventEntry(CTX_EVENTS.redacted, { data: { type: 'message', role: 'user' } })],
      [
        CTX_EVENTS.unreadable,
        eventEntry(CTX_EVENTS.unreadable, { data: { v: 9, type: 'message', error: { type: 't', message: 'm' } } }),
      ],
    ] as const;
    for (const [kind, entry] of cases) {
      const [back] = stored([entry]);
      assert.deepEqual(ctxEventData(back, kind), entry.data, kind);
      assert.equal(ctxEventData(back, kind === CTX_EVENTS.error ? CTX_EVENTS.runEnded : CTX_EVENTS.error), undefined);
    }
  });

  test('必填字段不对返回 undefined；可选字段只留类型对的，别的键不带', () => {
    assert.equal(ctxEventData(read(CTX_EVENTS.runStarted, { agent: {} }), CTX_EVENTS.runStarted), undefined);
    assert.equal(ctxEventData(read(CTX_EVENTS.runEnded, { runId: 'r1' }), CTX_EVENTS.runEnded), undefined);
    assert.equal(ctxEventData(read(CTX_EVENTS.runEnded, 'r1'), CTX_EVENTS.runEnded), undefined);
    assert.equal(ctxEventData(read(CTX_EVENTS.erased, { op: 'shred', count: 1 }), CTX_EVENTS.erased), undefined);
    assert.equal(
      ctxEventData(read(CTX_EVENTS.compacted, { covers: '2', summaryId: 's' }), CTX_EVENTS.compacted),
      undefined,
    );
    assert.deepEqual(
      ctxEventData(
        read(CTX_EVENTS.runStarted, {
          runId: 'r1',
          owner: 3,
          parent: { session: '', runId: 'r0' },
          harness: { version: '1' },
          extra: true,
        }),
        CTX_EVENTS.runStarted,
      ),
      { runId: 'r1', agent: {} },
      'agent 缺了给 {}；owner、parent、harness 不对的当作没有',
    );
    assert.deepEqual(
      ctxEventData(
        read(CTX_EVENTS.runEnded, { runId: 'r1', stopReason: 'later_reason', usage: { inputTokens: 3, note: 'x' } }),
        CTX_EVENTS.runEnded,
      ),
      { runId: 'r1', stopReason: 'later_reason', usage: { inputTokens: 3 } },
      'stopReason 只查是字符串；usage 只留数字',
    );
    assert.deepEqual(
      ctxEventData(
        read(CTX_EVENTS.runEnded, { runId: 'r1', stopReason: 'requires_action', executors: { c1: 'w', c2: 2 } }),
        CTX_EVENTS.runEnded,
      ),
      { runId: 'r1', stopReason: 'requires_action', executors: { c1: 'w' } },
      'executors 只留值是字符串的',
    );
    for (const executors of [{ c1: 1 }, ['w'], 'w']) {
      assert.deepEqual(
        ctxEventData(
          read(CTX_EVENTS.runEnded, { runId: 'r1', stopReason: 'requires_action', executors }),
          CTX_EVENTS.runEnded,
        ),
        { runId: 'r1', stopReason: 'requires_action' },
      );
    }
    assert.deepEqual(
      ctxEventData(read(CTX_EVENTS.erased, { op: 'truncate', upTo: '3', seqs: [1, 'x'], count: 2 }), CTX_EVENTS.erased),
      { op: 'truncate', count: 2 },
    );
  });

  test('lastHarnessRun：最近一轮这个 harness 记下了会话的运行，和它的 ended', () => {
    const log = stored([
      runStartedEntry({ runId: 'r1', agent: {}, harness: harness('pi', 'old') }),
      runEndedEntry({ runId: 'r1', stopReason: 'end_turn' }),
      runStartedEntry({ runId: 'r2', agent: {}, harness: harness('pi', 'new') }),
      runEndedEntry({ runId: 'r2', stopReason: 'error' }),
      runStartedEntry({ runId: 'r3', agent: {}, harness: harness('claude-code', 'cc') }),
      runStartedEntry({ runId: 'r4', agent: {} }),
      runStartedEntry({ runId: 'r5', agent: {}, harness: harness('pi') }),
    ]);
    const pi = lastHarnessRun(log, 'pi');
    assert.equal(pi?.session, 'new');
    assert.equal(pi?.started.seq, 3);
    assert.equal(pi?.ended?.seq, 4);
    const claude = lastHarnessRun(log, 'claude-code');
    assert.equal(claude?.session, 'cc');
    assert.equal(claude?.ended, undefined, '还没结束');
    assert.equal(lastHarnessRun(log, 'dsh'), undefined);
    assert.equal(lastHarnessRun([], 'pi'), undefined);
  });
});
