import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';

import { eventEntry, messageEntry, userEntry, type Message } from '@modelctx-ai/ctx-protocol';
import { describeSessionStoreContract } from '@modelctx-ai/ctx-protocol/testing';
import { describe, test } from 'vite-plus/test';

import { createSqliteStore } from './index.ts';

describeSessionStoreContract('sqlite', ({ now }) => createSqliteStore({ path: ':memory:', now, pollIntervalMs: 10 }), {
  describe,
  test,
});

describe('sqlite store', () => {
  test('关掉重开，条目和顺序都还在', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'ctx-sqlite-')), 'ctx.db');
    const first = createSqliteStore({ path });
    await first.append('t', [userEntry('一'), eventEntry('pet.whisper', { text: '二' })]);
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

  test('循环结构写不进去，整批回滚', async () => {
    const store = createSqliteStore({ path: ':memory:' });
    const loop: Record<string, unknown> = {};
    loop['self'] = loop;
    const call = {
      role: 'assistant',
      content: [{ type: 'tool-call', id: 'c1', name: 'x', input: loop }],
    } as unknown as Message;
    await assert.rejects(store.append('t', [userEntry('先写的'), messageEntry(call)]), /circular/i);
    assert.deepEqual(await store.list('t'), []);
    store.close();
  });

  test('表名前缀只能是标识符', () => {
    assert.throws(() => createSqliteStore({ path: ':memory:', prefix: 'x; DROP TABLE y' }), /Invalid table prefix/);
  });

  test('watch 轮询：另一个连接写进同一个库的条目也能读到', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'ctx-sqlite-')), 'ctx.db');
    const reader = createSqliteStore({ path, pollIntervalMs: 10 });
    const writer = createSqliteStore({ path });
    const controller = new AbortController();
    const iterator = reader.watch('s', { signal: controller.signal })[Symbol.asyncIterator]();
    const pending = iterator.next();
    await writer.append('s', [userEntry('别的进程写的')]);
    const { value } = await pending;
    assert.equal(value?.type === 'message' && value.message.content, '别的进程写的');
    const ending = iterator.next();
    controller.abort();
    assert.equal((await ending).done, true);
    reader.close();
    writer.close();
  });
});

const OLD_DDL = (column: string): string => `
  CREATE TABLE ctx_entries (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    ${column} TEXT NOT NULL,
    at INTEGER NOT NULL,
    type TEXT NOT NULL,
    key TEXT,
    source TEXT,
    body TEXT NOT NULL,
    meta TEXT
  );
  CREATE UNIQUE INDEX ctx_entries_key ON ctx_entries (${column}, key) WHERE key IS NOT NULL;
  CREATE INDEX ctx_entries_order ON ctx_entries (${column}, at, seq);
  CREATE TABLE ctx_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  INSERT INTO ctx_meta (key, value) VALUES ('schema', '1');
  INSERT INTO ctx_entries (id, ${column}, at, type, key, body)
    VALUES ('old-1', 'user:1', 1, 'message', 'k', '{"message":{"role":"user","content":"旧的"}}');
`;

/** ADR 0005 阶段 1 的提交建出来的 schema 3：只有 `(session, seq)` 索引，没有后面阶段加的列和索引。 */
const PHASE1_DDL = `
  CREATE TABLE ctx_entries (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    session TEXT NOT NULL,
    at INTEGER NOT NULL,
    type TEXT NOT NULL,
    key TEXT,
    source TEXT,
    body TEXT NOT NULL,
    meta TEXT
  );
  CREATE UNIQUE INDEX ctx_entries_key ON ctx_entries (session, key) WHERE key IS NOT NULL;
  CREATE INDEX ctx_entries_seq ON ctx_entries (session, seq);
  CREATE TABLE ctx_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  INSERT INTO ctx_meta (key, value) VALUES ('schema', '3');
  INSERT INTO ctx_entries (id, session, at, type, key, body)
    VALUES ('p1-1', 'user:1', 1, 'message', 'k', '{"message":{"role":"user","content":"阶段 1 写的"}}'),
           ('p1-2', 'user:1', 2, 'event', NULL, '{"kind":"note","text":"事件"}');
`;

function indexNames(database: DatabaseSync): string[] {
  const rows = database.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'ctx_entries'`);
  return (rows.all() as { name: string }[]).map((row) => row.name).filter((name) => name.startsWith('ctx_entries_'));
}

function schemaVersion(database: DatabaseSync): unknown {
  return database.prepare(`SELECT value FROM ctx_meta WHERE key = 'schema'`).get()?.['value'];
}

describe('schema 迁移', () => {
  test('新库直接是当前版本', () => {
    const database = new DatabaseSync(':memory:');
    createSqliteStore({ database });
    assert.equal(schemaVersion(database), '3');
  });

  test('0.1 的库（thread 列、schema=1）能直接打开：旧数据在，索引随列改名，可以接着写', async () => {
    const database = new DatabaseSync(':memory:');
    database.exec(OLD_DDL('thread'));
    const store = createSqliteStore({ database });
    assert.equal(schemaVersion(database), '3');
    const [old] = await store.list('user:1');
    assert.equal(old?.id, 'old-1');
    assert.equal(old?.session, 'user:1');
    // 同会话同 key 的唯一索引还在，说明索引跟着列改了名。
    assert.deepEqual(await store.append('user:1', [{ ...userEntry('重复'), key: 'k' }]), []);
    assert.equal((await store.append('user:1', [userEntry('新的')])).length, 1);
    assert.deepEqual(await store.sessions(), ['user:1']);
  });

  test('0.2 的库（session 列、schema=1）只升版本；yoyo 自己改过列名的库同理', async () => {
    const database = new DatabaseSync(':memory:');
    database.exec(OLD_DDL('session'));
    const store = createSqliteStore({ database });
    assert.equal(schemaVersion(database), '3');
    assert.equal((await store.list('user:1')).length, 1);
  });

  test('schema 2 的库升到 3：旧的 (session, at, seq) 索引换成 (session, seq)，数据和旧摘要的 covers 照读', async () => {
    const database = new DatabaseSync(':memory:');
    database.exec(OLD_DDL('session'));
    database.exec(`UPDATE ctx_meta SET value = '2' WHERE key = 'schema'`);
    database.exec(`
      INSERT INTO ctx_entries (id, session, at, type, body)
        VALUES ('old-2', 'user:1', 2, 'message', '{"message":{"role":"assistant","content":"旧回答"}}'),
               ('old-s', 'user:1', 3, 'summary', '{"text":"旧摘要","covers":{"at":2,"seq":2}}');
    `);
    const store = createSqliteStore({ database });
    assert.equal(schemaVersion(database), '3');
    const indexes = (database.prepare(`PRAGMA index_list(ctx_entries)`).all() as { name: string }[]).map((i) => i.name);
    assert.ok(indexes.includes('ctx_entries_seq'));
    assert.ok(indexes.includes('ctx_entries_kind'));
    assert.ok(!indexes.includes('ctx_entries_order'));
    const entries = await store.list('user:1');
    assert.deepEqual(
      entries.map((entry) => entry.id),
      ['old-1', 'old-2', 'old-s'],
    );
    assert.equal(entries[2]?.type === 'summary' && entries[2].covers, 2, '旧的 { at, seq } 读成 seq');
    assert.equal((await store.append('user:1', [userEntry('新的')]))[0]?.seq, 4);
  });

  test('schema 3 同一级的结构不全也能补齐：索引缺了补上，留着的旧索引删掉，重复打开不变', async () => {
    const database = new DatabaseSync(':memory:');
    database.exec(PHASE1_DDL);
    database.exec(`DROP INDEX ctx_entries_seq; CREATE INDEX ctx_entries_order ON ctx_entries (session, at, seq);`);
    createSqliteStore({ database });
    const first = indexNames(database).toSorted();
    assert.ok(first.includes('ctx_entries_seq'));
    assert.ok(first.includes('ctx_entries_key'));
    assert.ok(!first.includes('ctx_entries_order'));
    assert.equal(schemaVersion(database), '3');
    const store = createSqliteStore({ database });
    assert.deepEqual(indexNames(database).toSorted(), first);
    assert.deepEqual(
      (await store.list('user:1')).map((entry) => entry.id),
      ['p1-1', 'p1-2'],
    );
  });

  test('阶段 1 的 schema 3 库补上生成列 kind 和 (session, kind, seq) 索引，旧行自动有 kind，可以按 kinds 查', async () => {
    const database = new DatabaseSync(':memory:');
    database.exec(PHASE1_DDL);
    const columns = (): string[] =>
      (database.prepare(`PRAGMA table_xinfo(ctx_entries)`).all() as { name: string }[]).map((c) => c.name);
    assert.ok(!columns().includes('kind'));
    const store = createSqliteStore({ database });
    assert.ok(columns().includes('kind'));
    assert.ok(indexNames(database).includes('ctx_entries_kind'));
    assert.equal(schemaVersion(database), '3');
    assert.deepEqual(
      (
        database.prepare(`SELECT id, kind FROM ctx_entries ORDER BY seq`).all() as { id: string; kind: string | null }[]
      ).map((row) => [row.id, row.kind]),
      [
        ['p1-1', null],
        ['p1-2', 'note'],
      ],
      '消息的 kind 是 NULL，旧事件的 kind 从 body 里取出来',
    );
    assert.deepEqual(
      (await store.list('user:1', { kinds: ['note'] })).map((entry) => entry.id),
      ['p1-2'],
    );
    await store.append('user:1', [eventEntry('note', { text: '新写的' })]);
    assert.equal((await store.list('user:1', { kinds: ['note'] })).length, 2);
    // 再打开一次：结构完整，什么都不改。
    const before = indexNames(database).toSorted();
    createSqliteStore({ database });
    assert.deepEqual(indexNames(database).toSorted(), before);
    assert.equal(columns().filter((name) => name === 'kind').length, 1);
  });

  test('阶段 1 的库补上 v 列（缺省 0），旧行读出来 v 是 0 且消息已是当前格式，新写的是 v 1，旧行的 body 不被改写', async () => {
    const database = new DatabaseSync(':memory:');
    database.exec(PHASE1_DDL);
    const body = JSON.stringify({
      message: {
        role: 'user',
        content: [
          { type: 'text', text: '看图' },
          { type: 'image', image: { '\u0000ctx': 'bytes', base64: 'AQID' }, mediaType: 'image/png' },
          { type: 'image', image: { '\u0000ctx': 'url', href: 'https://example.com/a.png' } },
        ],
      },
    });
    database
      .prepare(`INSERT INTO ctx_entries (id, session, at, type, body) VALUES ('p1-img', 'user:1', 3, 'message', ?)`)
      .run(body);
    database.exec(`INSERT INTO ctx_entries (id, session, at, type, body)
      VALUES ('p1-sum', 'user:1', 4, 'summary', '{"text":"摘要","covers":{"at":2,"seq":2}}')`);
    const columns = (): { name: string; dflt_value: unknown; notnull: number }[] =>
      database.prepare(`PRAGMA table_xinfo(ctx_entries)`).all() as never;
    assert.ok(!columns().some((column) => column.name === 'v'));

    const store = createSqliteStore({ database });
    const v = columns().find((column) => column.name === 'v');
    assert.equal(v?.notnull, 1);
    assert.equal(String(v?.dflt_value), '0');

    const entries = await store.list('user:1');
    assert.deepEqual(
      entries.map((entry) => [entry.id, entry.v]),
      [
        ['p1-1', 0],
        ['p1-2', 0],
        ['p1-img', 0],
        ['p1-sum', 0],
      ],
    );
    const image = entries.find((entry) => entry.id === 'p1-img');
    assert.deepEqual(image?.type === 'message' && image.message.content, [
      { type: 'text', text: '看图' },
      { type: 'file', mediaType: 'image/png', data: { type: 'data', data: 'AQID' } },
      { type: 'file', mediaType: 'image', data: { type: 'url', url: 'https://example.com/a.png' } },
    ]);
    const summary = entries.find((entry) => entry.id === 'p1-sum');
    assert.equal(summary?.type === 'summary' && summary.covers, 2);

    const [written] = await store.append('user:1', [userEntry('新写的')]);
    assert.equal(written?.v, 1);
    assert.equal((await store.list('user:1', { last: 1 }))[0]?.v, 1);
    const stored = database
      .prepare(`SELECT id, v, body FROM ctx_entries WHERE id IN ('p1-img', ?) ORDER BY seq`)
      .all(written.id) as { id: string; v: number; body: string }[];
    assert.deepEqual(
      stored.map((row) => row.v),
      [0, 1],
    );
    assert.equal(stored[0]?.body, body, '旧行不被改写');

    // 再打开一次：v 列不重复加。
    createSqliteStore({ database });
    assert.equal(columns().filter((column) => column.name === 'v').length, 1);
  });

  test('补 v 列也是只补缺的：已有 v 列的库不报错，在应用的事务里补齐后回滚回到原结构', () => {
    const database = new DatabaseSync(':memory:');
    database.exec(PHASE1_DDL);
    database.exec(`ALTER TABLE ctx_entries ADD COLUMN v INTEGER NOT NULL DEFAULT 0`);
    createSqliteStore({ database });
    const rolledBack = new DatabaseSync(':memory:');
    rolledBack.exec(PHASE1_DDL);
    rolledBack.exec('BEGIN');
    createSqliteStore({ database: rolledBack });
    rolledBack.exec('ROLLBACK');
    assert.ok(
      !(rolledBack.prepare(`PRAGMA table_xinfo(ctx_entries)`).all() as { name: string }[]).some((c) => c.name === 'v'),
    );
  });

  test('比自己新的行格式读不了：unsupported_version，不猜', async () => {
    const database = new DatabaseSync(':memory:');
    const store = createSqliteStore({ database });
    await store.append('t', [userEntry('好')]);
    database.exec(`UPDATE ctx_entries SET v = 2`);
    await assert.rejects(store.list('t'), (error: Error) => error.name === 'unsupported_version');
  });

  test('只补缺的：kind 列在、索引缺时只补索引；索引在、列缺时先补列', () => {
    const lacksIndex = new DatabaseSync(':memory:');
    lacksIndex.exec(PHASE1_DDL);
    lacksIndex.exec(
      `ALTER TABLE ctx_entries ADD COLUMN kind TEXT GENERATED ALWAYS AS (json_extract(body, '$.kind')) VIRTUAL`,
    );
    createSqliteStore({ database: lacksIndex });
    assert.ok(indexNames(lacksIndex).includes('ctx_entries_kind'));
    const partial = new DatabaseSync(':memory:');
    partial.exec(PHASE1_DDL);
    partial.exec(`DROP INDEX ctx_entries_key`);
    createSqliteStore({ database: partial });
    assert.ok(indexNames(partial).includes('ctx_entries_key'));
    assert.ok(indexNames(partial).includes('ctx_entries_kind'));
  });

  test('在应用的事务里补齐 schema 3，回滚后回到阶段 1 的结构', () => {
    const database = new DatabaseSync(':memory:');
    database.exec(PHASE1_DDL);
    database.exec('BEGIN');
    createSqliteStore({ database });
    assert.ok(indexNames(database).includes('ctx_entries_kind'));
    database.exec('ROLLBACK');
    assert.ok(!indexNames(database).includes('ctx_entries_kind'));
    assert.ok(
      !(database.prepare(`PRAGMA table_xinfo(ctx_entries)`).all() as { name: string }[]).some((c) => c.name === 'kind'),
    );
  });

  test('kind 条件能用上 (session, kind, seq) 索引；前缀按字面匹配，最大码点做前缀也不出错', async () => {
    const store = createSqliteStore({ path: ':memory:' });
    const plan = (sql: string, ...params: (string | number)[]): string =>
      (store.database.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as { detail: string }[])
        .map((row) => row.detail)
        .join('\n');
    // 带 ORDER BY seq 时规划器可能改走 (session, seq) 索引顺着扫；这里只确认 kind 条件能用上新索引。
    assert.match(
      plan(`SELECT seq FROM ctx_entries WHERE session = ? AND kind IN (?, ?)`, 's', 'a', 'b'),
      /USING (COVERING )?INDEX ctx_entries_kind \(session=\? AND kind=\?\)/,
    );
    await store.append('a', [userEntry('x')]);
    await store.append('a%', [userEntry('x')]);
    assert.deepEqual(await store.sessions({ prefix: 'a%' }), ['a%']);
    assert.deepEqual(await store.sessions({ prefix: '\u{10ffff}' }), [], '最大码点做前缀：没有上界也不出错');
    store.close();
  });

  test('比自己新的版本拒绝打开，库原样不动；自己开的库也关掉', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'ctx-sqlite-')), 'ctx.db');
    createSqliteStore({ path }).close();
    const raw = new DatabaseSync(path);
    raw.exec(`UPDATE ctx_meta SET value = '4' WHERE key = 'schema'`);
    raw.close();
    assert.throws(() => createSqliteStore({ path }), /version 4, newer than/);
    const check = new DatabaseSync(path);
    assert.equal(schemaVersion(check), '4');
    check.close();
  });

  test('thread 和 session 两列都在时跳过改名，不炸', () => {
    const database = new DatabaseSync(':memory:');
    database.exec(OLD_DDL('thread'));
    database.exec('ALTER TABLE ctx_entries ADD COLUMN session TEXT');
    assert.equal(
      database.prepare(`SELECT count(*) AS n FROM pragma_table_info('ctx_entries') WHERE name = 'thread'`).get()?.['n'],
      1,
    );
    createSqliteStore({ database });
    assert.equal(schemaVersion(database), '3');
  });

  test('在应用的事务里打开旧库也能迁，回滚后版本回到 1', () => {
    const database = new DatabaseSync(':memory:');
    database.exec(OLD_DDL('thread'));
    database.exec('BEGIN');
    createSqliteStore({ database });
    assert.equal(schemaVersion(database), '3');
    database.exec('ROLLBACK');
    assert.equal(schemaVersion(database), '1');
    assert.equal(
      database.prepare(`SELECT count(*) AS n FROM pragma_table_info('ctx_entries') WHERE name = 'thread'`).get()?.['n'],
      1,
    );
  });
});

describe('写入约束', () => {
  test('NOT NULL 违例报错，不再被当成重复静默跳过；整批回滚', async () => {
    const store = createSqliteStore({ path: ':memory:' });
    await assert.rejects(store.append(null as unknown as string, [userEntry('x')]), /NOT NULL/);
    await assert.rejects(
      store.append('t', [userEntry('先写的'), { ...userEntry('坏的'), type: null as unknown as 'message' }]),
      /NOT NULL/,
    );
    assert.deepEqual(await store.list('t'), []);
    store.close();
  });

  test('重复的 id 和 key 照旧跳过，其余照写', async () => {
    const store = createSqliteStore({ path: ':memory:' });
    await store.append('t', [{ ...userEntry('a'), id: 'x', key: 'k' }]);
    const written = await store.append('t', [
      { ...userEntry('同 id'), id: 'x' },
      { ...userEntry('同 key'), key: 'k' },
      userEntry('新的'),
    ]);
    assert.equal(written.length, 1);
    store.close();
  });
});

const busyTimeout = (database: DatabaseSync): unknown => database.prepare('PRAGMA busy_timeout').get()?.['timeout'];

describe('busy_timeout', () => {
  test('自己开库缺省 5000，可以改', () => {
    assert.equal(busyTimeout(createSqliteStore({ path: ':memory:' }).database), 5000);
    assert.equal(busyTimeout(createSqliteStore({ path: ':memory:', busyTimeoutMs: 123 }).database), 123);
  });

  test('传进来的库缺省不改，显式传了才设', () => {
    const database = new DatabaseSync(':memory:');
    database.exec('PRAGMA busy_timeout = 777');
    createSqliteStore({ database });
    assert.equal(busyTimeout(database), 777);
    createSqliteStore({ database, busyTimeoutMs: 42 });
    assert.equal(busyTimeout(database), 42);
  });

  test('不合法的值报错', () => {
    assert.throws(() => createSqliteStore({ path: ':memory:', busyTimeoutMs: -1 }), /busyTimeoutMs/);
  });
});

describe('多进程', () => {
  const writer = fileURLToPath(new URL('./fixtures/writer.ts', import.meta.url));
  const exec = promisify(execFile);
  const spawnWriter = (path: string, session: string, count: number) =>
    exec(process.execPath, ['--conditions=@modelctx-ai/source', writer, path, session, String(count)], {
      timeout: 60_000,
    });

  test('几个进程同时往同一个库写：不报 SQLITE_BUSY，一条不丢，seq 不重复', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'ctx-sqlite-')), 'ctx.db');
    await Promise.all(['a', 'b', 'c', 'd'].map((session) => spawnWriter(path, session, 40)));
    const store = createSqliteStore({ path });
    assert.deepEqual(await store.sessions(), ['a', 'b', 'c', 'd']);
    for (const session of ['a', 'b', 'c', 'd']) assert.equal((await store.list(session)).length, 40);
    const seqs = store.database.prepare('SELECT count(DISTINCT seq) AS n FROM ctx_entries').get()?.['n'];
    assert.equal(seqs, 160);
    store.close();
  }, 90_000);

  test('几个进程同时打开同一个 0.1 旧库：只迁一次，旧数据在', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'ctx-sqlite-')), 'ctx.db');
    const raw = new DatabaseSync(path);
    raw.exec('PRAGMA journal_mode = WAL');
    raw.exec(OLD_DDL('thread'));
    raw.close();
    await Promise.all(['a', 'b', 'c', 'd'].map((session) => spawnWriter(path, session, 5)));
    const store = createSqliteStore({ path });
    assert.equal(schemaVersion(store.database), '3');
    assert.equal((await store.list('user:1')).length, 1);
    assert.equal((await store.sessions()).length, 5);
    store.close();
  }, 90_000);
});
