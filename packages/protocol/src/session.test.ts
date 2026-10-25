import assert from 'node:assert/strict';

import { describe, test } from 'vite-plus/test';

import {
  compactedEntry,
  compareCursor,
  CTX_EVENTS,
  cursorOf,
  eventEntry,
  filterEntries,
  isFrameworkKind,
  runEndedEntry,
  runStartedEntry,
  summaryEntry,
  textOf,
  userEntry,
  type Entry,
} from './session.ts';

describe('cursor', () => {
  test('先比 at，再比 seq', () => {
    assert.ok(compareCursor({ at: 1, seq: 9 }, { at: 2, seq: 1 }) < 0);
    assert.ok(compareCursor({ at: 2, seq: 2 }, { at: 2, seq: 1 }) > 0);
    assert.equal(compareCursor({ at: 2, seq: 1 }, { at: 2, seq: 1 }), 0);
    const entry = { ...userEntry('x'), id: 'e', session: 's', seq: 3, at: 7 } as Entry;
    assert.deepEqual(cursorOf(entry), { at: 7, seq: 3 });
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
    assert.deepEqual(summaryEntry('摘要', { at: 1, seq: 2 }, { source: 'model' }), {
      type: 'summary',
      text: '摘要',
      covers: { at: 1, seq: 2 },
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
          { type: 'tool-call', toolCallId: 'c', toolName: 't', input: {} },
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
    }));
    assert.equal(filterEntries(entries, { after: entries[0]! }).length, 2);
    assert.equal(filterEntries(entries, { types: ['event'] }).length, 1);
    assert.deepEqual(
      filterEntries(entries, { types: ['message'], last: 1 }).map((entry) => entry.id),
      ['e2'],
    );
    assert.deepEqual(filterEntries(entries, { last: Number.NaN }), []);
    assert.equal(filterEntries(entries, undefined).length, 3);
  });
});

describe('framework events', () => {
  test('kind 是 ctx. 前缀的 {domain}.{action}', () => {
    assert.deepEqual(Object.values(CTX_EVENTS), ['ctx.run.started', 'ctx.run.ended', 'ctx.compacted', 'ctx.error']);
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
    const compacted = compactedEntry({ covers: { at: 1, seq: 2 }, summaryId: 's1' });
    assert.equal(compacted.kind, CTX_EVENTS.compacted);
    assert.deepEqual(JSON.parse(JSON.stringify(compacted)), compacted);
  });
});
