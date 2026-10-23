/**
 * 存储契约测试。自己实现 `ContextStore` 时，用同一套用例验证行为一致。
 * 不绑定测试框架：把所用框架的 `describe`、`test` 传进来（Vitest、`node:test`、Jest、Bun 都行），断言用 `node:assert/strict`：
 *
 * ```ts
 * import { describe, test } from 'vitest'; // 或 'node:test'
 * import { describeStoreContract } from '@modelctx-ai/ctx/testing';
 * describeStoreContract('my-store', ({ now }) => createMyStore({ now }), { describe, test });
 * ```
 */
import assert from 'node:assert/strict';

import type { ModelMessage } from 'ai';

import { assistantEntry, eventEntry, messageEntry, userEntry, type ContextEntry } from './entry.ts';
import type { ContextStore } from './store.ts';

export type StoreFactory = (options: { readonly now: () => number }) => ContextStore | Promise<ContextStore>;

/**
 * 契约测试用到的最小测试框架接口。Vitest、`node:test`、Jest、Bun 的 `describe` / `test` 都满足，
 * 失败靠抛异常报告，返回值不看。
 */
export interface ContractTestApi {
  readonly describe: (name: string, fn: () => void) => unknown;
  readonly test: (name: string, fn: () => Promise<void>) => unknown;
}

function texts(entries: readonly ContextEntry[]): string[] {
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

function partsOf(entry: ContextEntry | undefined): Loose[] {
  if (entry?.type !== 'message' || typeof entry.message.content === 'string') return [];
  return entry.message.content as unknown as Loose[];
}

export function describeStoreContract(name: string, factory: StoreFactory, { describe, test }: ContractTestApi): void {
  describe(`ContextStore contract: ${name}`, () => {
    test('按 (at, seq) 排序，导入的旧记录插回原来的位置', async () => {
      let clock = 1_000;
      const store = await factory({ now: () => clock++ });
      await store.append('t', [userEntry('二'), userEntry('三')]);
      await store.append('t', [userEntry('一', { at: 10 })]);
      assert.deepEqual(texts(await store.list('t')), ['一', '二', '三']);
    });

    test('同一时刻按写入先后排', async () => {
      const store = await factory({ now: () => 5 });
      await store.append('t', [eventEntry('whisper', { text: 'a' }), eventEntry('whisper', { text: 'b' })]);
      await store.append('t', [eventEntry('whisper', { text: 'c' })]);
      assert.deepEqual(texts(await store.list('t')), ['a', 'b', 'c']);
    });

    test('幂等键和 id 重复时跳过，只返回真正写入的', async () => {
      const store = await factory({ now: Date.now });
      const first = await store.append('t', [userEntry('在吗', { key: 'k1' }), userEntry('在吗', { key: 'k1' })]);
      assert.equal(first.length, 1);
      assert.equal((await store.append('t', [userEntry('在吗', { key: 'k1' })])).length, 0);
      assert.equal((await store.append('other', [userEntry('在吗', { key: 'k1' })])).length, 1, '键按线程隔离');
      assert.equal((await store.append('t', [assistantEntry('x', { id: first[0]!.id })])).length, 0);
      assert.equal((await store.list('t')).length, 1);
    });

    test('after、last、types 可以组合', async () => {
      let clock = 0;
      const store = await factory({ now: () => (clock += 10) });
      const written = await store.append('t', [
        userEntry('1'),
        eventEntry('whisper', { text: '2' }),
        userEntry('3'),
        userEntry('4'),
      ]);
      assert.deepEqual(texts(await store.list('t', { after: written[1]! })), ['3', '4']);
      assert.deepEqual(texts(await store.list('t', { types: ['message'], last: 2 })), ['3', '4']);
      assert.deepEqual(texts(await store.list('t', { types: ['event'] })), ['2']);
      assert.deepEqual(await store.list('t', { last: 0 }), []);
    });

    test('last 向下取整，不是有限正数时返回空', async () => {
      const store = await factory({ now: Date.now });
      await store.append('t', [userEntry('a'), userEntry('b'), userEntry('c')]);
      const last = async (n: number) => texts(await store.list('t', { last: n }));
      assert.deepEqual(await last(1.5), ['c']);
      assert.deepEqual(await last(2.9), ['b', 'c']);
      for (const n of [0.5, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
        assert.deepEqual(await last(n), [], `last: ${n}`);
      }
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
      const [written] = await store.append('t', [messageEntry(call, { source: 'model', meta: { step: 1 } })]);
      await store.append('t', [
        messageEntry(image),
        eventEntry('reminder', { text: '喝水', data: { id: 's_1', repeat: null } }),
        { type: 'summary', text: '摘要', covers: { at: 1, seq: 2 } },
      ]);
      const [first, second, third, fourth] = await store.list('t');
      assert.equal(first?.id, written?.id);
      assert.equal(first?.thread, 't');
      assert.equal(first?.at, 42);
      assert.equal(first?.source, 'model');
      assert.deepEqual(first?.meta, { step: 1 });
      assert.deepEqual(first?.type === 'message' && first.message, call);
      const part = second?.type === 'message' && Array.isArray(second.message.content) && second.message.content[0];
      assert.equal(part && part.type === 'image' && hrefOf(part.image), 'https://example.com/a.png');
      assert.deepEqual(third?.type === 'event' && [third.kind, third.text, third.data], [
        'reminder',
        '喝水',
        { id: 's_1', repeat: null },
      ]);
      assert.deepEqual(fourth?.type === 'summary' && [fourth.text, fourth.covers], ['摘要', { at: 1, seq: 2 }]);
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
      await store.append('t', [messageEntry(message)]);
      const [image, buffer, tagged, url, taggedUrl] = partsOf((await store.list('t'))[0]);
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
      await store.append('t', [eventEntry('tool-log', { data })]);
      const [entry] = await store.list('t');
      assert.deepEqual(entry?.type === 'event' && entry.data, data);
    });

    test('clear 删掉整条线程，threads 只列有内容的', async () => {
      const store = await factory({ now: Date.now });
      await store.append('a', [userEntry('x')]);
      await store.append('b', [userEntry('y'), userEntry('z')]);
      assert.deepEqual((await store.threads()).toSorted(), ['a', 'b']);
      assert.equal(await store.clear('b'), 2);
      assert.deepEqual(await store.threads(), ['a']);
      assert.equal(await store.clear('missing'), 0);
    });
  });
}
