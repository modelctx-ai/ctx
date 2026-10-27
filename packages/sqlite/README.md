# @modelctx-ai/ctx-sqlite

ctx 的 SQLite 会话存储（协议的 `SessionStore`），基于 Node 自带的 `node:sqlite`，没有原生依赖。只依赖 `@modelctx-ai/ctx-protocol`。可以自己开库，也可以和应用共用已经打开的 `DatabaseSync`。

## 安装

```sh
pnpm add @modelctx-ai/ctx-sqlite @modelctx-ai/ctx-protocol
```

Node ≥22.13。下面的例子另外用到核心包 `@modelctx-ai/ctx`。

## 用法

```ts
import { DatabaseSync } from 'node:sqlite';

import { createContext, userEntry } from '@modelctx-ai/ctx';
import { createSqliteStore } from '@modelctx-ai/ctx-sqlite';

// 自己开库：设成 WAL，close() 时关掉
const store = createSqliteStore({ path: 'ctx.db' });
const context = createContext({ store, session: 'user:42' });
await context.append(userEntry('你好'));
store.close();

// 和应用共用一个库：表名带前缀；库上已有应用的事务时写入用 SAVEPOINT，可以放进应用自己的事务
const db = new DatabaseSync('app.db');
const shared = createSqliteStore({ database: db, prefix: 'ctx_' });
db.exec('BEGIN');
await shared.append('user:42', [userEntry('和应用的数据一起提交')]);
db.exec('COMMIT'); // 换成 ROLLBACK，ctx 的写入一起回滚
shared.close(); // 不关应用的库

// 别的进程写进同一个库的条目也读得到：watch 轮询 list(after)，这里看一分钟
const watcher = createSqliteStore({ path: 'ctx.db', pollIntervalMs: 500 });
for await (const entry of watcher.watch('user:42', { signal: AbortSignal.timeout(60_000) })) console.log(entry.type);
watcher.close();
```

## 选项

| 选项             | 说明                                                                                    |
| ---------------- | --------------------------------------------------------------------------------------- |
| `path`           | 数据库文件，或 `:memory:`；和 `database` 二选一                                         |
| `database`       | 应用已经打开的 `DatabaseSync`；不改它的 `journal_mode`，`close()` 不关它                |
| `busyTimeoutMs`  | 别的连接占着写锁时最多等多久。自己开库缺省 5000；传 `database` 时缺省不动，显式传了才设 |
| `prefix`         | 表名前缀，缺省 `ctx_`，只能是标识符                                                     |
| `now`、`id`      | 缺省 `at` 和 `id` 的生成函数                                                            |
| `pollIntervalMs` | `watch` 轮询新条目的间隔，缺省 250 毫秒                                                 |

## 表

| 表                | 内容                                                                                                                                                                                                                                                                                                  |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<prefix>entries` | 每行一个条目：`seq`（自增，就是写入序号）、`id`（唯一）、`session`、`at`、`type`、`key`、`source`、`v`（格式版本）、`body`（JSON）、`meta`（JSON）。索引 `(session, seq)`；`(session, key)` 唯一。生成列 `kind`（`json_extract(body, '$.kind')`，VIRTUAL，只有事件有值）和索引 `(session, kind, seq)` |
| `<prefix>meta`    | 结构版本 `schema`                                                                                                                                                                                                                                                                                     |

- `list({ kinds })` 只返回 `type = 'event'` 且 `kind` 在其中的行，靠 `kind` 列和索引；旧版本写的行不用回填，`kind` 自动有值。`sessions({ prefix, after, limit })` 按名字升序，前缀用范围查询（`session >= ? AND session < ?`），不用 `LIKE`，`%`、`_` 不用转义。
- 每次 `append` 在 `BEGIN IMMEDIATE` 里做：先拿写锁（等 `busy_timeout`），再检查 `expectSeq`，再写。两个进程用同一个 `expectSeq` 并发写，恰好一个成功，另一个得到 `conflict`，不会是 `SQLITE_BUSY`。库上已有应用的事务时改用 SAVEPOINT，锁归应用管。
- 重复的 `id`、同会话重复的 `key` 由 `ON CONFLICT DO NOTHING` 跳过，同一批的其余照写；只跳过唯一约束冲突，NOT NULL 之类的违例照常报错；一批在一个 SAVEPOINT 里，要么全写要么不写。
- `watch(session, { after, signal })` 轮询 `list(session, { after })`，先给出已有的再给出新写入的；`signal` 中止后迭代结束。
- 消息是 ctx 的 JSON 格式（二进制是 base64 字符串），`body` 就是 `JSON.stringify` 的结果，不做编码。有循环引用的条目写入时报错。
- `v` 列记写入这一行时的格式版本（新行是 `1`，列加上之前的行是 `0`）。读每一行经协议包的 `upgradeEntry` 升到当前形状：0.2 及以前存的 AI SDK 消息（二进制和 URL 带 `\u0000ctx` 标记）转成 `Message`，旧摘要的 `covers: { at, seq }` 读成 `seq`；旧行不会被改写。比自己认识的更高的 `v` 读时抛 `unsupported_version`。
- 通过协议包的契约测试 `describeSessionStoreContract`（含 `watch`）。

## 结构版本和迁移

`<prefix>meta` 的 `schema` 记结构版本，当前是 `3`。打开时：

- 没有表：直接建当前结构。
- 版本比 3 低：在写锁里按序升级，同时打开同一个旧库的几个进程只有一个真的迁，其余拿到锁后重读版本。0.1 的库（列叫 `thread`，`schema` 是 `1`）会被改成 `session`，索引随列一起改，数据不动；0.2 的库（列已经是 `session`，`schema` 也是 `1`）和应用自己改过列名的库只升版本号；3 把索引 `(session, at, seq)` 换成 `(session, seq)`，旧摘要的 `covers: { at, seq }` 读成 `seq`。
- 版本等于 3：不信版本号，查实际的列和索引（`PRAGMA table_xinfo`、`sqlite_master`），缺什么在写锁里补什么，结构完整时什么都不写。所以先前的提交建出来的 schema 3 库，在之后的版本上打开也会补齐；每一步都能重复执行。`v` 列（`INTEGER NOT NULL DEFAULT 0`）也在这一级补：缺就加，已有的行是 0。
- 版本比 3 高：抛错，不打开。旧代码不认识新结构，写进去可能写坏；升级本包即可。

应用传进来的 `database` 上已经有事务时，迁移用 SAVEPOINT，随应用的事务一起提交或回滚。

## 多进程

自己开库时设 `journal_mode = WAL` 和 `busy_timeout`（缺省 5000 毫秒），几个进程可以同时写同一个库，等锁而不是报 `SQLITE_BUSY`。传进来的 `database` 归应用管：本包缺省不改它的 `journal_mode` 和 `busy_timeout`，要多进程写请应用自己设（或传 `busyTimeoutMs`）。写入每批第一条语句就是 INSERT，所以拿写锁时会等 `busy_timeout`；应用自己的事务如果先读后写，升级写锁时仍可能直接 `SQLITE_BUSY`，应该用 `BEGIN IMMEDIATE`。

## 导出

| 导出                                       | 说明                                                                                |
| ------------------------------------------ | ----------------------------------------------------------------------------------- |
| `createSqliteStore(options)`               | 返回 `SqliteSessionStore`：`SessionStore`（含 `watch`）加上 `database` 和 `close()` |
| `SqliteStoreOptions`、`SqliteSessionStore` | 类型\1                                                                              |
