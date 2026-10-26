import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

import type {
  Entry,
  JsonObject,
  JsonValue,
  ListOptions,
  MessageEntry,
  NewEntry,
  SessionStore,
  SessionsOptions,
  WatchOptions,
} from '@modelctx-ai/ctx-protocol';

type ModelMessage = MessageEntry['message'];

export interface SqliteStoreOptions {
  /** 数据库文件；也可以是 `:memory:`。和 `database` 二选一。 */
  readonly path?: string;
  /** 复用应用已经打开的库（例如应用自己的 yoyo.db）。这种情况下 `close()` 不关它，也不改它的 `journal_mode`。 */
  readonly database?: DatabaseSync;
  /**
   * 别的连接占着写锁时，写入最多等多久（毫秒，`PRAGMA busy_timeout`）。自己开库时缺省 5000；
   * 传 `database` 时缺省不动应用设的值，只有显式传了才设。
   */
  readonly busyTimeoutMs?: number;
  /** 表名前缀，缺省 `ctx_`，和应用自己的表分开。 */
  readonly prefix?: string;
  readonly now?: () => number;
  readonly id?: () => string;
  /** `watch` 轮询新条目的间隔（毫秒），缺省 250。 */
  readonly pollIntervalMs?: number;
}

export interface SqliteSessionStore extends SessionStore {
  readonly database: DatabaseSync;
  watch(session: string, options?: WatchOptions): AsyncIterable<Entry>;
  close(): void;
}

/** @deprecated 改名为 `SqliteSessionStore`，下一个 minor 删掉。 */
export type SqliteContextStore = SqliteSessionStore;

interface Row {
  seq: number | bigint;
  id: string;
  session: string;
  at: number | bigint;
  type: string;
  key: string | null;
  source: string | null;
  body: string;
  meta: string | null;
}

interface Body {
  message?: ModelMessage;
  kind?: string;
  text?: string;
  data?: JsonValue;
  /** 0.2 及以前写的是 `{ at, seq }`，读的时候取 `seq`。 */
  covers?: number | { seq: number };
}

/**
 * 结构版本，存在 `${prefix}meta` 的 `schema` 里。
 * 1：0.1 和 0.2 都写这个值，但 0.1 的列叫 `thread`，0.2 叫 `session`，所以升到 2 时要看实际的列。
 * 2：列叫 `session`。
 * 3：位置只用 `seq`，索引是 `(session, seq)`，不再有 `(session, at, seq)`；生成列 `kind` 和索引 `(session, kind, seq)`。
 *    同一级的结构分阶段补全，所以版本号等于 3 时也要查实际的列和索引（见 `repairs`）。
 */
const SCHEMA_VERSION = 3;

/** 自己开库时 `busy_timeout` 的缺省值（毫秒）。 */
const DEFAULT_BUSY_TIMEOUT_MS = 5000;

/** 编码标记用的键，正常数据里不会出现。 */
const TAG = '\u0000ctx';

function base64(view: ArrayBufferView | ArrayBuffer): string {
  const bytes = view instanceof ArrayBuffer ? new Uint8Array(view) : view;
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
}

/**
 * JSON 存不了二进制和 URL，先把它们换成带 `TAG` 的对象再序列化。必须在 `JSON.stringify` 之前做：
 * 它会先调 `toJSON`，Buffer 和 URL 到了 replacer 里已经变了样。
 */
function encode(value: unknown, parents: Set<object> = new Set()): unknown {
  if (value instanceof URL) return { [TAG]: 'url', href: value.href };
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return { [TAG]: 'bytes', base64: base64(value) };
  if (value === null || typeof value !== 'object' || typeof (value as { toJSON?: unknown }).toJSON === 'function') {
    return value;
  }
  if (parents.has(value)) throw new TypeError('Cannot store a circular structure.');
  parents.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => encode(item, parents));
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = encode(item, parents);
    return out;
  } finally {
    parents.delete(value);
  }
}

/** 只认恰好是编码结果的对象；别的对象（包括 `{ $url }`、`{ $bytes }` 这种）原样返回。 */
function reviver(_key: string, value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const tagged = value as Record<string, unknown>;
  const keys = Object.keys(tagged);
  if (keys.length !== 2 || !keys.includes(TAG)) return value;
  if (tagged[TAG] === 'bytes' && typeof tagged['base64'] === 'string') {
    return new Uint8Array(Buffer.from(tagged['base64'], 'base64'));
  }
  if (tagged[TAG] === 'url' && typeof tagged['href'] === 'string' && URL.canParse(tagged['href'])) {
    return new URL(tagged['href']);
  }
  return value;
}

/** 等一会儿；`signal` 中止时提前醒。 */
function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

function bodyOf(entry: NewEntry): Body {
  if (entry.type === 'message') return { message: entry.message };
  if (entry.type === 'event') return { kind: entry.kind, text: entry.text, data: entry.data };
  return { text: entry.text, covers: entry.covers };
}

/** 旧行的 `covers` 是 `{ at, seq }`，位置现在只看 `seq`。 */
function coversOf(covers: number | { seq: number }): number {
  return typeof covers === 'number' ? covers : covers.seq;
}

function decode(row: Row): Entry {
  const base = {
    id: row.id,
    session: row.session,
    seq: Number(row.seq),
    at: Number(row.at),
    ...(row.key !== null ? { key: row.key } : {}),
    ...(row.source !== null ? { source: row.source } : {}),
    ...(row.meta !== null ? { meta: JSON.parse(row.meta) as JsonObject } : {}),
  };
  const body = JSON.parse(row.body, reviver) as Body;
  if (row.type === 'message') return { ...base, type: 'message', message: body.message! };
  if (row.type === 'summary') return { ...base, type: 'summary', text: body.text!, covers: coversOf(body.covers!) };
  return {
    ...base,
    type: 'event',
    kind: body.kind!,
    ...(body.text !== undefined ? { text: body.text } : {}),
    ...(body.data !== undefined ? { data: body.data } : {}),
  };
}

/**
 * 以 `prefix` 开头的名字的上界（不含）：最后一个码点加 1。SQLite 按 UTF-8 字节比较，和码点序一致。
 * 最后一个码点已经是最大值时往前进一位；空串或全是最大码点时没有上界，返回 `undefined`。
 */
function prefixEnd(prefix: string): string | undefined {
  const points = Array.from(prefix);
  while (points.length > 0) {
    const last = points.pop()!.codePointAt(0)!;
    if (last < 0x10ffff) return points.join('') + String.fromCodePoint(last === 0xd7ff ? 0xe000 : last + 1);
  }
  return undefined;
}

function hasTable(database: DatabaseSync, name: string): boolean {
  return database.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name) !== undefined;
}

/** 读 `${prefix}meta` 里的结构版本；没有 meta 表或没有这一行时返回 `undefined`。 */
function readSchemaVersion(database: DatabaseSync, prefix: string): number | undefined {
  if (!hasTable(database, `${prefix}meta`)) return undefined;
  const row = database.prepare(`SELECT value FROM ${prefix}meta WHERE key = 'schema'`).get() as
    | { value: string }
    | undefined;
  if (!row) return undefined;
  const version = Number(row.value);
  if (!Number.isInteger(version) || version < 1) throw new Error(`Unrecognized ctx schema version "${row.value}".`);
  return version;
}

/**
 * 拿到写锁再做 `work`。库上没有事务时用 `BEGIN IMMEDIATE`：一开始就要写锁，会等 `busy_timeout`，
 * 不会像先读后升级的延迟事务那样直接 `SQLITE_BUSY`。库上已经有应用的事务时只能用 SAVEPOINT，锁归应用管。
 */
function withWriteLock(database: DatabaseSync, prefix: string, work: () => void): void {
  const savepoint = database.isTransaction;
  database.exec(savepoint ? `SAVEPOINT ${prefix}migrate` : 'BEGIN IMMEDIATE');
  try {
    work();
  } catch (error) {
    database.exec(savepoint ? `ROLLBACK TO ${prefix}migrate` : 'ROLLBACK');
    if (savepoint) database.exec(`RELEASE ${prefix}migrate`);
    throw error;
  }
  database.exec(savepoint ? `RELEASE ${prefix}migrate` : 'COMMIT');
}

/** 表上实际有的列和索引。`table_info` 不列生成列，`table_xinfo` 才列。 */
function inspect(database: DatabaseSync, table: string): { columns: Set<string>; indexes: Set<string> } {
  const columns = (database.prepare(`PRAGMA table_xinfo(${table})`).all() as { name: string }[]).map((c) => c.name);
  const indexes = (
    database.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ?`).all(table) as {
      name: string;
    }[]
  ).map((i) => i.name);
  return { columns: new Set(columns), indexes: new Set(indexes) };
}

/**
 * 当前结构缺的东西，每一项是一条语句；空表示完整。迁移的每一步都先查实际的列和索引再补，
 * 所以半截的库、别的版本建出来的同一级库（schema 版本号相同、结构不全）都能补齐，重复执行也没有副作用。
 */
function repairs(database: DatabaseSync, table: string): string[] {
  const { columns, indexes } = inspect(database, table);
  const sql: string[] = [];
  // 旧的 `(session, at, seq)` 索引：位置只看 `seq` 以后不再需要。
  if (indexes.has(`${table}_order`)) sql.push(`DROP INDEX ${table}_order`);
  if (!indexes.has(`${table}_key`)) {
    sql.push(`CREATE UNIQUE INDEX ${table}_key ON ${table} (session, key) WHERE key IS NOT NULL`);
  }
  if (!indexes.has(`${table}_seq`)) sql.push(`CREATE INDEX ${table}_seq ON ${table} (session, seq)`);
  // 事件的 `kind` 是 body 顶层的字段，用 VIRTUAL 生成列取出来，`list({ kinds })` 靠 (session, kind, seq) 索引。
  // 不占行空间，不用回填，旧版本写的行也自动有 `kind`；SQLite 只允许 ADD COLUMN 加 VIRTUAL 的生成列。
  if (!columns.has('kind')) {
    sql.push(`ALTER TABLE ${table} ADD COLUMN kind TEXT GENERATED ALWAYS AS (json_extract(body, '$.kind')) VIRTUAL`);
  }
  if (!indexes.has(`${table}_kind`)) sql.push(`CREATE INDEX ${table}_kind ON ${table} (session, kind, seq)`);
  return sql;
}

/** 表不在就建，再补上缺的列和索引。 */
function createSchema(database: DatabaseSync, prefix: string): void {
  const table = `${prefix}entries`;
  database.exec(`
    CREATE TABLE IF NOT EXISTS ${table} (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      session TEXT NOT NULL,
      at INTEGER NOT NULL,
      type TEXT NOT NULL,
      key TEXT,
      source TEXT,
      body TEXT NOT NULL,
      meta TEXT
    )
  `);
  for (const statement of repairs(database, table)) database.exec(statement);
}

/** 比自己新的结构版本不认识，写进去可能写坏，拒绝打开。 */
function check(version: number | undefined): void {
  if (version !== undefined && version > SCHEMA_VERSION) {
    throw new Error(
      `The ctx schema in this database is version ${version}, newer than the version ${SCHEMA_VERSION} this ctx-sqlite supports. Upgrade @modelctx-ai/ctx-sqlite.`,
    );
  }
}

/**
 * 把库带到 `SCHEMA_VERSION`：没有表就建；旧版本按序升级；比自己新的版本拒绝打开（旧代码不知道新结构，写进去可能写坏）。
 * 升级在写锁里做，进程同时打开同一个旧库时只有一个真的在迁，别的拿到锁后重读版本发现已经是新的。
 * 版本号相同不等于结构完整：同一级的结构可能是之前的提交建的，所以每次打开都查一遍实际的列和索引，缺的在锁里补。
 */
function migrate(database: DatabaseSync, prefix: string): void {
  const table = `${prefix}entries`;
  const complete = (version: number | undefined): boolean =>
    version === SCHEMA_VERSION && hasTable(database, table) && repairs(database, table).length === 0;
  const seen = readSchemaVersion(database, prefix);
  check(seen);
  if (complete(seen)) return;

  withWriteLock(database, prefix, () => {
    database.exec(`CREATE TABLE IF NOT EXISTS ${prefix}meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    let version = readSchemaVersion(database, prefix);
    check(version);
    if (complete(version)) return;
    // 没有版本记录但有数据表：只可能是更早的写法，按 1 处理。
    version ??= hasTable(database, table) ? 1 : 0;
    if (version < 2) {
      // 0.1 的列叫 `thread`；0.2 改成 `session` 时没升版本，所以 1 里两种库都有，要看实际的列。
      // yoyo 之前自己改过名的库也是 `session`，这里跳过。RENAME COLUMN 会把索引定义一起改掉。
      const columns = inspect(database, table).columns;
      if (columns.has('thread') && !columns.has('session')) {
        database.exec(`ALTER TABLE ${table} RENAME COLUMN thread TO session`);
      }
    }
    // 3：`(session, at, seq)` 索引换成 `(session, seq)`。`seq` 是主键，行的顺序本来就是它，`createSchema` 换索引。
    createSchema(database, prefix);
    database
      .prepare(
        `INSERT INTO ${prefix}meta (key, value) VALUES ('schema', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      )
      .run(String(SCHEMA_VERSION));
  });
}

/**
 * 基于 `node:sqlite` 的存储。所有条目在一张表里，按会话和写入序号 `seq` 建索引，事件另按 `kind` 建索引。
 * 写入用 SAVEPOINT，所以和应用共用一个库、处在应用自己的事务里也能用。
 * 消息里的二进制（Uint8Array、Buffer、ArrayBuffer、其他 TypedArray）读回来都是 Uint8Array，URL 读回来还是 URL。
 */
export function createSqliteStore(options: SqliteStoreOptions): SqliteSessionStore {
  const prefix = options.prefix ?? 'ctx_';
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(prefix)) throw new Error(`Invalid table prefix "${prefix}".`);
  if (!options.database && !options.path) throw new Error('Pass `path` or `database` to createSqliteStore().');
  const owned = !options.database;
  const database = options.database ?? new DatabaseSync(options.path!);
  const now = options.now ?? Date.now;
  const id = options.id ?? (() => crypto.randomUUID());
  const table = `${prefix}entries`;

  try {
    if (options.busyTimeoutMs !== undefined || owned) {
      const timeout = options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
      if (!Number.isInteger(timeout) || timeout < 0) throw new Error(`Invalid busyTimeoutMs ${timeout}.`);
      database.exec(`PRAGMA busy_timeout = ${timeout}`);
    }
    if (owned) database.exec('PRAGMA journal_mode = WAL');
    migrate(database, prefix);
  } catch (error) {
    if (owned) database.close();
    throw error;
  }

  const insert = database.prepare(
    // ON CONFLICT DO NOTHING 只跳过唯一约束冲突；NOT NULL 之类的违例照常报错。INSERT OR IGNORE 会把它们一起吞掉。
    `INSERT INTO ${table} (id, session, at, type, key, source, body, meta) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
  );
  const removeSession = database.prepare(`DELETE FROM ${table} WHERE session = ?`);
  const pollInterval = options.pollIntervalMs ?? 250;

  function run<T>(work: () => T): T {
    database.exec(`SAVEPOINT ${prefix}write`);
    try {
      const result = work();
      database.exec(`RELEASE ${prefix}write`);
      return result;
    } catch (error) {
      database.exec(`ROLLBACK TO ${prefix}write`);
      database.exec(`RELEASE ${prefix}write`);
      throw error;
    }
  }

  const store: SqliteSessionStore = {
    database,
    async append(session, drafts) {
      return run(() => {
        const written: Entry[] = [];
        for (const draft of drafts) {
          const entryId = draft.id ?? id();
          const at = draft.at ?? now();
          const result = insert.run(
            entryId,
            session,
            at,
            draft.type,
            draft.key ?? null,
            draft.source ?? null,
            JSON.stringify(encode(bodyOf(draft))),
            draft.meta !== undefined ? JSON.stringify(draft.meta) : null,
          );
          if (result.changes === 0) continue;
          written.push({ ...draft, id: entryId, session, at, seq: Number(result.lastInsertRowid) });
        }
        return written;
      });
    },
    async list(session, listOptions: ListOptions = {}) {
      const where = ['session = ?'];
      const params: SQLInputValue[] = [session];
      if (listOptions.after !== undefined) {
        where.push('seq > ?');
        params.push(listOptions.after);
      }
      if (listOptions.types) {
        if (listOptions.types.length === 0) return [];
        where.push(`type IN (${listOptions.types.map(() => '?').join(', ')})`);
        params.push(...listOptions.types);
      }
      if (listOptions.kinds) {
        if (listOptions.kinds.length === 0) return [];
        // 只有事件有 kind（生成列取 body 顶层的 `kind`，消息和摘要的 body 里没有）；和 types 取交集靠两个条件同时成立。
        where.push(`type = 'event' AND kind IN (${listOptions.kinds.map(() => '?').join(', ')})`);
        params.push(...listOptions.kinds);
      }
      let sql = `SELECT * FROM ${table} WHERE ${where.join(' AND ')}`;
      if (listOptions.last !== undefined) {
        // 和内存存储一样：小数向下取整，不是有限正数时返回空。
        const last = Number.isFinite(listOptions.last) ? Math.floor(listOptions.last) : 0;
        if (last <= 0) return [];
        sql = `SELECT * FROM (${sql} ORDER BY seq DESC LIMIT ?) ORDER BY seq`;
        params.push(last);
      } else {
        sql += ' ORDER BY seq';
      }
      const rows = database.prepare(sql).all(...params) as unknown as Row[];
      return rows.map(decode);
    },
    async clear(session) {
      return Number(removeSession.run(session).changes);
    },
    async sessions(sessionsOptions: SessionsOptions = {}) {
      const where: string[] = [];
      const params: SQLInputValue[] = [];
      // 前缀用范围查询，不用 LIKE：`%`、`_` 不用转义，也能用上 (session, seq) 索引。
      if (sessionsOptions.prefix) {
        where.push('session >= ?');
        params.push(sessionsOptions.prefix);
        const end = prefixEnd(sessionsOptions.prefix);
        if (end !== undefined) {
          where.push('session < ?');
          params.push(end);
        }
      }
      if (sessionsOptions.after !== undefined) {
        where.push('session > ?');
        params.push(sessionsOptions.after);
      }
      let sql = `SELECT DISTINCT session FROM ${table}${where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY session`;
      if (sessionsOptions.limit !== undefined) {
        // 和 `filterSessions` 一样：小数向下取整，不是正数时返回空。
        const limit = Number.isNaN(sessionsOptions.limit) ? 0 : Math.floor(sessionsOptions.limit);
        if (limit <= 0) return [];
        if (Number.isFinite(limit)) {
          sql += ' LIMIT ?';
          params.push(limit);
        }
      }
      const rows = database.prepare(sql).all(...params) as { session: string }[];
      return rows.map((row) => row.session);
    },
    /** 轮询 `list(after)`：别的进程写进同一个库的条目也能看到。 */
    async *watch(session: string, watchOptions: WatchOptions = {}) {
      const { signal } = watchOptions;
      let after = watchOptions.after;
      for (;;) {
        if (signal?.aborted) return;
        const fresh = await store.list(session, after ? { after } : {});
        for (const entry of fresh) {
          if (signal?.aborted) return;
          yield entry;
          after = entry.seq;
        }
        if (fresh.length === 0) await sleep(pollInterval, signal);
      }
    },
    close() {
      if (owned) database.close();
    },
  };
  return store;
}
