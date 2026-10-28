import { DatabaseSync } from 'node:sqlite';

/** 自己开库时 `busy_timeout` 的缺省值（毫秒）。 */
const DEFAULT_BUSY_TIMEOUT_MS = 5000;

export interface OpenOptions {
  readonly path?: string;
  readonly database?: DatabaseSync;
  readonly busyTimeoutMs?: number;
}

/**
 * 校验前提、开库、设 `busy_timeout`（自己开库或显式传了时）和 WAL（只在自己开库时），再跑 `migrate`。
 * 任何一步失败都把自己开的库关掉再抛。`owned` 表示库是自己开的，`close()` 时才关。
 */
export function openDatabase(
  options: OpenOptions,
  prefix: string,
  caller: string,
  migrate: (database: DatabaseSync) => void,
): { database: DatabaseSync; owned: boolean } {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(prefix)) throw new Error(`Invalid table prefix "${prefix}".`);
  if (!options.database && !options.path) throw new Error(`Pass \`path\` or \`database\` to ${caller}().`);
  const owned = !options.database;
  const database = options.database ?? new DatabaseSync(options.path!);
  try {
    const timeout = options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
    if (options.busyTimeoutMs !== undefined || owned) {
      if (!Number.isInteger(timeout) || timeout < 0) throw new Error(`Invalid busyTimeoutMs ${timeout}.`);
      database.exec(`PRAGMA busy_timeout = ${timeout}`);
    }
    if (owned) enableWal(database, timeout);
    migrate(database);
  } catch (error) {
    if (owned) database.close();
    throw error;
  }
  return { database, owned };
}

/** SQLite 的结果码 `SQLITE_BUSY`。 */
const SQLITE_BUSY = 5;

/**
 * 切到 WAL。库还在 rollback 模式、别的连接正持有写锁时（几个进程同时打开一个新库，另一个也正在切 WAL），
 * 这条 PRAGMA 立刻报 `SQLITE_BUSY`，不等 `busy_timeout`：SQLite 为避免死锁在这条路上不调 busy handler。
 * 所以自己等：每 10 毫秒再试一次，最多等 `timeout` 毫秒。库已经是 WAL 时这条 PRAGMA 只读，不碰锁。
 */
function enableWal(database: DatabaseSync, timeout: number): void {
  const deadline = Date.now() + timeout;
  for (;;) {
    try {
      database.exec('PRAGMA journal_mode = WAL');
      return;
    } catch (error) {
      if ((error as { errcode?: number }).errcode !== SQLITE_BUSY || Date.now() >= deadline) throw error;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
}

export function hasTable(database: DatabaseSync, name: string): boolean {
  return database.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name) !== undefined;
}

/** 读 `${prefix}meta` 里 `key` 那一行的结构版本；没有 meta 表或没有这一行时返回 `undefined`。 */
export function readSchemaVersion(
  database: DatabaseSync,
  prefix: string,
  key = 'schema',
  label = 'ctx',
): number | undefined {
  if (!hasTable(database, `${prefix}meta`)) return undefined;
  const row = database.prepare(`SELECT value FROM ${prefix}meta WHERE key = ?`).get(key) as
    | { value: string }
    | undefined;
  if (!row) return undefined;
  const version = Number(row.value);
  if (!Number.isInteger(version) || version < 1)
    throw new Error(`Unrecognized ${label} schema version "${row.value}".`);
  return version;
}

/** 写 `${prefix}meta` 里 `key` 那一行的结构版本。 */
export function writeSchemaVersion(database: DatabaseSync, prefix: string, key: string, version: number): void {
  database
    .prepare(
      `INSERT INTO ${prefix}meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    )
    .run(key, String(version));
}

/**
 * 拿到写锁再做 `work`。库上没有事务时用 `BEGIN IMMEDIATE`：一开始就要写锁，会等 `busy_timeout`，
 * 不会像先读后升级的延迟事务那样直接 `SQLITE_BUSY`。库上已经有应用的事务时只能用 SAVEPOINT，锁归应用管。
 */
export function withWriteLock<T>(database: DatabaseSync, name: string, work: () => T): T {
  const savepoint = database.isTransaction;
  database.exec(savepoint ? `SAVEPOINT ${name}` : 'BEGIN IMMEDIATE');
  let result: T;
  try {
    result = work();
  } catch (error) {
    database.exec(savepoint ? `ROLLBACK TO ${name}` : 'ROLLBACK');
    if (savepoint) database.exec(`RELEASE ${name}`);
    throw error;
  }
  database.exec(savepoint ? `RELEASE ${name}` : 'COMMIT');
  return result;
}

/** 表上实际有的列和索引。`table_info` 不列生成列，`table_xinfo` 才列。 */
export function inspect(database: DatabaseSync, table: string): { columns: Set<string>; indexes: Set<string> } {
  const columns = (database.prepare(`PRAGMA table_xinfo(${table})`).all() as { name: string }[]).map((c) => c.name);
  const indexes = (
    database.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ?`).all(table) as {
      name: string;
    }[]
  ).map((i) => i.name);
  return { columns: new Set(columns), indexes: new Set(indexes) };
}
