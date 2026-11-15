import assert from 'node:assert/strict';

import { describe, test } from 'vite-plus/test';

import { eraseEntries, isErased, redactedEntry } from './erase.ts';
import { CTX_EVENTS, erasedEntry, eventEntry, summaryEntry, userEntry, type Entry, type NewEntry } from './session.ts';
import { ENTRY_VERSION } from './version.ts';

function stored(drafts: readonly NewEntry[]): Entry[] {
  return drafts.map((draft, i) => ({ ...draft, id: `e${i + 1}`, session: 's', seq: (i + 1) * 10, at: 100 + i, v: 0 }));
}

const ENTRIES = stored([
  userEntry('一', { key: 'k1', source: 'user', meta: { secret: true } }),
  eventEntry('pet.whisper', { text: '二', data: { x: 1 } }),
  summaryEntry('摘要', 10),
  userEntry('四'),
]);

describe('eraseEntries', () => {
  test('truncate：删掉 seq ≤ upTo 的，记录里的 upTo 是真删掉的最大 seq', () => {
    const { entries, touched, erased } = eraseEntries(ENTRIES, { op: 'truncate', upTo: 25.9 });
    assert.deepEqual(entries, ENTRIES.slice(2));
    assert.deepEqual(touched, ENTRIES.slice(0, 2));
    assert.deepEqual(erased, { op: 'truncate', upTo: 20, count: 2 });
  });

  test('什么都没动时没有 erased，条目原样；upTo 不是有限数时不删', () => {
    for (const upTo of [0, 9, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const result = eraseEntries(ENTRIES, { op: 'truncate', upTo });
      assert.deepEqual(result, { entries: ENTRIES, touched: [] }, String(upTo));
    }
    assert.deepEqual(eraseEntries(ENTRIES, { op: 'remove', ids: ['missing'] }), { entries: ENTRIES, touched: [] });
    assert.deepEqual(eraseEntries([], { op: 'redact', ids: ['e1'] }), { entries: [], touched: [] });
  });

  test('remove：按 id 删，seqs 升序，重复的 id 只算一次', () => {
    const { entries, touched, erased } = eraseEntries(ENTRIES, { op: 'remove', ids: ['e4', 'e2', 'e4', 'nope'] });
    assert.deepEqual(entries, [ENTRIES[0], ENTRIES[2]]);
    assert.deepEqual(touched, [ENTRIES[1], ENTRIES[3]]);
    assert.deepEqual(erased, { op: 'remove', seqs: [20, 40], count: 2 });
  });

  test('redact：原位换成占位，已经是占位的跳过', () => {
    const first = eraseEntries(ENTRIES, { op: 'redact', ids: ['e1', 'e3'] });
    assert.deepEqual(first.erased, { op: 'redact', seqs: [10, 30], count: 2 });
    assert.deepEqual(
      first.entries.map((entry) => [entry.seq, entry.type === 'event' ? entry.kind : entry.type]),
      [
        [10, CTX_EVENTS.redacted],
        [20, 'pet.whisper'],
        [30, CTX_EVENTS.redacted],
        [40, 'message'],
      ],
    );
    const again = eraseEntries(first.entries, { op: 'redact', ids: ['e1', 'e2'] });
    assert.deepEqual(again.erased, { op: 'redact', seqs: [20], count: 1 });
    assert.deepEqual(again.touched, [ENTRIES[1]]);
  });
});

describe('redactedEntry', () => {
  test('留着 id、session、seq、at、key、source，v 是当前版本；内容、meta 不带', () => {
    assert.deepEqual(redactedEntry(ENTRIES[0]), {
      type: 'event',
      kind: 'ctx.redacted',
      id: 'e1',
      session: 's',
      seq: 10,
      at: 100,
      v: ENTRY_VERSION,
      key: 'k1',
      source: 'user',
      data: { type: 'message', role: 'user' },
    });
    assert.deepEqual(redactedEntry(ENTRIES[1]).data, { type: 'event' });
    assert.deepEqual(redactedEntry(ENTRIES[2]).data, { type: 'summary' });
  });

  test('原始行解不了也行：只要位置在；什么都没有时字段是空的', () => {
    const row = { id: 'x', session: 's', seq: 7, at: 9, v: 99, type: 'hologram', message: 'not an object' };
    assert.deepEqual(redactedEntry(row), {
      type: 'event',
      kind: 'ctx.redacted',
      id: 'x',
      session: 's',
      seq: 7,
      at: 9,
      v: ENTRY_VERSION,
      data: { type: 'hologram' },
    });
    assert.deepEqual(redactedEntry(null).data, {});
  });
});

describe('ctx.erased', () => {
  test('erasedEntry 的 source 缺省是 store，可以改；data 是纯 JSON', () => {
    const record = erasedEntry({ op: 'remove', seqs: [3, 5], count: 2 });
    assert.deepEqual(record, {
      type: 'event',
      kind: 'ctx.erased',
      source: 'store',
      data: { op: 'remove', seqs: [3, 5], count: 2 },
    });
    assert.equal(erasedEntry({ op: 'truncate', upTo: 4, count: 4 }, { source: 'mirror' }).source, 'mirror');
  });

  test('isErased：truncate 看 upTo，remove 和 redact 看 seqs', () => {
    assert.equal(isErased({ op: 'truncate', upTo: 4, count: 4 }, 4), true);
    assert.equal(isErased({ op: 'truncate', upTo: 4, count: 4 }, 5), false);
    assert.equal(isErased({ op: 'truncate', count: 0 }, 1), false);
    assert.equal(isErased({ op: 'remove', seqs: [3, 5], count: 2 }, 5), true);
    assert.equal(isErased({ op: 'redact', seqs: [3, 5], count: 2 }, 4), false);
    assert.equal(isErased({ op: 'redact', count: 0 }, 4), false);
  });
});
