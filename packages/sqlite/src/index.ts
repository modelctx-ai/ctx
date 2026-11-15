import type { DatabaseSync, SQLInputValue } from 'node:sqlite';

import {
  checkExpectSeq,
  CTX_EVENTS,
  ENTRY_VERSION,
  erasedEntry,
  readEntry,
  redactedEntry,
  type Entry,
  type ErasedData,
  type JsonObject,
  type JsonValue,
  type ListOptions,
  type Message,
  type NewEntry,
  type SessionStore,
  type SessionsOptions,
  type UnreadableMode,
  type WatchOptions,
} from '@modelctx-ai/ctx-protocol';

export { createSqliteMemoryStore, type SqliteMemoryStore, type SqliteMemoryStoreOptions } from './memory.ts';
import { hasTable, inspect, openDatabase, readSchemaVersion, withWriteLock, writeSchemaVersion } from './shared.ts';

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
  /**
   * 读到解不了的一行（`v` 比这个版本认识的高、带不认识的部件、正文不是 JSON）时怎么办。缺省 `throw`；
   * `placeholder` 把那一行读成 `ctx.unreadable` 事件，会话其余部分照常能读。
   */
  readonly unreadable?: UnreadableMode;
  /**
   * 在这条连接上打开 `PRAGMA secure_delete`，缺省 `true`：被删掉、被改掉的内容当场用零覆写，不留在库文件的空闲空间里。
   * 开关是连接上的，不存进库文件，所以每次打开都设；传 `database` 时也设，应用在这条连接上对自己的表的删除同样会覆写。
   * 写入时也要开着：没开的时候页分裂会在页里留下行内容的旧副本，之后再开着删也擦不到，只有 `vacuum()` 清得掉。
   * 传 `false` 不动连接的设置：删除就只是把空间标成可用，内容留到被新数据盖住或 `vacuum()` 为止。
   */
  readonly secureDelete?: boolean;
}

/** `watch` 一次读多少条。 */
const WATCH_PAGE = 500;

/** `remove`、`redact` 一条语句里最多带多少个 `id`（SQLite 对绑定参数的个数有上限）。 */
const ID_CHUNK = 500;

export interface SqliteSessionStore extends SessionStore {
  readonly database: DatabaseSync;
  watch(session: string, options?: WatchOptions): AsyncIterable<Entry>;
  /**
   * `VACUUM` 重写整个库文件，再 `PRAGMA wal_checkpoint(TRUNCATE)` 把 `-wal` 截到空。两个用处：把删除腾出来的空间
   * 还给文件系统（删除本身不会让文件变小，腾出来的页留给以后的写入）；清掉没开 `secure_delete` 时留在文件里的旧内容
   * （升级之前写的、别的连接写的、`secureDelete: false` 时删的）。库是应用传进来的时候，整个库（含应用自己的表）一起重写。
   * 不能在事务里调；要独占库，别的连接正读写时会等 `busy_timeout`，等不到就抛。
   */
  vacuum(): void;
  close(): void;
}

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
  /** 这一行写入时的格式版本；0.2 及以前的行没有，列的缺省值是 0。 */
  v: number | bigint;
}

interface Body {
  message?: Message;
  kind?: string;
  text?: string;
  data?: JsonValue;
  covers?: number;
}

/**
 * 结构版本，存在 `${prefix}meta` 的 `schema` 里。
 * 1：0.1 和 0.2 都写这个值，但 0.1 的列叫 `thread`，0.2 叫 `session`，所以升到 2 时要看实际的列。
 * 2：列叫 `session`。
 * 3：位置只用 `seq`，索引是 `(session, seq)`，不再有 `(session, at, seq)`；生成列 `kind` 和索引 `(session, kind, seq)`。
 *    加列 `v`（条目格式版本，见 `ENTRY_VERSION`）。
 *    同一级的结构分阶段补全，所以版本号等于 3 时也要查实际的列和索引（见 `repairs`）。
 */
const SCHEMA_VERSION = 3;

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

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function bodyOf(entry: NewEntry): Body {
  if (entry.type === 'message') return { message: entry.message };
  if (entry.type === 'event') return { kind: entry.kind, text: entry.text, data: entry.data };
  return { text: entry.text, covers: entry.covers };
}

/**
 * 一行转成条目：行里的字段和 `body` 平铺成一个对象交给 `readEntry`（里面是 `upgradeEntry`），它按 `v` 升到当前格式
 * （0 版的消息是 AI SDK 的 `ModelMessage`，二进制和 URL 带 `\u0000ctx` 标记，摘要的 `covers` 是 `{ at, seq }`）。
 * 存量行不改写，每次读都现升。
 */
function decode(row: Row, mode: UnreadableMode): Entry {
  const head = { id: row.id, session: row.session, seq: Number(row.seq), at: Number(row.at), v: Number(row.v) };
  return readEntry(
    () => ({
      ...head,
      ...(row.key !== null ? { key: row.key } : {}),
      ...(row.source !== null ? { source: row.source } : {}),
      ...(row.meta !== null ? { meta: JSON.parse(row.meta) as JsonObject } : {}),
      type: row.type,
      ...(JSON.parse(row.body) as Body),
    }),
    mode,
    { ...head, type: row.type },
  );
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
  // 格式版本：0.2 及以前的行没有这一列，缺省 0；新写的行带 `ENTRY_VERSION`。读时按它升级，存量行不改写。
  if (!columns.has('v')) sql.push(`ALTER TABLE ${table} ADD COLUMN v INTEGER NOT NULL DEFAULT 0`);
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

  withWriteLock(database, `${prefix}migrate`, () => {
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
    writeSchemaVersion(database, prefix, 'schema', SCHEMA_VERSION);
  });
}

/**
 * 基于 `node:sqlite` 的存储。所有条目在一张表里，按会话和写入序号 `seq` 建索引，事件另按 `kind` 建索引。
 * 每次写入在 `BEGIN IMMEDIATE` 里做（先拿写锁，再检查 `expectSeq`，再写）；库上已有应用的事务时改用 SAVEPOINT，
 * 所以和应用共用一个库、处在应用自己的事务里也能用。
 * 连接上缺省开着 `secure_delete`：删除（`clear`、`truncate`、`remove`）和涂改（`redact`）当场覆写被删的内容；
 * 文件不会因此变小，要空间就调 `vacuum()`。
 */
export function createSqliteStore(options: SqliteStoreOptions): SqliteSessionStore {
  const prefix = options.prefix ?? 'ctx_';
  const { database, owned } = openDatabase(options, prefix, 'createSqliteStore', (opened) => migrate(opened, prefix));
  const now = options.now ?? Date.now;
  const id = options.id ?? (() => crypto.randomUUID());
  const table = `${prefix}entries`;

  const insert = database.prepare(
    // ON CONFLICT DO NOTHING 只跳过唯一约束冲突；NOT NULL 之类的违例照常报错。INSERT OR IGNORE 会把它们一起吞掉。
    `INSERT INTO ${table} (id, session, at, type, key, source, body, meta, v) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
  );
  const removeSession = database.prepare(`DELETE FROM ${table} WHERE session = ?`);
  const pollInterval = options.pollIntervalMs ?? 250;
  const unreadable = options.unreadable ?? 'throw';
  // 连接级的开关，不存进库文件，所以每次打开都设。写入时也要开着（见 `SqliteStoreOptions.secureDelete`）。
  if (options.secureDelete !== false) database.exec('PRAGMA secure_delete = ON');

  /** 删除和涂改在写锁里做；`work` 返回擦除记录的 `data`，真的动了条目才在同一个事务里追加 `ctx.erased`。 */
  function erase(session: string, work: () => ErasedData | undefined): number {
    return withWriteLock(database, `${prefix}write`, () => {
      const erased = work();
      if (!erased) return 0;
      const record = erasedEntry(erased);
      const written = insert.run(
        id(),
        session,
        now(),
        record.type,
        null,
        record.source ?? null,
        JSON.stringify(bodyOf(record)),
        null,
        ENTRY_VERSION,
      );
      // 记录没写进去（`id` 生成器给了一个已有的 `id`）就整个回滚：没有记录，运行中的 harness 和 `watch` 看不见这次擦除。
      if (written.changes === 0)
        throw new Error('Could not record the erasure: the generated entry id already exists.');
      return erased.count;
    });
  }

  const store: SqliteSessionStore = {
    database,
    async append(session, drafts, appendOptions) {
      // 先拿写锁再检查前提：两个进程读后写不会各自读到同一个末尾、再在升级写锁时撞上 SQLITE_BUSY，
      // 后到的那个等锁，拿到锁后读到新的末尾，得到 `conflict`。库上已有应用事务时退回 SAVEPOINT。
      return withWriteLock(database, `${prefix}write`, () => {
        if (appendOptions?.expectSeq !== undefined) {
          const head = database.prepare(`SELECT max(seq) AS head FROM ${table} WHERE session = ?`).get(session);
          checkExpectSeq(Number(head?.['head'] ?? 0), appendOptions);
        }
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
            JSON.stringify(bodyOf(draft)),
            draft.meta !== undefined ? JSON.stringify(draft.meta) : null,
            ENTRY_VERSION,
          );
          if (result.changes === 0) continue;
          written.push({
            ...draft,
            id: entryId,
            session,
            at,
            seq: Number(result.lastInsertRowid),
            v: ENTRY_VERSION,
          });
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
      if (listOptions.limit !== undefined) {
        const limit = Number.isFinite(listOptions.limit) ? Math.floor(listOptions.limit) : 0;
        if (limit <= 0) return [];
        // 有 `last` 时外层已经是子查询的结果，再套一层取最早的几条。
        sql = listOptions.last !== undefined ? `SELECT * FROM (${sql}) ORDER BY seq LIMIT ?` : `${sql} LIMIT ?`;
        params.push(limit);
      }
      const rows = database.prepare(sql).all(...params) as unknown as Row[];
      return rows.map((row) => decode(row, unreadable));
    },
    async clear(session) {
      return Number(removeSession.run(session).changes);
    },
    async truncate(session, upTo) {
      if (!Number.isFinite(upTo)) return 0;
      return erase(session, () => {
        const found = database
          .prepare(`SELECT count(*) AS count, max(seq) AS last FROM ${table} WHERE session = ? AND seq <= ?`)
          .get(session, Math.floor(upTo));
        const count = Number(found?.['count'] ?? 0);
        if (count === 0) return undefined;
        const last = Number(found?.['last']);
        database.prepare(`DELETE FROM ${table} WHERE session = ? AND seq <= ?`).run(session, last);
        return { op: 'truncate', upTo: last, count };
      });
    },
    async remove(session, ids) {
      const wanted = [...new Set(ids)];
      if (wanted.length === 0) return 0;
      return erase(session, () => {
        const seqs: number[] = [];
        // 只按列删，不解析正文：读不了的行也删得掉。
        for (const chunk of chunks(wanted, ID_CHUNK)) {
          const rows = database
            .prepare(
              `DELETE FROM ${table} WHERE session = ? AND id IN (${chunk.map(() => '?').join(', ')}) RETURNING seq`,
            )
            .all(session, ...chunk);
          for (const row of rows) seqs.push(Number(row['seq']));
        }
        if (seqs.length === 0) return undefined;
        return { op: 'remove', seqs: seqs.toSorted((a, b) => a - b), count: seqs.length };
      });
    },
    async redact(session, ids) {
      const wanted = [...new Set(ids)];
      if (wanted.length === 0) return 0;
      return erase(session, () => {
        const seqs: number[] = [];
        const rewrite = database.prepare(`UPDATE ${table} SET type = ?, body = ?, meta = NULL, v = ? WHERE seq = ?`);
        for (const chunk of chunks(wanted, ID_CHUNK)) {
          // 只读列和消息的角色，不整行解码：读不了的行也能涂改。已经是占位的跳过。
          const rows = database
            .prepare(
              `SELECT seq, id, session, at, type, key, source, json_extract(body, '$.message.role') AS role FROM ${table}
               WHERE session = ? AND id IN (${chunk.map(() => '?').join(', ')}) AND NOT (type = 'event' AND kind IS ?)`,
            )
            .all(session, ...chunk, CTX_EVENTS.redacted);
          for (const row of rows) {
            const seq = Number(row['seq']);
            const placeholder = redactedEntry({ ...row, seq, at: Number(row['at']), message: { role: row['role'] } });
            rewrite.run(placeholder.type, JSON.stringify(bodyOf(placeholder)), ENTRY_VERSION, seq);
            seqs.push(seq);
          }
        }
        if (seqs.length === 0) return undefined;
        return { op: 'redact', seqs: seqs.toSorted((a, b) => a - b), count: seqs.length };
      });
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
        // 一页一页读：从头订阅一个很长的会话时，不把整个会话一次读进内存、卡住事件循环。
        const fresh = await store.list(session, { ...(after ? { after } : {}), limit: WATCH_PAGE });
        for (const entry of fresh) {
          if (signal?.aborted) return;
          yield entry;
          after = entry.seq;
        }
        if (fresh.length < WATCH_PAGE) await sleep(pollInterval, signal);
      }
    },
    vacuum() {
      if (database.isTransaction) throw new Error('vacuum() cannot run inside a transaction.');
      database.exec('VACUUM');
      database.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    },
    close() {
      if (owned) database.close();
    },
  };
  return store;
}
