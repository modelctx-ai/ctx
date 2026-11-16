/**
 * 协议的契约测试。实现一个协议时，用同一套用例验证行为和参考实现一致。
 * 不绑定测试框架：把所用框架的 `describe`、`test` 传进来（Vitest、`node:test`、Jest、Bun 都行），断言用 `node:assert/strict`：
 *
 * ```ts
 * import { describe, test } from 'vitest'; // 或 'node:test'
 * import { describeSessionStoreContract } from '@modelctx-ai/ctx-protocol/testing';
 * describeSessionStoreContract('my-store', ({ now }) => createMyStore({ now }), { describe, test });
 * ```
 */
import assert from 'node:assert/strict';

import type { ContextBuilder } from './context.ts';
import type { AgentSpec, Harness, RunEvent, RunRequest } from './harness.ts';
import { textOf, type Message } from './message.ts';
import type { Orchestrator, OrchestratorEvent } from './orchestrator.ts';
import { eraseEntries, isErased, type Erasure } from './erase.ts';
import {
  CTX_EVENTS,
  assistantEntry,
  erasedEntry,
  eventEntry,
  filterEntries,
  filterSessions,
  headSeq,
  isConflict,
  messageEntry,
  summaryEntry,
  userEntry,
  type Entry,
  type ErasedData,
  type NewEntry,
  type SessionStore,
} from './session.ts';
import { ENTRY_VERSION } from './version.ts';
import { copySession, exportSession, importSession } from './transfer.ts';
import { project } from './context.ts';
import { selectTools, type Executor, type ToolDefinition, type ToolFilter, type ToolRegistry } from './tools.ts';
import { CtxError, type JsonObject, type JsonValue } from './types.ts';
import {
  MAX_DECISION_QUESTIONS,
  MAX_FACT_RECALLS,
  MEMORY_RECALL_TOOL,
  checkSourceRef,
  filterFacts,
  inSourceRef,
  sourceRef,
  type DecisionAnswer,
  type DecisionModel,
  type DecisionQuestion,
  type DecisionRequest,
  type ExtractionAnswer,
  type ExtractionField,
  type ExtractionModel,
  type ExtractionRequest,
  type Memory,
  type MemoryFact,
  type MemoryStore,
  type NewMemoryFact,
  type SourceRef,
} from './memory.ts';

/**
 * 契约测试用到的最小测试框架接口。Vitest、`node:test`、Jest、Bun 的 `describe` / `test` 都满足，
 * 失败靠抛异常报告，返回值不看。
 */
export interface ContractTestApi {
  readonly describe: (name: string, fn: () => void) => unknown;
  readonly test: (name: string, fn: () => Promise<void>) => unknown;
}

// ---- SessionStore ----

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

/** 会话里的擦除记录（`ctx.erased`）的 `data`，按写入顺序。 */
async function erasures(store: SessionStore, session: string): Promise<ErasedData[]> {
  const records = await store.list(session, { kinds: [CTX_EVENTS.erased] });
  return records.flatMap((entry) => (entry.type === 'event' ? [entry.data as unknown as ErasedData] : []));
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
        userEntry('银行卡号 6222', { key: 'k1', source: 'user', at: 111, meta: { secret: '6222' } }),
        assistantEntry('记下了 6222'),
        eventEntry('pet.whisper', { text: '6222', data: { card: '6222' } }),
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
      assert.ok(!JSON.stringify(left).includes('6222'), '内容、数据、meta 都不在了');
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
        await store.append('s', [userEntry('银行卡号 6222', { key: 'k1' })]),
        [],
        'key 还在，重试写不回来',
      );
    });

    test('redact 一条摘要：它不再是摘要；别的会话的 id 涂不到', async () => {
      const store = await factory({ now: Date.now });
      const [first] = await store.append('s', [userEntry('一')]);
      const [summary] = await store.append('s', [summaryEntry('摘要里有 6222', first!.seq)]);
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
        assert.ok(record?.type === 'event', '重读就看得到擦除记录');
        const data = record.data as unknown as ErasedData;
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

// ---- Executor ----

export interface ExecutorFixture {
  readonly executor: Executor;
  /** 一个它能执行的回显工具的名字：把输入原样（或作为文字、内容块）放进结果里。 */
  readonly echo: string;
}

/** 每个用例调一次。用例开始时调 `provision`（有的话），结束时调 `dispose`（有的话）。 */
export type ExecutorFactory = () => ExecutorFixture | Promise<ExecutorFixture>;

async function withExecutor(factory: ExecutorFactory, fn: (fixture: ExecutorFixture) => Promise<void>): Promise<void> {
  const fixture = await factory();
  try {
    await fixture.executor.provision?.();
    await fn(fixture);
  } finally {
    await fixture.executor.dispose?.();
  }
}

function roundTrips(value: unknown): boolean {
  try {
    assert.deepEqual(JSON.parse(JSON.stringify(value)), value);
    return true;
  } catch {
    return false;
  }
}

export function describeExecutorContract(
  name: string,
  factory: ExecutorFactory,
  { describe, test }: ContractTestApi,
): void {
  describe(`Executor contract: ${name}`, () => {
    const context = { session: 'contract', runId: 'run-contract' };

    test('有名字', async () => {
      await withExecutor(factory, async ({ executor }) => {
        assert.equal(typeof executor.name, 'string');
        assert.ok(executor.name.length > 0);
      });
    });

    test('tools（有时）：列出回显工具，绑定到自己，定义能序列化', async () => {
      await withExecutor(factory, async ({ executor, echo }) => {
        if (!executor.tools) return;
        const tools = await executor.tools();
        const found = tools.find((tool) => tool.name === echo);
        assert.ok(found, `tools() 里没有 ${echo}`);
        assert.equal(found.executor, executor.name);
        assert.equal(typeof found.inputSchema, 'object');
        assert.ok(roundTrips(tools), 'tools() 的结果能 JSON 往返');
      });
    });

    test('execute 回显输入，结果能序列化', async () => {
      await withExecutor(factory, async ({ executor, echo }) => {
        const marker = `echo-${Math.random().toString(36).slice(2)}`;
        const output = await executor.execute({ id: 'c1', name: echo, input: { text: marker } }, context);
        assert.notEqual(output.type, 'error', JSON.stringify(output));
        assert.ok(JSON.stringify(output).includes(marker), `结果里没有输入：${JSON.stringify(output)}`);
        assert.ok(roundTrips(output), '结果能 JSON 往返');
      });
    });

    test('不认识的工具返回 { type: error }，不抛', async () => {
      await withExecutor(factory, async ({ executor }) => {
        const output = await executor.execute({ id: 'c2', name: 'no_such_tool_for_contract', input: {} }, context);
        assert.equal(output.type, 'error');
        assert.ok(output.type === 'error' && output.message.length > 0, '错误要有可读的信息');
      });
    });

    test('signal 已中止时不执行，返回 { type: error }，不抛', async () => {
      await withExecutor(factory, async ({ executor, echo }) => {
        const output = await executor.execute(
          { id: 'c3', name: echo, input: { text: 'aborted' } },
          { ...context, signal: AbortSignal.abort() },
        );
        assert.equal(output.type, 'error');
      });
    });

    test('provision（有时）可以重复调', async () => {
      await withExecutor(factory, async ({ executor, echo }) => {
        if (!executor.provision) return;
        await executor.provision();
        const output = await executor.execute({ id: 'c4', name: echo, input: { text: 'again' } }, context);
        assert.notEqual(output.type, 'error');
      });
    });

    test('open、close（有时）按会话：都可以重复调，close 之后还能再 open，open 过的会话照常执行', async () => {
      await withExecutor(factory, async ({ executor, echo }) => {
        if (!executor.open || !executor.close) return;
        const session = 'contract-session';
        await executor.open(session);
        await executor.open(session);
        const output = await executor.execute({ id: 'c5', name: echo, input: { text: 'in session' } }, { session });
        assert.notEqual(output.type, 'error');
        await executor.close(session);
        await executor.close(session);
        await executor.open(session);
        await executor.close(session);
      });
    });
  });
}

// ---- ToolRegistry ----

/** 每个用例调一次，拿到一个空的目录。 */
export type ToolRegistryFactory = () => ToolRegistry | Promise<ToolRegistry>;

function definition(name: string, extra: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name,
    description: `${name} 的说明`,
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    executor: 'local',
    ...extra,
  };
}

export function describeToolRegistryContract(
  name: string,
  factory: ToolRegistryFactory,
  { describe, test }: ContractTestApi,
): void {
  describe(`ToolRegistry contract: ${name}`, () => {
    test('add、has、get、size、list：按加入顺序，定义原样读回', async () => {
      const registry = await factory();
      assert.equal(registry.size, 0);
      const weather = definition('weather_get', { source: 'local', tags: ['read'] });
      const files = definition('fs__read_file', { source: 'mcp:fs', executor: 'mcp:fs' });
      assert.equal(registry.add(weather).add(files), registry, 'add 返回自己，可以连写');
      assert.equal(registry.size, 2);
      assert.ok(registry.has('weather_get'));
      assert.ok(!registry.has('missing'));
      assert.deepEqual(registry.get('fs__read_file'), files);
      assert.equal(registry.get('missing'), undefined);
      assert.deepEqual(registry.list(), [weather, files]);
      assert.ok(roundTrips(registry.list()), 'list() 能 JSON 往返');
    });

    test('名字不合法时抛错，不写入', async () => {
      const registry = await factory();
      for (const bad of ['', 'has space', '中文', 'a'.repeat(65), 'dot.name']) {
        assert.throws(() => registry.add(definition(bad)), Error, `名字 ${JSON.stringify(bad)}`);
      }
      assert.equal(registry.size, 0);
      registry.add(definition('a'.repeat(64)));
      assert.equal(registry.size, 1);
    });

    test('同名抛错，replace 时替换', async () => {
      const registry = await factory();
      registry.add(definition('weather_get'));
      assert.throws(() => registry.add(definition('weather_get', { description: '第二个' })));
      registry.add(definition('weather_get', { description: '新的' }), { replace: true });
      assert.equal(registry.size, 1);
      assert.equal(registry.get('weather_get')?.description, '新的');
    });

    test('remove 和 removeSource', async () => {
      const registry = await factory();
      registry
        .add(definition('a', { source: 'mcp:x' }))
        .add(definition('b', { source: 'mcp:x' }))
        .add(definition('c', { source: 'local' }));
      assert.equal(registry.remove('c'), true);
      assert.equal(registry.remove('c'), false);
      assert.equal(registry.removeSource('mcp:x'), 2);
      assert.equal(registry.removeSource('mcp:x'), 0);
      assert.equal(registry.size, 0);
    });

    test('select 的语义同 selectTools', async () => {
      const registry = await factory();
      registry
        .add(definition('weather_get', { source: 'local', tags: ['read', 'weather'] }))
        .add(definition('fs__read_file', { source: 'mcp:fs', tags: ['read'] }))
        .add(definition('fs__write_file', { source: 'mcp:fs', tags: ['write'] }))
        .add(definition('plain'));
      const names = (filter?: ToolFilter) =>
        (filter === undefined ? registry.select() : registry.select(filter)).map((tool) => tool.name);
      const filters: ToolFilter[] = [
        true,
        false,
        ['plain', 'fs__read_file', 'missing'],
        { tags: ['read'] },
        { sources: ['mcp:fs'] },
        { sources: ['mcp:fs'], tags: ['read'] },
        { names: ['plain', 'weather_get'], tags: ['weather'] },
        {},
        (tool) => tool.name.startsWith('fs__'),
      ];
      assert.deepEqual(names(), ['weather_get', 'fs__read_file', 'fs__write_file', 'plain'], '缺省全部');
      for (const filter of filters) {
        assert.deepEqual(
          names(filter),
          selectTools(registry.list(), filter).map((tool) => tool.name),
          `filter: ${typeof filter === 'function' ? 'function' : JSON.stringify(filter)}`,
        );
      }
      assert.deepEqual(names({ sources: ['mcp:fs'], tags: ['read'] }), ['fs__read_file']);
      assert.deepEqual(names(false), []);
    });
  });
}

// ---- Harness ----

/**
 * 契约测试给模型的剧本：每调一次模型按顺序取下一步。`text` 回一段文字并停下，带 `truncated` 时这段输出是被
 * `maxOutputTokens` 截断的（`finishReason` 是 `length`）；`tool-call` 调用回显工具（名字由实现方填，就是 fixture 的
 * `echo`）；`error` 让这次模型调用抛出带这段信息的错误。
 */
export type ModelScriptStep =
  | { readonly type: 'text'; readonly text: string; readonly truncated?: boolean }
  | { readonly type: 'tool-call'; readonly id: string; readonly input: JsonObject }
  | { readonly type: 'error'; readonly message: string };

export interface ModelScript {
  readonly script: readonly ModelScriptStep[];
}

export interface HarnessFixture {
  readonly harness: Harness;
  /** harness 写日志用的存储，用例从这里读日志。 */
  readonly store: SessionStore;
  /** 一个能跑的 agent：模型按剧本回答（流式和非流式都要支持），工具里有回显工具。 */
  readonly agent: AgentSpec;
}

/** 每个用例调一次，拿到一个空的存储和按这份剧本回答的模型。 */
export type HarnessFactory = (setup: ModelScript) => HarnessFixture | Promise<HarnessFixture>;

function kinds(entries: readonly Entry[]): string[] {
  return entries.map((entry) => {
    if (entry.type === 'event') return entry.kind;
    if (entry.type === 'message') return entry.message.role;
    return entry.type;
  });
}

/** 一条 `ctx.run.*` 事件，`data` 只带 `runId` 和最小的 `agent`。 */
function lifecycle(kind: string, runId: string): NewEntry {
  return eventEntry(kind, { data: { runId, agent: { model: 'm' } } });
}

function eventData(entries: readonly Entry[], kind: string): Record<string, unknown>[] {
  return entries.flatMap((entry) =>
    entry.type === 'event' && entry.kind === kind ? [(entry.data ?? {}) as Record<string, unknown>] : [],
  );
}

/** 模型出错的用例不要重试，免得剧本被多取几步。 */
function noRetry(agent: AgentSpec): AgentSpec {
  return { ...agent, settings: { ...agent.settings, maxRetries: 0 } };
}

function randomMarker(): string {
  return `echo-${Math.random().toString(36).slice(2)}`;
}

export function describeHarnessContract(
  name: string,
  factory: HarnessFactory,
  { describe, test }: ContractTestApi,
): void {
  describe(`Harness contract: ${name}`, () => {
    test('一轮：ctx.run.started → 输入 → 回复 → ctx.run.ended，recorded 就是写进日志的', async () => {
      const { harness, store, agent } = await factory({ script: [{ type: 'text', text: '在的' }] });
      const result = await harness.run({ session: 's', agent, input: '在吗', runId: 'run-1' });
      assert.equal(result.runId, 'run-1');
      assert.equal(result.text, '在的');
      assert.equal(result.stopReason, 'end_turn');
      assert.equal(result.error, undefined);
      assert.ok(result.messages.length > 0, '有模型产出的消息');
      const log = await store.list('s');
      assert.deepEqual(kinds(log), [CTX_EVENTS.runStarted, 'user', 'assistant', CTX_EVENTS.runEnded]);
      const [started] = eventData(log, CTX_EVENTS.runStarted);
      assert.equal(started?.['runId'], 'run-1');
      assert.equal(typeof (started?.['agent'] as Record<string, unknown> | undefined)?.['model'], 'string');
      assert.equal(eventData(log, CTX_EVENTS.runEnded)[0]?.['stopReason'], 'end_turn');
      assert.deepEqual(
        result.recorded.map((entry) => entry.id),
        log.map((entry) => entry.id),
      );
      assert.ok(roundTrips(eventData(log, CTX_EVENTS.runStarted)), 'ctx.run.started 的 data 能序列化');
    });

    test('不给 runId 时生成一个，两轮不同', async () => {
      const { harness, agent } = await factory({
        script: [
          { type: 'text', text: '一' },
          { type: 'text', text: '二' },
        ],
      });
      const first = await harness.run({ session: 's', agent, input: '1' });
      const second = await harness.run({ session: 's', agent, input: '2' });
      assert.equal(typeof first.runId, 'string');
      assert.ok(first.runId.length > 0);
      assert.notEqual(first.runId, second.runId);
    });

    test('工具调用交给执行环境，结果回到模型，调用和结果都记下', async () => {
      const text = randomMarker();
      const { harness, store, agent } = await factory({
        script: [
          { type: 'tool-call', id: 'call-1', input: { text } },
          { type: 'text', text: '好了' },
        ],
      });
      const result = await harness.run({ session: 's', agent, input: '回显一下' });
      assert.equal(result.text, '好了');
      assert.equal(result.stopReason, 'end_turn');
      const log = await store.list('s');
      assert.deepEqual(kinds(log), [
        CTX_EVENTS.runStarted,
        'user',
        'assistant',
        'tool',
        'assistant',
        CTX_EVENTS.runEnded,
      ]);
      const tool = log.find((entry) => entry.type === 'message' && entry.message.role === 'tool');
      assert.ok(JSON.stringify(tool).includes(text), '工具结果里有回显的输入');
    });

    test('模型出错：run 照常返回 stopReason error 和 error，日志里有 ctx.run.ended', async () => {
      const { harness, store, agent } = await factory({ script: [{ type: 'error', message: 'model exploded' }] });
      const result = await harness.run({ session: 's', agent: noRetry(agent), input: '在吗' });
      assert.equal(result.stopReason, 'error');
      assert.match(result.error?.message ?? '', /model exploded/);
      const log = await store.list('s');
      assert.equal(kinds(log).at(-1), CTX_EVENTS.runEnded);
      assert.equal(eventData(log, CTX_EVENTS.runEnded)[0]?.['stopReason'], 'error');
      assert.deepEqual(
        eventData(log, CTX_EVENTS.runStarted).map((data) => data['runId']),
        eventData(log, CTX_EVENTS.runEnded).map((data) => data['runId']),
        'started 和 ended 成对',
      );
    });

    test('每一步结束就落日志：工具调用之后模型出错，前一步的调用和结果留在日志里', async () => {
      const text = randomMarker();
      const { harness, store, agent } = await factory({
        script: [
          { type: 'tool-call', id: 'call-1', input: { text } },
          { type: 'error', message: 'model exploded' },
        ],
      });
      const result = await harness.run({ session: 's', agent: noRetry(agent), input: '回显一下' });
      assert.equal(result.stopReason, 'error');
      const log = await store.list('s');
      assert.deepEqual(kinds(log), [
        CTX_EVENTS.runStarted,
        'user',
        'assistant',
        'tool',
        CTX_EVENTS.error,
        CTX_EVENTS.runEnded,
      ]);
      const tool = log.find((entry) => entry.type === 'message' && entry.message.role === 'tool');
      assert.ok(JSON.stringify(tool).includes(text), '工具结果在日志里');
    });

    test('AgentSpec.output：最后的回答按 schema 解析进 RunResult.output；version 原样记进 ctx.run.started', async () => {
      const { harness, store, agent } = await factory({ script: [{ type: 'text', text: '{"answer":42}' }] });
      const result = await harness.run({
        session: 's',
        agent: {
          ...agent,
          version: 'contract@1',
          output: { schema: { type: 'object', properties: { answer: { type: 'number' } }, required: ['answer'] } },
        },
        input: '答案是多少？',
      });
      assert.equal(result.stopReason, 'end_turn');
      assert.deepEqual(result.output, { answer: 42 });
      const [started] = eventData(await store.list('s'), CTX_EVENTS.runStarted);
      assert.equal((started?.['agent'] as Record<string, unknown> | undefined)?.['version'], 'contract@1');
    });

    test('RunRequest.parent 原样记进 ctx.run.started：子会话知道自己是谁派的', async () => {
      const { harness, store, agent } = await factory({ script: [{ type: 'text', text: '好' }] });
      const parent = { session: 'parent', runId: 'r-parent', toolCallId: 'call-1' };
      await harness.run({ session: 's', agent, input: '子任务', parent });
      const [started] = eventData(await store.list('s'), CTX_EVENTS.runStarted);
      assert.deepEqual(started?.['parent'], parent);
    });

    test('inputKey：失败后用同一个键重试，输入只记一次', async () => {
      const { harness, store, agent } = await factory({
        script: [
          { type: 'error', message: 'network down' },
          { type: 'text', text: '三点了' },
        ],
      });
      const request: RunRequest = { session: 's', agent: noRetry(agent), input: '几点了？', inputKey: 'turn-1' };
      assert.equal((await harness.run(request)).stopReason, 'error');
      const retry = await harness.run(request);
      assert.equal(retry.stopReason, 'end_turn');
      assert.equal(retry.text, '三点了');
      const log = await store.list('s');
      assert.equal(kinds(log).filter((kind) => kind === 'user').length, 1);
      assert.ok(!retry.recorded.some((entry) => entry.type === 'message' && entry.message.role === 'user'));
    });

    test('record: false 一条都不写，输入照样交给模型', async () => {
      const { harness, store, agent } = await factory({ script: [{ type: 'text', text: '好' }] });
      const result = await harness.run({ session: 's', agent, input: '不记', record: false });
      assert.equal(result.text, '好');
      assert.deepEqual(result.recorded, []);
      assert.deepEqual(await store.list('s'), []);
    });

    test('会话里有未结束的运行（最后一个生命周期事件是 started）：run 以 session_busy 结束，什么都不写', async () => {
      const { harness, store, agent } = await factory({ script: [{ type: 'text', text: '好' }] });
      await store.append('s', [lifecycle(CTX_EVENTS.runStarted, 'other')]);
      const before = await store.list('s');
      const result = await harness.run({ session: 's', agent, input: '在吗' });
      assert.equal(result.stopReason, 'error');
      assert.equal(result.error?.type, 'session_busy');
      assert.equal(result.error?.retryable, true);
      assert.deepEqual(result.recorded, []);
      assert.deepEqual(await store.list('s'), before, '一条都没写');
      // 别的会话不受影响；那个运行结束以后就能接着跑。
      assert.equal((await harness.run({ session: 't', agent, input: '在吗' })).stopReason, 'end_turn');
    });

    test('上一轮已经 ended：可以接着跑；record: false 的运行不受未结束的运行影响，也不留生命周期事件', async () => {
      const { harness, store, agent } = await factory({
        script: [
          { type: 'text', text: '一' },
          { type: 'text', text: '二' },
        ],
      });
      await store.append('s', [lifecycle(CTX_EVENTS.runStarted, 'old'), lifecycle(CTX_EVENTS.runEnded, 'old')]);
      assert.equal((await harness.run({ session: 's', agent, input: '1' })).stopReason, 'end_turn');
      await store.append('t', [lifecycle(CTX_EVENTS.runStarted, 'stuck')]);
      const quiet = await harness.run({ session: 't', agent, input: '2', record: false });
      assert.equal(quiet.stopReason, 'end_turn');
      assert.equal(quiet.text, '二');
      assert.deepEqual(kinds(await store.list('t')), [CTX_EVENTS.runStarted], '只有原来那一条');
    });

    test('stream（有时）：会话忙时 run.ended 带 session_busy，不写日志', async () => {
      const { harness, store, agent } = await factory({ script: [{ type: 'text', text: '好' }] });
      if (!harness.stream) return;
      await store.append('s', [lifecycle(CTX_EVENTS.runStarted, 'other')]);
      const events: RunEvent[] = [];
      for await (const event of harness.stream({ session: 's', agent, input: '在吗' })) events.push(event);
      const ended = events.at(-1);
      assert.equal(ended?.type === 'run.ended' && ended.result.error?.type, 'session_busy');
      assert.equal((await store.list('s')).length, 1);
    });

    test('owner 写进 ctx.run.started；不给就没有这个字段', async () => {
      const { harness, store, agent } = await factory({
        script: [
          { type: 'text', text: '一' },
          { type: 'text', text: '二' },
        ],
      });
      await harness.run({ session: 's', agent, input: '1', owner: 'yoyo' });
      await harness.run({ session: 's', agent, input: '2' });
      const started = eventData(await store.list('s'), CTX_EVENTS.runStarted);
      assert.deepEqual(
        started.map((data) => data['owner']),
        ['yoyo', undefined],
      );
      assert.ok(!('owner' in started[1]!));
    });

    test('agent.context 交给 ContextBuilder：不认识的投影名以 not_found 结束，不调模型；facts: false 照常跑', async () => {
      const { harness, store, agent } = await factory({
        script: [
          { type: 'text', text: '好' },
          { type: 'text', text: '多余' },
        ],
      });
      // 忽略 `context` 的 builder 会静默回到缺省，在这里被暴露。
      const unknown = await harness.run({
        session: 's',
        agent: { ...agent, context: { projection: 'no-such-projection' } },
        input: '在吗',
      });
      assert.equal(unknown.stopReason, 'error');
      assert.equal(unknown.error?.type, 'not_found');
      assert.equal(eventData(await store.list('s'), CTX_EVENTS.runEnded)[0]?.['stopReason'], 'error');
      const quiet = await harness.run({ session: 't', agent: { ...agent, context: { facts: false } }, input: '在吗' });
      assert.equal(quiet.stopReason, 'end_turn');
      assert.equal(quiet.text, '好');
    });

    test('agent.context 记进 ctx.run.started 的 agent，能 JSON 往返', async () => {
      const { harness, store, agent } = await factory({ script: [{ type: 'text', text: '好' }] });
      const context = {
        facts: { sources: ['clock'], placement: 'prompt', heading: '环境' },
        projection: 'default',
        overflow: { maxTokens: 100_000, strategy: 'trim', compact: { keep: 4, maxInputTokens: 8_000 } },
      } as const;
      await harness.run({ session: 's', agent: { ...agent, context }, input: '在吗' });
      const [started] = eventData(await store.list('s'), CTX_EVENTS.runStarted);
      assert.deepEqual((started?.['agent'] as Record<string, unknown> | undefined)?.['context'], context);
    });

    test('不给 inputKey：上一轮失败留下的输入，带同样的输入重试不再记一遍；换一句照常记', async () => {
      const { harness, store, agent } = await factory({
        script: [
          { type: 'error', message: 'network down' },
          { type: 'error', message: 'network down' },
          { type: 'text', text: '三点了' },
          { type: 'error', message: 'network down' },
          { type: 'text', text: '晴' },
        ],
      });
      const request: RunRequest = { session: 's', agent: noRetry(agent), input: '几点了？' };
      assert.equal((await harness.run(request)).stopReason, 'error');
      assert.equal((await harness.run(request)).stopReason, 'error');
      const retry = await harness.run(request);
      assert.equal(retry.text, '三点了');
      const users = async (): Promise<number> => kinds(await store.list('s')).filter((kind) => kind === 'user').length;
      assert.equal(await users(), 1, '失败的重试不让历史变长');
      assert.ok(!retry.recorded.some((entry) => entry.type === 'message' && entry.message.role === 'user'));
      // 换了一句话就是新的输入；上一轮成功之后再说同一句也是。
      assert.equal((await harness.run({ ...request, input: '天气呢？' })).stopReason, 'error');
      assert.equal((await harness.run({ ...request, input: '我是说今天的天气' })).text, '晴');
      assert.equal(await users(), 3);
    });

    test('模型报上下文过长：以 error 结束，error.type 是 context_overflow，不可重试', async () => {
      const { harness, store, agent } = await factory({
        script: [
          {
            type: 'error',
            message:
              "This model's maximum context length is 8192 tokens. However, your messages resulted in 9000 tokens.",
          },
        ],
      });
      const result = await harness.run({ session: 's', agent: noRetry(agent), input: '在吗' });
      assert.equal(result.stopReason, 'error');
      assert.equal(result.error?.type, 'context_overflow');
      assert.equal(result.error?.retryable, false);
      assert.equal(eventData(await store.list('s'), CTX_EVENTS.error)[0]?.['type'], 'context_overflow');
    });

    test('agent.context.overflow：超了又选 error 就不调模型，以 context_overflow 结束；没超照常跑', async () => {
      const { harness, store, agent } = await factory({ script: [{ type: 'text', text: '好' }] });
      const strict = { ...agent, context: { overflow: { maxTokens: 1, strategy: 'error' } } } as const;
      const over = await harness.run({ session: 's', agent: strict, input: '在吗' });
      assert.equal(over.stopReason, 'error');
      assert.equal(over.error?.type, 'context_overflow');
      assert.equal(eventData(await store.list('s'), CTX_EVENTS.runEnded)[0]?.['stopReason'], 'error');
      // 剧本只有一步：上面要是调了模型，这里就没得回了。
      const roomy = { ...agent, context: { overflow: { maxTokens: 1_000_000, strategy: 'error' } } } as const;
      const fine = await harness.run({ session: 't', agent: roomy, input: '在吗' });
      assert.equal(fine.stopReason, 'end_turn');
      assert.equal(fine.text, '好');
    });

    test('agent.context.overflow：历史超了，裁到放得下再调模型（trim 不写摘要）', async () => {
      const { harness, store, agent } = await factory({ script: [{ type: 'text', text: '好' }] });
      await store.append('s', dialogue(40, 400));
      const result = await harness.run({
        session: 's',
        agent: { ...agent, context: { overflow: { maxTokens: 1_500, strategy: 'trim' } } },
        input: '接着说',
      });
      assert.equal(result.stopReason, 'end_turn', result.error?.message);
      assert.equal(result.text, '好');
      assert.deepEqual(await store.list('s', { types: ['summary'] }), []);
    });

    test('signal 已中止：返回 stopReason aborted，写 ctx.run.ended', async () => {
      const { harness, store, agent } = await factory({ script: [{ type: 'text', text: '不该说' }] });
      const result = await harness.run({ session: 's', agent, input: '在吗', signal: AbortSignal.abort() });
      assert.equal(result.stopReason, 'aborted');
      assert.equal(eventData(await store.list('s'), CTX_EVENTS.runEnded)[0]?.['stopReason'], 'aborted');
    });

    test('stream（有时）：run.started 在最前、run.ended 在最后，工具事件在两次模型调用之间', async () => {
      const text = randomMarker();
      const { harness, store, agent } = await factory({
        script: [
          { type: 'tool-call', id: 'call-1', input: { text } },
          { type: 'text', text: '好了' },
        ],
      });
      if (!harness.stream) return;
      const events: RunEvent[] = [];
      for await (const event of harness.stream({ session: 's', agent, input: '回显一下' })) events.push(event);
      const types = events.map((event) => event.type);
      assert.equal(types[0], 'run.started');
      assert.equal(types.at(-1), 'run.ended');
      assert.ok(
        events.every((event) => event.runId === events[0]!.runId),
        '同一个 runId',
      );
      const at = (type: RunEvent['type'], from = 0) => types.indexOf(type, from);
      assert.ok(at('model.started') > 0);
      assert.ok(at('tool.called') > at('model.started'));
      assert.ok(at('tool.returned') > at('tool.called'));
      assert.ok(at('model.started', at('tool.returned')) > at('tool.returned'), '工具结果之后再调一次模型');
      const deltas = events.flatMap((event) => (event.type === 'text.delta' ? [event.text] : []));
      assert.equal(deltas.join(''), '好了');
      const returned = events.find((event) => event.type === 'tool.returned');
      assert.ok(JSON.stringify(returned).includes(text), 'tool.returned 带着回显的输入');
      const ended = events.at(-1);
      assert.equal(ended?.type === 'run.ended' && ended.result.stopReason, 'end_turn');
      assert.equal(kinds(await store.list('s')).at(-1), CTX_EVENTS.runEnded);
    });

    test('stream（有时）：模型出错时先给 error 再给 run.ended，不抛', async () => {
      const { harness, agent } = await factory({ script: [{ type: 'error', message: 'model exploded' }] });
      if (!harness.stream) return;
      const types: string[] = [];
      for await (const event of harness.stream({ session: 's', agent: noRetry(agent), input: '在吗' })) {
        types.push(event.type);
        if (event.type === 'run.ended') assert.equal(event.result.stopReason, 'error');
      }
      assert.deepEqual(types.slice(-2), ['error', 'run.ended']);
    });
  });
}

// ---- ContextBuilder ----

export interface ContextBuilderFixture {
  readonly builder: ContextBuilder;
  /** builder 读的那个存储，用例往里写。 */
  readonly store: SessionStore;
}

/**
 * 每个用例调一次，拿到一个空的存储和读它的 builder。builder 用缺省的配置：没有事件规则、摘要按缺省渲染、不配窗口、
 * 不配来源。实现有 `compact` 时，摘要模型按这份剧本回答：每调一次取下一步，带 `truncated` 的那一步是被
 * `maxOutputTokens` 截断的输出（`finishReason` 是 `length`）。
 */
export type ContextBuilderFactory = (setup: ModelScript) => ContextBuilderFixture | Promise<ContextBuilderFixture>;

function said(messages: readonly Message[]): string[] {
  return messages.map((message) => `${message.role}:${textOf(message)}`);
}

/** 一问一答交替的 `count` 条消息，每条 `chars` 个字符左右。 */
function dialogue(count: number, chars = 2): NewEntry[] {
  const filler = 'lorem ipsum dolor sit amet '.repeat(Math.ceil(chars / 27)).slice(0, Math.max(0, chars - 2));
  return Array.from({ length: count }, (_, index) =>
    index % 2 === 0 ? userEntry(`问${index}${filler}`) : assistantEntry(`答${index}${filler}`),
  );
}

export function describeContextBuilderContract(
  name: string,
  factory: ContextBuilderFactory,
  { describe, test }: ContractTestApi,
): void {
  describe(`ContextBuilder contract: ${name}`, () => {
    test('build：历史按顺序，input 接在后面，prompt 在最后；带上指令；不写日志；结果全是 JSON', async () => {
      const { builder, store } = await factory({ script: [] });
      await store.append('s', [userEntry('一'), assistantEntry('二')]);
      const before = await store.list('s');
      const call = await builder.build({ session: 's', instructions: '你是助手。', input: '三', prompt: '四' });
      assert.deepEqual(said(call.messages), ['user:一', 'assistant:二', 'user:三', 'user:四']);
      assert.ok(call.instructions?.includes('你是助手。'), '指令在 instructions 里');
      assert.ok(
        call.messages.every((message) => message.role !== 'system'),
        'messages 里没有 system 消息',
      );
      assert.deepEqual(call.tools, []);
      assert.ok(Array.isArray(call.facts));
      assert.deepEqual(call.projection.messages.length, 2, '投影里只有历史');
      assert.deepEqual(await store.list('s'), before, 'build 不改日志');
      assert.ok(roundTrips(call), 'PreparedCall 能 JSON 往返');
    });

    test('build：tools 是候选工具的子集（按名字）；别的会话的历史不串进来', async () => {
      const { builder, store } = await factory({ script: [] });
      await store.append('s', [userEntry('这边')]);
      await store.append('t', [userEntry('那边')]);
      const candidates = [definition('echo'), definition('lookup')];
      const call = await builder.build({ session: 's', tools: candidates });
      assert.ok(call.tools.every((tool) => candidates.some((candidate) => candidate.name === tool)));
      assert.deepEqual(said(call.messages), ['user:这边']);
    });

    test('不认识的投影名：build 和 view 都以 not_found 失败，不回退到缺省', async () => {
      const { builder, store } = await factory({ script: [] });
      await store.append('s', [userEntry('在吗')]);
      await assert.rejects(builder.build({ session: 's', projection: 'no-such-projection' }), hasType('not_found'));
      await assert.rejects(builder.view('s', { projection: 'no-such-projection' }), hasType('not_found'));
      assert.equal((await builder.view('s', { projection: 'default' })).messages.length, 1);
    });

    test('view：没有规则的事件不进上下文；摘要代替它盖住的条目，排在最前', async () => {
      const { builder, store } = await factory({ script: [] });
      const written = await store.append('s', [
        userEntry('甲'),
        eventEntry('app.note', { text: '模型看不到' }),
        assistantEntry('乙'),
        userEntry('丙'),
      ]);
      assert.deepEqual(said((await builder.view('s')).messages), ['user:甲', 'assistant:乙', 'user:丙']);
      await store.append('s', [summaryEntry('之前聊了甲和乙', written[2]!.seq)]);
      const view = await builder.view('s');
      assert.equal(view.messages.length, 2);
      assert.ok(textOf(view.messages[0]!).includes('之前聊了甲和乙'), '第一条是摘要');
      assert.equal(textOf(view.messages[1]!), '丙');
      assert.equal(view.summary?.text, '之前聊了甲和乙');
      assert.equal(view.items[0]?.pinned, true);
      assert.ok(roundTrips(view), 'Projection 能 JSON 往返');
    });

    test('window：maxMessages 留最近的几条，{} 不裁剪；build 和 view 一样', async () => {
      const { builder, store } = await factory({ script: [] });
      await store.append('s', dialogue(6));
      const two = await builder.view('s', { window: { maxMessages: 2 } });
      assert.deepEqual(said(two.messages), ['user:问4', 'assistant:答5']);
      assert.equal(two.dropped, 4);
      assert.equal((await builder.view('s', { window: {} })).messages.length, 6);
      const call = await builder.build({ session: 's', window: { maxMessages: 2 } });
      assert.deepEqual(said(call.messages), ['user:问4', 'assistant:答5']);
    });

    test('window.truncate：单条消息就超过 maxTokens 时截短它，留头尾；不给 truncate 原样交出', async () => {
      const { builder, store } = await factory({ script: [] });
      const long = `HEAD ${'lorem ipsum dolor sit amet '.repeat(2_000)}TAIL`;
      await store.append('s', [userEntry(long)]);
      const whole = await builder.view('s', { window: { maxTokens: 500 } });
      assert.equal(textOf(whole.messages[0]!), long, '缺省宁可超预算也不动最后一组');
      assert.equal(whole.truncated, 0);
      const cut = await builder.view('s', { window: { maxTokens: 500, truncate: true } });
      assert.equal(cut.messages.length, 1);
      assert.equal(cut.truncated, 1);
      assert.ok(cut.tokens <= 500, `估算 ${cut.tokens}`);
      const text = textOf(cut.messages[0]!);
      assert.ok(text.length < long.length / 10, `截到 ${text.length} 个字符`);
      assert.ok(text.startsWith('HEAD lorem') && text.endsWith('TAIL'), '头尾都在');
      const [stored] = await store.list('s');
      assert.equal(stored?.type === 'message' && textOf(stored.message), long, '日志里的原文不动');
    });

    test('build 的 tokens（有时）：整次调用的估算，不小于历史的，指令越长越大', async () => {
      const { builder, store } = await factory({ script: [] });
      await store.append('s', dialogue(4, 200));
      const short = await builder.build({ session: 's', instructions: '短' });
      if (short.tokens === undefined) return;
      assert.ok(short.tokens >= short.projection.tokens);
      const long = await builder.build({ session: 's', instructions: '很长的指令。'.repeat(500) });
      assert.ok((long.tokens ?? 0) > short.tokens + 1_000);
    });

    test('compact（有时）：历史不够长返回 null，不调模型，什么都不写', async () => {
      const { builder, store } = await factory({ script: [] });
      if (!builder.compact) return;
      await store.append('s', dialogue(3));
      const before = await store.list('s');
      assert.equal(await builder.compact('s'), null);
      assert.deepEqual(await store.list('s'), before);
      if (builder.compactDetailed) assert.equal((await builder.compactDetailed('s')).status, 'not_needed');
    });

    test('compact（有时）：较早的历史压成摘要并记 ctx.compacted，最近 keep 条原样留着，原条目还在', async () => {
      const { builder, store } = await factory({ script: [{ type: 'text', text: '摘要甲' }] });
      if (!builder.compact) return;
      const written = await store.append('s', dialogue(10));
      const summary = await builder.compact('s', { keep: 2, minimum: 1 });
      assert.equal(summary?.type, 'summary');
      assert.equal(summary?.text, '摘要甲');
      assert.equal(summary?.covers, written[7]!.seq, 'covers 是被保留的第一条之前');
      const log = await store.list('s');
      assert.equal(log.filter((entry) => entry.type === 'message').length, 10, '原条目都在');
      assert.deepEqual(eventData(log, CTX_EVENTS.compacted), [{ covers: summary?.covers, summaryId: summary?.id }]);
      const view = await builder.view('s');
      assert.equal(view.messages.length, 3);
      assert.ok(textOf(view.messages[0]!).includes('摘要甲'));
      assert.deepEqual(said(view.messages.slice(1)), ['user:问8', 'assistant:答9']);
      assert.equal(view.summary?.id, summary?.id);
    });

    test('compact（有时）：摘要被截断时不写，返回 null；compactDetailed（有时）说是 truncated，和 not_needed 分得开', async () => {
      const step = { type: 'text', text: '半截', truncated: true } as const;
      const { builder, store } = await factory({ script: [step, step] });
      if (!builder.compact) return;
      await store.append('s', dialogue(10));
      assert.equal(await builder.compact('s', { keep: 2, minimum: 1 }), null);
      assert.deepEqual(await store.list('s', { types: ['summary'] }), []);
      if (!builder.compactDetailed) return;
      const result = await builder.compactDetailed('s', { keep: 2, minimum: 1 });
      assert.equal(result.status, 'truncated');
      assert.equal(result.summary, undefined);
      assert.equal(result.compacted, 0);
      assert.equal(result.remaining, 8);
      assert.ok(roundTrips(result), 'CompactResult 能 JSON 往返');
    });

    test('compact（有时）：历史超过 maxInputTokens 时分段滚动摘要，最后只有一条生效的摘要', async () => {
      const script = Array.from({ length: 64 }, (_, index) => ({ type: 'text', text: `摘要${index + 1}` }) as const);
      const { builder, store } = await factory({ script });
      if (!builder.compact) return;
      // 40 条、每条四百个字符：无论怎么估，一次 1500 token 的输入都放不下。
      await store.append('s', dialogue(40, 400));
      const summary = await builder.compact('s', { keep: 2, minimum: 1, maxInputTokens: 1_500 });
      assert.ok(summary, '压缩了');
      assert.notEqual(summary.text, '摘要1', '不是一次调用压完的');
      const view = await builder.view('s');
      assert.equal(view.messages.length, 3, '一条摘要 + 最近 2 条');
      assert.equal(view.summary?.id, summary.id);
      assert.equal(view.items.filter((item) => item.pinned).length, 1);
      if (!builder.compactDetailed) return;
      await store.append('s', dialogue(40, 400));
      const result = await builder.compactDetailed('s', { keep: 2, minimum: 1, maxInputTokens: 1_500 });
      assert.equal(result.status, 'compacted');
      assert.ok(result.calls >= 2, `调了 ${result.calls} 次模型`);
      assert.equal(result.remaining, 0);
      assert.equal((await builder.view('s')).summary?.id, result.summary?.id);
    });
  });
}

// ---- Orchestrator ----

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
            ? [
                `${entry.kind === CTX_EVENTS.runStarted ? 'start' : 'end'}:${(entry.data as JsonObject)['runId'] as string}`,
              ]
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

// ---- MemoryStore ----

/** 每个用例调一次，拿到一个空的存储。存储的时刻都由调用方给；`now` 只给要用时钟生成 `id` 的实现。 */
export type MemoryStoreFactory = (options: { readonly now: () => number }) => MemoryStore | Promise<MemoryStore>;

const MEMORY_NOW = Date.UTC(2026, 9, 27);
const MEMORY_STORE_SETUP = { now: (): number => MEMORY_NOW };

function ref(from: number, upTo: number = from, session = 's'): SourceRef {
  return { session, from, upTo };
}

function newFact(text: string, extra: Partial<NewMemoryFact> = {}): NewMemoryFact {
  return {
    subject: 'user',
    text,
    validFrom: MEMORY_NOW,
    confidence: 0.9,
    salience: 0.6,
    sources: [ref(1)],
    ...extra,
  };
}

/** 错误的 `type` 是它：本地的 `CtxError` 和远端客户端转出来的错误都认。 */
function hasType(type: string): (error: unknown) => boolean {
  return (error) => typeof error === 'object' && error !== null && (error as { type?: unknown }).type === type;
}

function ids(items: readonly { readonly id: string }[]): string[] {
  return items.map((item) => item.id);
}

async function factById(store: MemoryStore, id: string): Promise<MemoryFact | undefined> {
  return (await store.facts.list()).find((fact) => fact.id === id);
}

/** `search` 命中的事实的 `id`，按返回的顺序。 */
async function searchIds(store: MemoryStore, query: Parameters<MemoryStore['facts']['search']>[0]): Promise<string[]> {
  return (await store.facts.search(query)).map((hit) => hit.fact.id);
}

/** 自然的中文问句和它该找回的事实：两边没有一个整句的子串，只有零散的共同的词。 */
const CHINESE_RECALL: readonly (readonly [question: string, fact: string])[] = [
  ['我们项目现在用的是什么数据库？', '主人的项目数据库从 MySQL 换成了 PostgreSQL'],
  ['我平时喜欢喝什么茶？', '主人喜欢喝乌龙茶，不喝咖啡'],
  ['你还记得我住在哪个城市吗', '主人住在杭州西湖区'],
  ['数据库一般什么时候备份', '主人每周五下午备份数据库'],
  ['我家的猫叫什么名字', '主人的猫叫年糕，三岁'],
  ['我有什么过敏的东西吗', '主人对花生过敏'],
  ['下个月出差是去哪里', '主人下个月要去东京出差'],
];

export function describeMemoryStoreContract(
  name: string,
  factory: MemoryStoreFactory,
  { describe, test }: ContractTestApi,
): void {
  describe(`MemoryStore contract: ${name}`, () => {
    test('scope：四个集合按作用域分开，互相读不到、搜不到', async () => {
      const store = await factory(MEMORY_STORE_SETUP);
      const alice = store.scope('user:alice');
      const bob = store.scope('user:bob');
      const procedure = { when: '部署前', do: '先跑测试', evidence: [ref(1)], at: 5 };

      const [note] = await alice.notes.add([{ session: 's', from: 1, upTo: 3, at: 10, salience: 0.8 }]);
      const fact = await alice.facts.add(newFact('喜欢喝乌龙茶'));
      const rule = await alice.procedures.add(procedure);
      await alice.core.set('alice 的画像', 1);
      assert.ok(note);

      assert.deepEqual(ids(await alice.notes.list()), [note.id]);
      assert.equal(await alice.notes.head('s'), 3);
      assert.deepEqual(ids(await alice.facts.list()), [fact.id]);
      assert.deepEqual(ids((await alice.facts.search({ text: '乌龙茶' })).map((hit) => hit.fact)), [fact.id]);
      assert.deepEqual(ids(await alice.procedures.list()), [rule.id]);
      assert.equal((await alice.core.get())?.text, 'alice 的画像');

      for (const other of [bob, store]) {
        assert.deepEqual(await other.notes.list(), []);
        assert.equal(await other.notes.head('s'), 0, 'head 按作用域：同一个会话在别的作用域里没被门控过');
        assert.deepEqual(await other.facts.list(), []);
        assert.deepEqual(await other.facts.search({ text: '乌龙茶', open: false }), []);
        assert.deepEqual(await other.procedures.list(), []);
        assert.equal(await other.core.get(), null);
        assert.deepEqual(await other.core.history(), []);
      }

      // 同样的东西写进另一个作用域是另一条，画像各是各的。
      const same = await bob.facts.add(newFact('喜欢喝乌龙茶'));
      await bob.core.set('bob 的画像', 2);
      assert.notEqual(same.id, fact.id, 'id 在整份存储里不重复');
      assert.deepEqual(ids(await bob.facts.list()), [same.id]);
      assert.equal((await alice.core.get())?.text, 'alice 的画像');
      assert.deepEqual(
        (await alice.core.history()).map((version) => version.text),
        ['alice 的画像'],
      );
    });

    test('scope：别的作用域的 id 和不存在的一样，改不了也删不掉', async () => {
      const store = await factory(MEMORY_STORE_SETUP);
      const alice = store.scope('user:alice');
      const bob = store.scope('user:bob');
      const [note] = await alice.notes.add([{ session: 's', from: 1, upTo: 3, at: 10, salience: 0.8 }]);
      const fact = await alice.facts.add(newFact('住在杭州'));
      const rule = await alice.procedures.add({ when: '部署前', do: '先跑测试', evidence: [ref(1)], at: 5 });
      const mine = await bob.facts.add(newFact('住在上海'));
      assert.ok(note);

      assert.equal(await bob.notes.settle([note.id], 20), 0);
      await assert.rejects(bob.facts.close(fact.id, 20), hasType('not_found'));
      await assert.rejects(bob.facts.close(mine.id, 20, { supersededBy: fact.id }), hasType('not_found'));
      await assert.rejects(bob.facts.cite(fact.id, [ref(5)]), hasType('not_found'));
      await bob.facts.touch([fact.id], 20);
      assert.equal(await bob.facts.archive([fact.id], 20), 0);
      assert.equal(await bob.facts.restore([fact.id]), 0);
      assert.equal(await bob.facts.forget([fact.id]), 0);
      await assert.rejects(bob.procedures.confirm(rule.id, [ref(5)]), hasType('not_found'));
      await assert.rejects(bob.procedures.retire(rule.id, 20), hasType('not_found'));

      assert.deepEqual(await alice.notes.list(), [note], '笔记没被处理');
      assert.deepEqual(await alice.facts.list(), [fact], '事实没被关闭、引用、召回、归档或删除');
      assert.deepEqual(await alice.procedures.list(), [rule], '程序没被确认或退役');
      assert.deepEqual(await bob.facts.list(), [mine], '没成的 close 不留下半截');
    });

    test('scope：名字是绝对的，不嵌套；空串是缺省的作用域；不合法的名字抛 invalid_request', async () => {
      const store = await factory(MEMORY_STORE_SETUP);
      const fact = await store.facts.add(newFact('缺省作用域里的事实'));
      const nested = await store.scope('a').scope('b').facts.add(newFact('b 里的事实'));
      assert.deepEqual(ids(await store.scope('b').facts.list()), [nested.id]);
      assert.deepEqual(await store.scope('a').facts.list(), []);
      assert.deepEqual(ids(await store.scope('a').scope('').facts.list()), [fact.id]);
      assert.deepEqual(ids(await store.scope('b').scope('').facts.list()), [fact.id]);
      // 名字原样比较：大小写、前后空白都算不同的作用域。
      assert.deepEqual(await store.scope('B').facts.list(), []);
      assert.deepEqual(await store.scope('b ').facts.list(), []);
      const long = 'x'.repeat(256);
      const inLong = await store.scope(long).facts.add(newFact('长名字'));
      assert.deepEqual(ids(await store.scope(long).facts.list()), [inLong.id]);
      // 远端的实现到真正请求时才知道名字不合法，所以连同一次读一起看。
      await assert.rejects(
        Promise.resolve().then(() => store.scope(`${long}x`).facts.list()),
        hasType('invalid_request'),
      );
    });

    test('scope：检索的索引、归档和恢复也按作用域分开', async () => {
      const store = await factory(MEMORY_STORE_SETUP);
      const alice = store.scope('user:alice');
      const bob = store.scope('user:bob');
      const hers = await alice.facts.add(newFact('主人住在杭州西湖区'));
      const his = await bob.facts.add(newFact('主人住在上海浦东'));
      const question = '主人住在哪里';
      assert.deepEqual(await searchIds(alice, { text: question }), [hers.id]);
      assert.deepEqual(await searchIds(bob, { text: question }), [his.id]);
      assert.deepEqual(await searchIds(bob, { text: '杭州西湖', open: false }), [], '别的作用域里才有的词搜不到');

      assert.equal(await alice.facts.archive([hers.id], 5), 1);
      assert.equal(await bob.facts.restore([hers.id]), 0, '恢复不了别的作用域里归档的事实');
      assert.deepEqual(await searchIds(bob, { text: question, archived: true }), [his.id]);
      assert.deepEqual(await searchIds(alice, { text: question, archived: true }), [hers.id]);
      assert.equal(await alice.facts.forget([hers.id]), 1);
      assert.deepEqual(await searchIds(alice, { text: question, open: false }), []);
      assert.deepEqual(
        await searchIds(bob, { text: question }),
        [his.id],
        '删掉一个作用域的事实，别的作用域里同样的词还搜得到',
      );
    });

    test('notes：add 按输入顺序返回并生成 id；list 按写入顺序，session、pending、limit 可组合', async () => {
      const store = await factory(MEMORY_STORE_SETUP);
      const [a, b] = await store.notes.add([
        { session: 's', from: 1, upTo: 3, at: 10, salience: 0.8, kind: 'pref', topic: 'user' },
        { session: 't', from: 2, upTo: 2, at: 11, salience: 0.4 },
      ]);
      assert.ok(a && b);
      assert.deepEqual(a, {
        id: a.id,
        session: 's',
        from: 1,
        upTo: 3,
        at: 10,
        salience: 0.8,
        kind: 'pref',
        topic: 'user',
      });
      assert.deepEqual(b, { id: b.id, session: 't', from: 2, upTo: 2, at: 11, salience: 0.4 });
      assert.ok(a.id.length > 0 && b.id.length > 0 && a.id !== b.id, 'id 非空、不重复');
      const [c] = await store.notes.add([{ session: 's', from: 4, upTo: 6, at: 12, salience: 0.1, settledAt: 12 }]);
      assert.ok(c);
      assert.equal(c.settledAt, 12, '可以直接写一条处理过的笔记');
      const all = await store.notes.list();
      assert.deepEqual(all, [a, b, c], '按写入顺序，原样读回');
      assert.ok(roundTrips(all), '笔记能 JSON 往返：可选字段不给时不出现');
      assert.deepEqual(ids(await store.notes.list({ session: 's' })), [a.id, c.id]);
      assert.deepEqual(ids(await store.notes.list({ pending: true })), [a.id, b.id]);
      assert.deepEqual(ids(await store.notes.list({ pending: false })), [c.id]);
      assert.deepEqual(ids(await store.notes.list({ session: 's', pending: true })), [a.id]);
      assert.deepEqual(ids(await store.notes.list({ limit: 2 })), [a.id, b.id], 'limit 取最早写入的');
      assert.deepEqual(ids(await store.notes.list({ limit: 1.9 })), [a.id], 'limit 向下取整');
      assert.deepEqual(await store.notes.list({ limit: 0 }), []);
      assert.deepEqual(await store.notes.list({ session: 'nope' }), []);
    });

    test('notes：settle 只标待处理的，返回真正标上的条数，可重复调；不改已有的 settledAt', async () => {
      const store = await factory(MEMORY_STORE_SETUP);
      const [a, b] = await store.notes.add([
        { session: 's', from: 1, upTo: 2, at: 1, salience: 0.9 },
        { session: 's', from: 3, upTo: 4, at: 2, salience: 0.9 },
      ]);
      assert.equal(await store.notes.settle([a!.id, 'missing'], 100), 1, '认不得的 id 跳过');
      assert.equal(await store.notes.settle([a!.id, b!.id], 200), 1, '已经处理过的不算');
      assert.equal(await store.notes.settle([a!.id, b!.id], 300), 0);
      assert.equal(await store.notes.settle([], 400), 0);
      assert.deepEqual(
        (await store.notes.list()).map((note) => note.settledAt),
        [100, 200],
      );
      assert.deepEqual(await store.notes.list({ pending: true }), []);
    });

    test('notes：head 是这个会话的笔记（含处理过的）覆盖到的最大 seq，没有是 0', async () => {
      const store = await factory(MEMORY_STORE_SETUP);
      assert.equal(await store.notes.head('s'), 0);
      await store.notes.add([
        { session: 's', from: 1, upTo: 3, at: 1, salience: 0.9 },
        { session: 's', from: 7, upTo: 9, at: 2, salience: 0.1, settledAt: 2 },
        { session: 't', from: 2, upTo: 20, at: 3, salience: 0.5 },
        { session: 's', from: 4, upTo: 5, at: 4, salience: 0.5 },
      ]);
      assert.equal(await store.notes.head('s'), 9);
      assert.equal(await store.notes.head('t'), 20);
      assert.equal(await store.notes.head('u'), 0);
    });

    test('notes：区间不合法时整批不写，抛 invalid_request', async () => {
      const store = await factory(MEMORY_STORE_SETUP);
      const good = { session: 's', from: 1, upTo: 2, at: 1, salience: 0.5 };
      await assert.rejects(store.notes.add([good, { ...good, from: 5, upTo: 4 }]), hasType('invalid_request'));
      await assert.rejects(store.notes.add([{ ...good, from: 0 }]), hasType('invalid_request'));
      assert.deepEqual(await store.notes.list(), []);
      assert.equal(await store.notes.head('s'), 0);
    });

    test('facts：add 生成 id，recalls 从空开始，没有有效期终点、取代和归档；字段原样读回', async () => {
      const store = await factory(MEMORY_STORE_SETUP);
      const input = newFact('主人喜欢乌龙茶', {
        predicate: 'likes',
        topic: 'user',
        sources: [ref(1, 2), ref(5, 5, 't')],
      });
      const fact = await store.facts.add(input);
      assert.ok(typeof fact.id === 'string' && fact.id.length > 0);
      assert.deepEqual(fact, { ...input, id: fact.id, recalls: [] });
      assert.deepEqual(await store.facts.list(), [fact]);
      assert.ok(roundTrips(fact), '事实能 JSON 往返：可选字段不给时不出现');
      const other = await store.facts.add(newFact('主人住在台北'));
      assert.notEqual(other.id, fact.id);
    });

    test('facts：没有证据或证据区间不合法时不写，抛 invalid_request', async () => {
      const store = await factory(MEMORY_STORE_SETUP);
      await assert.rejects(store.facts.add(newFact('编造的', { sources: [] })), hasType('invalid_request'));
      await assert.rejects(store.facts.add(newFact('编造的', { sources: [ref(3, 2)] })), hasType('invalid_request'));
      await assert.rejects(
        store.facts.add(newFact('编造的', { sources: [ref(1), ref(0, 1)] })),
        hasType('invalid_request'),
      );
      assert.deepEqual(await store.facts.list(), []);
    });

    test('facts：close 关闭有效期并记 supersededBy，文字不变；已关闭的不再改；认不得的 id 抛 not_found', async () => {
      const store = await factory(MEMORY_STORE_SETUP);
      const old = await store.facts.add(newFact('项目用 MySQL', { topic: 'work' }));
      const next = await store.facts.add(newFact('项目用 PostgreSQL', { topic: 'work' }));
      await store.facts.close(old.id, MEMORY_NOW + 500, { supersededBy: next.id });
      const closed = await factById(store, old.id);
      assert.deepEqual(
        closed,
        { ...old, validTo: MEMORY_NOW + 500, supersededBy: next.id },
        '只多了 validTo 和 supersededBy',
      );
      await store.facts.close(old.id, MEMORY_NOW + 900);
      assert.deepEqual(await factById(store, old.id), closed, '第二次 close 什么都不做');
      await assert.rejects(store.facts.close('missing', 1), hasType('not_found'));
      await assert.rejects(store.facts.close(next.id, 1, { supersededBy: 'missing' }), hasType('not_found'));
      assert.equal((await factById(store, next.id))?.validTo, undefined, 'supersededBy 认不得时不关闭');
      await store.facts.close(next.id, MEMORY_NOW + 600);
      const plain = await factById(store, next.id);
      assert.equal(plain?.validTo, MEMORY_NOW + 600);
      assert.ok(plain && !('supersededBy' in plain), '不给 supersededBy 就没有这个字段');
      assert.deepEqual(await store.facts.list({ open: true }), []);
      assert.equal((await store.facts.list()).length, 2, '关闭不删');
    });

    test('facts：cite 追加证据，文字和有效期不变；相同的区间跳过；没有证据抛 invalid_request，认不得的 id 抛 not_found', async () => {
      const store = await factory(MEMORY_STORE_SETUP);
      const fact = await store.facts.add(newFact('主人喜欢乌龙茶', { sources: [ref(1, 2)] }));
      const cited = await store.facts.cite(fact.id, [ref(5, 6), ref(1, 2)]);
      assert.deepEqual(cited, { ...fact, sources: [ref(1, 2), ref(5, 6)] });
      assert.deepEqual(await store.facts.cite(fact.id, [ref(5, 6)]), cited, '重复的证据不再记');
      assert.deepEqual(await factById(store, fact.id), cited);
      await assert.rejects(store.facts.cite(fact.id, []), hasType('invalid_request'));
      await assert.rejects(store.facts.cite(fact.id, [ref(4, 3)]), hasType('invalid_request'));
      await assert.rejects(store.facts.cite('missing', [ref(1)]), hasType('not_found'));
      assert.deepEqual(await factById(store, fact.id), cited, '失败的调用什么都不改');
    });

    test('facts：touch 按先后追加召回时刻，跳过认不得的 id', async () => {
      const store = await factory(MEMORY_STORE_SETUP);
      const a = await store.facts.add(newFact('甲'));
      const b = await store.facts.add(newFact('乙'));
      await store.facts.touch([a.id, 'missing'], 100);
      await store.facts.touch([a.id, b.id], 200);
      await store.facts.touch([a.id], 300);
      await store.facts.touch([], 400);
      assert.deepEqual((await factById(store, a.id))?.recalls, [100, 200, 300]);
      assert.deepEqual((await factById(store, b.id))?.recalls, [200]);
    });

    test(`facts：recalls 只留最近 ${MAX_FACT_RECALLS} 次，早的丢掉，一条事实不随召回次数无限变长`, async () => {
      const store = await factory(MEMORY_STORE_SETUP);
      const a = await store.facts.add(newFact('甲'));
      const b = await store.facts.add(newFact('乙'));
      await store.facts.touch([b.id], 1);
      for (let i = 0; i < MAX_FACT_RECALLS + 5; i += 1) await store.facts.touch([a.id], 1000 + i);
      const expected = Array.from({ length: MAX_FACT_RECALLS }, (_, i) => 1005 + i);
      assert.deepEqual((await factById(store, a.id))?.recalls, expected, '留下的是最近的那些，仍按先后');
      await store.facts.touch([a.id, b.id], 5000);
      assert.deepEqual((await factById(store, a.id))?.recalls, [...expected.slice(1), 5000]);
      assert.deepEqual((await factById(store, b.id))?.recalls, [1, 5000], '没满的照常追加');
    });

    test('facts：archive 退出 open 的查询但不删，返回真正归档的条数', async () => {
      const store = await factory(MEMORY_STORE_SETUP);
      const a = await store.facts.add(newFact('甲'));
      const b = await store.facts.add(newFact('乙'));
      const c = await store.facts.add(newFact('丙'));
      assert.equal(await store.facts.archive([a.id, 'missing'], 100), 1);
      assert.equal(await store.facts.archive([a.id, b.id], 200), 1, '已经归档的不算，也不改 archivedAt');
      assert.deepEqual(await factById(store, a.id), { ...a, archivedAt: 100 });
      assert.equal((await factById(store, b.id))?.archivedAt, 200);
      assert.deepEqual(ids(await store.facts.list({ open: true })), [c.id]);
      assert.equal((await store.facts.list()).length, 3);
    });

    test('facts：restore 恢复归档的事实，返回真正恢复的条数；有效期不动；恢复之后可以再归档', async () => {
      const store = await factory(MEMORY_STORE_SETUP);
      const a = await store.facts.add(newFact('甲'));
      const b = await store.facts.add(newFact('乙'));
      const c = await store.facts.add(newFact('丙'));
      const open = async (): Promise<string[]> => ids(await store.facts.list({ open: true })).toSorted();
      assert.equal(await store.facts.archive([a.id, b.id], 100), 2);
      assert.equal(await store.facts.restore([a.id, c.id, 'missing']), 1, '没归档的、认不得的不算');
      assert.deepEqual(await factById(store, a.id), a, '恢复之后和归档之前一样，没有 archivedAt');
      assert.equal(await store.facts.restore([a.id, a.id]), 0, '已经恢复的不算');
      assert.equal(await store.facts.restore([]), 0);
      assert.deepEqual(await open(), [a.id, c.id].toSorted());

      await store.facts.close(b.id, 150);
      assert.equal(await store.facts.restore([b.id]), 1);
      assert.deepEqual(await factById(store, b.id), { ...b, validTo: 150 }, '关闭的恢复了还是关闭的');
      assert.deepEqual(await open(), [a.id, c.id].toSorted());

      assert.equal(await store.facts.archive([a.id], 300), 1);
      assert.equal((await factById(store, a.id))?.archivedAt, 300, '再归档记的是新的时刻');
    });

    test('facts：forget 真删，并清掉别的事实里指向它的 supersededBy', async () => {
      const store = await factory(MEMORY_STORE_SETUP);
      const old = await store.facts.add(newFact('项目用 MySQL'));
      const next = await store.facts.add(newFact('项目用 PostgreSQL'));
      await store.facts.close(old.id, MEMORY_NOW + 5, { supersededBy: next.id });
      assert.equal(await store.facts.forget([next.id, 'missing']), 1);
      assert.equal(await store.facts.forget([next.id]), 0);
      assert.deepEqual(
        await store.facts.list(),
        [{ ...old, validTo: MEMORY_NOW + 5 }],
        '有效期还在，supersededBy 没了',
      );
      assert.deepEqual(await store.facts.search({ text: 'PostgreSQL', open: false }), [], '搜也搜不到');
    });

    test('facts：list 按 id 码点序；subject、topic、open 筛选和 filterFacts 一致；after、limit 翻页不重不漏', async () => {
      const store = await factory(MEMORY_STORE_SETUP);
      const added: MemoryFact[] = [];
      for (const [i, extra] of [
        { subject: 'user', topic: 'user' },
        { subject: 'user', topic: 'work' },
        { subject: 'project:x', topic: 'work' },
        { subject: 'user' },
        { subject: 'project:x' },
        { subject: 'user', topic: 'work' },
        { subject: 'user', topic: 'user' },
      ].entries()) {
        added.push(await store.facts.add(newFact(`事实 ${i}`, extra)));
      }
      await store.facts.close(added[1]!.id, MEMORY_NOW + 1);
      await store.facts.archive([added[4]!.id], MEMORY_NOW + 1);
      const all = await store.facts.list();
      assert.equal(all.length, added.length);
      assert.deepEqual(ids(all), ids(filterFacts(all)), '按 id 码点序');
      const queries = [
        { subject: 'user' },
        { topic: 'work' },
        { open: true },
        { open: false },
        { subject: 'user', topic: 'work', open: true },
        { after: all[2]!.id },
        { after: all[2]!.id, limit: 2 },
        { limit: 3 },
        { limit: 2.5 },
        { limit: 0 },
        { subject: 'nobody' },
      ];
      for (const query of queries) {
        assert.deepEqual(ids(await store.facts.list(query)), ids(filterFacts(all, query)), JSON.stringify(query));
      }
      for (const base of [{}, { open: true }, { subject: 'user' }]) {
        const pages: string[] = [];
        for (let after: string | undefined; ;) {
          const page = await store.facts.list({ ...base, limit: 2, ...(after !== undefined ? { after } : {}) });
          if (page.length === 0) break;
          pages.push(...ids(page));
          after = page.at(-1)!.id;
        }
        assert.deepEqual(pages, ids(filterFacts(all, base)), `翻页 ${JSON.stringify(base)}`);
      }
    });

    test('facts：search 至少全文命中（英文词、三个字以上的中文子串）；缺省只看 open，open: false 不限；topic、k 生效；score 在 0..1 从高到低', async () => {
      const store = await factory(MEMORY_STORE_SETUP);
      const pg = await store.facts.add(newFact('主人的项目用 PostgreSQL 存数据', { topic: 'work' }));
      const tea = await store.facts.add(newFact('主人的饮料是乌龙茶', { topic: 'user' }));
      const mysql = await store.facts.add(newFact('以前的项目用 MySQL', { topic: 'work' }));
      const backup = await store.facts.add(newFact('MySQL 备份在周五', { topic: 'work' }));
      await store.facts.close(mysql.id, MEMORY_NOW + 1);
      await store.facts.archive([backup.id], MEMORY_NOW + 1);
      const all = await store.facts.list();
      const hits = async (query: Parameters<MemoryStore['facts']['search']>[0]): Promise<string[]> => {
        const found = await store.facts.search(query);
        assert.ok(roundTrips(found), '命中能 JSON 往返');
        for (const [i, hit] of found.entries()) {
          assert.ok(hit.score >= 0 && hit.score <= 1, `score ${hit.score} 在 0..1`);
          if (i > 0) assert.ok(hit.score <= found[i - 1]!.score, '按 score 从高到低');
          assert.deepEqual(
            hit.fact,
            all.find((fact) => fact.id === hit.fact.id),
            '命中的事实和 list 读到的一样',
          );
        }
        return found.map((hit) => hit.fact.id);
      };
      assert.ok((await hits({ text: 'PostgreSQL' })).includes(pg.id), '英文词');
      assert.ok((await hits({ text: '乌龙茶' })).includes(tea.id), '中文子串');
      const open = await hits({ text: 'MySQL' });
      assert.ok(!open.includes(mysql.id) && !open.includes(backup.id), '缺省不看关闭的和归档的');
      const any = await hits({ text: 'MySQL', open: false });
      assert.ok(any.includes(mysql.id) && any.includes(backup.id), 'open: false 连同关闭、归档的一起搜');
      assert.ok(!(await hits({ text: 'PostgreSQL', topic: 'user' })).includes(pg.id), 'topic 不对不命中');
      assert.ok((await hits({ text: 'PostgreSQL', topic: 'work' })).includes(pg.id));
      const work = await store.facts.search({ text: '项目', topic: 'work', open: false });
      assert.ok(work.every((hit) => hit.fact.topic === 'work'));
      assert.equal((await hits({ text: '主人的', k: 1 })).length, 1, 'k 限制条数');
      assert.ok((await hits({ text: '主人的' })).length >= 2);
      assert.deepEqual(await hits({ text: '主人的', k: 0 }), []);
    });

    test('facts：search 的 archived：仍然成立的里面连归档的一起搜，关闭的不搜；open: false 本来就不限', async () => {
      const store = await factory(MEMORY_STORE_SETUP);
      const open = await store.facts.add(newFact('项目用 Kubernetes 部署'));
      const archived = await store.facts.add(newFact('以前在 Kubernetes 上跑批处理'));
      const closed = await store.facts.add(newFact('Kubernetes 的版本是 1.28'));
      const both = await store.facts.add(newFact('Kubernetes 集群放在机房'));
      await store.facts.archive([archived.id, both.id], MEMORY_NOW + 1);
      await store.facts.close(closed.id, MEMORY_NOW + 1);
      await store.facts.close(both.id, MEMORY_NOW + 2);
      const found = async (query: { open?: boolean; archived?: boolean }): Promise<Set<string>> =>
        new Set(await searchIds(store, { text: 'Kubernetes', ...query }));
      const all = new Set([open.id, archived.id, closed.id, both.id]);
      assert.deepEqual(await found({}), new Set([open.id]));
      assert.deepEqual(await found({ archived: false }), new Set([open.id]));
      assert.deepEqual(await found({ archived: true }), new Set([open.id, archived.id]), '关闭的归档了也不搜');
      assert.deepEqual(await found({ open: true, archived: true }), new Set([open.id, archived.id]));
      assert.deepEqual(await found({ open: false }), all);
      assert.deepEqual(await found({ open: false, archived: false }), all, 'open: false 时 archived 不起作用');
      const hit = (await store.facts.search({ text: 'Kubernetes', archived: true })).find(
        (item) => item.fact.id === archived.id,
      );
      assert.equal(hit?.fact.archivedAt, MEMORY_NOW + 1, '归档的命中带着 archivedAt，调用方据此降权');

      assert.equal(await store.facts.restore([archived.id]), 1);
      assert.deepEqual(await found({}), new Set([open.id, archived.id]), '恢复之后缺省的搜索又搜得到');
    });

    test('facts：search 中文问句：没有空白分词也找得回该找回的那条；没有共同的词就不命中', async () => {
      const store = await factory(MEMORY_STORE_SETUP);
      const added: MemoryFact[] = [];
      for (const [, text] of CHINESE_RECALL) added.push(await store.facts.add(newFact(text)));
      for (const [i, [question, text]] of CHINESE_RECALL.entries()) {
        const found = await searchIds(store, { text: question });
        assert.ok(found.includes(added[i]!.id), `「${question}」应该找回「${text}」`);
      }
      assert.deepEqual(await store.facts.search({ text: '明天天气怎么样' }), []);
      assert.deepEqual(await store.facts.search({ text: '' }), [], '空的查询什么都不命中');
      assert.deepEqual(await store.facts.search({ text: ' ，。？ ' }), [], '只有空白和标点的查询什么都不命中');
    });

    test('facts：search 超长的查询（上千个不同的词）不报错，开头和结尾的词照样命中', async () => {
      const store = await factory(MEMORY_STORE_SETUP);
      const head = await store.facts.add(newFact('主人的项目用 PostgreSQL 存数据'));
      const tail = await store.facts.add(newFact('服务部署在 Kubernetes 集群上'));
      const other = await store.facts.add(newFact('主人每天早上跑步'));
      const filler = Array.from({ length: 1500 }, (_, i) => `filler${i}`).join(' ');
      const hits = await store.facts.search({ text: `PostgreSQL ${filler} Kubernetes` });
      const found = hits.map((hit) => hit.fact.id);
      assert.ok(found.includes(head.id), '开头的词命中');
      assert.ok(found.includes(tail.id), '结尾的词命中');
      assert.ok(!found.includes(other.id));
      for (const hit of hits) assert.ok(hit.score > 0 && hit.score <= 1, `score ${hit.score} 在 0..1`);

      // 没有空白的一长段中文：三千个字，接着一句问话。
      const prose = Array.from({ length: 3000 }, (_, i) => String.fromCodePoint(0x4e00 + ((i * 7) % 2000))).join('');
      const asked = await store.facts.search({ text: `${prose}。主人每天早上跑步吗`, k: 2 });
      assert.ok(asked.length <= 2, 'k 照样生效');
      assert.ok(
        asked.some((hit) => hit.fact.id === other.id),
        '长段后面的问话照样命中',
      );
      const huge = Array.from({ length: 20_000 }, (_, i) => `w${i}`).join(' ');
      assert.deepEqual(await store.facts.search({ text: huge }), [], '两万个不同的词也只是没有命中');
    });

    test('facts：search 按相关度排：共同的词占得多的在前，分数也高；不相关的不出现', async () => {
      const store = await factory(MEMORY_STORE_SETUP);
      const partial = await store.facts.add(newFact('集群跑在 Kubernetes 上'));
      const unrelated = await store.facts.add(newFact('主人每天早上跑步'));
      const full = await store.facts.add(newFact('Kubernetes 集群每周五部署'));
      const hits = await store.facts.search({ text: '周五 部署 Kubernetes 集群' });
      assert.deepEqual(
        hits.map((hit) => hit.fact.id),
        [full.id, partial.id],
        '四个词全中的排在只中两个的前面，和写入的先后无关',
      );
      assert.ok(hits[0]!.score > hits[1]!.score && hits[1]!.score > 0, JSON.stringify(hits.map((hit) => hit.score)));
      assert.ok(!hits.some((hit) => hit.fact.id === unrelated.id));
      // 问句里零散地提到：提到得多的在前。
      const asked = await searchIds(store, { text: '我们的集群是哪天部署来着？是每周五吗' });
      assert.deepEqual(asked.slice(0, 2), [full.id, partial.id]);
      assert.deepEqual(
        await searchIds(store, { text: '周五 部署 Kubernetes 集群', k: 1 }),
        [full.id],
        'k 取的是最相关的',
      );
    });

    test('procedures：add 的 confirmations 是 1；confirm 加 1 并追加证据，相同的证据不算；没有证据抛 invalid_request；认不得的 id 抛 not_found', async () => {
      const store = await factory(MEMORY_STORE_SETUP);
      const input = {
        topic: 'work',
        when: '构建失败且提示缺少依赖',
        do: '先跑 pnpm install',
        evidence: [ref(3, 4)],
        at: 100,
      };
      const procedure = await store.procedures.add(input);
      assert.deepEqual(procedure, { ...input, id: procedure.id, confirmations: 1 });
      assert.ok(roundTrips(procedure));
      const confirmed = await store.procedures.confirm(procedure.id, [ref(9, 10)]);
      assert.deepEqual(confirmed, { ...procedure, confirmations: 2, evidence: [ref(3, 4), ref(9, 10)] });
      assert.deepEqual(
        await store.procedures.confirm(procedure.id, [ref(9, 10), ref(3, 4)]),
        confirmed,
        '同一段证据不算又一次确认',
      );
      assert.deepEqual(await store.procedures.list(), [confirmed]);
      await assert.rejects(store.procedures.add({ ...input, evidence: [] }), hasType('invalid_request'));
      await assert.rejects(store.procedures.confirm(procedure.id, []), hasType('invalid_request'));
      await assert.rejects(store.procedures.confirm(procedure.id, [ref(2, 1)]), hasType('invalid_request'));
      await assert.rejects(store.procedures.confirm('missing', [ref(1)]), hasType('not_found'));
      assert.deepEqual(await store.procedures.list(), [confirmed], '失败的调用什么都不改');
    });

    test('procedures：retire 只记第一次；list 按写入顺序，topic、active 筛选', async () => {
      const store = await factory(MEMORY_STORE_SETUP);
      const a = await store.procedures.add({ topic: 'work', when: '甲', do: '一', evidence: [ref(1)], at: 1 });
      const b = await store.procedures.add({ topic: 'user', when: '乙', do: '二', evidence: [ref(2)], at: 2 });
      const c = await store.procedures.add({ when: '丙', do: '三', evidence: [ref(3)], at: 3 });
      await store.procedures.retire(a.id, 50);
      await store.procedures.retire(a.id, 60);
      await assert.rejects(store.procedures.retire('missing', 1), hasType('not_found'));
      const all = await store.procedures.list();
      assert.deepEqual(all, [{ ...a, retiredAt: 50 }, b, c]);
      assert.deepEqual(ids(await store.procedures.list({ active: true })), [b.id, c.id]);
      assert.deepEqual(ids(await store.procedures.list({ active: false })), ids(all), 'active: false 不限');
      assert.deepEqual(ids(await store.procedures.list({ topic: 'work' })), [a.id]);
      assert.deepEqual(await store.procedures.list({ topic: 'work', active: true }), []);
    });

    test('core：没写过是 null；set 追加版本，get 是最后一个，history 按写入顺序保留全部，last 取最后几个', async () => {
      const store = await factory(MEMORY_STORE_SETUP);
      assert.equal(await store.core.get(), null);
      assert.deepEqual(await store.core.history(), []);
      await store.core.set('一', 1);
      await store.core.set('二', 2);
      await store.core.set('三', 3);
      assert.deepEqual(await store.core.get(), { text: '三', at: 3 });
      assert.deepEqual(await store.core.history(), [
        { text: '一', at: 1 },
        { text: '二', at: 2 },
        { text: '三', at: 3 },
      ]);
      assert.deepEqual(await store.core.history({ last: 2 }), [
        { text: '二', at: 2 },
        { text: '三', at: 3 },
      ]);
      assert.deepEqual(await store.core.history({ last: 1.5 }), [{ text: '三', at: 3 }]);
      assert.deepEqual(await store.core.history({ last: 0 }), []);
      await store.core.set('一', 4);
      assert.deepEqual(await store.core.get(), { text: '一', at: 4 }, '回滚就是把旧文字再 set 一次');
    });

    test('notes：同一个会话、同样区间的笔记只写一次，add 返回已有的那条；同一批里重复的也一样', async () => {
      const store = await factory(MEMORY_STORE_SETUP);
      const draft = { session: 's', from: 1, upTo: 3, at: 10, salience: 0.8 };
      const [first] = await store.notes.add([draft]);
      const again = await store.notes.add([
        { ...draft, at: 11, salience: 0.2 },
        { ...draft, from: 2 },
        { ...draft, from: 2, at: 12 },
      ]);
      assert.ok(first);
      assert.equal(again[0]?.id, first.id);
      assert.equal(again[0]?.salience, 0.8, '已有的不改');
      assert.equal(again[1]?.id, again[2]?.id);
      assert.deepEqual(ids(await store.notes.list()), [first.id, again[1]!.id]);
      const [other] = await store.notes.add([{ ...draft, session: 't' }]);
      assert.notEqual(other?.id, first.id, '别的会话的同一个区间是另一条');
      const [scoped] = await store.scope('user:alice').notes.add([draft]);
      assert.notEqual(scoped?.id, first.id, '别的作用域的是另一条');
    });

    test('notes：fail 记失败次数和原因，到 maxAttempts 进死信；死信不算待处理，retry 放回去；list 的 failed、since', async () => {
      const store = await factory(MEMORY_STORE_SETUP);
      const [a, b, done] = await store.notes.add([
        { session: 's', from: 1, upTo: 1, at: 10, salience: 0.8 },
        { session: 's', from: 2, upTo: 2, at: 20, salience: 0.8 },
        { session: 's', from: 3, upTo: 3, at: 30, salience: 0.8, settledAt: 30 },
      ]);
      assert.ok(a && b && done);
      const once = await store.notes.fail([a.id, b.id, done.id, 'missing'], 40, { error: '坏的 JSON', maxAttempts: 2 });
      assert.deepEqual(ids(once), [a.id, b.id], '处理过的、认不得的跳过');
      assert.equal(once[0]?.attempts, 1);
      assert.equal(once[0]?.error, '坏的 JSON');
      assert.equal(once[0]?.failedAt, undefined);
      assert.deepEqual(ids(await store.notes.list({ pending: true })), [a.id, b.id], '失败一次还是待处理');

      const twice = await store.notes.fail([a.id], 50, { error: '还是坏的', maxAttempts: 2 });
      assert.equal(twice[0]?.attempts, 2);
      assert.equal(twice[0]?.error, '还是坏的');
      assert.equal(twice[0]?.failedAt, 50, '到上限进死信');
      assert.deepEqual(ids(await store.notes.list({ pending: true })), [b.id], '死信不算待处理');
      assert.deepEqual(ids(await store.notes.list({ failed: true })), [a.id]);
      assert.deepEqual(ids(await store.notes.list({ failed: false })), [b.id, done.id]);
      assert.deepEqual(ids(await store.notes.list({ pending: false })), [done.id], '死信也不算处理过');
      assert.deepEqual(await store.notes.fail([a.id], 60, { error: 'x', maxAttempts: 2 }), [], '死信不再记');
      assert.equal(await store.notes.settle([a.id], 60), 0, '死信不能直接标成处理过');
      assert.equal(await store.notes.head('s'), 3, 'head 含死信');

      assert.equal(await store.notes.retry([a.id, b.id, 'missing']), 1, '只有死信放得回去');
      const [back] = (await store.notes.list()).filter((note) => note.id === a.id);
      assert.equal(back?.failedAt, undefined);
      assert.equal(back?.attempts, undefined);
      assert.equal(back?.error, undefined);
      assert.deepEqual(ids(await store.notes.list({ pending: true })), [a.id, b.id]);
      assert.deepEqual(ids(await store.notes.list({ since: 20 })), [b.id, done.id]);
      assert.equal((await store.scope('user:bob').notes.fail([b.id], 70, { error: 'x', maxAttempts: 1 })).length, 0);
    });

    test('notes：forget 删掉一个会话的笔记（head 回到 0），不给会话删掉全部；别的作用域不动', async () => {
      const store = await factory(MEMORY_STORE_SETUP);
      const alice = store.scope('user:alice');
      const draft = { from: 1, upTo: 3, at: 10, salience: 0.8 };
      await store.notes.add([
        { ...draft, session: 's' },
        { ...draft, session: 's', from: 4, upTo: 5 },
        { ...draft, session: 't' },
      ]);
      await alice.notes.add([{ ...draft, session: 's' }]);
      assert.equal(await store.notes.forget('s'), 2);
      assert.equal(await store.notes.head('s'), 0);
      assert.deepEqual(
        (await store.notes.list()).map((note) => note.session),
        ['t'],
      );
      assert.equal(await store.notes.forget('s'), 0);
      assert.equal(await store.notes.forget(), 1);
      assert.deepEqual(await store.notes.list(), []);
      assert.equal((await alice.notes.list()).length, 1, '别的作用域的还在');
    });

    test('facts：key 一个作用域里不重复，add 遇到已有的键返回已有的那条、什么都不写', async () => {
      const store = await factory(MEMORY_STORE_SETUP);
      const first = await store.facts.add(newFact('主人住在杭州', { key: 'k1' }));
      assert.equal(first.key, 'k1');
      const again = await store.facts.add(newFact('主人住在上海', { key: 'k1' }));
      assert.deepEqual(again, first);
      assert.deepEqual(ids(await store.facts.list()), [first.id]);
      const other = await store.scope('user:alice').facts.add(newFact('主人住在上海', { key: 'k1' }));
      assert.notEqual(other.id, first.id, '别的作用域的同一个键是另一条');
      const plain = [await store.facts.add(newFact('没有键')), await store.facts.add(newFact('没有键'))];
      assert.notEqual(plain[0]!.id, plain[1]!.id, '没有键的不去重');
      assert.equal((await store.facts.list()).length, 3);
    });

    test('facts：supersede 原子地加新关旧；认不得的 id 什么都不写；键已经有了什么都不改；已经关闭的只写新的', async () => {
      const store = await factory(MEMORY_STORE_SETUP);
      const old = await store.facts.add(newFact('主人住在杭州'));
      const added = await store.facts.supersede(old.id, newFact('主人住在上海', { key: 'move' }), 50);
      assert.equal(added.text, '主人住在上海');
      const closed = await factById(store, old.id);
      assert.equal(closed?.validTo, 50);
      assert.equal(closed?.supersededBy, added.id);
      assert.equal((await factById(store, added.id))?.validTo, undefined);

      await assert.rejects(store.facts.supersede('missing', newFact('不该写'), 60), hasType('not_found'));
      assert.deepEqual(
        (await store.facts.list()).map((fact) => fact.text).toSorted(),
        ['主人住在上海', '主人住在杭州'],
        '认不得的 id：新的也没写',
      );
      await assert.rejects(
        store.facts.supersede(added.id, newFact('没有证据', { sources: [] }), 60),
        hasType('invalid_request'),
      );

      const repeated = await store.facts.supersede(added.id, newFact('主人住在上海', { key: 'move' }), 70);
      assert.equal(repeated.id, added.id, '同一个键：返回已有的');
      assert.equal((await factById(store, added.id))?.validTo, undefined, '什么都不改：没有把自己关掉');

      const again = await store.facts.supersede(old.id, newFact('主人住在北京'), 80);
      assert.equal((await factById(store, old.id))?.validTo, 50, '已经关闭的不改');
      assert.equal((await factById(store, old.id))?.supersededBy, added.id);
      assert.equal((await factById(store, again.id))?.text, '主人住在北京');
      await assert.rejects(
        store.scope('user:bob').facts.supersede(added.id, newFact('别的作用域'), 90),
        hasType('not_found'),
      );
    });

    test('facts：reopen 撤销关闭，清掉 validTo 和 supersededBy，返回真正重新打开的条数', async () => {
      const store = await factory(MEMORY_STORE_SETUP);
      const old = await store.facts.add(newFact('主人住在杭州'));
      const added = await store.facts.supersede(old.id, newFact('主人住在上海'), 50);
      assert.equal(await store.facts.reopen([old.id, added.id, 'missing']), 1);
      const reopened = await factById(store, old.id);
      assert.equal(reopened?.validTo, undefined);
      assert.equal(reopened?.supersededBy, undefined);
      assert.deepEqual(ids(await store.facts.list({ open: true })).toSorted(), [old.id, added.id].toSorted());
      assert.equal((await searchIds(store, { text: '杭州' }))[0], old.id, '回到 open 的搜索里');
      assert.equal(await store.facts.reopen([old.id]), 0);
      assert.equal(await store.scope('user:bob').facts.reopen([old.id]), 0);
    });

    test('procedures：forget 真删，返回删掉的条数；core：clear 删掉全部版本，get 回到 null', async () => {
      const store = await factory(MEMORY_STORE_SETUP);
      const a = await store.procedures.add({ when: '部署前', do: '先跑测试', evidence: [ref(1)], at: 1 });
      const b = await store.procedures.add({ when: '发版后', do: '看监控', evidence: [ref(2)], at: 2 });
      assert.equal(await store.scope('user:bob').procedures.forget([a.id]), 0);
      assert.equal(await store.procedures.forget([a.id, a.id, 'missing']), 1);
      assert.deepEqual(ids(await store.procedures.list()), [b.id]);

      await store.core.set('一', 1);
      await store.core.set('二', 2);
      await store.scope('user:bob').core.set('bob', 3);
      assert.equal(await store.core.clear(), 2);
      assert.equal(await store.core.get(), null);
      assert.deepEqual(await store.core.history(), []);
      assert.equal(await store.core.clear(), 0);
      assert.equal((await store.scope('user:bob').core.get())?.text, 'bob', '别的作用域的不动');
    });
  });
}

// ---- 剧本式决策、提取模型 ----

/**
 * 剧本式决策模型的回答规则。按问题名给了答案就原样返回；其余按题型：`noul` 回 `noul`，`score` 落在离 `score` 最近的档，
 * `choice` 按 `prefer` 的顺序选第一个在 `criteria` 里的选项，都不在就选第一个选项。
 */
export interface DecisionScript {
  readonly answers?: Readonly<Record<string, DecisionAnswer>>;
  /** `noul` 题的 P(是)，缺省 0.5。 */
  readonly noul?: number;
  /** `score` 题的分数（0..1），落到最近的档，缺省 0.5。 */
  readonly score?: number;
  readonly prefer?: readonly string[];
}

export interface ScriptedDecisionModel extends DecisionModel {
  /** 收到过的请求（不含 `signal`），按先后。 */
  readonly requests: readonly DecisionRequest[];
}

function scriptedDecision(question: DecisionQuestion, script: DecisionScript): DecisionAnswer {
  switch (question.type) {
    case 'noul':
      return { type: 'noul', noul: script.noul ?? 0.5 };
    case 'choice': {
      const keys = Object.keys(question.criteria);
      if (keys.length === 0) throw new CtxError('invalid_request', 'A choice question needs at least one option.');
      const choice = script.prefer?.find((key) => keys.includes(key)) ?? keys[0]!;
      const top = keys.length === 1 ? 1 : 0.9;
      const rest = keys.length === 1 ? 0 : 0.1 / (keys.length - 1);
      return {
        type: 'choice',
        choice,
        probabilities: Object.fromEntries(keys.map((key) => [key, key === choice ? top : rest])),
        confidence: top,
      };
    }
    default: {
      const n = question.criteria.length;
      if (n < 2) throw new CtxError('invalid_request', 'A score question needs at least two levels.');
      const level = Math.round(Math.min(1, Math.max(0, script.score ?? 0.5)) * (n - 1));
      return {
        type: 'score',
        score: level / (n - 1),
        probabilities: question.criteria.map((_, i) => (i === level ? 1 : 0)),
      };
    }
  }
}

/**
 * 按剧本回答的决策模型，给契约测试和 `Memory` 的测试用：不联网、确定。`signal` 已中止时 reject，
 * 问题超过 `MAX_DECISION_QUESTIONS` 个、`choice` 没有选项、`score` 少于两档时抛 `invalid_request`。
 */
export function createScriptedDecisionModel(
  script: DecisionScript = {},
  options: { readonly name?: string } = {},
): ScriptedDecisionModel {
  const requests: DecisionRequest[] = [];
  return {
    name: options.name ?? 'scripted-decision',
    requests,
    async decide(request) {
      request.signal?.throwIfAborted();
      requests.push({ state: request.state, questions: request.questions });
      const entries = Object.entries(request.questions);
      if (entries.length > MAX_DECISION_QUESTIONS)
        throw new CtxError('invalid_request', `At most ${MAX_DECISION_QUESTIONS} questions per call.`);
      return Object.fromEntries(
        entries.map(([key, question]) => [key, script.answers?.[key] ?? scriptedDecision(question, script)]),
      );
    },
  };
}

/**
 * 剧本式提取模型的回答规则。按字段名给了值就用它；其余按字段类型取 `byType`，再取缺省
 * （`text` 是 `scripted`，`number` 是 1，`date` 是 `2026-01-01`，`datetime` 是 `2026-01-01T00:00:00Z`，`duration` 是 60，
 * `list` 按 `items` 是 `['scripted']` 或 `[1]`）。输入是空的（null 或空白文字）时全部没找到。值是 null 表示没找到。
 */
export interface ExtractionScript {
  readonly values?: Readonly<Record<string, JsonValue>>;
  readonly byType?: Readonly<Partial<Record<ExtractionField['type'], JsonValue>>>;
}

export interface ScriptedExtractionModel extends ExtractionModel {
  /** 收到过的请求（不含 `signal`），按先后。 */
  readonly requests: readonly ExtractionRequest[];
}

function scriptedValue(field: ExtractionField): JsonValue {
  switch (field.type) {
    case 'text':
      return 'scripted';
    case 'number':
      return 1;
    case 'date':
      return '2026-01-01';
    case 'datetime':
      return '2026-01-01T00:00:00Z';
    case 'duration':
      return 60;
    default:
      return field.items === 'text' ? ['scripted'] : [1];
  }
}

function isEmptyState(state: JsonValue): boolean {
  return state === null || (typeof state === 'string' && state.trim() === '');
}

/** 按剧本回答的提取模型，给契约测试和 `Memory` 的测试用：不联网、确定。`signal` 已中止时 reject。 */
export function createScriptedExtractionModel(
  script: ExtractionScript = {},
  options: { readonly name?: string } = {},
): ScriptedExtractionModel {
  const requests: ExtractionRequest[] = [];
  return {
    name: options.name ?? 'scripted-extraction',
    requests,
    async extract(request) {
      request.signal?.throwIfAborted();
      requests.push({ state: request.state, fields: request.fields });
      const empty = isEmptyState(request.state);
      return Object.fromEntries(
        Object.entries(request.fields).map(([key, field]): [string, ExtractionAnswer] => {
          let value: JsonValue = null;
          if (!empty) {
            if (script.values && key in script.values) value = script.values[key]!;
            else if (script.byType && field.type in script.byType) value = script.byType[field.type]!;
            else value = scriptedValue(field);
          }
          return [key, { value, pNull: value === null ? 0.95 : 0.05, confidence: 0.9 }];
        }),
      );
    },
  };
}

// ---- DecisionModel ----

/** 每个用例调一次。 */
export type DecisionModelFactory = () => DecisionModel | Promise<DecisionModel>;

/** 概率的和、期望档位允许的误差：服务商的概率可能四舍五入过。 */
const PROBABILITY_TOLERANCE = 0.01;

function inUnit(value: unknown): boolean {
  return typeof value === 'number' && value >= 0 && value <= 1;
}

function sumsToOne(values: readonly number[]): boolean {
  return Math.abs(values.reduce((sum, value) => sum + value, 0) - 1) <= PROBABILITY_TOLERANCE;
}

function checkDecisionAnswer(question: DecisionQuestion, answer: DecisionAnswer | undefined, label: string): void {
  assert.ok(answer, `${label}：没有回答`);
  assert.equal(answer.type, question.type, `${label}：回答的 type 和问题一样`);
  if (question.type === 'noul' && answer.type === 'noul') {
    assert.ok(inUnit(answer.noul), `${label}：noul ${answer.noul} 在 0..1`);
  } else if (question.type === 'choice' && answer.type === 'choice') {
    const keys = Object.keys(question.criteria).toSorted();
    assert.deepEqual(Object.keys(answer.probabilities).toSorted(), keys, `${label}：概率覆盖所有选项`);
    const values = Object.values(answer.probabilities);
    assert.ok(values.every(inUnit) && sumsToOne(values), `${label}：概率在 0..1、和为 1`);
    assert.ok(keys.includes(answer.choice), `${label}：choice 是选项之一`);
    assert.ok(answer.probabilities[answer.choice]! >= Math.max(...values), `${label}：choice 是概率最大的`);
    assert.ok(inUnit(answer.confidence), `${label}：confidence 在 0..1`);
  } else if (question.type === 'score' && answer.type === 'score') {
    const n = question.criteria.length;
    assert.equal(answer.probabilities.length, n, `${label}：概率逐档`);
    assert.ok(answer.probabilities.every(inUnit) && sumsToOne(answer.probabilities), `${label}：概率在 0..1、和为 1`);
    assert.ok(inUnit(answer.score), `${label}：score 在 0..1`);
    const expected = answer.probabilities.reduce((sum, p, i) => sum + (p * i) / (n - 1), 0);
    assert.ok(Math.abs(answer.score - expected) <= PROBABILITY_TOLERANCE, `${label}：score 是期望档位 ${expected}`);
  }
}

const DECISION_STATE = '用户：以后回答都用中文，记住了吗？\n助手：记住了，以后都用中文回答。';

const DECISION_QUESTIONS: Readonly<Record<string, DecisionQuestion>> = {
  keep: { type: 'noul', instructions: '这段里有没有值得长期记住的信息：偏好、事实变化、决定、教训？' },
  kind: {
    type: 'choice',
    instructions: '主要属于哪一类？',
    criteria: { pref: '主人的偏好', obs: '观察到的事实', fail: '失败的经验', ok: '成功的经验' },
  },
  salience: {
    type: 'score',
    instructions: '对未来的任务有多重要？',
    criteria: ['无关', '顺带提到', '有用', '必须记住'],
  },
};

export function describeDecisionModelContract(
  name: string,
  factory: DecisionModelFactory,
  { describe, test }: ContractTestApi,
): void {
  describe(`DecisionModel contract: ${name}`, () => {
    test('有名字', async () => {
      const model = await factory();
      assert.equal(typeof model.name, 'string');
      assert.ok(model.name.length > 0);
    });

    for (const [key, question] of Object.entries(DECISION_QUESTIONS)) {
      test(`${question.type}：回答的形状、概率`, async () => {
        const model = await factory();
        const replies = await model.decide({ state: DECISION_STATE, questions: { [key]: question } });
        assert.deepEqual(Object.keys(replies), [key], '键和问题一样');
        checkDecisionAnswer(question, replies[key], key);
      });
    }

    test('三种问题一次问，state 是 JSON 也行；结果能序列化', async () => {
      const model = await factory();
      for (const state of [DECISION_STATE, { messages: [{ role: 'user', text: '以后回答都用中文' }] }]) {
        const replies = await model.decide({ state, questions: DECISION_QUESTIONS });
        assert.deepEqual(Object.keys(replies).toSorted(), Object.keys(DECISION_QUESTIONS).toSorted());
        for (const [key, question] of Object.entries(DECISION_QUESTIONS))
          checkDecisionAnswer(question, replies[key], key);
        assert.ok(roundTrips(replies), '回答能 JSON 往返');
      }
    });

    test(`一次 ${MAX_DECISION_QUESTIONS} 个问题都答`, async () => {
      const model = await factory();
      const questions: Record<string, DecisionQuestion> = Object.fromEntries(
        Array.from({ length: MAX_DECISION_QUESTIONS }, (_, i) => [
          `q${i}`,
          { type: 'noul', instructions: `这段里提到数字 ${i} 了吗？` },
        ]),
      );
      const replies = await model.decide({ state: DECISION_STATE, questions });
      assert.equal(Object.keys(replies).length, MAX_DECISION_QUESTIONS);
      for (const [key, question] of Object.entries(questions)) checkDecisionAnswer(question, replies[key], key);
    });

    test('signal 已中止时 reject', async () => {
      const model = await factory();
      await assert.rejects(
        model.decide({ state: DECISION_STATE, questions: DECISION_QUESTIONS, signal: AbortSignal.abort() }),
      );
    });
  });
}

// ---- ExtractionModel ----

/** 每个用例调一次。 */
export type ExtractionModelFactory = () => ExtractionModel | Promise<ExtractionModel>;

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** 找到时 `value` 的形状对不对（见 `ExtractionField`）。null 总是对的。 */
function extractionShapeOk(field: ExtractionField, value: JsonValue): boolean {
  if (value === null) return true;
  switch (field.type) {
    case 'text':
      return typeof value === 'string';
    case 'number': {
      if (!isFiniteNumber(value)) return false;
      if (field.integer && !Number.isInteger(value)) return false;
      if (field.decimals !== undefined) {
        const scaled = value * 10 ** field.decimals;
        if (Math.abs(scaled - Math.round(scaled)) > 1e-6) return false;
      }
      return true;
    }
    case 'date':
      return typeof value === 'string' && DATE.test(value) && !Number.isNaN(Date.parse(value));
    case 'datetime':
      return typeof value === 'string' && DATETIME.test(value) && !Number.isNaN(Date.parse(value));
    case 'duration':
      return isFiniteNumber(value) && value >= 0;
    default:
      return (
        Array.isArray(value) &&
        value.every((item) => (field.items === 'text' ? typeof item === 'string' : isFiniteNumber(item)))
      );
  }
}

const EXTRACTION_STATE =
  '周三（2026-11-04）下午两点在台北开会，开 90 分钟，预算 1200.5 元，参会的有小明、小红，一共 2 人。';

const EXTRACTION_FIELDS: Readonly<Record<string, ExtractionField>> = {
  place: { type: 'text', instructions: '开会的地点' },
  budget: { type: 'number', instructions: '预算', unit: '元', decimals: 1 },
  people: { type: 'number', instructions: '参会人数', integer: true },
  day: { type: 'date', instructions: '开会的日期' },
  start: { type: 'datetime', instructions: '开始的时间' },
  length: { type: 'duration', instructions: '开多久' },
  names: { type: 'list', items: 'text', instructions: '参会的人' },
  amounts: { type: 'list', items: 'number', instructions: '文中出现的金额' },
};

export function describeExtractionModelContract(
  name: string,
  factory: ExtractionModelFactory,
  { describe, test }: ContractTestApi,
): void {
  describe(`ExtractionModel contract: ${name}`, () => {
    test('有名字', async () => {
      const model = await factory();
      assert.equal(typeof model.name, 'string');
      assert.ok(model.name.length > 0);
    });

    test('每种字段：键和 fields 一样，value 是 null 或对应的形状，pNull、confidence 在 0..1；结果能序列化', async () => {
      const model = await factory();
      const replies = await model.extract({ state: EXTRACTION_STATE, fields: EXTRACTION_FIELDS });
      assert.deepEqual(Object.keys(replies).toSorted(), Object.keys(EXTRACTION_FIELDS).toSorted());
      for (const [key, field] of Object.entries(EXTRACTION_FIELDS)) {
        const answer = replies[key];
        assert.ok(answer, `${key}：没有回答`);
        assert.ok(extractionShapeOk(field, answer.value), `${key}：value ${JSON.stringify(answer.value)} 的形状`);
        assert.ok(inUnit(answer.pNull), `${key}：pNull 在 0..1`);
        assert.ok(inUnit(answer.confidence), `${key}：confidence 在 0..1`);
      }
      assert.ok(roundTrips(replies), '回答能 JSON 往返');
    });

    test('输入里没有的值：value 是 null，pNull 高', async () => {
      const model = await factory();
      const fields: Record<string, ExtractionField> = {
        email: { type: 'text', instructions: '对方的电子邮件地址' },
        amount: { type: 'number', instructions: '发票金额' },
        due: { type: 'date', instructions: '截止日期' },
      };
      const replies = await model.extract({ state: '', fields });
      for (const key of Object.keys(fields)) {
        assert.equal(replies[key]?.value, null, `${key}：没找到是 null`);
        assert.ok((replies[key]?.pNull ?? 0) >= 0.5, `${key}：pNull ${replies[key]?.pNull} 应当高`);
      }
    });

    test('signal 已中止时 reject', async () => {
      const model = await factory();
      await assert.rejects(
        model.extract({ state: EXTRACTION_STATE, fields: EXTRACTION_FIELDS, signal: AbortSignal.abort() }),
      );
    });
  });
}

// ---- Memory ----

/** 契约测试交给 `Memory` 工厂的东西。 */
export interface MemorySetup {
  /** 会话日志：用例往里写，memory 只读它。是契约测试自带的最小内存实现。 */
  readonly sessions: SessionStore;
  /** 剧本式决策模型（`createScriptedDecisionModel`），门控和并入都用它。 */
  readonly decision: DecisionModel;
  /** 剧本式提取模型（`createScriptedExtractionModel`）。 */
  readonly extraction: ExtractionModel;
  /** 时钟：门控的 `at`、召回的 `touch` 都用它。 */
  readonly now: () => number;
}

export interface MemoryFixture {
  readonly memory: Memory;
  /** memory 用的存储，开始时是空的；用例直接读写它。 */
  readonly store: MemoryStore;
}

/**
 * 每个用例调一次。memory 要读 `setup.sessions`、用 `setup.decision` 和 `setup.extraction`、按 `setup.now` 取时刻；
 * 门控阈值要固定（0.1..0.9 之间：剧本里该记的打 0.95 分左右，不该记的 0.02 左右），`LanguageModel` 可以不给。
 * 用例开始时调 `provision`（有的话），结束时调 `dispose`（有的话）。
 */
export type MemoryFactory = (setup: MemorySetup) => MemoryFixture | Promise<MemoryFixture>;

interface MemoryScript {
  readonly decision?: DecisionScript;
  readonly extraction?: ExtractionScript;
}

interface MemoryCase extends MemoryFixture {
  readonly sessions: SessionStore;
  readonly decision: ScriptedDecisionModel;
  readonly now: number;
}

/** 契约测试自带的会话日志：只够这些用例（不去重、不检查 expectSeq、没有 watch）。 */
function contractSessionStore(now: () => number): SessionStore {
  const logs = new Map<string, Entry[]>();
  let seq = 0;
  let id = 0;
  const erase = (session: string, erasure: Erasure): number => {
    const { entries, erased } = eraseEntries(logs.get(session) ?? [], erasure);
    if (!erased) return 0;
    const record = {
      ...erasedEntry(erased),
      id: `e${(id += 1)}`,
      session,
      seq: (seq += 1),
      at: now(),
      v: ENTRY_VERSION,
    };
    logs.set(session, [...entries, record]);
    return erased.count;
  };
  return {
    async append(session, drafts) {
      const written = drafts.map((draft) => ({
        ...draft,
        id: draft.id ?? `e${(id += 1)}`,
        session,
        seq: (seq += 1),
        at: draft.at ?? now(),
        v: ENTRY_VERSION,
      }));
      logs.set(session, [...(logs.get(session) ?? []), ...written]);
      return written;
    },
    async list(session, options) {
      return filterEntries(logs.get(session) ?? [], options);
    },
    async clear(session) {
      const count = logs.get(session)?.length ?? 0;
      logs.delete(session);
      return count;
    },
    truncate: async (session, upTo) => erase(session, { op: 'truncate', upTo }),
    remove: async (session, entryIds) => erase(session, { op: 'remove', ids: entryIds }),
    redact: async (session, entryIds) => erase(session, { op: 'redact', ids: entryIds }),
    async sessions(options) {
      return filterSessions([...logs.keys()], options);
    },
  };
}

async function withMemory(
  factory: MemoryFactory,
  script: MemoryScript,
  fn: (fixture: MemoryCase) => Promise<void>,
): Promise<void> {
  const now = MEMORY_NOW;
  const sessions = contractSessionStore(() => now);
  const decision = createScriptedDecisionModel(script.decision);
  const extraction = createScriptedExtractionModel(script.extraction);
  const fixture = await factory({ sessions, decision, extraction, now: () => now });
  try {
    await fixture.memory.provision?.();
    await fn({ ...fixture, sessions, decision, now });
  } finally {
    await fixture.memory.dispose?.();
  }
}

/** 该记：`keep` 和 `score` 都打满。 */
const KEEP: DecisionScript = { noul: 0.95, score: 1 };
/** 不该记。 */
const SKIP: DecisionScript = { noul: 0.02, score: 0 };

const EXTRACTED = '主人的项目改用 PostgreSQL';
/** 文字字段都提取出同一句话，日期、数字都当没找到（`validFrom` 回到这段的第一条 `at`）。 */
const EXTRACT: ExtractionScript = {
  byType: { text: EXTRACTED, list: [EXTRACTED], number: null, date: null, datetime: null, duration: null },
};

/** 每段证据都合法，并且日志里真有这一段。 */
async function assertEvidence(sessions: SessionStore, refs: readonly SourceRef[], label: string): Promise<void> {
  assert.ok(refs.length > 0, `${label}：证据不能为空`);
  for (const source of refs) {
    assert.doesNotThrow(() => checkSourceRef(source), `${label}：证据区间 ${JSON.stringify(source)}`);
    const entries = await sessions.list(source.session);
    assert.ok(
      entries.some((entry) => inSourceRef(entry, source)),
      `${label}：证据 ${JSON.stringify(source)} 在日志里找不到`,
    );
  }
}

async function seedFact(
  { sessions, store, now }: MemoryCase,
  text: string,
  extra: Partial<NewMemoryFact> = {},
): Promise<MemoryFact> {
  const written = await sessions.append('s', [userEntry(text)]);
  return store.facts.add(newFact(text, { validFrom: now, sources: [sourceRef('s', written)], ...extra }));
}

function checkReport(report: Awaited<ReturnType<Memory['consolidate']>>): void {
  const counts = [
    report.notes,
    report.facts.added,
    report.facts.merged,
    report.facts.superseded,
    report.facts.archived,
    report.procedures.added,
    report.procedures.confirmed,
    report.escalated,
  ];
  assert.ok(
    counts.every((count) => Number.isInteger(count) && count >= 0),
    `报告的计数是非负整数：${JSON.stringify(report)}`,
  );
  assert.equal(typeof report.core, 'boolean');
  assert.ok(roundTrips(report), '报告能 JSON 往返');
}

export function describeMemoryContract(
  name: string,
  factory: MemoryFactory,
  { describe, test }: ContractTestApi,
): void {
  describe(`Memory contract: ${name}`, () => {
    test('gate：笔记指向新条目的 seq 区间，不改日志；同一段不重复打分，下一次从 head 之后读', async () => {
      await withMemory(factory, { decision: KEEP }, async ({ memory, store, sessions, decision }) => {
        const first = await sessions.append('s', [
          userEntry('以后回答都用中文，记住'),
          assistantEntry('好的，以后都用中文'),
        ]);
        const log = await sessions.list('s');
        const notes = await memory.gate('s');
        assert.deepEqual(await sessions.list('s'), log, 'gate 不改日志');
        assert.ok(decision.requests.length > 0, '给了决策模型就用它打分');
        assert.ok(notes.length > 0, '该记的写了笔记');
        for (const note of notes) {
          assert.equal(note.session, 's');
          assert.ok(
            note.from <= note.upTo && note.from >= first[0]!.seq && note.upTo <= first[1]!.seq,
            JSON.stringify(note),
          );
          assert.equal(note.settledAt, undefined, '该记的是待处理');
          assert.ok(inUnit(note.salience));
        }
        assert.equal(Math.min(...notes.map((note) => note.from)), first[0]!.seq, '从第一条新条目开始');
        assert.equal(Math.max(...notes.map((note) => note.upTo)), first[1]!.seq, '到最后一条新条目');
        assert.deepEqual(ids(await store.notes.list({ session: 's' })), ids(notes), '返回的就是写进存储的');
        assert.ok(roundTrips(notes));
        assert.equal(await store.notes.head('s'), first[1]!.seq);
        assert.deepEqual(await memory.gate('s'), [], '没有新条目时什么都不写');
        assert.equal((await store.notes.list()).length, notes.length);

        const second = await sessions.append('s', [userEntry('我换到台北住了'), assistantEntry('记下了')]);
        const more = await memory.gate('s');
        assert.ok(more.length > 0);
        assert.equal(Math.min(...more.map((note) => note.from)), second[0]!.seq, '只读 head 之后的');
        assert.equal(await store.notes.head('s'), second[1]!.seq);
      });
    });

    test('gate：没过阈值的那段也记下（已处理），head 照样前进，不留待处理的笔记', async () => {
      await withMemory(factory, { decision: SKIP }, async ({ memory, store, sessions }) => {
        const written = await sessions.append('s', [userEntry('嗯'), assistantEntry('嗯嗯')]);
        const notes = await memory.gate('s');
        assert.ok(
          notes.every((note) => note.settledAt !== undefined),
          '没过阈值的笔记是处理过的',
        );
        assert.deepEqual(await store.notes.list({ pending: true }), []);
        assert.equal(await store.notes.head('s'), written[1]!.seq, 'head 前进到读过的最后一条');
        assert.deepEqual(await memory.gate('s'), [], '同一段不再打分');
      });
    });

    test('gate：空会话返回空，什么都不写', async () => {
      await withMemory(factory, { decision: KEEP }, async ({ memory, store }) => {
        assert.deepEqual(await memory.gate('empty'), []);
        assert.deepEqual(await store.notes.list(), []);
        assert.equal(await store.notes.head('empty'), 0);
      });
    });

    test('consolidate：处理待处理的笔记；写下的事实和程序都有指回日志的证据；不改日志', async () => {
      await withMemory(factory, { decision: KEEP, extraction: EXTRACT }, async ({ memory, store, sessions, now }) => {
        await sessions.append('s', [userEntry('项目的数据库换成 PostgreSQL 了，记住'), assistantEntry('记下了')]);
        await memory.gate('s');
        const pending = await store.notes.list({ pending: true });
        assert.ok(pending.length > 0);
        const log = await sessions.list('s');
        const report = await memory.consolidate({ now });
        checkReport(report);
        assert.deepEqual(await sessions.list('s'), log, 'consolidate 不改日志');
        assert.equal(report.notes, pending.length, '处理了全部待处理的笔记');
        assert.deepEqual(await store.notes.list({ pending: true }), []);
        const facts = await store.facts.list();
        assert.ok(facts.length > 0 && report.facts.added > 0, '提取出的事实写进去了');
        for (const fact of facts) await assertEvidence(sessions, fact.sources, `事实 ${fact.text}`);
        for (const procedure of await store.procedures.list())
          await assertEvidence(sessions, procedure.evidence, `程序 ${procedure.when}`);
      });
    });

    test('consolidate 幂等：再跑一次不再处理笔记，事实和程序都不变', async () => {
      await withMemory(factory, { decision: KEEP, extraction: EXTRACT }, async ({ memory, store, sessions, now }) => {
        await sessions.append('s', [userEntry('项目的数据库换成 PostgreSQL 了，记住'), assistantEntry('记下了')]);
        await memory.gate('s');
        await memory.consolidate({ now });
        const facts = await store.facts.list();
        const procedures = await store.procedures.list();
        const again = await memory.consolidate({ now });
        checkReport(again);
        assert.equal(again.notes, 0);
        assert.deepEqual(
          [
            again.facts.added,
            again.facts.merged,
            again.facts.superseded,
            again.procedures.added,
            again.procedures.confirmed,
          ],
          [0, 0, 0, 0, 0],
        );
        assert.deepEqual(await store.facts.list(), facts);
        assert.deepEqual(await store.procedures.list(), procedures);
      });
    });

    test('consolidate：取代不覆盖，旧事实的文字和证据不变，关闭了就指向一条存在的事实', async () => {
      const script = { decision: { ...KEEP, prefer: ['supersede'] }, extraction: EXTRACT };
      await withMemory(factory, script, async (fixture) => {
        const { memory, store, sessions, now } = fixture;
        const old = await seedFact(fixture, '主人的项目用 MySQL', { topic: 'work' });
        await sessions.append('s', [userEntry('项目从 MySQL 换成 PostgreSQL 了，记住'), assistantEntry('记下了')]);
        await memory.gate('s');
        checkReport(await memory.consolidate({ now }));
        const facts = await store.facts.list();
        const kept = facts.find((fact) => fact.id === old.id);
        assert.ok(kept, '旧事实还在：取代是 close + add，不删');
        const { validTo, supersededBy, recalls, archivedAt, ...rest } = kept;
        const { recalls: oldRecalls, ...oldRest } = old;
        assert.deepEqual(rest, oldRest, '文字、主语、证据、validFrom 都没改');
        assert.ok(recalls.length >= oldRecalls.length && validTo !== null && archivedAt !== null);
        for (const fact of facts) {
          await assertEvidence(sessions, fact.sources, `事实 ${fact.text}`);
          if (fact.supersededBy === undefined) continue;
          assert.notEqual(fact.validTo, undefined, '被取代的事实是关闭的');
          assert.ok(
            facts.some((other) => other.id === fact.supersededBy),
            `supersededBy ${fact.supersededBy} 指向一条存在的事实`,
          );
        }
        if (supersededBy !== undefined) assert.ok(facts.length >= 2);
      });
    });

    test('recall：按文字找回仍然成立的事实，每条的 recalls 多一个（时刻取 now）；不改日志；evidence 只在要时带', async () => {
      await withMemory(factory, {}, async (fixture) => {
        const { memory, store, sessions, now } = fixture;
        const pg = await seedFact(fixture, '主人的项目用 PostgreSQL 存数据', { topic: 'work' });
        const closed = await seedFact(fixture, '主人以前的项目用 PostgreSQL 9', { topic: 'work' });
        await store.facts.close(closed.id, now);
        const log = await sessions.list('s');
        const recalled = await memory.recall('PostgreSQL');
        assert.deepEqual(await sessions.list('s'), log, 'recall 不改日志');
        assert.ok(ids(recalled.facts).includes(pg.id), '找回了仍然成立的事实');
        assert.ok(!ids(recalled.facts).includes(closed.id), '关闭的不召回');
        assert.equal(recalled.evidence, undefined, '没要证据就不带');
        assert.ok(roundTrips(recalled));
        assert.deepEqual((await factById(store, pg.id))?.recalls, [now], '记了一次 touch');
        assert.deepEqual((await factById(store, closed.id))?.recalls, [], '没召回的不 touch');

        const withEvidence = await memory.recall('PostgreSQL', { evidence: true });
        assert.equal((await factById(store, pg.id))?.recalls.length, 2, '每次召回多一个');
        const evidence = withEvidence.evidence ?? [];
        assert.ok(
          evidence.some((entry) => pg.sources.some((source) => inSourceRef(entry, source))),
          '证据里有这条事实指向的原文',
        );
        assert.ok(roundTrips(withEvidence));
      });
    });

    test('recall：归档的事实也找得回来，被召回的恢复成没归档的', async () => {
      await withMemory(factory, {}, async (fixture) => {
        const { memory, store, now } = fixture;
        const archived = await seedFact(fixture, '主人的项目用 PostgreSQL 存数据');
        assert.equal(await store.facts.archive([archived.id], now), 1);
        const recalled = await memory.recall('PostgreSQL');
        const found = recalled.facts.find((fact) => fact.id === archived.id);
        assert.ok(found, '归档的事实也召回');
        assert.equal(found.archivedAt, undefined, '返回的已经不带 archivedAt');
        assert.ok(roundTrips(recalled));
        const after = await factById(store, archived.id);
        assert.equal(after?.archivedAt, undefined, '被召回就恢复');
        assert.deepEqual(after?.recalls, [now], '恢复的同时记了一次召回');
        assert.deepEqual(ids(await store.facts.list({ open: true })), [archived.id]);
      });
    });

    test('recall：minConfidence 筛掉置信度低的事实，给 0 就不筛', async () => {
      await withMemory(factory, {}, async (fixture) => {
        const { memory, store } = fixture;
        const sure = await seedFact(fixture, '主人的项目用 PostgreSQL 存数据', { confidence: 0.9 });
        const unsure = await seedFact(fixture, '主人的项目好像要换掉 PostgreSQL', { confidence: 0.2 });
        const strict = await memory.recall('PostgreSQL', { minConfidence: 0.5 });
        assert.ok(ids(strict.facts).includes(sure.id));
        assert.ok(!ids(strict.facts).includes(unsure.id), '置信度低于门槛的不召回');
        assert.deepEqual((await factById(store, unsure.id))?.recalls, [], '没召回的不 touch');
        const loose = await memory.recall('PostgreSQL', { minConfidence: 0 });
        assert.ok(ids(loose.facts).includes(sure.id) && ids(loose.facts).includes(unsure.id), '给 0 就不筛');
      });
    });

    test('source：名字缺省 memory；collect 带出 core 和按最近一条用户消息召回的事实；什么都没有时是空', async () => {
      await withMemory(factory, {}, async (fixture) => {
        const { memory, store, sessions, now } = fixture;
        const empty = memory.source();
        assert.equal(empty.name, 'memory');
        const nothing = await empty.collect({ session: 'nobody' });
        assert.ok(!nothing || nothing.trim() === '', `没有记忆时是空：${JSON.stringify(nothing)}`);

        const pg = await seedFact(fixture, '主人的项目用 PostgreSQL 存数据');
        await store.core.set('主人叫小明，住在台北', now);
        await sessions.append('chat', [userEntry('PostgreSQL')]);
        const text = await memory.source().collect({ session: 'chat' });
        assert.equal(typeof text, 'string');
        assert.ok(text!.includes('小明'), `带出 core：${text}`);
        assert.ok(text!.includes(pg.text), `带出召回的事实：${text}`);

        const named = memory.source({ name: 'memory2', query: async () => 'PostgreSQL', k: 1 });
        assert.equal(named.name, 'memory2');
        assert.ok((await named.collect({ session: 'nobody' }))?.includes(pg.text), '用给的 query 召回');
      });
    });

    test('source：同一条事实连着带出几轮，recalls 不跟着涨；主动的 recall 照常记', async () => {
      await withMemory(factory, {}, async (fixture) => {
        const { memory, store, sessions } = fixture;
        const pg = await seedFact(fixture, '主人的项目用 PostgreSQL 存数据');
        await sessions.append('chat', [userEntry('PostgreSQL')]);
        const source = memory.source();
        for (let round = 0; round < 4; round += 1) {
          assert.ok((await source.collect({ session: 'chat' }))?.includes(pg.text), `第 ${round + 1} 轮照样带出`);
        }
        const auto = (await factById(store, pg.id))?.recalls.length ?? 0;
        assert.ok(auto <= 1, `来源每一轮都跑，不能每轮都记一次召回：记了 ${auto} 次`);
        await memory.recall('PostgreSQL');
        assert.equal((await factById(store, pg.id))?.recalls.length, auto + 1, '主动召回记一次');
      });
    });

    test('tools 和 execute：recall 工具绑定到自己、能序列化；结果带事实；不认识的工具、坏输入、已中止都返回 error', async () => {
      await withMemory(factory, {}, async (fixture) => {
        const { memory } = fixture;
        assert.ok(typeof memory.name === 'string' && memory.name.length > 0);
        const tools = await memory.tools();
        const recall = tools.find((tool) => tool.name === MEMORY_RECALL_TOOL);
        assert.ok(recall, `tools() 里没有 ${MEMORY_RECALL_TOOL}`);
        assert.equal(recall.executor, memory.name);
        const properties = recall.inputSchema['properties'] as Record<string, unknown> | undefined;
        assert.ok(properties && 'query' in properties, '输入里有 query');
        assert.ok(roundTrips(tools), 'tools() 能 JSON 往返');

        const pg = await seedFact(fixture, '主人的项目用 PostgreSQL 存数据');
        const context = { session: 's', runId: 'run-memory' };
        const output = await memory.execute(
          { id: 'c1', name: MEMORY_RECALL_TOOL, input: { query: 'PostgreSQL' } },
          context,
        );
        assert.notEqual(output.type, 'error', JSON.stringify(output));
        assert.ok(JSON.stringify(output).includes(pg.text), `结果里有事实：${JSON.stringify(output)}`);
        assert.ok(roundTrips(output));
        const unknown = await memory.execute({ id: 'c2', name: 'no_such_tool_for_contract', input: {} }, context);
        assert.equal(unknown.type, 'error');
        const bad = await memory.execute({ id: 'c3', name: MEMORY_RECALL_TOOL, input: { nope: 1 } }, context);
        assert.equal(bad.type, 'error', '没有 query 是错误');
        const aborted = await memory.execute(
          { id: 'c4', name: MEMORY_RECALL_TOOL, input: { query: 'PostgreSQL' } },
          { ...context, signal: AbortSignal.abort() },
        );
        assert.equal(aborted.type, 'error');
      });
    });
  });
}
