import assert from 'node:assert/strict';

import {
  CTX_EVENTS,
  eventEntry,
  summaryEntry,
  textOf,
  userEntry,
  type Entry,
  type ErasedData,
  type SessionStore,
} from '@modelctx-ai/ctx-protocol';
import { describe, test } from 'vite-plus/test';

import { pruneSession } from './retention.ts';
import { createMemoryStore } from './store.ts';

const DAY = 24 * 60 * 60 * 1000;
const NOW = 100 * DAY;

/** 十条旧消息（第 n 条是 n 天前写的，从最旧的 10 天前到 1 天前），一条盖住前八条的摘要，再两条新消息。 */
async function seed(): Promise<{ store: SessionStore; old: Entry[]; summary: Entry }> {
  const store = createMemoryStore({ now: () => NOW });
  const old = await store.append(
    's',
    Array.from({ length: 10 }, (_, i) => userEntry(`旧 ${i + 1}`, { at: NOW - (10 - i) * DAY })),
  );
  const [summary] = await store.append('s', [summaryEntry('摘要', old[7]!.seq)]);
  await store.append('s', [userEntry('新 1'), userEntry('新 2')]);
  return { store, old, summary: summary! };
}

async function texts(store: SessionStore): Promise<string[]> {
  const entries = await store.list('s', { types: ['message'] });
  return entries.map((entry) => (entry.type === 'message' ? textOf(entry.message) : ''));
}

const LEFT_AFTER_ALL = ['旧 9', '旧 10', '新 1', '新 2'];

describe('pruneSession', () => {
  test('不给选项：被摘要盖住的全删，摘要和之后的不动；再调一次什么都不删', async () => {
    const { store, old, summary } = await seed();
    assert.equal(await pruneSession(store, 's'), 8);
    assert.deepEqual(await texts(store), LEFT_AFTER_ALL);
    assert.deepEqual(await store.list('s', { types: ['summary'] }), [summary]);
    const [record] = await store.list('s', { kinds: [CTX_EVENTS.erased] });
    assert.deepEqual(record?.type === 'event' && (record.data as unknown as ErasedData), {
      op: 'truncate',
      upTo: old[7]!.seq,
      count: 8,
    });
    assert.equal(await pruneSession(store, 's'), 0);
    assert.equal((await store.list('s', { kinds: [CTX_EVENTS.erased] })).length, 1, '没删东西不留记录');
  });

  test('没有摘要的会话不删；不存在的会话是 0', async () => {
    const store = createMemoryStore();
    await store.append('s', [userEntry('一'), userEntry('二')]);
    assert.equal(await pruneSession(store, 's'), 0);
    assert.equal(await pruneSession(store, 's', { keep: 0, maxAgeMs: 0 }), 0);
    assert.equal(await pruneSession(store, 'missing'), 0);
    assert.equal((await store.list('s')).length, 2);
  });

  test('keep：被盖住的条目里最后写入的 N 条留着；N 不小于条数时不删', async () => {
    const { store } = await seed();
    assert.equal(await pruneSession(store, 's', { keep: 8 }), 0);
    assert.equal(await pruneSession(store, 's', { keep: 3.9 }), 5);
    assert.deepEqual(await texts(store), ['旧 6', '旧 7', '旧 8', ...LEFT_AFTER_ALL]);
    assert.equal(await pruneSession(store, 's', { keep: 0 }), 3);
    assert.deepEqual(await texts(store), LEFT_AFTER_ALL);
  });

  test('maxAgeMs：只删过了保留期的；分页读也一样', async () => {
    const { store } = await seed();
    const options = { now: () => NOW, pageSize: 3 };
    assert.equal(await pruneSession(store, 's', { ...options, maxAgeMs: 30 * DAY }), 0);
    // 「旧 4」正好 7 天前，还在保留期内：删前三条。
    assert.equal(await pruneSession(store, 's', { ...options, maxAgeMs: 7 * DAY }), 3);
    assert.deepEqual((await texts(store))[0], '旧 4');
    assert.equal(await pruneSession(store, 's', { ...options, maxAgeMs: 0 }), 5, '全过期也只删到 covers');
    assert.deepEqual(await texts(store), LEFT_AFTER_ALL);
  });

  test('maxAgeMs：补写的旧记录 at 早、seq 大，排在它前面的没过期就不删到它', async () => {
    const store = createMemoryStore({ now: () => NOW });
    const written = await store.append('s', [
      userEntry('很旧', { at: NOW - 9 * DAY }),
      userEntry('还新', { at: NOW - 1 * DAY }),
      userEntry('补写的旧记录', { at: NOW - 8 * DAY }),
    ]);
    await store.append('s', [summaryEntry('摘要', written[2]!.seq)]);
    assert.equal(await pruneSession(store, 's', { maxAgeMs: 3 * DAY, now: () => NOW }), 1);
    assert.deepEqual(await texts(store), ['还新', '补写的旧记录']);
  });

  test('keep 和 maxAgeMs 都给：两个条件都放行的才删', async () => {
    const { store } = await seed();
    // 按条数可以删 6 条，按时间只能删 2 条。
    assert.equal(await pruneSession(store, 's', { keep: 2, maxAgeMs: 8 * DAY, now: () => NOW }), 2);
    assert.deepEqual((await texts(store))[0], '旧 3');
    // 反过来：按时间可以删光，按条数只能再删 1 条。
    assert.equal(await pruneSession(store, 's', { keep: 5, maxAgeMs: 0, now: () => NOW }), 1);
    assert.deepEqual((await texts(store))[0], '旧 4');
  });

  test('选项不合法（负数、NaN、Infinity）：一条都不删', async () => {
    const { store } = await seed();
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.equal(await pruneSession(store, 's', { keep: bad }), 0, `keep ${bad}`);
      assert.equal(await pruneSession(store, 's', { maxAgeMs: bad }), 0, `maxAgeMs ${bad}`);
    }
    assert.equal((await texts(store)).length, 12);
  });

  test('会话里有未结束的运行：不删到它的 ctx.run.started；它结束之后再调才删得到', async () => {
    const store = createMemoryStore();
    const old = await store.append('s', [userEntry('一'), userEntry('二')]);
    const [started] = await store.append('s', [
      eventEntry(CTX_EVENTS.runStarted, { data: { runId: 'r1', agent: { model: 'm' } } }),
      userEntry('这一轮的输入'),
    ]);
    // 运行中途压缩，摘要盖到了这一轮里面。
    await store.append('s', [summaryEntry('摘要', started!.seq + 1)]);
    assert.equal(await pruneSession(store, 's'), 2);
    assert.deepEqual(
      (await store.list('s')).filter((entry) => entry.seq <= started!.seq).map((entry) => entry.seq),
      [started!.seq],
      `只删到 ${old[1]!.seq}`,
    );
    await store.append('s', [eventEntry(CTX_EVENTS.runEnded, { data: { runId: 'r1', stopReason: 'end_turn' } })]);
    assert.equal(await pruneSession(store, 's'), 2, 'started 和输入；上一次的擦除记录 seq 在摘要之后，不在内');
  });

  test('摘要自己不删：covers 不小于自己的 seq 时删到它前一条为止', async () => {
    const store = createMemoryStore();
    const [first] = await store.append('s', [userEntry('一')]);
    const [summary] = await store.append('s', [summaryEntry('手写的摘要', first!.seq + 100)]);
    await store.append('s', [userEntry('之后')]);
    assert.equal(await pruneSession(store, 's'), 1);
    assert.deepEqual(await store.list('s', { types: ['summary'] }), [summary]);
    assert.deepEqual(await texts(store), ['之后']);
  });
});
