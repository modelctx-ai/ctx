# @modelctx-ai/ctx-sqlite

ctx 的 SQLite 存储，基于 Node 自带的 `node:sqlite`，没有原生依赖。可以自己开库，也可以和应用共用已经打开的 `DatabaseSync`。

## 安装

```sh
pnpm add @modelctx-ai/ctx-sqlite @modelctx-ai/ctx zod
```

Node ≥22.13。

## 用法

```ts
import { DatabaseSync } from 'node:sqlite';

import { createContext, userEntry } from '@modelctx-ai/ctx';
import { createSqliteStore } from '@modelctx-ai/ctx-sqlite';

// 自己开库：设成 WAL，close() 时关掉
const store = createSqliteStore({ path: 'ctx.db' });
const context = createContext({ store, thread: 'user:42' });
await context.append(userEntry('你好'));
store.close();

// 和应用共用一个库：表名带前缀；写入用 SAVEPOINT，可以放进应用自己的事务
const db = new DatabaseSync('app.db');
const shared = createSqliteStore({ database: db, prefix: 'ctx_' });
db.exec('BEGIN');
await shared.append('user:42', [userEntry('和应用的数据一起提交')]);
db.exec('COMMIT'); // 换成 ROLLBACK，ctx 的写入一起回滚
shared.close(); // 不关应用的库
```

## 选项

| 选项        | 说明                                                                     |
| ----------- | ------------------------------------------------------------------------ |
| `path`      | 数据库文件，或 `:memory:`；和 `database` 二选一                          |
| `database`  | 应用已经打开的 `DatabaseSync`；不改它的 `journal_mode`，`close()` 不关它 |
| `prefix`    | 表名前缀，缺省 `ctx_`，只能是标识符                                      |
| `now`、`id` | 缺省 `at` 和 `id` 的生成函数                                             |

## 表

| 表                | 内容                                                                                                                                                                             |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<prefix>entries` | 每行一个条目：`seq`（自增，就是写入序号）、`id`（唯一）、`thread`、`at`、`type`、`key`、`source`、`body`（JSON）、`meta`（JSON）。索引 `(thread, at, seq)`；`(thread, key)` 唯一 |
| `<prefix>meta`    | 结构版本 `schema`                                                                                                                                                                |

- 重复的 `id`、同线程重复的 `key` 由 `INSERT OR IGNORE` 跳过。
- JSON 编码保留 `Uint8Array`（存成 `{"$bytes": "<base64>"}`）和 `URL`（`{"$url": "<href>"}`），读回来还原。
- 通过核心包的存储契约测试 `describeStoreContract`。

## 导出

| 导出                                       | 说明                                                                   |
| ------------------------------------------ | ---------------------------------------------------------------------- |
| `createSqliteStore(options)`               | 返回 `SqliteContextStore`：`ContextStore` 加上 `database` 和 `close()` |
| `SqliteStoreOptions`、`SqliteContextStore` | 类型                                                                   |
