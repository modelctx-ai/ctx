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

import type { ModelMessage } from 'ai';

import type { AgentSpec, Harness, RunEvent, RunRequest } from './harness.ts';
import type { Orchestrator, OrchestratorEvent } from './orchestrator.ts';
import {
  CTX_EVENTS,
  assistantEntry,
  eventEntry,
  messageEntry,
  userEntry,
  type Entry,
  type NewEntry,
  type SessionStore,
} from './session.ts';
import { selectTools, type Executor, type ToolDefinition, type ToolFilter, type ToolRegistry } from './tools.ts';
import type { JsonObject } from './types.ts';

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

/** 二进制读回来可以换容器（Buffer 变 Uint8Array 之类），只比字节。 */
function bytesOf(value: unknown): number[] | undefined {
  if (value instanceof ArrayBuffer) return [...new Uint8Array(value)];
  if (ArrayBuffer.isView(value)) return [...new Uint8Array(value.buffer, value.byteOffset, value.byteLength)];
  return undefined;
}

function hrefOf(value: unknown): string | undefined {
  return value instanceof URL ? value.href : undefined;
}

type Loose = Record<string, unknown> | undefined;

function partsOf(entry: Entry | undefined): Loose[] {
  if (entry?.type !== 'message' || typeof entry.message.content === 'string') return [];
  return entry.message.content as unknown as Loose[];
}

function batch(tag: string): NewEntry[] {
  return [1, 2, 3, 4].map((n) => userEntry(`${tag}${n}`));
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

    test('条目原样读回：消息分段、事件数据、摘要位置、元数据', async () => {
      const store = await factory({ now: () => 42 });
      const call: ModelMessage = {
        role: 'assistant',
        content: [
          { type: 'text', text: '查一下' },
          { type: 'tool-call', toolCallId: 'c1', toolName: 'weather', input: { city: '台北', days: [1, 2] } },
        ],
      };
      const image: ModelMessage = {
        role: 'user',
        content: [{ type: 'image', image: new URL('https://example.com/a.png'), mediaType: 'image/png' }],
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
      const part = second?.type === 'message' && Array.isArray(second.message.content) && second.message.content[0];
      assert.equal(part && part.type === 'image' && hrefOf(part.image), 'https://example.com/a.png');
      assert.deepEqual(third?.type === 'event' && [third.kind, third.text, third.data], [
        'pet.reminder',
        '喝水',
        { id: 's_1', repeat: null },
      ]);
      assert.deepEqual(fourth?.type === 'summary' && [fourth.text, fourth.covers], ['摘要', 2]);
      assert.ok((second?.seq ?? 0) > (first?.seq ?? 0));
    });

    test('二进制和 URL 读回来字节、地址不变：Buffer、ArrayBuffer、带标签的数据', async () => {
      const store = await factory({ now: () => 42 });
      const message: ModelMessage = {
        role: 'user',
        content: [
          { type: 'image', image: Buffer.from('hello'), mediaType: 'image/png' },
          { type: 'image', image: new Uint8Array([1, 2, 3]).buffer, mediaType: 'image/png' },
          { type: 'file', mediaType: 'image', data: { type: 'data', data: Buffer.from('hi') } },
          { type: 'image', image: new URL('https://example.com/a.png') },
          { type: 'file', mediaType: 'image', data: { type: 'url', url: new URL('https://example.com/b.png') } },
        ],
      };
      await store.append('s', [messageEntry(message)]);
      const [image, buffer, tagged, url, taggedUrl] = partsOf((await store.list('s'))[0]);
      assert.deepEqual(bytesOf(image?.['image']), [...Buffer.from('hello')], 'Buffer');
      assert.deepEqual(bytesOf(buffer?.['image']), [1, 2, 3], 'ArrayBuffer');
      assert.deepEqual(
        bytesOf((tagged?.['data'] as Loose)?.['data']),
        [...Buffer.from('hi')],
        '{ type: data } 里的 Buffer',
      );
      assert.equal(hrefOf(url?.['image']), 'https://example.com/a.png', 'URL');
      assert.equal(
        hrefOf((taggedUrl?.['data'] as Loose)?.['url']),
        'https://example.com/b.png',
        '{ type: url } 里的 URL',
      );
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

    test('clear 删掉整个会话，sessions 只列有内容的', async () => {
      const store = await factory({ now: Date.now });
      await store.append('a', [userEntry('x')]);
      await store.append('b', [userEntry('y'), userEntry('z')]);
      assert.deepEqual((await store.sessions()).toSorted(), ['a', 'b']);
      assert.equal(await store.clear('b'), 2);
      assert.deepEqual(await store.sessions(), ['a']);
      assert.equal(await store.clear('missing'), 0);
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
 * 契约测试给模型的剧本：每调一次模型按顺序取下一步。`text` 回一段文字并停下；`tool-call` 调用回显工具
 * （名字由实现方填，就是 fixture 的 `echo`）；`error` 让这次模型调用抛出带这段信息的错误。
 */
export type ModelScriptStep =
  | { readonly type: 'text'; readonly text: string }
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
