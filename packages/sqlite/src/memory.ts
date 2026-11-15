import type { DatabaseSync, SQLInputValue } from 'node:sqlite';

import {
  checkEvidence,
  checkMemoryScope,
  checkSourceRef,
  CtxError,
  DEFAULT_MEMORY_SCOPE,
  MAX_FACT_RECALLS,
  MAX_SEARCH_TERMS,
  sameSourceRef,
  searchTerms,
  termOverlap,
  type CoreVersion,
  type FactHit,
  type MemoryFact,
  type MemoryStore,
  type Note,
  type Procedure,
  type SourceRef,
} from '@modelctx-ai/ctx-protocol';

import { hasTable, inspect, openDatabase, readSchemaVersion, withWriteLock, writeSchemaVersion } from './shared.ts';

export interface SqliteMemoryStoreOptions {
  /** 数据库文件；也可以是 `:memory:`。和 `database` 二选一。 */
  readonly path?: string;
  /** 复用应用已经打开的库（可以就是 `createSqliteStore` 用的那个）。这种情况下 `close()` 不关它，也不改它的 `journal_mode`。 */
  readonly database?: DatabaseSync;
  /** 别的连接占着写锁时，写入最多等多久（毫秒）。和 `SqliteStoreOptions.busyTimeoutMs` 一样。 */
  readonly busyTimeoutMs?: number;
  /** 表名前缀，缺省 `memory_`。 */
  readonly prefix?: string;
  /** 笔记、事实、程序的 `id` 生成函数，缺省 `crypto.randomUUID()`。 */
  readonly id?: () => string;
}

export interface SqliteMemoryStore extends MemoryStore {
  readonly database: DatabaseSync;
  close(): void;
}

/**
 * 记忆的结构版本，存在 `${prefix}meta` 的 `memory_schema` 里（键和会话存储的 `schema` 不同，同一个前缀也不冲突）。
 * 1：`notes`、`facts`、`procedures`、`core` 四张表和它们的索引。
 * 2：四张表各加一列 `scope`（作用域，已有的行都在缺省的作用域 `''` 里），索引换成以 `scope` 开头的。
 * 3：加 `fact_docs`、`fact_terms` 两张表，是事实文字的倒排索引（`search` 用）；已有的事实补进索引，
 *    `recalls` 超过 `MAX_FACT_RECALLS` 个的截到最近的那些。
 * 同一级的结构可能是之前的提交建的，所以版本号对得上时也要查实际的表、列和索引（见 `memoryRepairs`）。
 */
const MEMORY_SCHEMA_VERSION = 3;
const MEMORY_SCHEMA_KEY = 'memory_schema';

/** 仍然成立且没归档（`isOpenFact`）。`list({ open: true })`、`search` 和部分索引 `facts_open` 用同一段文字。 */
const OPEN_FACT = 'valid_to IS NULL AND archived_at IS NULL';
/** 同一个条件，列名带上 `search` 里事实表的别名 `f`。 */
const OPEN_FACT_F = 'f.valid_to IS NULL AND f.archived_at IS NULL';

/** 老库的表补上 `scope` 列：已有的行都算缺省的作用域。 */
const SCOPE_COLUMN = `scope TEXT NOT NULL DEFAULT ''`;

interface MemoryTable {
  readonly table: string;
  readonly create: string;
  readonly indexes: Record<string, string>;
  /** 版本 1 建的、现在不用的索引：迁移时删掉。 */
  readonly obsolete: readonly string[];
}

/** 每张表的建表语句和索引。只加不改：结构要变就升版本。 */
function memoryTables(prefix: string): MemoryTable[] {
  const notes = `${prefix}notes`;
  const facts = `${prefix}facts`;
  const procedures = `${prefix}procedures`;
  const core = `${prefix}core`;
  const docs = `${prefix}fact_docs`;
  const terms = `${prefix}fact_terms`;
  return [
    {
      table: notes,
      // `seq` 是写入顺序；`from`、`when`、`do` 是关键字，列名换成 `from_seq`、`up_to`、`when_text`、`do_text`。
      create: `CREATE TABLE ${notes} (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        ${SCOPE_COLUMN},
        session TEXT NOT NULL,
        from_seq INTEGER NOT NULL,
        up_to INTEGER NOT NULL,
        at INTEGER NOT NULL,
        salience REAL NOT NULL,
        kind TEXT,
        topic TEXT,
        settled_at INTEGER
      )`,
      indexes: {
        // `head`：max(up_to) 只读索引的一端。
        [`${notes}_scope_head`]: `CREATE INDEX ${notes}_scope_head ON ${notes} (scope, session, up_to)`,
        // `list`：一个作用域里按写入顺序；`pending: true` 走部分索引。
        [`${notes}_scope`]: `CREATE INDEX ${notes}_scope ON ${notes} (scope, seq)`,
        [`${notes}_scope_pending`]: `CREATE INDEX ${notes}_scope_pending ON ${notes} (scope, seq) WHERE settled_at IS NULL`,
      },
      obsolete: [`${notes}_head`, `${notes}_pending`],
    },
    {
      table: facts,
      // `id` 是主键：`list` 按 `id` 排、翻页走它的索引（BINARY 比较 UTF-8 字节，和码点序一致）。
      // `sources`、`recalls` 是 JSON 数组。
      create: `CREATE TABLE ${facts} (
        id TEXT PRIMARY KEY NOT NULL,
        ${SCOPE_COLUMN},
        subject TEXT NOT NULL,
        predicate TEXT,
        text TEXT NOT NULL,
        topic TEXT,
        valid_from INTEGER NOT NULL,
        valid_to INTEGER,
        superseded_by TEXT,
        confidence REAL NOT NULL,
        salience REAL NOT NULL,
        sources TEXT NOT NULL,
        recalls TEXT NOT NULL DEFAULT '[]',
        archived_at INTEGER
      )`,
      indexes: {
        [`${facts}_scope`]: `CREATE INDEX ${facts}_scope ON ${facts} (scope, id)`,
        [`${facts}_scope_subject`]: `CREATE INDEX ${facts}_scope_subject ON ${facts} (scope, subject, id)`,
        [`${facts}_scope_topic`]: `CREATE INDEX ${facts}_scope_topic ON ${facts} (scope, topic, id)`,
        // `open: true` 的条件必须和这里一字不差，规划器才认部分索引。
        [`${facts}_scope_open`]: `CREATE INDEX ${facts}_scope_open ON ${facts} (scope, id) WHERE ${OPEN_FACT}`,
        // `forget` 清掉指向被删事实的 `superseded_by`。
        [`${facts}_superseded`]: `CREATE INDEX ${facts}_superseded ON ${facts} (superseded_by) WHERE superseded_by IS NOT NULL`,
      },
      obsolete: [`${facts}_subject`, `${facts}_topic`, `${facts}_open`],
    },
    {
      table: procedures,
      create: `CREATE TABLE ${procedures} (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        ${SCOPE_COLUMN},
        topic TEXT,
        when_text TEXT NOT NULL,
        do_text TEXT NOT NULL,
        evidence TEXT NOT NULL,
        confirmations INTEGER NOT NULL,
        at INTEGER NOT NULL,
        retired_at INTEGER
      )`,
      indexes: {
        [`${procedures}_scope`]: `CREATE INDEX ${procedures}_scope ON ${procedures} (scope, seq)`,
        [`${procedures}_scope_topic`]: `CREATE INDEX ${procedures}_scope_topic ON ${procedures} (scope, topic, seq)`,
      },
      obsolete: [`${procedures}_topic`],
    },
    {
      table: core,
      // 每次 `set` 一行，`seq` 是写入顺序，一个作用域里最后一行就是它当前的版本。
      create: `CREATE TABLE ${core} (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        ${SCOPE_COLUMN},
        text TEXT NOT NULL,
        at INTEGER NOT NULL
      )`,
      indexes: {
        [`${core}_scope`]: `CREATE INDEX ${core}_scope ON ${core} (scope, seq)`,
      },
      obsolete: [],
    },
    {
      table: docs,
      // 进了索引的事实，一条一行。`doc` 是给倒排表用的短编号：事实的 `id` 是 UUID，每个词都带着它太占地方；
      // `terms` 是这条事实切出了多少个不同的词，打分时用。`fact_id` 的 UNIQUE 自带索引，`forget` 按它找。
      create: `CREATE TABLE ${docs} (
        doc INTEGER PRIMARY KEY,
        ${SCOPE_COLUMN},
        fact_id TEXT NOT NULL UNIQUE,
        terms INTEGER NOT NULL
      )`,
      indexes: {},
      obsolete: [],
    },
    {
      table: terms,
      // 倒排表：哪个作用域的哪个词出现在哪条事实里。主键以 `scope` 开头，一次查找只碰自己作用域的词。
      create: `CREATE TABLE ${terms} (
        ${SCOPE_COLUMN},
        term TEXT NOT NULL,
        doc INTEGER NOT NULL,
        PRIMARY KEY (scope, term, doc)
      ) WITHOUT ROWID`,
      indexes: {},
      obsolete: [],
    },
  ];
}

/**
 * 当前结构缺的表、列和索引，以及多出来的旧索引，每一项是一条语句；空表示完整。只补缺的，重复执行没有副作用。
 * 版本 1 的表没有 `scope` 列：补上（已有的行落在缺省的作用域里），再把索引换成以 `scope` 开头的。
 */
function memoryRepairs(database: DatabaseSync, prefix: string): string[] {
  const sql: string[] = [];
  for (const { table, create, indexes, obsolete } of memoryTables(prefix)) {
    const exists = hasTable(database, table);
    if (!exists) sql.push(create);
    const { columns, indexes: existing } = inspect(database, table);
    if (exists && !columns.has('scope')) sql.push(`ALTER TABLE ${table} ADD COLUMN ${SCOPE_COLUMN}`);
    for (const [name, statement] of Object.entries(indexes)) if (!existing.has(name)) sql.push(statement);
    for (const name of obsolete) if (existing.has(name)) sql.push(`DROP INDEX ${name}`);
  }
  return sql;
}

/** 比自己新的结构版本不认识，写进去可能写坏，拒绝打开。 */
function checkMemoryVersion(version: number | undefined): void {
  if (version !== undefined && version > MEMORY_SCHEMA_VERSION) {
    throw new Error(
      `The ctx memory schema in this database is version ${version}, newer than the version ${MEMORY_SCHEMA_VERSION} this ctx-sqlite supports. Upgrade @modelctx-ai/ctx-sqlite.`,
    );
  }
}

/**
 * 返回「一条事实进索引」的函数：`fact_docs` 一行，切出的每个词在 `fact_terms` 一行。两条语句只备一次；
 * 要在两张表都建好之后调。
 */
function factIndexer(database: DatabaseSync, prefix: string): (scope: string, factId: string, text: string) => void {
  const insertDoc = database.prepare(`INSERT INTO ${prefix}fact_docs (scope, fact_id, terms) VALUES (?, ?, ?)`);
  const insertTerm = database.prepare(`INSERT INTO ${prefix}fact_terms (scope, term, doc) VALUES (?, ?, ?)`);
  return (scope, factId, text) => {
    const terms = searchTerms(text);
    const { lastInsertRowid } = insertDoc.run(scope, factId, terms.length);
    for (const term of terms) insertTerm.run(scope, term, lastInsertRowid);
  };
}

/**
 * 版本 3 的数据迁移：还没进索引的事实补进去，过长的 `recalls` 截到最近 `MAX_FACT_RECALLS` 个。
 * 只动缺的和超长的，重复执行没有副作用。
 */
function backfillMemory(database: DatabaseSync, prefix: string): void {
  const facts = `${prefix}facts`;
  const missing = database
    .prepare(
      `SELECT id, scope, text FROM ${facts} AS f WHERE NOT EXISTS (SELECT 1 FROM ${prefix}fact_docs AS d WHERE d.fact_id = f.id)`,
    )
    .all() as { id: string; scope: string; text: string }[];
  const indexFact = factIndexer(database, prefix);
  for (const row of missing) indexFact(row.scope, row.id, row.text);
  const long = database
    .prepare(`SELECT id, recalls FROM ${facts} WHERE json_array_length(recalls) > ?`)
    .all(MAX_FACT_RECALLS) as { id: string; recalls: string }[];
  const trim = database.prepare(`UPDATE ${facts} SET recalls = ? WHERE id = ?`);
  for (const row of long)
    trim.run(JSON.stringify((JSON.parse(row.recalls) as number[]).slice(-MAX_FACT_RECALLS)), row.id);
}

/** 和会话存储的 `migrate` 同一个模式：先不加锁看一眼，结构完整就不写；否则在写锁里重读版本、补齐、记版本。 */
function migrateMemory(database: DatabaseSync, prefix: string): void {
  const read = (): number | undefined => readSchemaVersion(database, prefix, MEMORY_SCHEMA_KEY, 'ctx memory');
  const complete = (version: number | undefined): boolean =>
    version === MEMORY_SCHEMA_VERSION && memoryRepairs(database, prefix).length === 0;
  const seen = read();
  checkMemoryVersion(seen);
  if (complete(seen)) return;

  withWriteLock(database, `${prefix}memory_migrate`, () => {
    database.exec(`CREATE TABLE IF NOT EXISTS ${prefix}meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    const version = read();
    checkMemoryVersion(version);
    if (complete(version)) return;
    for (const statement of memoryRepairs(database, prefix)) database.exec(statement);
    backfillMemory(database, prefix);
    writeSchemaVersion(database, prefix, MEMORY_SCHEMA_KEY, MEMORY_SCHEMA_VERSION);
  });
}

interface NoteRow {
  id: string;
  session: string;
  from_seq: number;
  up_to: number;
  at: number;
  salience: number;
  kind: string | null;
  topic: string | null;
  settled_at: number | null;
}

interface FactRow {
  id: string;
  subject: string;
  predicate: string | null;
  text: string;
  topic: string | null;
  valid_from: number;
  valid_to: number | null;
  superseded_by: string | null;
  confidence: number;
  salience: number;
  sources: string;
  recalls: string;
  archived_at: number | null;
}

interface ProcedureRow {
  id: string;
  topic: string | null;
  when_text: string;
  do_text: string;
  evidence: string;
  confirmations: number;
  at: number;
  retired_at: number | null;
}

/** 可选字段：列是 NULL 时不出现，JSON 往返不多出 `undefined` 或 `null`。 */
function optional<K extends string, V>(key: K, value: V | null): { [P in K]?: V } {
  return (value === null ? {} : { [key]: value }) as { [P in K]?: V };
}

function decodeNote(row: NoteRow): Note {
  return {
    id: row.id,
    session: row.session,
    from: row.from_seq,
    upTo: row.up_to,
    at: row.at,
    salience: row.salience,
    ...optional('kind', row.kind),
    ...optional('topic', row.topic),
    ...optional('settledAt', row.settled_at),
  };
}

function decodeFact(row: FactRow): MemoryFact {
  return {
    id: row.id,
    subject: row.subject,
    ...optional('predicate', row.predicate),
    text: row.text,
    ...optional('topic', row.topic),
    validFrom: row.valid_from,
    ...optional('validTo', row.valid_to),
    ...optional('supersededBy', row.superseded_by),
    confidence: row.confidence,
    salience: row.salience,
    sources: JSON.parse(row.sources) as SourceRef[],
    recalls: JSON.parse(row.recalls) as number[],
    ...optional('archivedAt', row.archived_at),
  };
}

function decodeProcedure(row: ProcedureRow): Procedure {
  return {
    id: row.id,
    ...optional('topic', row.topic),
    when: row.when_text,
    do: row.do_text,
    evidence: JSON.parse(row.evidence) as SourceRef[],
    confirmations: row.confirmations,
    at: row.at,
    ...optional('retiredAt', row.retired_at),
  };
}

/** 证据只存三个字段，调用方多带的键不进库。 */
function encodeRefs(refs: readonly SourceRef[]): string {
  return JSON.stringify(refs.map(({ session, from, upTo }) => ({ session, from, upTo })));
}

/** 追加没有的区间；返回 `undefined` 表示一段新的都没有。 */
function appendRefs(existing: readonly SourceRef[], refs: readonly SourceRef[]): SourceRef[] | undefined {
  const out = [...existing];
  for (const ref of refs) if (!out.some((other) => sameSourceRef(other, ref))) out.push(ref);
  return out.length === existing.length ? undefined : out;
}

/** `limit`、`k`、`last` 的取整：不给是不限，小数向下取整，NaN 和非正数是 0。 */
function countOf(n: number | undefined): number {
  if (n === undefined) return Infinity;
  return n > 0 ? Math.floor(n) : 0;
}

function notFound(id: string): CtxError {
  return new CtxError('not_found', `No memory item "${id}".`);
}

/**
 * `search` 的语句。参数依次是：查询的词（JSON 数组）、作用域、作用域、`where` 里的参数、查询的词数、`LIMIT`。
 * 每个词在倒排表里查一次（主键 `scope, term, doc`），按事实数命中了几个词；只有命中的事实才去读事实表，
 * `where` 是加在事实表（别名 `f`）上的条件。CROSS JOIN 固定连接顺序（词 → 倒排表 → 事实）：库里没有统计信息，
 * 规划器自己排会先扫整个作用域。排序就是 `termOverlap`：`hits / min(查询的词数, 事实的词数)`；
 * 相同时命中多的在前，再相同按 `id`，结果稳定。测试用它看查询计划，不从包里导出。
 */
export function factSearchSql(prefix: string, where: readonly string[]): string {
  return `SELECT f.*, c.hits AS hits, d.terms AS terms
    FROM (
      SELECT t.doc AS doc, count(*) AS hits
      FROM json_each(?) AS q
      CROSS JOIN ${prefix}fact_terms AS t ON t.scope = ? AND t.term = q.value
      GROUP BY t.doc
    ) AS c
    CROSS JOIN ${prefix}fact_docs AS d ON d.doc = c.doc
    CROSS JOIN ${prefix}facts AS f ON f.id = d.fact_id AND f.scope = ?
    ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY c.hits * 1.0 / min(?, d.terms) DESC, c.hits DESC, f.id
    LIMIT ?`;
}

/** `search` 读出来的一行：事实的各列，加上命中了查询里几个词（`hits`）和这条事实一共有几个词（`terms`）。 */
interface HitRow extends FactRow {
  hits: number;
  terms: number;
}

/**
 * 基于 `node:sqlite` 的记忆存储：`notes`、`facts`、`procedures`、`core` 四张表加 `meta`，表名带前缀（缺省 `memory_`），
 * 可以和 `createSqliteStore` 的 `ctx_` 表放在同一个库里。每个写方法在一个 `BEGIN IMMEDIATE` 里做完（库上已有应用的事务时用
 * SAVEPOINT），单个方法是原子的；跨方法的组合（先 `add` 新事实再 `close` 旧的）由调用方负责。
 * `search` 走倒排索引：事实写入时用协议包的 `searchTerms` 切成词（字母数字连成的词、中日韩文字相邻两字）存进
 * `fact_terms`，查询切成同样的词去查，按 `termOverlap` 打分，和内存存储同一套。不用 FTS5：它不是每个 Node 自带的
 * SQLite 都编进去了，自带的分词器也切不了中文。
 */
export function createSqliteMemoryStore(options: SqliteMemoryStoreOptions): SqliteMemoryStore {
  const prefix = options.prefix ?? 'memory_';
  const { database, owned } = openDatabase(options, prefix, 'createSqliteMemoryStore', (opened) =>
    migrateMemory(opened, prefix),
  );
  const id = options.id ?? (() => crypto.randomUUID());
  const notes = `${prefix}notes`;
  const facts = `${prefix}facts`;
  const procedures = `${prefix}procedures`;
  const core = `${prefix}core`;
  const docs = `${prefix}fact_docs`;
  const terms = `${prefix}fact_terms`;
  const write = <T>(work: () => T): T => withWriteLock(database, `${prefix}memory_write`, work);

  // 每条语句都带 `scope`：按 `id` 找的也带，别的作用域的 `id` 和不存在的一样。
  const insertNote = database.prepare(
    `INSERT INTO ${notes} (id, scope, session, from_seq, up_to, at, salience, kind, topic, settled_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const selectNote = database.prepare(`SELECT * FROM ${notes} WHERE id = ? AND scope = ?`);
  const settleNote = database.prepare(
    `UPDATE ${notes} SET settled_at = ? WHERE id = ? AND scope = ? AND settled_at IS NULL`,
  );
  const insertFact = database.prepare(
    `INSERT INTO ${facts} (id, scope, subject, predicate, text, topic, valid_from, confidence, salience, sources) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const selectFact = database.prepare(`SELECT * FROM ${facts} WHERE id = ? AND scope = ?`);
  const insertProcedure = database.prepare(
    `INSERT INTO ${procedures} (id, scope, topic, when_text, do_text, evidence, confirmations, at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
  );
  const selectProcedure = database.prepare(`SELECT * FROM ${procedures} WHERE id = ? AND scope = ?`);
  const indexFact = factIndexer(database, prefix);

  const views = new Map<string, MemoryStore>();
  const scopeOf = (scope: string): MemoryStore => {
    checkMemoryScope(scope);
    let view = views.get(scope);
    if (!view) {
      view = createView(scope);
      views.set(scope, view);
    }
    return view;
  };

  /** 一个作用域的视图：和别的作用域共用连接、写锁和语句，只是每次都带上自己的名字。 */
  function createView(scope: string): MemoryStore {
    const factOf = (factId: string): MemoryFact => {
      const row = selectFact.get(factId, scope) as FactRow | undefined;
      if (!row) throw notFound(factId);
      return decodeFact(row);
    };
    const procedureOf = (procedureId: string): Procedure => {
      const row = selectProcedure.get(procedureId, scope) as ProcedureRow | undefined;
      if (!row) throw notFound(procedureId);
      return decodeProcedure(row);
    };

    return {
      scope: scopeOf,
      notes: {
        async add(drafts) {
          for (const draft of drafts) checkSourceRef(draft);
          return write(() =>
            drafts.map((draft) => {
              const noteId = id();
              insertNote.run(
                noteId,
                scope,
                draft.session,
                draft.from,
                draft.upTo,
                draft.at,
                draft.salience,
                draft.kind ?? null,
                draft.topic ?? null,
                draft.settledAt ?? null,
              );
              return decodeNote(selectNote.get(noteId, scope) as unknown as NoteRow);
            }),
          );
        },
        async list(query) {
          const where: string[] = ['scope = ?'];
          const params: SQLInputValue[] = [scope];
          if (query?.session !== undefined) {
            where.push('session = ?');
            params.push(query.session);
          }
          if (query?.pending !== undefined) where.push(query.pending ? 'settled_at IS NULL' : 'settled_at IS NOT NULL');
          const limit = countOf(query?.limit);
          if (limit === 0) return [];
          let sql = `SELECT * FROM ${notes} WHERE ${where.join(' AND ')} ORDER BY seq`;
          if (Number.isFinite(limit)) {
            sql += ' LIMIT ?';
            params.push(limit);
          }
          return (database.prepare(sql).all(...params) as unknown as NoteRow[]).map(decodeNote);
        },
        async settle(ids, at) {
          return write(() => {
            let count = 0;
            for (const noteId of ids) count += Number(settleNote.run(at, noteId, scope).changes);
            return count;
          });
        },
        async head(session) {
          const row = database
            .prepare(`SELECT coalesce(max(up_to), 0) AS head FROM ${notes} WHERE scope = ? AND session = ?`)
            .get(scope, session) as { head: number };
          return row.head;
        },
      },
      facts: {
        async add(draft) {
          checkEvidence(draft.sources);
          return write(() => {
            const factId = id();
            insertFact.run(
              factId,
              scope,
              draft.subject,
              draft.predicate ?? null,
              draft.text,
              draft.topic ?? null,
              draft.validFrom,
              draft.confidence,
              draft.salience,
              encodeRefs(draft.sources),
            );
            indexFact(scope, factId, draft.text);
            return factOf(factId);
          });
        },
        async close(factId, at, closeOptions) {
          write(() => {
            const found = factOf(factId);
            const supersededBy = closeOptions?.supersededBy;
            if (supersededBy !== undefined) factOf(supersededBy);
            if (found.validTo !== undefined) return;
            database
              .prepare(`UPDATE ${facts} SET valid_to = ?, superseded_by = ? WHERE id = ? AND scope = ?`)
              .run(at, supersededBy ?? null, factId, scope);
          });
        },
        async cite(factId, sources) {
          checkEvidence(sources);
          return write(() => {
            const found = factOf(factId);
            const merged = appendRefs(found.sources, sources);
            if (!merged) return found;
            database
              .prepare(`UPDATE ${facts} SET sources = ? WHERE id = ? AND scope = ?`)
              .run(encodeRefs(merged), factId, scope);
            return { ...found, sources: merged };
          });
        },
        async touch(ids, at) {
          const read = database.prepare(`SELECT recalls FROM ${facts} WHERE id = ? AND scope = ?`);
          const save = database.prepare(`UPDATE ${facts} SET recalls = ? WHERE id = ? AND scope = ?`);
          write(() => {
            for (const factId of ids) {
              const row = read.get(factId, scope) as { recalls: string } | undefined;
              if (!row) continue;
              // 只留最近的 `MAX_FACT_RECALLS` 个：一行不随召回次数无限变长。
              const recalls = [...(JSON.parse(row.recalls) as number[]), at].slice(-MAX_FACT_RECALLS);
              save.run(JSON.stringify(recalls), factId, scope);
            }
          });
        },
        async archive(ids, at) {
          const archive = database.prepare(
            `UPDATE ${facts} SET archived_at = ? WHERE id = ? AND scope = ? AND archived_at IS NULL`,
          );
          return write(() => {
            let count = 0;
            for (const factId of new Set(ids)) count += Number(archive.run(at, factId, scope).changes);
            return count;
          });
        },
        async restore(ids) {
          const restore = database.prepare(
            `UPDATE ${facts} SET archived_at = NULL WHERE id = ? AND scope = ? AND archived_at IS NOT NULL`,
          );
          return write(() => {
            let count = 0;
            for (const factId of new Set(ids)) count += Number(restore.run(factId, scope).changes);
            return count;
          });
        },
        async forget(ids) {
          const remove = database.prepare(`DELETE FROM ${facts} WHERE id = ? AND scope = ?`);
          const unlink = database.prepare(`UPDATE ${facts} SET superseded_by = NULL WHERE superseded_by = ?`);
          const findDoc = database.prepare(`SELECT doc FROM ${docs} WHERE fact_id = ? AND scope = ?`);
          const removeDoc = database.prepare(`DELETE FROM ${docs} WHERE doc = ?`);
          const removeTerm = database.prepare(`DELETE FROM ${terms} WHERE scope = ? AND term = ? AND doc = ?`);
          return write(() => {
            let count = 0;
            for (const factId of new Set(ids)) {
              const row = selectFact.get(factId, scope) as FactRow | undefined;
              if (!row) continue;
              // 索引跟着删：词是从文字切出来的，文字不改，所以再切一遍就是当初写进去的那些。
              const indexed = findDoc.get(factId, scope) as { doc: number } | undefined;
              if (indexed) {
                for (const term of searchTerms(row.text)) removeTerm.run(scope, term, indexed.doc);
                removeDoc.run(indexed.doc);
              }
              const removed = Number(remove.run(factId, scope).changes);
              if (removed > 0) unlink.run(factId);
              count += removed;
            }
            return count;
          });
        },
        async list(query) {
          const where: string[] = ['scope = ?'];
          const params: SQLInputValue[] = [scope];
          if (query?.subject !== undefined) {
            where.push('subject = ?');
            params.push(query.subject);
          }
          if (query?.topic !== undefined) {
            where.push('topic = ?');
            params.push(query.topic);
          }
          if (query?.open === true) where.push(OPEN_FACT);
          if (query?.after !== undefined) {
            where.push('id > ?');
            params.push(query.after);
          }
          const limit = countOf(query?.limit);
          if (limit === 0) return [];
          let sql = `SELECT * FROM ${facts} WHERE ${where.join(' AND ')} ORDER BY id`;
          if (Number.isFinite(limit)) {
            sql += ' LIMIT ?';
            params.push(limit);
          }
          return (database.prepare(sql).all(...params) as unknown as FactRow[]).map(decodeFact);
        },
        async search(query) {
          if (typeof query?.text !== 'string') throw new CtxError('invalid_request', 'Search text must be a string.');
          const k = countOf(query.k ?? 10);
          if (k === 0) return [];
          // 查询切成和索引里一样的词，去重、最多 `MAX_SEARCH_TERMS` 个，整个数组当一个参数传进去（`json_each`）：
          // 语句的形状不随词数变，再长的查询也不会撑破表达式树。
          const wanted = searchTerms(query.text, MAX_SEARCH_TERMS);
          if (wanted.length === 0) return [];
          const where: string[] = [];
          const params: SQLInputValue[] = [JSON.stringify(wanted), scope, scope];
          if (query.topic !== undefined) {
            where.push('f.topic = ?');
            params.push(query.topic);
          }
          if (query.open !== false) where.push(query.archived === true ? 'f.valid_to IS NULL' : OPEN_FACT_F);
          params.push(wanted.length, Number.isFinite(k) ? k : -1);
          const rows = database.prepare(factSearchSql(prefix, where)).all(...params) as unknown as HitRow[];
          return rows.map((row): FactHit => ({
            fact: decodeFact(row),
            score: termOverlap(row.hits, wanted.length, row.terms),
          }));
        },
      },
      procedures: {
        async add(draft) {
          checkEvidence(draft.evidence);
          return write(() => {
            const procedureId = id();
            insertProcedure.run(
              procedureId,
              scope,
              draft.topic ?? null,
              draft.when,
              draft.do,
              encodeRefs(draft.evidence),
              draft.at,
            );
            return procedureOf(procedureId);
          });
        },
        async confirm(procedureId, evidence) {
          checkEvidence(evidence);
          return write(() => {
            const found = procedureOf(procedureId);
            const merged = appendRefs(found.evidence, evidence);
            if (!merged) return found;
            database
              .prepare(
                `UPDATE ${procedures} SET evidence = ?, confirmations = confirmations + 1 WHERE id = ? AND scope = ?`,
              )
              .run(encodeRefs(merged), procedureId, scope);
            return procedureOf(procedureId);
          });
        },
        async retire(procedureId, at) {
          write(() => {
            procedureOf(procedureId);
            database
              .prepare(`UPDATE ${procedures} SET retired_at = ? WHERE id = ? AND scope = ? AND retired_at IS NULL`)
              .run(at, procedureId, scope);
          });
        },
        async list(query) {
          const where: string[] = ['scope = ?'];
          const params: SQLInputValue[] = [scope];
          if (query?.topic !== undefined) {
            where.push('topic = ?');
            params.push(query.topic);
          }
          if (query?.active === true) where.push('retired_at IS NULL');
          const sql = `SELECT * FROM ${procedures} WHERE ${where.join(' AND ')} ORDER BY seq`;
          return (database.prepare(sql).all(...params) as unknown as ProcedureRow[]).map(decodeProcedure);
        },
      },
      core: {
        async get() {
          const row = database
            .prepare(`SELECT text, at FROM ${core} WHERE scope = ? ORDER BY seq DESC LIMIT 1`)
            .get(scope) as CoreVersion | undefined;
          return row ? { text: row.text, at: row.at } : null;
        },
        async set(text, at) {
          write(() => {
            database.prepare(`INSERT INTO ${core} (scope, text, at) VALUES (?, ?, ?)`).run(scope, text, at);
          });
        },
        async history(historyOptions) {
          const last = countOf(historyOptions?.last);
          if (last === 0) return [];
          const sql = Number.isFinite(last)
            ? `SELECT text, at FROM (SELECT seq, text, at FROM ${core} WHERE scope = ? ORDER BY seq DESC LIMIT ?) ORDER BY seq`
            : `SELECT text, at FROM ${core} WHERE scope = ? ORDER BY seq`;
          const rows = database
            .prepare(sql)
            .all(...(Number.isFinite(last) ? [scope, last] : [scope])) as unknown as CoreVersion[];
          return rows.map((row) => ({ text: row.text, at: row.at }));
        },
      },
    };
  }

  return {
    ...scopeOf(DEFAULT_MEMORY_SCOPE),
    database,
    close() {
      if (owned) database.close();
    },
  };
}
