import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

import type {
  Cursor,
  Entry,
  JsonObject,
  JsonValue,
  ListOptions,
  MessageEntry,
  NewEntry,
  SessionStore,
  WatchOptions,
} from '@modelctx-ai/ctx-protocol';

type ModelMessage = MessageEntry['message'];

export interface SqliteStoreOptions {
  /** 数据库文件；也可以是 `:memory:`。和 `database` 二选一。 */
  readonly path?: string;
  /** 复用应用已经打开的库（例如应用自己的 yoyo.db）。这种情况下 `close()` 不关它。 */
  readonly database?: DatabaseSync;
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
  covers?: Cursor;
}

const SCHEMA_VERSION = '1';

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
 * 基于 `node:sqlite` 的存储。所有条目在一张表里，按会话、时间、写入序号建索引。
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

  if (owned) database.exec('PRAGMA journal_mode = WAL');
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
    );
    CREATE UNIQUE INDEX IF NOT EXISTS ${table}_key ON ${table} (session, key) WHERE key IS NOT NULL;
    CREATE INDEX IF NOT EXISTS ${table}_order ON ${table} (session, at, seq);
    CREATE TABLE IF NOT EXISTS ${prefix}meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT OR IGNORE INTO ${prefix}meta (key, value) VALUES ('schema', '${SCHEMA_VERSION}');
  `);

  const insert = database.prepare(
    `INSERT OR IGNORE INTO ${table} (id, session, at, type, key, source, body, meta) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const removeSession = database.prepare(`DELETE FROM ${table} WHERE session = ?`);
  const listSessions = database.prepare(`SELECT DISTINCT session FROM ${table} ORDER BY session`);
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
        // 和内存存储一样：小数向下取整，不是有限正数时返回空。
        const last = Number.isFinite(listOptions.last) ? Math.floor(listOptions.last) : 0;
        if (last <= 0) return [];
        sql = `SELECT * FROM (${sql} ORDER BY at DESC, seq DESC LIMIT ?) ORDER BY at, seq`;
        params.push(last);
      } else {
        sql += ' ORDER BY at, seq';
      }
      const rows = database.prepare(sql).all(...params) as unknown as Row[];
      return rows.map(decode);
    },
    async clear(session) {
      return Number(removeSession.run(session).changes);
    },
    async sessions() {
      return (listSessions.all() as { session: string }[]).map((row) => row.session);
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
          after = entry;
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
