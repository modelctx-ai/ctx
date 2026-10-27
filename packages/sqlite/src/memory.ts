import type { DatabaseSync, SQLInputValue } from 'node:sqlite';

import {
  checkEvidence,
  checkSourceRef,
  CtxError,
  sameSourceRef,
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
 * 1：`notes`、`facts`、`procedures`、`core` 四张表和它们的索引。同一级的结构可能是之前的提交建的，所以版本号等于 1 时
 * 也要查实际的表和索引（见 `memoryRepairs`）。
 */
const MEMORY_SCHEMA_VERSION = 1;
const MEMORY_SCHEMA_KEY = 'memory_schema';

/** 仍然成立且没归档（`isOpenFact`）。`list({ open: true })`、`search` 和部分索引 `facts_open` 用同一段文字。 */
const OPEN_FACT = 'valid_to IS NULL AND archived_at IS NULL';

/** 每张表的建表语句和索引。只加不改：结构要变就升版本。 */
function memoryTables(prefix: string): { table: string; create: string; indexes: Record<string, string> }[] {
  const notes = `${prefix}notes`;
  const facts = `${prefix}facts`;
  const procedures = `${prefix}procedures`;
  const core = `${prefix}core`;
  return [
    {
      table: notes,
      // `seq` 是写入顺序；`from`、`when`、`do` 是关键字，列名换成 `from_seq`、`up_to`、`when_text`、`do_text`。
      create: `CREATE TABLE ${notes} (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
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
        [`${notes}_head`]: `CREATE INDEX ${notes}_head ON ${notes} (session, up_to)`,
        // `list({ pending: true })`：待处理的按写入顺序。
        [`${notes}_pending`]: `CREATE INDEX ${notes}_pending ON ${notes} (seq) WHERE settled_at IS NULL`,
      },
    },
    {
      table: facts,
      // `id` 是主键：`list` 按 `id` 排、翻页走它的索引（BINARY 比较 UTF-8 字节，和码点序一致）。
      // `sources`、`recalls` 是 JSON 数组。
      create: `CREATE TABLE ${facts} (
        id TEXT PRIMARY KEY NOT NULL,
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
        [`${facts}_subject`]: `CREATE INDEX ${facts}_subject ON ${facts} (subject, id)`,
        [`${facts}_topic`]: `CREATE INDEX ${facts}_topic ON ${facts} (topic, id)`,
        // `open: true` 的条件必须和这里一字不差，规划器才认部分索引。
        [`${facts}_open`]: `CREATE INDEX ${facts}_open ON ${facts} (id) WHERE ${OPEN_FACT}`,
        // `forget` 清掉指向被删事实的 `superseded_by`。
        [`${facts}_superseded`]: `CREATE INDEX ${facts}_superseded ON ${facts} (superseded_by) WHERE superseded_by IS NOT NULL`,
      },
    },
    {
      table: procedures,
      create: `CREATE TABLE ${procedures} (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        topic TEXT,
        when_text TEXT NOT NULL,
        do_text TEXT NOT NULL,
        evidence TEXT NOT NULL,
        confirmations INTEGER NOT NULL,
        at INTEGER NOT NULL,
        retired_at INTEGER
      )`,
      indexes: {
        [`${procedures}_topic`]: `CREATE INDEX ${procedures}_topic ON ${procedures} (topic, seq)`,
      },
    },
    {
      table: core,
      // 每次 `set` 一行，`seq` 是写入顺序，最后一行就是当前版本。
      create: `CREATE TABLE ${core} (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        text TEXT NOT NULL,
        at INTEGER NOT NULL
      )`,
      indexes: {},
    },
  ];
}

/** 当前结构缺的表和索引，每一项是一条语句；空表示完整。只补缺的，重复执行没有副作用。 */
function memoryRepairs(database: DatabaseSync, prefix: string): string[] {
  const sql: string[] = [];
  for (const { table, create, indexes } of memoryTables(prefix)) {
    if (!hasTable(database, table)) sql.push(create);
    const existing = inspect(database, table).indexes;
    for (const [name, statement] of Object.entries(indexes)) if (!existing.has(name)) sql.push(statement);
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

/** 只折叠 ASCII 大小写，和 SQLite 的 `lower()` 一致：SQL 里筛的和这里打分的是同一个判断。 */
function foldAscii(text: string): string {
  return text.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

function length(text: string): number {
  return Array.from(text).length;
}

/**
 * 命中的打分，0..1。整个查询是文字的子串（不分 ASCII 大小写）时在 [0.5, 1]：`0.5 + 0.5 × 查询长度 / 文字长度`，
 * 查询覆盖得越多越高；否则按空白切出的词里命中的那些的长度占比，在 (0, 0.5)。长度按码点数。
 */
function scoreOf(text: string, query: string, terms: readonly string[]): number {
  const folded = foldAscii(text);
  if (folded.includes(query)) return 0.5 + (0.5 * length(query)) / Math.max(1, length(text));
  let hit = 0;
  let total = 0;
  for (const term of terms) {
    total += length(term);
    if (folded.includes(term)) hit += length(term);
  }
  return total > 0 ? (0.5 * hit) / total : 0;
}

/**
 * 基于 `node:sqlite` 的记忆存储：`notes`、`facts`、`procedures`、`core` 四张表加 `meta`，表名带前缀（缺省 `memory_`），
 * 可以和 `createSqliteStore` 的 `ctx_` 表放在同一个库里。每个写方法在一个 `BEGIN IMMEDIATE` 里做完（库上已有应用的事务时用
 * SAVEPOINT），单个方法是原子的；跨方法的组合（先 `add` 新事实再 `close` 旧的）由调用方负责。
 * `search` 是子串匹配（`instr`），不用 FTS5：Node 22 自带的 SQLite 没有编译 FTS5。
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
  const write = <T>(work: () => T): T => withWriteLock(database, `${prefix}memory_write`, work);

  const insertNote = database.prepare(
    `INSERT INTO ${notes} (id, session, from_seq, up_to, at, salience, kind, topic, settled_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const selectNote = database.prepare(`SELECT * FROM ${notes} WHERE id = ?`);
  const settleNote = database.prepare(`UPDATE ${notes} SET settled_at = ? WHERE id = ? AND settled_at IS NULL`);
  const insertFact = database.prepare(
    `INSERT INTO ${facts} (id, subject, predicate, text, topic, valid_from, confidence, salience, sources) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const selectFact = database.prepare(`SELECT * FROM ${facts} WHERE id = ?`);
  const insertProcedure = database.prepare(
    `INSERT INTO ${procedures} (id, topic, when_text, do_text, evidence, confirmations, at) VALUES (?, ?, ?, ?, ?, 1, ?)`,
  );
  const selectProcedure = database.prepare(`SELECT * FROM ${procedures} WHERE id = ?`);

  const factOf = (factId: string): MemoryFact => {
    const row = selectFact.get(factId) as FactRow | undefined;
    if (!row) throw notFound(factId);
    return decodeFact(row);
  };
  const procedureOf = (procedureId: string): Procedure => {
    const row = selectProcedure.get(procedureId) as ProcedureRow | undefined;
    if (!row) throw notFound(procedureId);
    return decodeProcedure(row);
  };

  return {
    database,
    notes: {
      async add(drafts) {
        for (const draft of drafts) checkSourceRef(draft);
        return write(() =>
          drafts.map((draft) => {
            const noteId = id();
            insertNote.run(
              noteId,
              draft.session,
              draft.from,
              draft.upTo,
              draft.at,
              draft.salience,
              draft.kind ?? null,
              draft.topic ?? null,
              draft.settledAt ?? null,
            );
            return decodeNote(selectNote.get(noteId) as unknown as NoteRow);
          }),
        );
      },
      async list(query) {
        const where: string[] = [];
        const params: SQLInputValue[] = [];
        if (query?.session !== undefined) {
          where.push('session = ?');
          params.push(query.session);
        }
        if (query?.pending !== undefined) where.push(query.pending ? 'settled_at IS NULL' : 'settled_at IS NOT NULL');
        const limit = countOf(query?.limit);
        if (limit === 0) return [];
        let sql = `SELECT * FROM ${notes}${where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY seq`;
        if (Number.isFinite(limit)) {
          sql += ' LIMIT ?';
          params.push(limit);
        }
        return (database.prepare(sql).all(...params) as unknown as NoteRow[]).map(decodeNote);
      },
      async settle(ids, at) {
        return write(() => {
          let count = 0;
          for (const noteId of ids) count += Number(settleNote.run(at, noteId).changes);
          return count;
        });
      },
      async head(session) {
        const row = database
          .prepare(`SELECT coalesce(max(up_to), 0) AS head FROM ${notes} WHERE session = ?`)
          .get(session) as { head: number };
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
            draft.subject,
            draft.predicate ?? null,
            draft.text,
            draft.topic ?? null,
            draft.validFrom,
            draft.confidence,
            draft.salience,
            encodeRefs(draft.sources),
          );
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
            .prepare(`UPDATE ${facts} SET valid_to = ?, superseded_by = ? WHERE id = ?`)
            .run(at, supersededBy ?? null, factId);
        });
      },
      async cite(factId, sources) {
        checkEvidence(sources);
        return write(() => {
          const found = factOf(factId);
          const merged = appendRefs(found.sources, sources);
          if (!merged) return found;
          database.prepare(`UPDATE ${facts} SET sources = ? WHERE id = ?`).run(encodeRefs(merged), factId);
          return { ...found, sources: merged };
        });
      },
      async touch(ids, at) {
        const touch = database.prepare(`UPDATE ${facts} SET recalls = json_insert(recalls, '$[#]', ?) WHERE id = ?`);
        write(() => {
          for (const factId of ids) touch.run(at, factId);
        });
      },
      async archive(ids, at) {
        const archive = database.prepare(`UPDATE ${facts} SET archived_at = ? WHERE id = ? AND archived_at IS NULL`);
        return write(() => {
          let count = 0;
          for (const factId of new Set(ids)) count += Number(archive.run(at, factId).changes);
          return count;
        });
      },
      async forget(ids) {
        const remove = database.prepare(`DELETE FROM ${facts} WHERE id = ?`);
        const unlink = database.prepare(`UPDATE ${facts} SET superseded_by = NULL WHERE superseded_by = ?`);
        return write(() => {
          let count = 0;
          for (const factId of new Set(ids)) {
            const removed = Number(remove.run(factId).changes);
            if (removed > 0) unlink.run(factId);
            count += removed;
          }
          return count;
        });
      },
      async list(query) {
        const where: string[] = [];
        const params: SQLInputValue[] = [];
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
        let sql = `SELECT * FROM ${facts}${where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY id`;
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
        const text = foldAscii(query.text);
        const terms = text.split(/\s+/).filter((term) => term.length > 0);
        // 整个查询或任何一个词是子串就是候选；分数在 JS 里算（见 `scoreOf`），所以候选全取出来再排。
        const needles = [...new Set([text, ...terms])];
        const where = [`(${needles.map(() => 'instr(lower(text), ?) > 0').join(' OR ')})`];
        const params: SQLInputValue[] = [...needles];
        if (query.topic !== undefined) {
          where.push('topic = ?');
          params.push(query.topic);
        }
        if (query.open !== false) where.push(OPEN_FACT);
        const rows = database
          .prepare(`SELECT * FROM ${facts} WHERE ${where.join(' AND ')} ORDER BY id`)
          .all(...params) as unknown as FactRow[];
        const hits: FactHit[] = rows.map((row) => ({ fact: decodeFact(row), score: scoreOf(row.text, text, terms) }));
        // 分数相同时保持 `id` 序，结果稳定。
        return hits.toSorted((a, b) => b.score - a.score).slice(0, k);
      },
    },
    procedures: {
      async add(draft) {
        checkEvidence(draft.evidence);
        return write(() => {
          const procedureId = id();
          insertProcedure.run(
            procedureId,
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
            .prepare(`UPDATE ${procedures} SET evidence = ?, confirmations = confirmations + 1 WHERE id = ?`)
            .run(encodeRefs(merged), procedureId);
          return procedureOf(procedureId);
        });
      },
      async retire(procedureId, at) {
        write(() => {
          procedureOf(procedureId);
          database
            .prepare(`UPDATE ${procedures} SET retired_at = ? WHERE id = ? AND retired_at IS NULL`)
            .run(at, procedureId);
        });
      },
      async list(query) {
        const where: string[] = [];
        const params: SQLInputValue[] = [];
        if (query?.topic !== undefined) {
          where.push('topic = ?');
          params.push(query.topic);
        }
        if (query?.active === true) where.push('retired_at IS NULL');
        const sql = `SELECT * FROM ${procedures}${where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY seq`;
        return (database.prepare(sql).all(...params) as unknown as ProcedureRow[]).map(decodeProcedure);
      },
    },
    core: {
      async get() {
        const row = database.prepare(`SELECT text, at FROM ${core} ORDER BY seq DESC LIMIT 1`).get() as
          | CoreVersion
          | undefined;
        return row ? { text: row.text, at: row.at } : null;
      },
      async set(text, at) {
        write(() => {
          database.prepare(`INSERT INTO ${core} (text, at) VALUES (?, ?)`).run(text, at);
        });
      },
      async history(historyOptions) {
        const last = countOf(historyOptions?.last);
        if (last === 0) return [];
        const sql = Number.isFinite(last)
          ? `SELECT text, at FROM (SELECT seq, text, at FROM ${core} ORDER BY seq DESC LIMIT ?) ORDER BY seq`
          : `SELECT text, at FROM ${core} ORDER BY seq`;
        const rows = database.prepare(sql).all(...(Number.isFinite(last) ? [last] : [])) as unknown as CoreVersion[];
        return rows.map((row) => ({ text: row.text, at: row.at }));
      },
    },
    close() {
      if (owned) database.close();
    },
  };
}
