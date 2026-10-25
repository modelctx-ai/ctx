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

import {
  assistantEntry,
  cursorOf,
  eventEntry,
  messageEntry,
  userEntry,
  type Entry,
  type NewEntry,
  type SessionStore,
} from './session.ts';
import { selectTools, type Executor, type ToolDefinition, type ToolFilter, type ToolRegistry } from './tools.ts';

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
    test('按 (at, seq) 排序，导入的旧记录插回原来的位置', async () => {
      let clock = 1_000;
      const store = await factory({ now: () => clock++ });
      await store.append('s', [userEntry('二'), userEntry('三')]);
      await store.append('s', [userEntry('一', { at: 10 })]);
      assert.deepEqual(texts(await store.list('s')), ['一', '二', '三']);
    });

    test('同一时刻按写入先后排', async () => {
      const store = await factory({ now: () => 5 });
      await store.append('s', [eventEntry('pet.whisper', { text: 'a' }), eventEntry('pet.whisper', { text: 'b' })]);
      await store.append('s', [eventEntry('pet.whisper', { text: 'c' })]);
      assert.deepEqual(texts(await store.list('s')), ['a', 'b', 'c']);
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
      assert.deepEqual(texts(await store.list('s', { after: written[1]! })), ['3', '4']);
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
        { type: 'summary', text: '摘要', covers: { at: 1, seq: 2 } },
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
      const iterator = store.watch('s', { after: cursorOf(first!), signal: controller.signal })[Symbol.asyncIterator]();
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
