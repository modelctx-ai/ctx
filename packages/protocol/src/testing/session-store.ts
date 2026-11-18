import assert from 'node:assert/strict';

import { project } from '../context.ts';
import { isErased } from '../erase.ts';
import type { Message } from '../message.ts';
import {
  assistantEntry,
  CTX_EVENTS,
  ctxEventData,
  eventEntry,
  headSeq,
  isConflict,
  messageEntry,
  summaryEntry,
  userEntry,
  type Entry,
  type NewEntry,
  type SessionStore,
} from '../session.ts';
import { copySession, exportSession, importSession } from '../transfer.ts';
import type { JsonObject, JsonValue } from '../types.ts';
import { ENTRY_VERSION } from '../version.ts';

import type { ContractTestApi } from './api.ts';

/** 工厂要用传进来的 `now` 作为缺省的 `at`。每个用例调一次，拿到一个空的存储。 */
export type SessionStoreFactory = (options: { readonly now: () => number }) => SessionStore | Promise<SessionStore>;

function texts(entries: readonly Entry[]): string[] {
  return entries.map((entry) => {
    if (entry.type === 'message') return typeof entry.message.content === 'string' ? entry.message.content : '[parts]';
    return entry.text ?? '';
  });
}

function batch(tag: string): NewEntry[] {
  return [1, 2, 3, 4].map((n) => userEntry(`${tag}${n}`));
}

/** 会话里的擦除记录（`ctx.erased`）的 `data`，原样，按写入顺序。 */
async function erasures(store: SessionStore, session: string): Promise<(JsonValue | undefined)[]> {
  const records = await store.list(session, { kinds: [CTX_EVENTS.erased] });
  return records.flatMap((entry) => (entry.type === 'event' ? [entry.data] : []));
}

/** 去掉擦除记录之后的条目：只看应用自己写的。 */
function withoutErased(entries: readonly Entry[]): Entry[] {
  return entries.filter((entry) => entry.type !== 'event' || entry.kind !== CTX_EVENTS.erased);
}

/** 占位置用的条目，自己带 `id`：不和别的存储生成的 `id` 撞。 */
function padding(count: number): NewEntry[] {
  return Array.from({ length: count }, (_, n) => userEntry(`pad${n}`, { id: `pad-${n}` }));
}

/** `work` 要抛 `invalid_request`。 */
async function rejected(work: () => Promise<unknown>, what: string): Promise<void> {
  const error = await work().then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  assert.equal((error as { type?: string } | undefined)?.type, 'invalid_request', what);
}

const WATCH_TIMEOUT_MS = 2_000;

/** 取迭代器的下一项，超时就失败，免得一个不出数据的 `watch` 把测试挂住。 */
async function nextWithin<T>(iterator: AsyncIterator<T>, what: string): Promise<IteratorResult<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`watch: ${what} 超过 ${WATCH_TIMEOUT_MS}ms`)), WATCH_TIMEOUT_MS);
  });
  try {
    return await Promise.race([iterator.next(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export function describeSessionStoreContract(
  name: string,
  factory: SessionStoreFactory,
  { describe, test }: ContractTestApi,
): void {
  describe(`SessionStore contract: ${name}`, () => {
    test('存进去的是拷贝：改传进去的草稿、改读出来的条目，日志都不变', async () => {
      const store = await factory({ now: () => 5 });
      const draft = {
        type: 'message' as const,
        message: { role: 'user' as const, content: [{ type: 'text' as const, text: '原话' }] },
        meta: { tags: ['a'] },
      };
      const [written] = await store.append('s', [draft]);
      draft.message.content[0]!.text = '改了草稿';
      draft.meta.tags.push('b');
      (written as { meta?: JsonObject }).meta!['tags'] = ['改了返回值'];
      const [first] = await store.list('s');
      assert.ok(first?.type === 'message');
      assert.deepEqual(first.message.content, [{ type: 'text', text: '原话' }]);
      assert.deepEqual(first.meta, { tags: ['a'] });

      (first.message.content as { text: string }[])[0]!.text = '改了读出来的';
      (first as { meta?: JsonObject }).meta = { tags: ['改了读出来的'] };
      const [again] = await store.list('s');
      assert.ok(again?.type === 'message');
      assert.deepEqual(again.message.content, [{ type: 'text', text: '原话' }]);
      assert.deepEqual(again.meta, { tags: ['a'] });
    });

    test('会话名不能是空串、. 和 ..：每个方法都抛 invalid_request，别的名字照常', async () => {
      const store = await factory({ now: () => 5 });
      for (const session of ['', '.', '..']) {
        const label = JSON.stringify(session);
        await rejected(() => store.append(session, [userEntry('x')]), `append ${label}`);
        await rejected(() => store.list(session), `list ${label}`);
        await rejected(() => store.clear(session), `clear ${label}`);
        await rejected(() => store.truncate(session, 1), `truncate ${label}`);
        await rejected(() => store.remove(session, ['x']), `remove ${label}`);
        await rejected(() => store.redact(session, ['x']), `redact ${label}`);
        if (store.watch) {
          const iterator = store.watch(session)[Symbol.asyncIterator]();
          await rejected(() => iterator.next(), `watch ${label}`);
        }
      }
      assert.deepEqual(await store.sessions(), []);
      for (const session of ['...', '.a', 'a/b', 'a/../b', '100%', '中文 会话', ' ']) {
        await store.append(session, [userEntry(session)]);
        assert.deepEqual(texts(await store.list(session)), [session], JSON.stringify(session));
        assert.equal(await store.clear(session), 1, JSON.stringify(session));
      }
    });

    test('导出再导入到另一个存储：seq 重新分配，摘要盖住的还是那几条', async () => {
      let clock = 1_000;
      const source = await factory({ now: () => clock++ });
      const target = await factory({ now: () => clock++ });
      // 两边的 seq 对不上：源存储先被别的会话占掉一段，目标存储占掉更长的一段。
      await source.append('pad', batch('p'));
      await target.append('pad', padding(12));
      const written = await source.append('s', [...batch('旧'), userEntry('问'), assistantEntry('答')]);
      const covers = written[3]!.seq;
      const [summary] = await source.append('s', [summaryEntry('前四句的摘要', covers, { source: 'compactor' })]);
      await source.append('s', [
        eventEntry('ctx.compacted', { data: { covers, summaryId: summary!.id } }),
        userEntry('再问', { key: 'k1', meta: { lang: 'zh' } }),
      ]);

      const chunks: string[] = [];
      for await (const chunk of exportSession(source, 's', { pageSize: 3 })) chunks.push(chunk);
      const result = await importSession(target, chunks, { batchSize: 2 });
      assert.equal(result.session, 's');
      assert.equal(result.read, 9);
      assert.equal(result.written, 9);
      assert.equal(result.skipped, 0);

      const before = await source.list('s');
      const after = await target.list('s');
      assert.deepEqual(texts(after), texts(before));
      assert.deepEqual(
        after.map((entry) => [entry.id, entry.at, entry.key, entry.source, entry.meta]),
        before.map((entry) => [entry.id, entry.at, entry.key, entry.source, entry.meta]),
        'id、at、key、source、meta 原样带过去',
      );
      const moved = after.find((entry) => entry.type === 'summary');
      assert.ok(moved?.type === 'summary');
      assert.equal(moved.covers, after[3]!.seq, 'covers 换成目标存储里同一条的 seq');
      assert.equal(result.remap(covers), after[3]!.seq);
      assert.equal(result.remap(before[0]!.seq - 1), 0, '第一条之前是会话开头');
      const compacted = after.find((entry) => entry.type === 'event' && entry.kind === 'ctx.compacted');
      assert.deepEqual(compacted?.type === 'event' && compacted.data, {
        covers: after[3]!.seq,
        summaryId: summary!.id,
      });
      assert.deepEqual(project(after).messages, project(before).messages, '投影出来的消息一样');
      assert.equal(project(after).messages.length, 4, '摘要、问、答、再问');
    });

    test('导入可以重来：同一份文件导两次只有一份，截断的文件报错之后拿完整的接上', async () => {
      let clock = 1_000;
      const source = await factory({ now: () => clock++ });
      const target = await factory({ now: () => clock++ });
      const written = await source.append('s', batch('m'));
      await source.append('s', [summaryEntry('摘要', written[1]!.seq), userEntry('后来')]);
      let file = '';
      for await (const chunk of exportSession(source, 's')) file += chunk;

      const lines = file.trimEnd().split('\n');
      const cut = `${lines.slice(0, 4).join('\n')}\n`;
      const error = await importSession(target, cut).then(
        () => undefined,
        (thrown: unknown) => thrown,
      );
      assert.equal((error as { type?: string } | undefined)?.type, 'invalid_request', '没有结束行的文件是截断的');
      assert.deepEqual(texts(await target.list('s')), ['m1', 'm2', 'm3'], '读到的部分已经写进去');

      const resumed = await importSession(target, file);
      assert.equal(resumed.written, 3);
      assert.equal(resumed.skipped, 3);
      const again = await importSession(target, file);
      assert.equal(again.written, 0);
      assert.equal(again.skipped, 6);
      const after = await target.list('s');
      assert.deepEqual(texts(after), ['m1', 'm2', 'm3', 'm4', '摘要', '后来']);
      const summary = after[4]!;
      assert.equal(summary.type === 'summary' && summary.covers, after[1]!.seq, '接上之后 covers 仍然指对');
      assert.equal(again.remap(written[1]!.seq), after[1]!.seq, '跳过的条目也找得回位置');
    });

    test('copySession：同一个存储里复制成另一个会话，id 重新生成，引用跟着换', async () => {
      let clock = 1_000;
      const store = await factory({ now: () => clock++ });
      const written = await store.append('a', batch('m'));
      const [summary] = await store.append('a', [summaryEntry('摘要', written[2]!.seq)]);
      await store.append('a', [
        eventEntry('ctx.compacted', { data: { covers: written[2]!.seq, summaryId: summary!.id } }),
      ]);

      const kept = await copySession(store, 'a', store, 'b', { ids: 'keep' }).then(
        () => undefined,
        (thrown: unknown) => thrown,
      );
      assert.equal((kept as { type?: string } | undefined)?.type, 'conflict', '保留 id 写不进同一个存储');
      assert.deepEqual(await store.list('b'), []);

      const result = await copySession(store, 'a', store, 'b');
      assert.equal(result.written, 6);
      const original = await store.list('a');
      const copy = await store.list('b');
      assert.deepEqual(texts(copy), texts(original));
      const originalIds = new Set(original.map((entry) => entry.id));
      assert.ok(
        copy.every((entry) => !originalIds.has(entry.id)),
        '每一条都是新的 id',
      );
      const copied = copy[4]!;
      assert.equal(copied.type === 'summary' && copied.covers, copy[2]!.seq);
      const compacted = copy[5]!;
      assert.deepEqual(compacted.type === 'event' && compacted.data, { covers: copy[2]!.seq, summaryId: copied.id });
      assert.deepEqual(texts(await store.list('a')), texts(original), '源会话不动');

      const mapped = await copySession(store, 'a', store, 'c', { ids: (id) => `c:${id}` });
      const again = await copySession(store, 'a', store, 'c', { ids: (id) => `c:${id}` });
      assert.equal(mapped.written, 6);
      assert.equal(again.written, 0, 'id 有固定的映射时重复复制不写第二份');
      const third = await store.list('c');
      assert.deepEqual(third[5]!.type === 'event' && third[5]!.data, {
        covers: third[2]!.seq,
        summaryId: `c:${summary!.id}`,
      });
    });

    test('导出和导入带上擦除：涂改的占位留在原位，擦除记录只留还指得到的位置', async () => {
      let clock = 1_000;
      const source = await factory({ now: () => clock++ });
      const target = await factory({ now: () => clock++ });
      await target.append('pad', padding(4));
      const written = await source.append('s', batch('m'));
      await source.redact('s', [written[1]!.id]);
      await source.remove('s', [written[2]!.id]);
      await source.append('s', [userEntry('后来')]);

      const result = await copySession(source, 's', target, 's');
      const after = await target.list('s');
      assert.deepEqual(
        after.map((entry) => (entry.type === 'event' ? entry.kind : entry.type)),
        ['message', 'ctx.redacted', 'message', 'ctx.erased', 'ctx.erased', 'message'],
      );
      assert.equal(result.written, 6);
      const records = after.filter((entry) => entry.type === 'event' && entry.kind === 'ctx.erased');
      assert.deepEqual(
        records.map((entry) => entry.type === 'event' && entry.data),
        [
          { op: 'redact', seqs: [after[1]!.seq], count: 1 },
          { op: 'remove', seqs: [], count: 1 },
        ],
      );
    });

    test('list 按 seq 返回：补写的旧记录排在写入的位置，不按 at 插回去', async () => {
      let clock = 1_000;
      const store = await factory({ now: () => clock++ });
      await store.append('s', [userEntry('二'), userEntry('三')]);
      await store.append('s', [userEntry('一', { at: 10 })]);
      await store.append('s', [userEntry('四')]);
      const listed = await store.list('s');
      assert.deepEqual(texts(listed), ['二', '三', '一', '四']);
      assert.ok(
        listed.every((entry, i) => i === 0 || entry.seq > listed[i - 1]!.seq),
        'seq 在会话内严格递增，按写入顺序分配',
      );
      assert.ok(listed[0]!.seq >= 1, 'seq 从 1 起；0 表示会话开头');
      assert.deepEqual(texts(await store.list('s', { last: 2 })), ['一', '四'], 'last 是 seq 最大的 N 条');
    });

    test('补写旧记录之后 list(after) 仍然给出它：位置是 seq，不是 at', async () => {
      let clock = 1_000;
      const store = await factory({ now: () => clock++ });
      const [a, b] = await store.append('s', [userEntry('a'), userEntry('b')]);
      await store.append('s', [{ type: 'summary', text: '摘要', covers: b!.seq }]);
      await store.append('s', [userEntry('late', { at: a!.at - 1 })]);
      await store.append('s', [userEntry('c')]);
      assert.deepEqual(texts(await store.list('s', { after: b!.seq })), ['摘要', 'late', 'c']);
      assert.deepEqual(texts(await store.list('s', { after: 0 })), ['a', 'b', '摘要', 'late', 'c']);
    });

    test('同一时刻按写入先后排', async () => {
      const store = await factory({ now: () => 5 });
      await store.append('s', [eventEntry('pet.whisper', { text: 'a' }), eventEntry('pet.whisper', { text: 'b' })]);
      await store.append('s', [eventEntry('pet.whisper', { text: 'c' })]);
      assert.deepEqual(texts(await store.list('s')), ['a', 'b', 'c']);
    });

    test('clear 之后 seq 不回退、不复用', async () => {
      const store = await factory({ now: Date.now });
      const before = await store.append('s', [userEntry('1'), userEntry('2')]);
      await store.clear('s');
      const [after] = await store.append('s', [userEntry('3')]);
      assert.ok(after!.seq > before[1]!.seq, `${after!.seq} 应大于 ${before[1]!.seq}`);
    });

    test('幂等键和 id 重复时跳过，只返回真正写入的', async () => {
      const store = await factory({ now: Date.now });
      const first = await store.append('s', [userEntry('在吗', { key: 'k1' }), userEntry('在吗', { key: 'k1' })]);
      assert.equal(first.length, 1);
      assert.equal((await store.append('s', [userEntry('在吗', { key: 'k1' })])).length, 0);
      assert.equal((await store.append('other', [userEntry('在吗', { key: 'k1' })])).length, 1, '键按会话隔离');
      assert.equal((await store.append('s', [assistantEntry('x', { id: first[0]!.id })])).length, 0);
      assert.equal((await store.append('other', [assistantEntry('x', { id: first[0]!.id })])).length, 0, 'id 全局唯一');
      assert.equal((await store.list('s')).length, 1);
    });

    test('一批里有重复的条目：其余照写、重复的跳过，返回的就是写进去的', async () => {
      let clock = 0;
      const store = await factory({ now: () => (clock += 1) });
      await store.append('s', [userEntry('原有', { id: 'dup' })]);
      const written = await store.append('s', [
        userEntry('1'),
        userEntry('和已有的 id 重复', { id: 'dup' }),
        userEntry('2', { id: 'fresh' }),
        userEntry('和同批的 id 重复', { id: 'fresh' }),
        userEntry('3', { key: 'k' }),
        userEntry('和同批的键重复', { key: 'k' }),
      ]);
      assert.deepEqual(texts(written), ['1', '2', '3']);
      assert.ok(written.every((entry) => entry.session === 's'));
      assert.ok(
        written.every((entry, i) => i === 0 || entry.seq > written[i - 1]!.seq),
        '同一批的 seq 递增',
      );
      const listed = await store.list('s');
      assert.deepEqual(texts(listed), ['原有', '1', '2', '3']);
      assert.deepEqual(
        listed.slice(1).map((entry) => entry.id),
        written.map((entry) => entry.id),
      );
    });

    test('并发追加的两批不交错', async () => {
      const store = await factory({ now: () => 7 });
      await Promise.all([store.append('s', batch('a')), store.append('s', batch('b'))]);
      const order = texts(await store.list('s')).join(',');
      assert.ok(order === 'a1,a2,a3,a4,b1,b2,b3,b4' || order === 'b1,b2,b3,b4,a1,a2,a3,a4', order);
    });

    test('after、last、types 可以组合', async () => {
      let clock = 0;
      const store = await factory({ now: () => (clock += 10) });
      const written = await store.append('s', [
        userEntry('1'),
        eventEntry('pet.whisper', { text: '2' }),
        userEntry('3'),
        userEntry('4'),
      ]);
      assert.deepEqual(texts(await store.list('s', { after: written[1]!.seq })), ['3', '4']);
      assert.deepEqual(texts(await store.list('s', { types: ['message'], last: 2 })), ['3', '4']);
      assert.deepEqual(texts(await store.list('s', { types: ['event'] })), ['2']);
      assert.deepEqual(await store.list('s', { last: 0 }), []);
    });

    test('limit 取最早的 N 条，和 after 配合向前翻页；过滤之后再取；和 last 同时给时先取 last', async () => {
      const store = await factory({ now: Date.now });
      await store.append('s', [
        userEntry('1'),
        eventEntry('pet.whisper', { text: '2' }),
        userEntry('3'),
        eventEntry('pet.whisper', { text: '4' }),
        userEntry('5'),
      ]);
      await store.append('other', [userEntry('别的会话')]);
      assert.deepEqual(texts(await store.list('s', { limit: 2 })), ['1', '2']);
      const pages: string[][] = [];
      for (let after = 0; ;) {
        const page = await store.list('s', { after, limit: 2 });
        pages.push(texts(page));
        if (page.length < 2) break;
        after = page.at(-1)!.seq;
      }
      assert.deepEqual(pages, [['1', '2'], ['3', '4'], ['5']]);
      assert.deepEqual(texts(await store.list('s', { types: ['message'], limit: 2 })), ['1', '3']);
      assert.deepEqual(texts(await store.list('s', { kinds: ['pet.whisper'], limit: 1 })), ['2']);
      assert.deepEqual(texts(await store.list('s', { last: 3, limit: 2 })), ['3', '4']);
      assert.deepEqual(texts(await store.list('s', { limit: 99 })), ['1', '2', '3', '4', '5']);
      assert.deepEqual(texts(await store.list('s', { limit: 1.9 })), ['1']);
      for (const n of [0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
        assert.deepEqual(await store.list('s', { limit: n }), [], `limit: ${n}`);
      }
    });

    test('last 向下取整，不是有限正数时返回空', async () => {
      const store = await factory({ now: Date.now });
      await store.append('s', [userEntry('a'), userEntry('b'), userEntry('c')]);
      const last = async (n: number) => texts(await store.list('s', { last: n }));
      assert.deepEqual(await last(1.5), ['c']);
      assert.deepEqual(await last(2.9), ['b', 'c']);
      for (const n of [0.5, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
        assert.deepEqual(await last(n), [], `last: ${n}`);
      }
    });

    test('kinds 只要 kind 在其中的事件，消息和摘要不返回，与 types 取交集', async () => {
      let clock = 0;
      const store = await factory({ now: () => (clock += 10) });
      const [, , , , , , last] = await store.append('s', [
        userEntry('消息'),
        eventEntry('pet.whisper', { text: '甲' }),
        eventEntry('pet.reminder', { text: '乙' }),
        { type: 'summary', text: '摘要', covers: 1 },
        eventEntry('pet.whisper', { text: '丙' }),
        eventEntry('ctx.run.started', { text: '丁', data: { runId: 'r' } }),
        eventEntry('pet.whisper', { text: '戊' }),
      ]);
      const listKinds = async (
        list: string[],
        more: { after?: number; last?: number; types?: ('event' | 'message')[] } = {},
      ) => texts(await store.list('s', { kinds: list, ...more }));
      assert.deepEqual(await listKinds(['pet.whisper']), ['甲', '丙', '戊']);
      assert.deepEqual(await listKinds(['pet.whisper', 'ctx.run.started']), ['甲', '丙', '丁', '戊']);
      assert.deepEqual(await listKinds(['pet.whisper'], { last: 1 }), ['戊'], 'last 是过滤之后的最后几条');
      assert.deepEqual(await listKinds(['pet.whisper', 'pet.reminder'], { last: 2 }), ['丙', '戊']);
      assert.deepEqual(await listKinds(['pet.whisper'], { after: last!.seq - 2 }), ['戊']);
      assert.deepEqual(await listKinds(['pet.whisper'], { types: ['event'] }), ['甲', '丙', '戊']);
      assert.deepEqual(await listKinds(['pet.whisper'], { types: ['message'] }), [], '与 types 取交集：消息没有 kind');
      assert.deepEqual(await listKinds([]), [], '空列表什么都不匹配');
      assert.deepEqual(await listKinds(['nope']), []);
      assert.equal((await store.list('s', { types: ['event'] })).length, 5, '不给 kinds 时不过滤');
    });

    test('atAfter 只要 at 更晚的（不含等于），仍按 seq 返回；和 after、types、last、limit 一起用；NaN 不过滤', async () => {
      const store = await factory({ now: Date.now });
      const written = await store.append('s', [
        userEntry('提醒', { at: 9_000 }),
        userEntry('一', { at: 100 }),
        eventEntry('pet.whisper', { text: '二', at: 200 }),
        userEntry('三', { at: 300 }),
        userEntry('四', { at: 300 }),
      ]);
      await store.append('other', [userEntry('别的会话', { at: 9_999 })]);
      assert.deepEqual(texts(await store.list('s', { atAfter: 200 })), ['提醒', '三', '四'], '按 seq，不按 at');
      assert.deepEqual(texts(await store.list('s', { atAfter: 200, after: written[0]!.seq })), ['三', '四']);
      assert.deepEqual(texts(await store.list('s', { atAfter: 100, types: ['event'] })), ['二']);
      assert.deepEqual(texts(await store.list('s', { atAfter: 100, limit: 2 })), ['提醒', '二'], '过滤之后取最早的');
      assert.deepEqual(texts(await store.list('s', { atAfter: 100, last: 1 })), ['四'], '过滤之后取最后的');
      assert.deepEqual(await store.list('s', { atAfter: 9_000 }), []);
      assert.equal((await store.list('s', { atAfter: Number.NaN })).length, 5, 'NaN 不过滤');
      assert.equal((await store.list('s', { atAfter: Number.NEGATIVE_INFINITY })).length, 5);
      assert.deepEqual(await store.list('s', { atAfter: Number.POSITIVE_INFINITY }), []);
    });

    test('kinds 只看事件自己的 kind：消息正文和事件数据里的 kind 字样不算', async () => {
      const store = await factory({ now: Date.now });
      await store.append('s', [
        userEntry('kind'),
        eventEntry('app.note', { text: '数据里有 kind', data: { kind: 'pet.whisper' } }),
        eventEntry('pet.whisper', { text: '真的' }),
      ]);
      assert.deepEqual(texts(await store.list('s', { kinds: ['pet.whisper'] })), ['真的']);
      assert.deepEqual(texts(await store.list('s', { kinds: ['kind'] })), []);
    });

    test('条目原样读回：消息分段、事件数据、摘要位置、元数据、格式版本', async () => {
      const store = await factory({ now: () => 42 });
      const call: Message = {
        role: 'assistant',
        content: [
          { type: 'text', text: '查一下' },
          { type: 'tool-call', id: 'c1', name: 'weather', input: { city: '台北', days: [1, 2] } },
        ],
      };
      const image: Message = {
        role: 'user',
        content: [{ type: 'file', mediaType: 'image/png', data: { type: 'url', url: 'https://example.com/a.png' } }],
      };
      const [written] = await store.append('s', [messageEntry(call, { source: 'model', meta: { step: 1 } })]);
      await store.append('s', [
        messageEntry(image),
        eventEntry('pet.reminder', { text: '喝水', data: { id: 's_1', repeat: null } }),
        { type: 'summary', text: '摘要', covers: 2 },
      ]);
      const [first, second, third, fourth] = await store.list('s');
      assert.equal(first?.id, written?.id);
      assert.equal(first?.session, 's');
      assert.equal(first?.at, 42);
      assert.equal(first?.source, 'model');
      assert.deepEqual(first?.meta, { step: 1 });
      assert.deepEqual(first?.type === 'message' && first.message, call);
      assert.deepEqual(second?.type === 'message' && second.message, image);
      assert.deepEqual(third?.type === 'event' && [third.kind, third.text, third.data], [
        'pet.reminder',
        '喝水',
        { id: 's_1', repeat: null },
      ]);
      assert.deepEqual(fourth?.type === 'summary' && [fourth.text, fourth.covers], ['摘要', 2]);
      assert.ok((second?.seq ?? 0) > (first?.seq ?? 0));
      assert.equal(written?.v, ENTRY_VERSION, 'append 返回的条目带格式版本');
      assert.ok(
        [first, second, third, fourth].every((entry) => entry?.v === ENTRY_VERSION),
        'list 读到的也是',
      );
    });

    test('消息全是 JSON：每种部件、每种文件数据都原样读回，不经任何编码', async () => {
      const store = await factory({ now: () => 42 });
      const options = { anthropic: { signature: 'sig==' } };
      const messages: Message[] = [
        { role: 'system', content: '系统', providerOptions: { openai: { cache: true } } },
        {
          role: 'user',
          content: [
            { type: 'text', text: '看图', providerOptions: options },
            { type: 'file', mediaType: 'image/png', data: { type: 'data', data: 'aGVsbG8=' }, filename: 'a.png' },
            { type: 'file', mediaType: 'image', data: { type: 'url', url: 'https://example.com/a.png' } },
            {
              type: 'file',
              mediaType: 'application/pdf',
              data: { type: 'reference', reference: { openai: 'file-1' } },
            },
            { type: 'file', mediaType: 'text/plain', data: { type: 'text', text: '内联文字' } },
          ],
        },
        {
          role: 'assistant',
          content: [
            { type: 'reasoning', text: '想一想', providerOptions: options },
            { type: 'reasoning-file', mediaType: 'image/png', data: { type: 'data', data: 'AQID' } },
            { type: 'custom', kind: 'openai.compaction', providerOptions: options },
            { type: 'tool-call', id: 'c1', name: 'lookup', input: { q: ['台北'] }, providerExecuted: true },
            { type: 'tool-result', id: 'c1', name: 'lookup', output: { type: 'json', value: { n: 1 } } },
            { type: 'tool-approval-request', approvalId: 'a1', callId: 'c2', reason: '要联网', signature: 's' },
          ],
        },
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              id: 'c2',
              name: 'shot',
              output: {
                type: 'content',
                parts: [
                  { type: 'text', text: '截图' },
                  { type: 'file', mediaType: 'image/png', data: { type: 'data', data: 'AQID' } },
                ],
              },
            },
            { type: 'tool-approval-response', approvalId: 'a1', approved: false, reason: '不行' },
          ],
        },
      ];
      await store.append(
        's',
        messages.map((message) => messageEntry(message)),
      );
      const listed = await store.list('s');
      assert.deepEqual(
        listed.map((entry) => entry.type === 'message' && entry.message),
        messages,
      );
      assert.deepEqual(JSON.parse(JSON.stringify(messages)), messages, '消息本身就是 JSON');
    });

    test('像旧编码标记的普通对象原样读回：新写的行不再解码 \\u0000ctx', async () => {
      const store = await factory({ now: () => 42 });
      const tagged = { '\u0000ctx': 'bytes', base64: 'aGk=' };
      const link = { '\u0000ctx': 'url', href: 'https://example.com/' };
      await store.append('s', [
        messageEntry({
          role: 'assistant',
          content: [{ type: 'tool-call', id: 'c1', name: 'x', input: { tagged, link } }],
        }),
        eventEntry('tool.log', { data: { tagged, link } }),
      ]);
      const [message, event] = await store.list('s');
      const part = message?.type === 'message' && Array.isArray(message.message.content) && message.message.content[0];
      assert.deepEqual(part && part.type === 'tool-call' && part.input, { tagged, link });
      assert.deepEqual(event?.type === 'event' && event.data, { tagged, link });
    });

    test('事件数据里长得像编码标记的普通对象原样读回', async () => {
      const store = await factory({ now: () => 42 });
      const data = { link: { $url: 'relative/path' }, blob: { $bytes: 'aGk=' }, list: [{ $url: 'x' }] };
      await store.append('s', [eventEntry('tool.log', { data })]);
      const [entry] = await store.list('s');
      assert.deepEqual(entry?.type === 'event' && entry.data, data);
    });

    test('sessions 按名字升序（码点序），prefix 是字面前缀，after 和 limit 翻页', async () => {
      const store = await factory({ now: Date.now });
      const names = [
        'b',
        'a_b',
        'user:10',
        'a%b',
        'user:2',
        'ab',
        'a',
        'a\\b',
        'user:1',
        'user;x',
        '用户:1',
        '😀:1',
        'Ａ:1',
      ];
      for (const session of names) await store.append(session, [userEntry(session)]);
      // 码点序：ASCII 在前，然后是 U+7528、U+FF21、U+1F600（JavaScript 的 `<` 会把补充平面的 😀 排到 Ａ 前面）。
      const sorted = [
        'a',
        'a%b',
        'a\\b',
        'a_b',
        'ab',
        'b',
        'user:1',
        'user:10',
        'user:2',
        'user;x',
        '用户:1',
        'Ａ:1',
        '😀:1',
      ];
      assert.deepEqual(await store.sessions(), sorted, '不给选项时是全部，名字升序');
      assert.deepEqual(await store.sessions({}), sorted);
      assert.deepEqual(await store.sessions({ prefix: '' }), sorted, '空前缀是全部');
      assert.deepEqual(await store.sessions({ prefix: 'user:' }), ['user:1', 'user:10', 'user:2']);
      assert.deepEqual(await store.sessions({ prefix: 'a%' }), ['a%b'], '% 不是通配符');
      assert.deepEqual(await store.sessions({ prefix: 'a_' }), ['a_b'], '_ 不是通配符');
      assert.deepEqual(await store.sessions({ prefix: 'a\\' }), ['a\\b'], '反斜杠不是转义');
      assert.deepEqual(await store.sessions({ prefix: 'a' }), ['a', 'a%b', 'a\\b', 'a_b', 'ab']);
      assert.deepEqual(await store.sessions({ prefix: '😀' }), ['😀:1']);
      assert.deepEqual(await store.sessions({ prefix: 'nope' }), []);
      assert.deepEqual(
        await store.sessions({ after: 'user:10' }),
        ['user:2', 'user;x', '用户:1', 'Ａ:1', '😀:1'],
        'after 不含',
      );
      assert.deepEqual(await store.sessions({ after: 'user:1', prefix: 'user:' }), ['user:10', 'user:2']);
      assert.deepEqual(
        await store.sessions({ after: 'zzz-不存在' }),
        ['用户:1', 'Ａ:1', '😀:1'],
        'after 不必是存在的名字',
      );
      assert.deepEqual(await store.sessions({ limit: 3 }), sorted.slice(0, 3));
      assert.deepEqual(await store.sessions({ limit: 2.9 }), sorted.slice(0, 2), '小数向下取整');
      assert.deepEqual(await store.sessions({ limit: 0 }), []);
      assert.deepEqual(await store.sessions({ limit: 1000 }), sorted);
      const pages: string[][] = [];
      for (let after: string | undefined; ;) {
        const page = await store.sessions({ limit: 4, ...(after !== undefined ? { after } : {}) });
        if (page.length === 0) break;
        pages.push(page);
        after = page.at(-1)!;
      }
      assert.deepEqual(
        pages.map((page) => page.length),
        [4, 4, 4, 1],
      );
      assert.deepEqual(pages.flat(), sorted, '翻页不重不漏');
      const user: string[] = [];
      for (let after: string | undefined; ;) {
        const page = await store.sessions({ prefix: 'user:', limit: 2, ...(after !== undefined ? { after } : {}) });
        if (page.length === 0) break;
        user.push(...page);
        after = page.at(-1)!;
      }
      assert.deepEqual(user, ['user:1', 'user:10', 'user:2']);
    });

    test('sessions 翻页：清掉的会话不再出现，没有内容的会话不出现', async () => {
      const store = await factory({ now: Date.now });
      for (const session of ['a', 'b', 'c']) await store.append(session, [userEntry(session)]);
      await store.clear('b');
      assert.deepEqual(await store.sessions({ limit: 2 }), ['a', 'c']);
      assert.deepEqual(await store.sessions({ after: 'a', limit: 1 }), ['c']);
    });

    test('expectSeq：末尾对得上才写，空会话是 0，对不上整批不写并抛 conflict（retryable）', async () => {
      const store = await factory({ now: Date.now });
      assert.equal(await headSeq(store, 's'), 0);
      const [first] = await store.append('s', [userEntry('一')], { expectSeq: 0 });
      assert.equal(await headSeq(store, 's'), first!.seq);
      const failure = await store.append('s', batch('二'), { expectSeq: 0 }).then(
        () => undefined,
        (error: unknown) => error,
      );
      assert.ok(isConflict(failure), '前提不满足抛 conflict');
      assert.equal((failure as { retryable?: unknown }).retryable, true);
      assert.deepEqual(texts(await store.list('s')), ['一'], '整批不写');
      const [second] = await store.append('s', [userEntry('二')], { expectSeq: first!.seq });
      assert.deepEqual(texts(await store.list('s')), ['一', '二']);
      assert.equal(await headSeq(store, 's'), second!.seq);
    });

    test('expectSeq：只看这个会话的末尾；不给就不检查；clear 之后又是 0', async () => {
      const store = await factory({ now: Date.now });
      const [a] = await store.append('a', [userEntry('a1')]);
      await store.append('b', [userEntry('b1')]);
      await store.append('a', [userEntry('a2')], { expectSeq: await headSeq(store, 'a') });
      await assert.rejects(store.append('a', [userEntry('a3')], { expectSeq: a!.seq }), isConflict);
      await store.append('a', [userEntry('a3')]);
      assert.equal((await store.list('a')).length, 3);
      await store.clear('a');
      assert.equal(await headSeq(store, 'a'), 0);
      await store.append('a', [userEntry('again')], { expectSeq: 0 });
      assert.deepEqual(texts(await store.list('a')), ['again']);
    });

    test('expectSeq：前提的检查先于去重，重复的批在前提对得上时是空操作', async () => {
      const store = await factory({ now: Date.now });
      const [first] = await store.append('s', [userEntry('一', { key: 'k1' })], { expectSeq: 0 });
      await store.append('s', [userEntry('二')]);
      // 重试一批已经成功的写入，其间别人又写了：仍然是 conflict，不是静默的空操作。
      await assert.rejects(store.append('s', [userEntry('一', { key: 'k1' })], { expectSeq: 0 }), isConflict);
      const head = await headSeq(store, 's');
      assert.notEqual(head, first!.seq);
      // 前提对得上、整批都是重复的：照旧静默跳过。
      assert.deepEqual(await store.append('s', [userEntry('一', { key: 'k1' })], { expectSeq: head }), []);
      assert.deepEqual(texts(await store.list('s')), ['一', '二']);
    });

    test('expectSeq：同一个前提并发写，恰好一个成功', async () => {
      const store = await factory({ now: Date.now });
      const [first] = await store.append('s', [userEntry('起点')]);
      const results = await Promise.allSettled(
        ['甲', '乙', '丙'].map((tag) => store.append('s', [userEntry(tag)], { expectSeq: first!.seq })),
      );
      assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
      for (const result of results) {
        if (result.status === 'rejected') assert.ok(isConflict(result.reason));
      }
      assert.equal((await store.list('s')).length, 2);
    });

    test('clear 删掉整个会话，sessions 只列有内容的', async () => {
      const store = await factory({ now: Date.now });
      await store.append('a', [userEntry('x')]);
      await store.append('b', [userEntry('y'), userEntry('z')]);
      assert.deepEqual((await store.sessions()).toSorted(), ['a', 'b']);
      assert.equal(await store.clear('b'), 2);
      assert.deepEqual(await store.sessions(), ['a']);
      assert.equal(await store.clear('missing'), 0);
    });

    test('truncate：删掉 seq ≤ upTo 的，返回条数，之后的条目原样；追加一条 ctx.erased，末尾往前走', async () => {
      let clock = 100;
      const store = await factory({ now: () => (clock += 1) });
      const written = await store.append('s', batch('a'));
      await store.append('other', [userEntry('别的会话')]);
      const head = await headSeq(store, 's');
      assert.equal(await store.truncate('s', written[1]!.seq), 2);
      const left = await store.list('s');
      assert.deepEqual(withoutErased(left), written.slice(2), '剩下的条目 id、seq、at 都不变');
      assert.deepEqual(await erasures(store, 's'), [{ op: 'truncate', upTo: written[1]!.seq, count: 2 }]);
      const record = left.at(-1)!;
      assert.equal(record.type === 'event' && record.kind, CTX_EVENTS.erased, '擦除记录在末尾');
      assert.equal(record.source, 'store');
      assert.ok(record.seq > head, `末尾 ${record.seq} 应大于删之前的 ${head}`);
      assert.deepEqual(JSON.parse(JSON.stringify(record)), record, '擦除记录是纯 JSON');
      assert.deepEqual(texts(await store.list('other')), ['别的会话'], '只动这个会话');
      assert.deepEqual(await store.list('s', { types: ['message'] }), written.slice(2));
    });

    test('truncate：什么都没删时返回 0，不追加记录，末尾不变；upTo 向下取整，不是有限数时不删', async () => {
      const store = await factory({ now: Date.now });
      const written = await store.append('s', batch('a'));
      const head = await headSeq(store, 's');
      assert.equal(await store.truncate('s', 0), 0);
      assert.equal(await store.truncate('s', written[0]!.seq - 0.5), 0);
      assert.equal(await store.truncate('s', Number.NaN), 0);
      assert.equal(await store.truncate('s', Number.POSITIVE_INFINITY), 0);
      assert.equal(await store.truncate('missing', 100), 0);
      assert.equal(await headSeq(store, 's'), head);
      assert.deepEqual(await store.list('s'), written);
      assert.deepEqual(await store.sessions(), ['s'], '不存在的会话不会因此出现');
      assert.equal(await store.truncate('s', written[0]!.seq + 0.5), 1, '小数向下取整');
      assert.deepEqual(texts(withoutErased(await store.list('s'))), ['a2', 'a3', 'a4']);
    });

    test('truncate 删到末尾之后：只剩擦除记录，seq 不回退、不复用，upTo 记的是真删掉的最大 seq', async () => {
      const store = await factory({ now: Date.now });
      const written = await store.append('s', batch('a'));
      const head = written.at(-1)!.seq;
      assert.equal(await store.truncate('s', head + 1_000), 4);
      const [record, ...rest] = await store.list('s');
      assert.deepEqual(rest, []);
      assert.ok(record!.seq > head);
      assert.deepEqual(await erasures(store, 's'), [{ op: 'truncate', upTo: head, count: 4 }]);
      assert.deepEqual(await store.sessions(), ['s'], '留着擦除记录，会话还在');
      const [next] = await store.append('s', [userEntry('b')]);
      assert.ok(next!.seq > record!.seq);
      assert.equal(await store.truncate('s', record!.seq), 1, '旧的擦除记录也是条目，删得掉');
      assert.deepEqual(await erasures(store, 's'), [{ op: 'truncate', upTo: record!.seq, count: 1 }]);
    });

    test('truncate 到摘要的 covers：被盖住的条目删掉，摘要和之后的条目留着', async () => {
      const store = await factory({ now: Date.now });
      const old = await store.append('s', batch('a'));
      const [summary] = await store.append('s', [summaryEntry('摘要', old[3]!.seq)]);
      const [later] = await store.append('s', [userEntry('之后')]);
      assert.equal(await store.truncate('s', old[3]!.seq), 4);
      assert.deepEqual(withoutErased(await store.list('s')), [summary, later]);
    });

    test('remove：按 id 真删，返回条数；认不得的、别的会话的 id 跳过，重复的只算一次；记录里的 seqs 升序', async () => {
      const store = await factory({ now: Date.now });
      const written = await store.append('s', batch('a'));
      const [other] = await store.append('other', [userEntry('别的会话')]);
      const head = await headSeq(store, 's');
      const [a1, a2, a3, a4] = written;
      assert.equal(await store.remove('s', [a3!.id, a1!.id, a3!.id, other!.id, 'missing']), 2);
      const left = await store.list('s');
      assert.deepEqual(withoutErased(left), [a2, a4]);
      assert.deepEqual(await erasures(store, 's'), [{ op: 'remove', seqs: [a1!.seq, a3!.seq], count: 2 }]);
      assert.ok(left.at(-1)!.seq > head, '末尾往前走');
      assert.deepEqual(await store.list('other'), [other], '别的会话的条目删不到');
      assert.equal(await store.remove('s', [a1!.id, 'missing']), 0, '已经删掉的不再算');
      assert.equal(await store.remove('s', []), 0);
      assert.equal((await erasures(store, 's')).length, 1, '什么都没删不追加记录');
    });

    test('remove 之后 id 和 key 可以再用；删掉最后一条，末尾也不回退', async () => {
      const store = await factory({ now: Date.now });
      const [first, last] = await store.append('s', [userEntry('一', { id: 'x1', key: 'k1' }), userEntry('二')]);
      assert.equal(await store.remove('s', [last!.id, first!.id]), 2);
      assert.ok((await headSeq(store, 's')) > last!.seq);
      const again = await store.append('s', [userEntry('重写', { id: 'x1', key: 'k1' })]);
      assert.equal(again.length, 1);
      assert.ok(again[0]!.seq > last!.seq, 'seq 不复用');
    });

    test('redact：id、seq、at、key、source 留着，内容换成 ctx.redacted；位置不变，再涂一遍是空操作', async () => {
      const store = await factory({ now: Date.now });
      const written = await store.append('s', [
        userEntry('我的卡号机密', { key: 'k1', source: 'user', at: 111, meta: { secret: '卡号机密' } }),
        assistantEntry('记下了 卡号机密'),
        eventEntry('pet.whisper', { text: '卡号机密', data: { card: '卡号机密' } }),
        userEntry('别的'),
      ]);
      const [user, assistant, event, keep] = written;
      const head = await headSeq(store, 's');
      assert.equal(await store.redact('s', [event!.id, user!.id, assistant!.id, 'missing']), 3);
      const left = await store.list('s');
      assert.deepEqual(
        withoutErased(left).map((entry) => entry.seq),
        written.map((entry) => entry.seq),
        '位置不变',
      );
      assert.ok(
        !JSON.stringify(left).includes('卡号机密'),
        '内容、数据、meta 都不在了（标记不会出现在 id 和时间戳里）',
      );
      assert.deepEqual(left[0], {
        type: 'event',
        kind: CTX_EVENTS.redacted,
        id: user!.id,
        session: 's',
        seq: user!.seq,
        at: 111,
        v: ENTRY_VERSION,
        key: 'k1',
        source: 'user',
        data: { type: 'message', role: 'user' },
      });
      assert.deepEqual(
        left.slice(1, 3).map((entry) => entry.type === 'event' && entry.data),
        [{ type: 'message', role: 'assistant' }, { type: 'event' }],
      );
      assert.deepEqual(left[3], keep);
      assert.deepEqual(await erasures(store, 's'), [
        { op: 'redact', seqs: [user!.seq, assistant!.seq, event!.seq], count: 3 },
      ]);
      assert.ok(left.at(-1)!.seq > head, '末尾往前走');
      assert.deepEqual(await store.list('s', { types: ['message'] }), [keep], '占位是事件，不是消息');
      assert.equal((await store.list('s', { kinds: [CTX_EVENTS.redacted] })).length, 3, '占位按 kind 筛得出');
      assert.equal(await store.redact('s', [user!.id, assistant!.id]), 0, '已经涂改过的跳过');
      assert.equal((await erasures(store, 's')).length, 1);
      assert.deepEqual(
        await store.append('s', [userEntry('我的卡号机密', { key: 'k1' })]),
        [],
        'key 还在，重试写不回来',
      );
    });

    test('redact 一条摘要：它不再是摘要；别的会话的 id 涂不到', async () => {
      const store = await factory({ now: Date.now });
      const [first] = await store.append('s', [userEntry('一')]);
      const [summary] = await store.append('s', [summaryEntry('摘要里有 卡号机密', first!.seq)]);
      assert.equal(await store.redact('other', [summary!.id]), 0);
      assert.equal(await store.redact('s', [summary!.id]), 1);
      assert.deepEqual(await store.list('s', { types: ['summary'] }), []);
      const [placeholder] = await store.list('s', { kinds: [CTX_EVENTS.redacted] });
      assert.equal(placeholder?.seq, summary!.seq);
      assert.deepEqual(placeholder?.type === 'event' && placeholder.data, { type: 'summary' });
    });

    test('擦除之后拿着旧末尾的 expectSeq 冲突一次，重读看得到记录；什么都没动时不冲突；isErased 认得出动了哪些 seq', async () => {
      const store = await factory({ now: Date.now });
      const written = await store.append('s', batch('a'));
      const [a1, a2, a3, a4] = written;
      const steps: [() => Promise<number>, number[]][] = [
        [() => store.truncate('s', a1!.seq), [a1!.seq]],
        [() => store.remove('s', [a2!.id]), [a2!.seq]],
        [() => store.redact('s', [a3!.id]), [a3!.seq]],
      ];
      for (const [erase, touched] of steps) {
        const head = await headSeq(store, 's');
        assert.equal(await erase(), 1);
        await assert.rejects(store.append('s', [userEntry('旧前提')], { expectSeq: head }), isConflict);
        const [record] = await store.list('s', { after: head, kinds: [CTX_EVENTS.erased] });
        const data = ctxEventData(record, CTX_EVENTS.erased);
        assert.ok(data, '重读就看得到擦除记录');
        assert.deepEqual(
          written.map((entry) => entry.seq).filter((seq) => isErased(data, seq)),
          touched,
        );
      }
      const head = await headSeq(store, 's');
      assert.equal(await store.remove('s', ['missing']), 0);
      const [next] = await store.append('s', [userEntry('新前提')], { expectSeq: head });
      assert.ok(next!.seq > a4!.seq);
    });

    test('擦除是原子的：和并发的 append 不交错，记录在那一批之前或之后', async () => {
      const store = await factory({ now: Date.now });
      const [first] = await store.append('s', [userEntry('起点')]);
      const [removed, appended] = await Promise.all([store.remove('s', [first!.id]), store.append('s', batch('b'))]);
      assert.equal(removed, 1);
      assert.equal(appended.length, 4);
      const left = await store.list('s');
      assert.deepEqual(texts(withoutErased(left)), ['b1', 'b2', 'b3', 'b4']);
      const at = left.findIndex((entry) => entry.type === 'event' && entry.kind === CTX_EVENTS.erased);
      assert.ok(at === 0 || at === 4, `擦除记录不在这一批中间（在 ${at}）`);
    });

    test('watch（有时）：擦除记录也到达已经在看的 watch', async () => {
      const store = await factory({ now: Date.now });
      if (!store.watch) return;
      const [first, second] = await store.append('s', [userEntry('一'), userEntry('二')]);
      const controller = new AbortController();
      const iterator = store.watch('s', { after: second!.seq, signal: controller.signal })[Symbol.asyncIterator]();
      try {
        const pending = nextWithin(iterator, '擦除记录');
        await store.redact('s', [first!.id]);
        const result = await pending;
        assert.ok(!result.done && result.value.type === 'event');
        assert.equal(result.value.kind, CTX_EVENTS.erased);
        assert.deepEqual(result.value.data, { op: 'redact', seqs: [first!.seq], count: 1 });
      } finally {
        controller.abort();
        await iterator.return?.();
      }
    });

    test('watch（有时）：先给出 after 之后已有的，再给出新写入的，只看这个会话', async () => {
      let clock = 0;
      const store = await factory({ now: () => (clock += 1) });
      if (!store.watch) return;
      const [first] = await store.append('s', [userEntry('旧')]);
      await store.append('s', [userEntry('已有')]);
      const controller = new AbortController();
      const iterator = store.watch('s', { after: first!.seq, signal: controller.signal })[Symbol.asyncIterator]();
      try {
        const existing = await nextWithin(iterator, '已有的条目');
        assert.deepEqual(texts(existing.done ? [] : [existing.value]), ['已有']);
        const pending = nextWithin(iterator, '新写入的条目');
        await store.append('other', [userEntry('别的会话')]);
        await store.append('s', [userEntry('新')]);
        const fresh = await pending;
        assert.deepEqual(texts(fresh.done ? [] : [fresh.value]), ['新']);
        assert.equal(!fresh.done && fresh.value.session, 's');
      } finally {
        controller.abort();
        await iterator.return?.();
      }
    });

    test('watch（有时）：已经看过 b 的 watch 也收到之后补写的旧记录', async () => {
      let clock = 1_000;
      const store = await factory({ now: () => clock++ });
      if (!store.watch) return;
      const [, b] = await store.append('s', [userEntry('a'), userEntry('b')]);
      const controller = new AbortController();
      const iterator = store.watch('s', { after: b!.seq, signal: controller.signal })[Symbol.asyncIterator]();
      try {
        const pending = nextWithin(iterator, '补写的旧记录');
        await store.append('s', [userEntry('late', { at: 1 })]);
        const late = await pending;
        assert.deepEqual(texts(late.done ? [] : [late.value]), ['late']);
        const next = nextWithin(iterator, '之后的条目');
        await store.append('s', [userEntry('c')]);
        const fresh = await next;
        assert.deepEqual(texts(fresh.done ? [] : [fresh.value]), ['c']);
      } finally {
        controller.abort();
        await iterator.return?.();
      }
    });

    test('watch（有时）：不给 after 从头读；signal 中止后迭代正常结束', async () => {
      const store = await factory({ now: Date.now });
      if (!store.watch) return;
      await store.append('s', [userEntry('一'), userEntry('二')]);
      const controller = new AbortController();
      const iterator = store.watch('s', { signal: controller.signal })[Symbol.asyncIterator]();
      const seen: Entry[] = [];
      for (let i = 0; i < 2; i += 1) {
        const result = await nextWithin(iterator, '已有的条目');
        if (!result.done) seen.push(result.value);
      }
      assert.deepEqual(texts(seen), ['一', '二']);
      const pending = nextWithin(iterator, '中止后结束');
      controller.abort();
      assert.equal((await pending).done, true);
    });
  });
}
