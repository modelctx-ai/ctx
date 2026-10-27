import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';

import { userEntry, type NewMemoryFact } from '@modelctx-ai/ctx-protocol';
import { describeMemoryStoreContract } from '@modelctx-ai/ctx-protocol/testing';
import { describe, test } from 'vite-plus/test';

import { createSqliteMemoryStore, createSqliteStore } from './index.ts';

describeMemoryStoreContract('sqlite', () => createSqliteMemoryStore({ path: ':memory:' }), { describe, test });

const tempPath = (): string => join(mkdtempSync(join(tmpdir(), 'ctx-sqlite-memory-')), 'memory.db');

function newFact(text: string, extra: Partial<NewMemoryFact> = {}): NewMemoryFact {
  return {
    subject: 'user',
    text,
    validFrom: 1,
    confidence: 0.9,
    salience: 0.6,
    sources: [{ session: 's', from: 1, upTo: 1 }],
    ...extra,
  };
}

/** 库里所有表和索引的定义，比较迁移前后结构用。 */
function schemaOf(database: DatabaseSync): string[] {
  return (
    database.prepare(`SELECT type, name, sql FROM sqlite_master ORDER BY type, name`).all() as {
      type: string;
      name: string;
      sql: string | null;
    }[]
  ).map((row) => `${row.type} ${row.name} ${row.sql ?? ''}`);
}

function metaOf(database: DatabaseSync, table: string): Record<string, string> {
  const rows = database.prepare(`SELECT key, value FROM ${table} ORDER BY key`).all() as {
    key: string;
    value: string;
  }[];
  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
}

const busyTimeout = (database: DatabaseSync): unknown => database.prepare('PRAGMA busy_timeout').get()?.['timeout'];

describe('sqlite memory store', () => {
  test('新库：四张表、meta 的 memory_schema 是 1，表名前缀缺省 memory_', () => {
    const store = createSqliteMemoryStore({ path: ':memory:' });
    const tables = (
      store.database.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`).all() as {
        name: string;
      }[]
    ).map((row) => row.name);
    assert.deepEqual(
      tables.filter((name) => name.startsWith('memory_')),
      ['memory_core', 'memory_facts', 'memory_meta', 'memory_notes', 'memory_procedures'],
    );
    assert.deepEqual(metaOf(store.database, 'memory_meta'), { memory_schema: '1' });
    store.close();
  });

  test('关掉重开，四个集合的数据都还在', async () => {
    const path = tempPath();
    const first = createSqliteMemoryStore({ path });
    const [note] = await first.notes.add([{ session: 's', from: 1, upTo: 4, at: 1, salience: 0.7, topic: 'user' }]);
    const fact = await first.facts.add(newFact('主人喜欢乌龙茶', { topic: 'user' }));
    await first.facts.touch([fact.id], 5);
    const procedure = await first.procedures.add({
      when: '构建失败',
      do: '先装依赖',
      evidence: [fact.sources[0]!],
      at: 2,
    });
    await first.core.set('画像一', 3);
    first.close();

    const second = createSqliteMemoryStore({ path });
    assert.deepEqual(await second.notes.list(), [note]);
    assert.equal(await second.notes.head('s'), 4);
    assert.deepEqual(await second.facts.list(), [{ ...fact, recalls: [5] }]);
    assert.deepEqual(await second.procedures.list(), [procedure]);
    assert.deepEqual(await second.core.get(), { text: '画像一', at: 3 });
    second.close();
  });

  test('和 ctx_ 会话表共用一个 DatabaseSync：表和结构版本互不干扰，两边都能读写', async () => {
    const database = new DatabaseSync(':memory:');
    const sessions = createSqliteStore({ database, prefix: 'ctx_' });
    const memory = createSqliteMemoryStore({ database, prefix: 'memory_' });
    await sessions.append('s', [userEntry('我喜欢乌龙茶')]);
    const fact = await memory.facts.add(newFact('主人喜欢乌龙茶'));
    assert.deepEqual(metaOf(database, 'ctx_meta'), { schema: '3' });
    assert.deepEqual(metaOf(database, 'memory_meta'), { memory_schema: '1' });
    // 两边按任意顺序重开都不改结构。
    const before = schemaOf(database);
    createSqliteMemoryStore({ database, prefix: 'memory_' });
    createSqliteStore({ database, prefix: 'ctx_' });
    assert.deepEqual(schemaOf(database), before);
    assert.equal((await sessions.list('s')).length, 1);
    assert.deepEqual(ids(await memory.facts.list()), [fact.id]);
    memory.close();
    sessions.close();
    assert.equal(database.isOpen, true, 'close 不关别人的库');
  });

  test('和会话存储用同一个前缀也不冲突：结构版本的键不同', async () => {
    const database = new DatabaseSync(':memory:');
    const sessions = createSqliteStore({ database, prefix: 'ctx_' });
    const memory = createSqliteMemoryStore({ database, prefix: 'ctx_' });
    assert.deepEqual(metaOf(database, 'ctx_meta'), { memory_schema: '1', schema: '3' });
    createSqliteStore({ database, prefix: 'ctx_' });
    createSqliteMemoryStore({ database, prefix: 'ctx_' });
    await sessions.append('s', [userEntry('一')]);
    await memory.core.set('画像', 1);
    assert.equal((await sessions.list('s')).length, 1);
    assert.deepEqual(await memory.core.get(), { text: '画像', at: 1 });
  });

  test('在应用的事务里也能写：用 SAVEPOINT，应用回滚时一起回滚；方法失败只回滚它自己', async () => {
    const database = new DatabaseSync(':memory:');
    const store = createSqliteMemoryStore({ database });
    database.exec('BEGIN');
    await store.facts.add(newFact('事务里'));
    await assert.rejects(store.facts.close('missing', 1), (error: Error) => error.name === 'not_found');
    assert.equal(database.isTransaction, true, '应用的事务还开着');
    assert.equal((await store.facts.list()).length, 1);
    database.exec('ROLLBACK');
    assert.deepEqual(await store.facts.list(), []);
  });

  test('两个句柄写同一个库：交错的写都在', async () => {
    const path = tempPath();
    const one = createSqliteMemoryStore({ path });
    const two = createSqliteMemoryStore({ path });
    const fact = await one.facts.add(newFact('共享的事实'));
    await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? one : two).facts.touch([fact.id], i)));
    await Promise.all([
      one.facts.cite(fact.id, [{ session: 'a', from: 1, upTo: 1 }]),
      two.facts.cite(fact.id, [{ session: 'b', from: 1, upTo: 1 }]),
    ]);
    const [read] = await two.facts.list();
    assert.deepEqual(
      read?.recalls,
      Array.from({ length: 20 }, (_, i) => i),
    );
    assert.equal(read?.sources.length, 3);
    one.close();
    two.close();
  });

  test('表名前缀只能是标识符；path 和 database 至少给一个', () => {
    assert.throws(
      () => createSqliteMemoryStore({ path: ':memory:', prefix: 'x; DROP TABLE y' }),
      /Invalid table prefix/,
    );
    assert.throws(() => createSqliteMemoryStore({}), /createSqliteMemoryStore/);
  });

  test('busy_timeout：自己开库缺省 5000；传进来的库缺省不改', () => {
    assert.equal(busyTimeout(createSqliteMemoryStore({ path: ':memory:' }).database), 5000);
    const database = new DatabaseSync(':memory:');
    database.exec('PRAGMA busy_timeout = 777');
    createSqliteMemoryStore({ database });
    assert.equal(busyTimeout(database), 777);
    createSqliteMemoryStore({ database, busyTimeoutMs: 42 });
    assert.equal(busyTimeout(database), 42);
  });
});

function ids(items: readonly { readonly id: string }[]): string[] {
  return items.map((item) => item.id);
}

describe('sqlite memory store：查询', () => {
  test('facts.list 的 subject、topic、open 和 id 翻页走索引', () => {
    const store = createSqliteMemoryStore({ path: ':memory:' });
    const plan = (sql: string, ...params: string[]): string =>
      (store.database.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as { detail: string }[])
        .map((row) => row.detail)
        .join('\n');
    const base = 'SELECT * FROM memory_facts';
    assert.match(plan(`${base} WHERE subject = ? ORDER BY id`, 'user'), /INDEX memory_facts_subject \(subject=\?\)/);
    assert.match(
      plan(`${base} WHERE topic = ? AND id > ? ORDER BY id`, 'work', 'a'),
      /INDEX memory_facts_topic \(topic=\? AND id>\?\)/,
    );
    assert.match(
      plan(`${base} WHERE valid_to IS NULL AND archived_at IS NULL AND id > ? ORDER BY id`, 'a'),
      /INDEX memory_facts_open \(id>\?\)/,
    );
    assert.match(
      plan(`${base} WHERE id > ? ORDER BY id LIMIT 2`, 'a'),
      /INDEX sqlite_autoindex_memory_facts_1 \(id>\?\)/,
    );
    assert.doesNotMatch(plan(`${base} WHERE subject = ? ORDER BY id`, 'user'), /TEMP B-TREE/, '不另外排序');
    assert.match(
      plan('SELECT coalesce(max(up_to), 0) FROM memory_notes WHERE session = ?', 's'),
      /INDEX memory_notes_head/,
    );
  });

  test('search：整句子串在前，分数随覆盖的比例升高；只命中部分词的分数低于 0.5', async () => {
    const store = createSqliteMemoryStore({ path: ':memory:' });
    const short = await store.facts.add(newFact('乌龙茶'));
    const long = await store.facts.add(newFact('主人每天下午都喝一杯乌龙茶'));
    const partial = await store.facts.add(newFact('主人的项目用 PostgreSQL'));
    const hits = await store.facts.search({ text: '乌龙茶' });
    assert.deepEqual(ids(hits.map((hit) => hit.fact)), [short.id, long.id]);
    assert.equal(hits[0]?.score, 1, '查询就是整句');
    assert.ok(hits[1]!.score > 0.5 && hits[1]!.score < 1);
    const mixed = await store.facts.search({ text: 'postgresql 乌龙茶' });
    assert.deepEqual(new Set(ids(mixed.map((hit) => hit.fact))), new Set([short.id, long.id, partial.id]));
    for (const hit of mixed) assert.ok(hit.score > 0 && hit.score < 0.5, '没有一条包含整句');
  });

  test('search：ASCII 不分大小写；%、_ 按字面匹配；空白不算词', async () => {
    const store = createSqliteMemoryStore({ path: ':memory:' });
    const pg = await store.facts.add(newFact('项目用 PostgreSQL'));
    const percent = await store.facts.add(newFact('完成了 100% 的迁移'));
    assert.deepEqual(ids((await store.facts.search({ text: 'POSTGRESQL' })).map((hit) => hit.fact)), [pg.id]);
    assert.deepEqual(ids((await store.facts.search({ text: '0% 的' })).map((hit) => hit.fact)), [percent.id]);
    assert.deepEqual(await store.facts.search({ text: 'a_b' }), []);
    await assert.rejects(
      store.facts.search({ text: 1 as unknown as string }),
      (error: Error) => error.name === 'invalid_request',
    );
  });
});

describe('sqlite memory store：结构版本和迁移', () => {
  /** 版本 1 的一个早先的样子：只有 notes 和 facts，facts 少了 open、superseded 两个索引。 */
  const PARTIAL_V1 = `
    CREATE TABLE memory_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO memory_meta (key, value) VALUES ('memory_schema', '1');
    CREATE TABLE memory_notes (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, session TEXT NOT NULL,
      from_seq INTEGER NOT NULL, up_to INTEGER NOT NULL, at INTEGER NOT NULL, salience REAL NOT NULL,
      kind TEXT, topic TEXT, settled_at INTEGER
    );
    CREATE INDEX memory_notes_head ON memory_notes (session, up_to);
    CREATE INDEX memory_notes_pending ON memory_notes (seq) WHERE settled_at IS NULL;
    CREATE TABLE memory_facts (
      id TEXT PRIMARY KEY NOT NULL, subject TEXT NOT NULL, predicate TEXT, text TEXT NOT NULL, topic TEXT,
      valid_from INTEGER NOT NULL, valid_to INTEGER, superseded_by TEXT, confidence REAL NOT NULL,
      salience REAL NOT NULL, sources TEXT NOT NULL, recalls TEXT NOT NULL DEFAULT '[]', archived_at INTEGER
    );
    CREATE INDEX memory_facts_subject ON memory_facts (subject, id);
    CREATE INDEX memory_facts_topic ON memory_facts (topic, id);
    INSERT INTO memory_notes (id, session, from_seq, up_to, at, salience) VALUES ('n-old', 's', 1, 7, 1, 0.5);
    INSERT INTO memory_facts (id, subject, text, valid_from, confidence, salience, sources)
      VALUES ('f-old', 'user', '旧库里的事实', 1, 0.9, 0.6, '[{"session":"s","from":1,"upTo":7}]');
  `;

  test('版本 1 的库结构不全：补齐缺的表和索引，旧数据在；再打开什么都不改', async () => {
    const database = new DatabaseSync(':memory:');
    database.exec(PARTIAL_V1);
    const store = createSqliteMemoryStore({ database });
    const fresh = new DatabaseSync(':memory:');
    createSqliteMemoryStore({ database: fresh });
    assert.deepEqual(
      schemaOf(database).map((line) => line.split(' ').slice(0, 2).join(' ')),
      schemaOf(fresh).map((line) => line.split(' ').slice(0, 2).join(' ')),
      '补齐后和新建的库有同样的表和索引',
    );
    assert.equal(await store.notes.head('s'), 7);
    assert.deepEqual(
      (await store.facts.list({ open: true })).map((fact) => fact.text),
      ['旧库里的事实'],
    );
    await store.core.set('补出来的表能写', 1);
    const before = schemaOf(database);
    createSqliteMemoryStore({ database });
    assert.deepEqual(schemaOf(database), before);
    assert.deepEqual(metaOf(database, 'memory_meta'), { memory_schema: '1' });
  });

  test('在应用的事务里补齐，回滚后回到原来的结构', () => {
    const database = new DatabaseSync(':memory:');
    database.exec(PARTIAL_V1);
    const before = schemaOf(database);
    database.exec('BEGIN');
    createSqliteMemoryStore({ database });
    assert.notDeepEqual(schemaOf(database), before);
    database.exec('ROLLBACK');
    assert.deepEqual(schemaOf(database), before);
  });

  test('比自己新的版本拒绝打开，库原样不动；自己开的库也关掉', () => {
    const path = tempPath();
    createSqliteMemoryStore({ path }).close();
    const raw = new DatabaseSync(path);
    raw.exec(`UPDATE memory_meta SET value = '2' WHERE key = 'memory_schema'`);
    raw.exec('DROP INDEX memory_facts_open');
    const before = schemaOf(raw);
    raw.close();
    assert.throws(() => createSqliteMemoryStore({ path }), /memory schema in this database is version 2, newer than/);
    const check = new DatabaseSync(path);
    assert.deepEqual(schemaOf(check), before, '没有补索引');
    assert.deepEqual(metaOf(check, 'memory_meta'), { memory_schema: '2' });
    check.close();
  });

  test('认不得的版本值报错', () => {
    const database = new DatabaseSync(':memory:');
    database.exec(`CREATE TABLE memory_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO memory_meta (key, value) VALUES ('memory_schema', 'x')`);
    assert.throws(() => createSqliteMemoryStore({ database }), /Unrecognized ctx memory schema version "x"/);
  });
});

describe('sqlite memory store：多进程', () => {
  const writer = fileURLToPath(new URL('./fixtures/memory-writer.ts', import.meta.url));
  const exec = promisify(execFile);

  test('几个进程同时写同一个库：不报 SQLITE_BUSY，touch、cite、笔记、core 一条不丢', async () => {
    const path = tempPath();
    const seed = createSqliteMemoryStore({ path });
    const fact = await seed.facts.add(newFact('大家都在召回的事实'));
    const rounds = 15;
    const startAt = Date.now() + 1_500;
    await Promise.all(
      [1, 2, 3, 4].map(() =>
        exec(
          process.execPath,
          ['--conditions=@modelctx-ai/source', writer, path, fact.id, String(rounds), String(startAt)],
          { timeout: 60_000 },
        ),
      ),
    );
    const [read] = await seed.facts.list();
    assert.equal(read?.recalls.length, 4 * rounds);
    assert.equal(read?.sources.length, 1 + 4 * rounds);
    assert.equal((await seed.notes.list()).length, 4 * rounds);
    assert.equal((await seed.core.history()).length, 4 * rounds);
    seed.close();
  }, 90_000);
});
