import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, test } from 'node:test';

import { eventEntry, messageEntry, userEntry, type JsonValue, type ModelMessage } from '@modelctx-ai/ctx';
import { describeStoreContract } from '@modelctx-ai/ctx/testing';

import { createSqliteStore } from './index.ts';

describeStoreContract('sqlite', ({ now }) => createSqliteStore({ path: ':memory:', now }));

describe('sqlite store', () => {
  test('关掉重开，条目和顺序都还在', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'ctx-sqlite-')), 'ctx.db');
    const first = createSqliteStore({ path });
    await first.append('t', [userEntry('一'), eventEntry('whisper', { text: '二' })]);
    first.close();
    const second = createSqliteStore({ path });
    const entries = await second.list('t');
    assert.deepEqual(
      entries.map((entry) => entry.type),
      ['message', 'event'],
    );
    second.close();
  });

  test('和应用共用一个库，在应用的事务里也能写，回滚一起回滚', async () => {
    const database = new DatabaseSync(':memory:');
    database.exec('CREATE TABLE app (x INTEGER)');
    const store = createSqliteStore({ database, prefix: 'yoyo_ctx_' });
    database.exec('BEGIN');
    await store.append('t', [userEntry('事务里')]);
    database.exec('INSERT INTO app (x) VALUES (1)');
    database.exec('ROLLBACK');
    assert.equal((await store.list('t')).length, 0);
    await store.append('t', [userEntry('事务外')]);
    assert.equal((await store.list('t')).length, 1);
    store.close();
    assert.equal(database.prepare('SELECT count(*) AS n FROM app').get()?.['n'], 0, 'close 不关别人的库');
  });

  test('别的 TypedArray 和切片按字节存，Buffer 读回来是普通的 Uint8Array', async () => {
    const store = createSqliteStore({ path: ':memory:' });
    const bytes = new Uint8Array([9, 1, 2, 3, 9]);
    const message: ModelMessage = {
      role: 'user',
      content: [
        { type: 'image', image: Buffer.from('hi') },
        { type: 'image', image: bytes.subarray(1, 4) },
        { type: 'image', image: new Uint16Array([1, 2]) as unknown as Uint8Array },
        { type: 'image', image: new DataView(bytes.buffer, 3, 2) as unknown as Uint8Array },
      ],
    };
    await store.append('t', [messageEntry(message)]);
    const [entry] = await store.list('t');
    const images = (entry?.type === 'message' && Array.isArray(entry.message.content) ? entry.message.content : []).map(
      (part) => (part.type === 'image' ? part.image : undefined),
    );
    for (const image of images) assert.equal(Object.getPrototypeOf(image), Uint8Array.prototype);
    assert.deepEqual(
      images.map((image) => [...(image as Uint8Array)]),
      [
        [104, 105],
        [1, 2, 3],
        [1, 0, 2, 0],
        [3, 9],
      ],
    );
    store.close();
  });

  test('只有恰好是编码结果的对象才还原，多一个键或地址不合法都原样读回', async () => {
    const store = createSqliteStore({ path: ':memory:' });
    const data: JsonValue = [
      { '\u0000ctx': 'url', href: 'https://example.com/', note: 'extra' },
      { '\u0000ctx': 'url', href: 'not a url' },
      { '\u0000ctx': 'bytes', base64: 42 },
    ];
    await store.append('t', [eventEntry('tool-log', { data })]);
    const [entry] = await store.list('t');
    assert.deepEqual(entry?.type === 'event' && entry.data, data);
    store.close();
  });

  test('循环结构写不进去，整批回滚', async () => {
    const store = createSqliteStore({ path: ':memory:' });
    const loop: Record<string, unknown> = {};
    loop['self'] = loop;
    const call: ModelMessage = {
      role: 'assistant',
      content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'x', input: loop }],
    };
    await assert.rejects(store.append('t', [userEntry('先写的'), messageEntry(call)]), /circular/);
    assert.deepEqual(await store.list('t'), []);
    store.close();
  });

  test('表名前缀只能是标识符', () => {
    assert.throws(() => createSqliteStore({ path: ':memory:', prefix: 'x; DROP TABLE y' }), /Invalid table prefix/);
  });
});
