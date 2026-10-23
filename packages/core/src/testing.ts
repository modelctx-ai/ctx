/**
 * 存储契约测试。自己实现 `ContextStore` 时，用同一套用例验证行为一致：
 *
 * ```ts
 * import { describeStoreContract } from '@modelctx-ai/ctx/testing';
 * describeStoreContract('my-store', ({ now }) => createMyStore({ now }));
 * ```
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { ModelMessage } from 'ai';

import { assistantEntry, eventEntry, messageEntry, userEntry, type ContextEntry } from './entry.ts';
import type { ContextStore } from './store.ts';

export type StoreFactory = (options: { readonly now: () => number }) => ContextStore | Promise<ContextStore>;

function texts(entries: readonly ContextEntry[]): string[] {
  return entries.map((entry) => {
    if (entry.type === 'message') return typeof entry.message.content === 'string' ? entry.message.content : '[parts]';
    return entry.text ?? '';
  });
}

export function describeStoreContract(name: string, factory: StoreFactory): void {
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
      assert.equal(part && part.type === 'image' && String(part.image), 'https://example.com/a.png');
      assert.deepEqual(third?.type === 'event' && [third.kind, third.text, third.data], [
        'reminder',
        '喝水',
        { id: 's_1', repeat: null },
      ]);
      assert.deepEqual(fourth?.type === 'summary' && [fourth.text, fourth.covers], ['摘要', { at: 1, seq: 2 }]);
      assert.ok((second?.seq ?? 0) > (first?.seq ?? 0));
    });

    test('clear 删掉整条线程，threads 只列有内容的', async () => {
      const store = await factory({ now: Date.now });
      await store.append('a', [userEntry('x')]);
      await store.append('b', [userEntry('y'), userEntry('z')]);
      assert.deepEqual((await store.threads()).sort(), ['a', 'b']);
      assert.equal(await store.clear('b'), 2);
      assert.deepEqual(await store.threads(), ['a']);
      assert.equal(await store.clear('missing'), 0);
    });
  });
}
