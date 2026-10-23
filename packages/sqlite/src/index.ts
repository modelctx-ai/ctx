import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

import type {
  ContextEntry,
  ContextStore,
  Cursor,
  JsonObject,
  JsonValue,
  ListOptions,
  ModelMessage,
  NewEntry,
} from '@modelctx-ai/ctx';

export interface SqliteStoreOptions {
  /** 数据库文件；也可以是 `:memory:`。和 `database` 二选一。 */
  readonly path?: string;
  /** 复用应用已经打开的库（例如应用自己的 yoyo.db）。这种情况下 `close()` 不关它。 */
  readonly database?: DatabaseSync;
  /** 表名前缀，缺省 `ctx_`，和应用自己的表分开。 */
  readonly prefix?: string;
  readonly now?: () => number;
  readonly id?: () => string;
}

export interface SqliteContextStore extends ContextStore {
  readonly database: DatabaseSync;
  close(): void;
}

interface Row {
  seq: number | bigint;
  id: string;
  thread: string;
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
  covers?: Cursor;
}

const SCHEMA_VERSION = '1';

/** JSON 存不了二进制和 URL，存成带标记的对象，读回来再还原。 */
function replacer(_key: string, value: unknown): unknown {
  if (value instanceof Uint8Array) return { $bytes: Buffer.from(value).toString('base64') };
  if (value instanceof URL) return { $url: value.href };
  return value;
}

function reviver(_key: string, value: unknown): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const keys = Object.keys(value);
    if (keys.length === 1 && typeof (value as { $bytes?: unknown }).$bytes === 'string') {
      return new Uint8Array(Buffer.from((value as { $bytes: string }).$bytes, 'base64'));
    }
    if (keys.length === 1 && typeof (value as { $url?: unknown }).$url === 'string') {
      return new URL((value as { $url: string }).$url);
    }
  }
  return value;
}

function bodyOf(entry: NewEntry): Body {
  switch (entry.type) {
    case 'message':
      return { message: entry.message };
    case 'event':
      return { kind: entry.kind, text: entry.text, data: entry.data };
    case 'summary':
      return { text: entry.text, covers: entry.covers };
  }
}

function decode(row: Row): ContextEntry {
  const base = {
    id: row.id,
    thread: row.thread,
    seq: Number(row.seq),
    at: Number(row.at),
    ...(row.key !== null ? { key: row.key } : {}),
    ...(row.source !== null ? { source: row.source } : {}),
    ...(row.meta !== null ? { meta: JSON.parse(row.meta) as JsonObject } : {}),
  };
  const body = JSON.parse(row.body, reviver) as Body;
  if (row.type === 'message') return { ...base, type: 'message', message: body.message! };
  if (row.type === 'summary') return { ...base, type: 'summary', text: body.text!, covers: body.covers! };
  return {
    ...base,
    type: 'event',
    kind: body.kind!,
    ...(body.text !== undefined ? { text: body.text } : {}),
    ...(body.data !== undefined ? { data: body.data } : {}),
  };
}

/**
 * 基于 `node:sqlite` 的存储。所有条目在一张表里，按线程、时间、写入序号建索引。
 * 写入用 SAVEPOINT，所以和应用共用一个库、处在应用自己的事务里也能用。
 */
export function createSqliteStore(options: SqliteStoreOptions): SqliteContextStore {
  const prefix = options.prefix ?? 'ctx_';
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(prefix)) throw new Error(`Invalid table prefix "${prefix}".`);
  if (!options.database && !options.path) throw new Error('Pass `path` or `database` to createSqliteStore().');
  const owned = !options.database;
  const database = options.database ?? new DatabaseSync(options.path!);
  const now = options.now ?? Date.now;
  const id = options.id ?? (() => crypto.randomUUID());
  const table = `${prefix}entries`;

  if (owned) database.exec('PRAGMA journal_mode = WAL');
  database.exec(`
    CREATE TABLE IF NOT EXISTS ${table} (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      thread TEXT NOT NULL,
      at INTEGER NOT NULL,
      type TEXT NOT NULL,
      key TEXT,
      source TEXT,
      body TEXT NOT NULL,
      meta TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS ${table}_key ON ${table} (thread, key) WHERE key IS NOT NULL;
    CREATE INDEX IF NOT EXISTS ${table}_order ON ${table} (thread, at, seq);
    CREATE TABLE IF NOT EXISTS ${prefix}meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT OR IGNORE INTO ${prefix}meta (key, value) VALUES ('schema', '${SCHEMA_VERSION}');
  `);

  const insert = database.prepare(
    `INSERT OR IGNORE INTO ${table} (id, thread, at, type, key, source, body, meta) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const removeThread = database.prepare(`DELETE FROM ${table} WHERE thread = ?`);
  const listThreads = database.prepare(`SELECT DISTINCT thread FROM ${table} ORDER BY thread`);

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

  return {
    database,
    async append(thread, drafts) {
      return run(() => {
        const written: ContextEntry[] = [];
        for (const draft of drafts) {
          const entryId = draft.id ?? id();
          const at = draft.at ?? now();
          const result = insert.run(
            entryId,
            thread,
            at,
            draft.type,
            draft.key ?? null,
            draft.source ?? null,
            JSON.stringify(bodyOf(draft), replacer),
            draft.meta !== undefined ? JSON.stringify(draft.meta) : null,
          );
          if (result.changes === 0) continue;
          written.push({ ...draft, id: entryId, thread, at, seq: Number(result.lastInsertRowid) } as ContextEntry);
        }
        return written;
      });
    },
    async list(thread, listOptions: ListOptions = {}) {
      const where = ['thread = ?'];
      const params: SQLInputValue[] = [thread];
      if (listOptions.after) {
        where.push('(at > ? OR (at = ? AND seq > ?))');
        params.push(listOptions.after.at, listOptions.after.at, listOptions.after.seq);
      }
      if (listOptions.types) {
        if (listOptions.types.length === 0) return [];
        where.push(`type IN (${listOptions.types.map(() => '?').join(', ')})`);
        params.push(...listOptions.types);
      }
      let sql = `SELECT * FROM ${table} WHERE ${where.join(' AND ')}`;
      if (listOptions.last !== undefined) {
        if (listOptions.last <= 0) return [];
        sql = `SELECT * FROM (${sql} ORDER BY at DESC, seq DESC LIMIT ?) ORDER BY at, seq`;
        params.push(listOptions.last);
      } else {
        sql += ' ORDER BY at, seq';
      }
      const rows = database.prepare(sql).all(...params) as unknown as Row[];
      return rows.map(decode);
    },
    async clear(thread) {
      return Number(removeThread.run(thread).changes);
    },
    async threads() {
      return (listThreads.all() as { thread: string }[]).map((row) => row.thread);
    },
    close() {
      if (owned) database.close();
    },
  };
}
