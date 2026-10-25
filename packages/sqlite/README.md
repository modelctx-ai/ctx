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

// 和应用共用一个库：表名带前缀；写入用 SAVEPOINT，可以放进应用自己的事务
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

| 选项             | 说明                                                                     |
| ---------------- | ------------------------------------------------------------------------ |
| `path`           | 数据库文件，或 `:memory:`；和 `database` 二选一                          |
| `database`       | 应用已经打开的 `DatabaseSync`；不改它的 `journal_mode`，`close()` 不关它 |
| `prefix`         | 表名前缀，缺省 `ctx_`，只能是标识符                                      |
| `now`、`id`      | 缺省 `at` 和 `id` 的生成函数                                             |
| `pollIntervalMs` | `watch` 轮询新条目的间隔，缺省 250 毫秒                                  |

## 表

| 表                | 内容                                                                                                                                                                                |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<prefix>entries` | 每行一个条目：`seq`（自增，就是写入序号）、`id`（唯一）、`session`、`at`、`type`、`key`、`source`、`body`（JSON）、`meta`（JSON）。索引 `(session, at, seq)`；`(session, key)` 唯一 |
| `<prefix>meta`    | 结构版本 `schema`                                                                                                                                                                   |

- 重复的 `id`、同会话重复的 `key` 由 `INSERT OR IGNORE` 跳过，同一批的其余照写；一批在一个 SAVEPOINT 里，要么全写要么不写。
- `watch(session, { after, signal })` 轮询 `list(session, { after })`，先给出已有的再给出新写入的；`signal` 中止后迭代结束。
- 二进制和 URL 在序列化之前换成带标记的对象：`Uint8Array`、`Buffer`、`ArrayBuffer` 和其他 TypedArray 存成 `{"\u0000ctx": "bytes", "base64": "…"}`，`URL` 存成 `{"\u0000ctx": "url", "href": "…"}`。读回来二进制都是 `Uint8Array`，URL 还是 `URL`。
- 只有恰好是这个形状的对象才会还原；`{ $url }`、`{ $bytes }` 这类普通对象原样读回。有循环引用的条目写入时报错。
- 通过协议包的契约测试 `describeSessionStoreContract`（含 `watch`）。0.1 的表列名是 `thread`，没有发布过，不做迁移；用 0.1 建过的库请换个文件或前缀。

## 导出

| 导出                                       | 说明                                                                                |
| ------------------------------------------ | ----------------------------------------------------------------------------------- |
| `createSqliteStore(options)`               | 返回 `SqliteSessionStore`：`SessionStore`（含 `watch`）加上 `database` 和 `close()` |
| `SqliteStoreOptions`、`SqliteSessionStore` | 类型；`SqliteContextStore` 是弃用的别名                                             |
