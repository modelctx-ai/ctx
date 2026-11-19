import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';

import { MAX_FACT_RECALLS, searchTerms, termOverlap, userEntry, type NewMemoryFact } from '@modelctx-ai/ctx-protocol';
import { describeMemoryStoreContract } from '@modelctx-ai/ctx-protocol/testing';
import { describe, test } from 'vite-plus/test';

import { createSqliteMemoryStore, createSqliteStore } from './index.ts';
import { factSearchSql } from './memory.ts';

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
  test('新库：四张表加倒排索引的两张、meta 的 memory_schema 是 5，表名前缀缺省 memory_', () => {
    const store = createSqliteMemoryStore({ path: ':memory:' });
    const tables = (
      store.database.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`).all() as {
        name: string;
      }[]
    ).map((row) => row.name);
    assert.deepEqual(
      tables.filter((name) => name.startsWith('memory_')),
      [
        'memory_core',
        'memory_fact_docs',
        'memory_fact_terms',
        'memory_facts',
        'memory_meta',
        'memory_notes',
        'memory_procedures',
      ],
    );
    assert.deepEqual(metaOf(store.database, 'memory_meta'), { memory_schema: '5' });
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
    assert.deepEqual(metaOf(database, 'memory_meta'), { memory_schema: '5' });
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
    assert.deepEqual(metaOf(database, 'ctx_meta'), { memory_schema: '5', schema: '3' });
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

/** 按 `searchTerms` 切词、`termOverlap` 打分：查询和一段文字的相似度。 */
function overlapOf(query: string, text: string): number {
  const wanted = searchTerms(query);
  const own = new Set(searchTerms(text));
  return termOverlap(wanted.filter((term) => own.has(term)).length, wanted.length, own.size);
}

describe('sqlite memory store：查询', () => {
  test('facts.list 的 subject、topic、open 和 id 翻页走索引', () => {
    const store = createSqliteMemoryStore({ path: ':memory:' });
    const plan = (sql: string, ...params: string[]): string =>
      (store.database.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as { detail: string }[])
        .map((row) => row.detail)
        .join('\n');
    const base = 'SELECT * FROM memory_facts';
    // 每个查询都带作用域，索引以 `scope` 开头。
    assert.match(
      plan(`${base} WHERE scope = ? AND subject = ? ORDER BY id`, 'u', 'user'),
      /INDEX memory_facts_scope_subject \(scope=\? AND subject=\?\)/,
    );
    assert.match(
      plan(`${base} WHERE scope = ? AND topic = ? AND id > ? ORDER BY id`, 'u', 'work', 'a'),
      /INDEX memory_facts_scope_topic \(scope=\? AND topic=\? AND id>\?\)/,
    );
    assert.match(
      plan(`${base} WHERE scope = ? AND valid_to IS NULL AND archived_at IS NULL AND id > ? ORDER BY id`, 'u', 'a'),
      /INDEX memory_facts_scope_open \(scope=\? AND id>\?\)/,
    );
    assert.match(
      plan(`${base} WHERE scope = ? AND id > ? ORDER BY id LIMIT 2`, 'u', 'a'),
      /INDEX memory_facts_scope\w* \(scope=\? AND id>\?\)/,
    );
    assert.match(
      plan(`${base} WHERE id = ? AND scope = ?`, 'a', 'u'),
      /INDEX sqlite_autoindex_memory_facts_1 \(id=\?\)/,
    );
    assert.doesNotMatch(
      plan(`${base} WHERE scope = ? AND subject = ? ORDER BY id`, 'u', 'user'),
      /TEMP B-TREE/,
      '不另外排序',
    );
    assert.match(
      plan('SELECT coalesce(max(up_to), 0) FROM memory_notes WHERE scope = ? AND session = ?', 'u', 's'),
      /INDEX memory_notes_scope_head/,
    );
    assert.match(
      plan('SELECT text, at FROM memory_core WHERE scope = ? ORDER BY seq DESC LIMIT 1', 'u'),
      /INDEX memory_core_scope/,
    );
  });

  test('search 走倒排索引：每个词按主键查一次，只读命中的事实，不扫事实表也不扫整个作用域的词', () => {
    const store = createSqliteMemoryStore({ path: ':memory:' });
    const plan = (where: readonly string[]): string =>
      (
        store.database
          .prepare(`EXPLAIN QUERY PLAN ${factSearchSql('memory_', where)}`)
          .all('["乌龙"]', 'u', 'u', 1, 10) as { detail: string }[]
      )
        .map((row) => row.detail)
        .join('\n');
    for (const where of [
      ['f.valid_to IS NULL AND f.archived_at IS NULL'],
      ['f.valid_to IS NULL'],
      [],
      ["f.topic = 'work'", 'f.valid_to IS NULL AND f.archived_at IS NULL'],
    ]) {
      const detail = plan(where);
      assert.match(detail, /SEARCH t USING PRIMARY KEY \(scope=\? AND term=\?\)/, detail);
      assert.match(detail, /SEARCH d USING INTEGER PRIMARY KEY \(rowid=\?\)/, detail);
      assert.match(detail, /SEARCH f USING INDEX \w+ \([^)]*id=\?\)/, detail);
      assert.doesNotMatch(detail, /SCAN (t|d|f)\b/, detail);
    }
  });

  test('search：分数是 termOverlap，切词是 searchTerms；大小写、全角半角不分，标点不是词', async () => {
    const store = createSqliteMemoryStore({ path: ':memory:' });
    const short = await store.facts.add(newFact('乌龙茶'));
    const long = await store.facts.add(newFact('主人每天下午都喝一杯乌龙茶'));
    const pg = await store.facts.add(newFact('主人的项目用 PostgreSQL'));
    const percent = await store.facts.add(newFact('完成了 100% 的迁移'));
    const scores = async (text: string): Promise<[string, number][]> =>
      (await store.facts.search({ text })).map((hit) => [hit.fact.id, hit.score]);

    // 两条都含整个查询：分数都是 1，命中的词一样多，按 id 排。
    assert.deepEqual(
      await scores('乌龙茶'),
      [short.id, long.id].toSorted().map((id) => [id, 1]),
    );
    assert.deepEqual(new Set(await scores('下午喝什么茶')), new Set([[long.id, overlapOf('下午喝什么茶', long.text)]]));
    assert.equal(overlapOf('下午喝什么茶', long.text), 0.2, '五个词里中了一个');
    const mixed = await scores('postgresql 乌龙茶');
    assert.deepEqual(new Set(mixed.map(([id]) => id)), new Set([short.id, long.id, pg.id]));
    assert.deepEqual(mixed[0], [short.id, 1], '整条事实都在查询里的排最前');
    for (const [id, score] of mixed.slice(1)) assert.ok(score > 0 && score < 1, `${id} ${score}`);

    assert.deepEqual(await scores('POSTGRESQL'), [[pg.id, 1]]);
    assert.deepEqual(await scores('ｐｏｓｔｇｒｅｓｑｌ'), [[pg.id, 1]], '全角字母');
    assert.deepEqual(
      (await scores('100%')).map(([id]) => id),
      [percent.id],
      '% 不是词，100 是',
    );
    assert.deepEqual(await scores('%_'), [], '只有标点：没有词，什么都不命中，也不当通配符');
    assert.deepEqual(await scores("' OR 1=1 --"), [], '词是当参数传进去的');
    assert.deepEqual(await scores('Postgre'), [], '英文按整词，半个词不命中');
    await assert.rejects(
      store.facts.search({ text: 1 as unknown as string }),
      (error: Error) => error.name === 'invalid_request',
    );
  });

  test('索引跟着事实走：add 写进去，forget 删干净，别的方法不动它', async () => {
    const store = createSqliteMemoryStore({ path: ':memory:' });
    const count = (table: string): number =>
      (store.database.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
    const tea = await store.facts.add(newFact('主人喜欢喝乌龙茶'));
    const pg = await store.scope('other').facts.add(newFact('主人喜欢喝乌龙茶'));
    const words = searchTerms(tea.text).length;
    assert.equal(count('memory_fact_docs'), 2);
    assert.equal(count('memory_fact_terms'), 2 * words, '每个作用域各存一份自己的词');
    await store.facts.touch([tea.id], 5);
    await store.facts.cite(tea.id, [{ session: 's', from: 2, upTo: 2 }]);
    await store.facts.archive([tea.id], 6);
    await store.facts.restore([tea.id]);
    await store.facts.close(tea.id, 7);
    assert.equal(count('memory_fact_terms'), 2 * words);
    assert.equal(await store.facts.forget([tea.id, 'missing']), 1);
    assert.equal(count('memory_fact_docs'), 1);
    assert.equal(count('memory_fact_terms'), words, '删掉的事实不在索引里留词');
    assert.deepEqual(await store.facts.search({ text: '乌龙茶', open: false }), []);
    assert.deepEqual(ids((await store.scope('other').facts.search({ text: '乌龙茶' })).map((hit) => hit.fact)), [
      pg.id,
    ]);
    // 写入失败时索引也不留半截：没有证据的事实不写。
    await assert.rejects(store.facts.add(newFact('没有证据', { sources: [] })), /evidence/);
    assert.equal(count('memory_fact_docs'), 1);
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
    assert.deepEqual(metaOf(database, 'memory_meta'), { memory_schema: '5' });
  });

  test('版本 1 升到当前版本：加 scope 列，旧数据落在缺省的作用域里，旧索引换成带 scope 的，旧事实进了检索的索引', async () => {
    const database = new DatabaseSync(':memory:');
    database.exec(PARTIAL_V1);
    const store = createSqliteMemoryStore({ database });
    const indexes = schemaOf(database).filter((line) => line.includes('INDEX'));
    for (const old of ['memory_notes_head ', 'memory_notes_pending ', 'memory_facts_subject ', 'memory_facts_topic ']) {
      assert.ok(!indexes.some((line) => line.includes(old)), `旧索引 ${old}删掉了`);
    }
    assert.ok(indexes.some((line) => line.includes('memory_facts_scope_subject')));
    assert.deepEqual(ids(await store.notes.list()), ['n-old']);
    assert.deepEqual(ids(await store.facts.list()), ['f-old']);
    assert.deepEqual((await store.facts.search({ text: '旧库' })).length, 1);
    const other = store.scope('user:alice');
    assert.deepEqual(await other.notes.list(), []);
    assert.deepEqual(await other.facts.list(), []);
    assert.equal(await other.notes.head('s'), 0);
    assert.equal(await other.facts.forget(['f-old']), 0);
    const mine = await other.facts.add(newFact('新作用域里的事实'));
    assert.deepEqual(ids(await other.facts.list()), [mine.id]);
    assert.deepEqual(ids(await store.facts.list()), ['f-old']);
    assert.deepEqual(ids((await store.facts.search({ text: '旧库里有什么事实？' })).map((hit) => hit.fact)), ['f-old']);
    assert.deepEqual(metaOf(database, 'memory_meta'), { memory_schema: '5' });
  });

  /** 版本 2 的库：四张表都带 scope，没有倒排索引；两个作用域各有事实，其中一条的 recalls 很长。 */
  const V2 = `
    CREATE TABLE memory_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO memory_meta (key, value) VALUES ('memory_schema', '2');
    CREATE TABLE memory_notes (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, scope TEXT NOT NULL DEFAULT '',
      session TEXT NOT NULL, from_seq INTEGER NOT NULL, up_to INTEGER NOT NULL, at INTEGER NOT NULL,
      salience REAL NOT NULL, kind TEXT, topic TEXT, settled_at INTEGER
    );
    CREATE INDEX memory_notes_scope_head ON memory_notes (scope, session, up_to);
    CREATE INDEX memory_notes_scope ON memory_notes (scope, seq);
    CREATE INDEX memory_notes_scope_pending ON memory_notes (scope, seq) WHERE settled_at IS NULL;
    CREATE TABLE memory_facts (
      id TEXT PRIMARY KEY NOT NULL, scope TEXT NOT NULL DEFAULT '', subject TEXT NOT NULL, predicate TEXT,
      text TEXT NOT NULL, topic TEXT, valid_from INTEGER NOT NULL, valid_to INTEGER, superseded_by TEXT,
      confidence REAL NOT NULL, salience REAL NOT NULL, sources TEXT NOT NULL,
      recalls TEXT NOT NULL DEFAULT '[]', archived_at INTEGER
    );
    CREATE INDEX memory_facts_scope ON memory_facts (scope, id);
    CREATE INDEX memory_facts_scope_subject ON memory_facts (scope, subject, id);
    CREATE INDEX memory_facts_scope_topic ON memory_facts (scope, topic, id);
    CREATE INDEX memory_facts_scope_open ON memory_facts (scope, id) WHERE valid_to IS NULL AND archived_at IS NULL;
    CREATE INDEX memory_facts_superseded ON memory_facts (superseded_by) WHERE superseded_by IS NOT NULL;
    CREATE TABLE memory_procedures (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, scope TEXT NOT NULL DEFAULT '', topic TEXT,
      when_text TEXT NOT NULL, do_text TEXT NOT NULL, evidence TEXT NOT NULL, confirmations INTEGER NOT NULL,
      at INTEGER NOT NULL, retired_at INTEGER
    );
    CREATE INDEX memory_procedures_scope ON memory_procedures (scope, seq);
    CREATE INDEX memory_procedures_scope_topic ON memory_procedures (scope, topic, seq);
    CREATE TABLE memory_core (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT NOT NULL DEFAULT '', text TEXT NOT NULL, at INTEGER NOT NULL
    );
    CREATE INDEX memory_core_scope ON memory_core (scope, seq);
  `;
  const SOURCES = '[{"session":"s","from":1,"upTo":1}]';

  function v2Database(): DatabaseSync {
    const database = new DatabaseSync(':memory:');
    database.exec(V2);
    const insert = database.prepare(
      `INSERT INTO memory_facts (id, scope, subject, text, valid_from, valid_to, confidence, salience, sources, recalls, archived_at)
       VALUES (?, ?, 'user', ?, 1, ?, 0.9, 0.6, '${SOURCES}', ?, ?)`,
    );
    const flooded = JSON.stringify(Array.from({ length: 20_000 }, (_, i) => i));
    insert.run('f-tea', '', '主人喜欢喝乌龙茶，不喝咖啡', null, flooded, null);
    insert.run('f-pg', '', '主人的项目数据库从 MySQL 换成了 PostgreSQL', null, '[3,4]', null);
    insert.run('f-archived', '', '主人以前喝绿茶', null, '[]', 9);
    insert.run('f-closed', '', '主人的项目用 MySQL', 8, '[]', null);
    insert.run('f-alice', 'user:alice', '主人喜欢喝咖啡', null, '[]', null);
    return database;
  }

  test('版本 2 升到当前版本：建倒排索引，已有的事实补进去（各在各的作用域里），过长的 recalls 截到最近的；再打开什么都不改', async () => {
    const database = v2Database();
    const store = createSqliteMemoryStore({ database });
    assert.deepEqual(metaOf(database, 'memory_meta'), { memory_schema: '5' });
    const found = async (
      scope: typeof store | ReturnType<typeof store.scope>,
      query: Parameters<typeof store.facts.search>[0],
    ): Promise<string[]> => ids((await scope.facts.search(query)).map((hit) => hit.fact));

    // 老库里的事实现在搜得到：中文问句以前是 0 命中。
    assert.deepEqual(await found(store, { text: '我平时喜欢喝什么茶？' }), ['f-tea']);
    assert.deepEqual(await found(store, { text: '我们项目现在用的是什么数据库？' }), ['f-pg']);
    assert.deepEqual(await found(store, { text: '绿茶', archived: true }), ['f-archived'], '归档的也进了索引');
    assert.deepEqual(await found(store, { text: 'MySQL', open: false }), ['f-closed', 'f-pg'], '关闭的也进了索引');
    assert.deepEqual(await found(store.scope('user:alice'), { text: '喜欢喝什么' }), ['f-alice'], '作用域没串');
    assert.deepEqual(await found(store, { text: '咖啡' }), ['f-tea']);

    const facts = await store.facts.list();
    assert.deepEqual(ids(facts), ['f-archived', 'f-closed', 'f-pg', 'f-tea'], '事实一条不少');
    assert.ok(
      facts.every((fact) => fact.at === fact.validFrom),
      '没有写入的时刻：补成 validFrom',
    );
    const tea = facts.find((fact) => fact.id === 'f-tea');
    assert.deepEqual(
      tea?.recalls,
      Array.from({ length: MAX_FACT_RECALLS }, (_, i) => 20_000 - MAX_FACT_RECALLS + i),
      '两万个召回时刻截到最近的那些',
    );
    assert.deepEqual(facts.find((fact) => fact.id === 'f-pg')?.recalls, [3, 4], '没超的不动');
    const size = (
      database.prepare(`SELECT length(recalls) AS n FROM memory_facts WHERE id = 'f-tea'`).get() as {
        n: number;
      }
    ).n;
    assert.ok(size < 400, `一行的 recalls 从一百多 KB 降到 ${size} 字节`);

    // 再打开：结构和索引的内容都不变（不重复补）。
    const dump = (): unknown[] => [
      schemaOf(database),
      database.prepare('SELECT * FROM memory_fact_docs ORDER BY doc').all(),
      database.prepare('SELECT * FROM memory_fact_terms ORDER BY scope, term, doc').all(),
    ];
    const before = dump();
    assert.equal((before[1] as unknown[]).length, 5, '五条事实各一行');
    createSqliteMemoryStore({ database });
    assert.deepEqual(dump(), before);

    // 迁移之后新写的照常进索引。
    const added = await store.facts.add(newFact('主人下个月要去东京出差'));
    assert.deepEqual(await found(store, { text: '下个月出差是去哪里' }), [added.id]);
  });

  test('版本 2 的库在应用的事务里升级，回滚后索引的表和补进去的词都不在', () => {
    const database = v2Database();
    const before = schemaOf(database);
    database.exec('BEGIN');
    createSqliteMemoryStore({ database });
    assert.notDeepEqual(schemaOf(database), before);
    database.exec('ROLLBACK');
    assert.deepEqual(schemaOf(database), before);
    assert.deepEqual(metaOf(database, 'memory_meta'), { memory_schema: '2' });
    const row = database.prepare(`SELECT json_array_length(recalls) AS n FROM memory_facts WHERE id = 'f-tea'`).get();
    assert.equal((row as { n: number }).n, 20_000, 'recalls 也没截');
  });

  test('版本 3 的库少了索引的表（被手工删掉）：重建并把事实补回去', async () => {
    const database = new DatabaseSync(':memory:');
    const store = createSqliteMemoryStore({ database });
    const tea = await store.facts.add(newFact('主人喜欢喝乌龙茶'));
    database.exec('DROP TABLE memory_fact_terms; DROP TABLE memory_fact_docs;');
    const reopened = createSqliteMemoryStore({ database });
    assert.deepEqual(ids((await reopened.facts.search({ text: '乌龙茶' })).map((hit) => hit.fact)), [tea.id]);
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
    raw.exec(`UPDATE memory_meta SET value = '6' WHERE key = 'memory_schema'`);
    raw.exec('DROP INDEX memory_facts_scope_open');
    const before = schemaOf(raw);
    raw.close();
    assert.throws(() => createSqliteMemoryStore({ path }), /memory schema in this database is version 6, newer than/);
    const check = new DatabaseSync(path);
    assert.deepEqual(schemaOf(check), before, '没有补索引');
    assert.deepEqual(metaOf(check, 'memory_meta'), { memory_schema: '6' });
    check.close();
  });

  test('版本 3 升到当前版本：笔记加失败的列，同一段的重复笔记只留最早的一条；事实加幂等键；再打开什么都不改', async () => {
    const database = new DatabaseSync(':memory:');
    const store = createSqliteMemoryStore({ database });
    const fact = await store.facts.add(newFact('主人喜欢喝乌龙茶'));
    // 退回版本 3 的结构：没有新列和新索引，待处理的部分索引是旧的那个。
    database.exec(`
      DROP INDEX memory_notes_scope_range; DROP INDEX memory_notes_scope_waiting; DROP INDEX memory_facts_scope_key;
      ALTER TABLE memory_notes DROP COLUMN attempts; ALTER TABLE memory_notes DROP COLUMN error;
      ALTER TABLE memory_notes DROP COLUMN failed_at; ALTER TABLE memory_facts DROP COLUMN fact_key;
      CREATE INDEX memory_notes_scope_pending ON memory_notes (scope, seq) WHERE settled_at IS NULL;
      UPDATE memory_meta SET value = '3' WHERE key = 'memory_schema';
    `);
    const insert = database.prepare(
      `INSERT INTO memory_notes (id, scope, session, from_seq, up_to, at, salience) VALUES (?, ?, 's', ?, ?, ?, 0.8)`,
    );
    insert.run('n-first', '', 1, 3, 10);
    insert.run('n-again', '', 1, 3, 11);
    insert.run('n-other', '', 4, 6, 12);
    insert.run('n-alice', 'user:alice', 1, 3, 13);

    const upgraded = createSqliteMemoryStore({ database });
    assert.deepEqual(metaOf(database, 'memory_meta'), { memory_schema: '5' });
    assert.deepEqual(ids(await upgraded.notes.list()), ['n-first', 'n-other'], '重复的那条删了，只留最早的');
    assert.deepEqual(ids(await upgraded.scope('user:alice').notes.list()), ['n-alice'], '别的作用域的不算重复');
    assert.deepEqual(ids(await upgraded.notes.list({ pending: true })), ['n-first', 'n-other']);
    const indexes = schemaOf(database).filter((line) => line.includes('INDEX'));
    assert.ok(!indexes.some((line) => line.includes('memory_notes_scope_pending')), '旧的部分索引删掉了');
    assert.deepEqual(
      (await upgraded.facts.list()).map((found) => found.id),
      [fact.id],
    );
    const keyed = await upgraded.facts.add({ ...newFact('主人住在杭州'), key: 'k1' });
    assert.equal((await upgraded.facts.add({ ...newFact('别的'), key: 'k1' })).id, keyed.id);

    const before = schemaOf(database);
    createSqliteMemoryStore({ database });
    assert.deepEqual(schemaOf(database), before);
  });

  test('版本 4 升到 5：事实加写入的时刻，已有的补成 validFrom，新写的按给的记；再打开什么都不改', async () => {
    const database = new DatabaseSync(':memory:');
    const store = createSqliteMemoryStore({ database });
    const old = await store.facts.add(newFact('主人喜欢喝乌龙茶', { validFrom: 7 }));
    // 退回版本 4 的结构：事实没有 `at`。
    database.exec(`
      ALTER TABLE memory_facts DROP COLUMN at;
      UPDATE memory_meta SET value = '4' WHERE key = 'memory_schema';
    `);

    const upgraded = createSqliteMemoryStore({ database });
    assert.deepEqual(metaOf(database, 'memory_meta'), { memory_schema: '5' });
    assert.deepEqual(await upgraded.facts.list(), [{ ...old, at: 7 }], '不知道什么时候写的：当成立的时候就记下了');
    const added = await upgraded.facts.add(newFact('主人住在杭州', { validFrom: 3, at: 20 }));
    assert.equal(added.at, 20);
    assert.equal((await upgraded.facts.supersede(added.id, newFact('主人住在上海', { at: 30 }), 30)).at, 30);

    const before = schemaOf(database);
    createSqliteMemoryStore({ database });
    assert.deepEqual(schemaOf(database), before);
    assert.deepEqual(Object.fromEntries((await upgraded.facts.list()).map((fact) => [fact.text, fact.at])), {
      主人喜欢喝乌龙茶: 7,
      主人住在杭州: 20,
      主人住在上海: 30,
    });
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
    // 四个进程合起来正好 `MAX_FACT_RECALLS` 次 touch：丢一次，数就对不上。
    const rounds = MAX_FACT_RECALLS / 4;
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
