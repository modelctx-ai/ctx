# @modelctx-ai/ctx-sqlite

ctx 的 SQLite 会话存储（协议的 `SessionStore`）和记忆存储（协议的 `MemoryStore`），基于 Node 自带的 `node:sqlite`，没有原生依赖。只依赖 `@modelctx-ai/ctx-protocol`。可以自己开库，也可以和应用共用已经打开的 `DatabaseSync`。

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

| 选项             | 说明                                                                                                                                                     |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `path`           | 数据库文件，或 `:memory:`；和 `database` 二选一                                                                                                          |
| `database`       | 应用已经打开的 `DatabaseSync`；不改它的 `journal_mode`，`close()` 不关它                                                                                 |
| `busyTimeoutMs`  | 别的连接占着写锁时最多等多久。自己开库缺省 5000；传 `database` 时缺省不动，显式传了才设                                                                  |
| `prefix`         | 表名前缀，缺省 `ctx_`，只能是标识符                                                                                                                      |
| `now`、`id`      | 缺省 `at` 和 `id` 的生成函数                                                                                                                             |
| `pollIntervalMs` | `watch` 轮询新条目的间隔，缺省 250 毫秒                                                                                                                  |
| `unreadable`     | 读到解不了的一行（`v` 比这个版本认识的高、带不认识的部件）时怎么办。缺省 `throw`；`placeholder` 把那一行读成 `ctx.unreadable` 事件，会话其余部分照常能读 |
| `secureDelete`   | 在连接上打开 `PRAGMA secure_delete`，缺省 `true`，传 `database` 时也设。`false` 不动连接的设置。见[删除和文件大小](#删除和文件大小)                      |

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
- `v` 列记写入这一行时的格式版本（新行是 `1`，列加上之前的行是 `0`）。读每一行经协议包的 `upgradeEntry` 升到当前形状：0.2 及以前存的 AI SDK 消息（二进制和 URL 带 `\u0000ctx` 标记）转成 `Message`，旧摘要的 `covers: { at, seq }` 读成 `seq`；旧行不会被改写。比自己认识的更高的 `v` 读时抛 `unsupported_version`；开了 `unreadable: 'placeholder'` 时那一行读成一条 `ctx.unreadable` 事件（`id`、`seq`、`at` 不变，`data` 里是原来的 `v`、`type` 和错误），`list`、`watch` 不会断在它上面。
- `truncate`、`remove`、`redact` 在写锁里做，`ctx.erased` 记录在同一个事务里插入；库上已有应用的事务时用 SAVEPOINT，应用回滚就一起回滚。`remove`、`redact` 只按列操作，不解码正文，读不了的行（`v` 太高、带不认识的部件）也删得掉、涂得掉——坏行的 `id` 用 `unreadable: 'placeholder'` 读出来的占位拿。`redact` 把那一行改成 `type = 'event'`、正文是 `ctx.redacted` 占位、`meta` 清空、`v` 写当前版本。一次传的 `id` 没有个数限制（分批执行，每条语句 500 个）。
- 通过协议包的契约测试 `describeSessionStoreContract`（含 `watch`）。

## 删除和文件大小

`clear`、`truncate`、`remove` 删行，`redact` 改行。被删掉的内容还在不在库文件里、文件会不会变小，是两件事：

| 问题                     | 回答                                                                                                                                                                                                                                   |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 删掉的内容还在库文件里吗 | 连接上开着 `secure_delete`（缺省）时不在：SQLite 把腾出来的空间当场用零覆写。测试里写 200 条带标记的消息，`clear`（或 `truncate`、`remove`、`redact`）之后 checkpoint、关库，库文件里找不到标记                                        |
| `-wal` 文件呢            | 改动先进 `-wal`，旧的页也可能还在里面，直到 checkpoint 把它截断：`store.vacuum()`，或者只要这一步的话 `store.database.exec('PRAGMA wal_checkpoint(TRUNCATE)')`。最后一个连接正常关库时 SQLite 也会做                                   |
| 文件什么时候变小         | 自己不会。删除腾出来的页留在文件里，之后的写入先用它们，所以一边写一边删的库大小是稳定的。要把空间还给文件系统，调 `store.vacuum()`                                                                                                    |
| 什么时候要 `vacuum()`    | 删了一大批、想要回磁盘空间时；以及要清掉没开 `secure_delete` 时留下的内容时（见下）。它重写整个库文件，要独占库：别的连接正在读写时等 `busy_timeout`，等不到就抛；不能在事务里调。库是应用传进来的 `database` 时，应用自己的表一起重写 |

`secure_delete` 的三个注意：

- **它是连接上的开关，不存进库文件。** 本包每次打开都设（传 `database` 时设在应用的连接上，应用在这条连接上对自己的表的删除也会覆写，多一些写入）。同一个库的别的连接——应用另开的、别的没用本包的进程——各管各的。不要这个行为就传 `secureDelete: false`，那删除只是把空间标成可用，内容留到被新数据盖住或 `vacuum()` 为止。
- **写入时也要开着。** 没开的时候，页分裂会在页里留下行内容的旧副本，它们不属于任何一行，之后开着 `secure_delete` 删也擦不到。所以升级到这个版本之前写的内容、`secureDelete: false` 时写的内容、别的连接写的内容，删掉之后库文件里还可能有残留，只有 `vacuum()` 清得掉。升级之后想对旧数据也有保证：删完调一次 `vacuum()`。（在 Node 22.23 自带的 SQLite 3.53.4 上实测；这是 SQLite 内部的行为，没有文档保证。）
- **它只管库文件里的字节。** 文件系统的日志和快照、SSD 的重映射块、备份、从库，都不在它的范围里；摘要里的文字、记忆里提取出来的事实也不会跟着删。

```ts
const store = createSqliteStore({ path: 'ctx.db' });
await store.redact('user:42', [entryId]); // 内容当场覆写，位置留着
await pruneSession(store, 'user:42', { maxAgeMs: 30 * 24 * 60 * 60 * 1000 }); // 核心包的保留期，走 truncate
store.vacuum(); // 要回磁盘空间，顺带把 -wal 截到空
```

## 结构版本和迁移

`<prefix>meta` 的 `schema` 记结构版本，当前是 `3`。打开时：

- 没有表：直接建当前结构。
- 版本比 3 低：在写锁里按序升级，同时打开同一个旧库的几个进程只有一个真的迁，其余拿到锁后重读版本。0.1 的库（列叫 `thread`，`schema` 是 `1`）会被改成 `session`，索引随列一起改，数据不动；0.2 的库（列已经是 `session`，`schema` 也是 `1`）和应用自己改过列名的库只升版本号；3 把索引 `(session, at, seq)` 换成 `(session, seq)`，旧摘要的 `covers: { at, seq }` 读成 `seq`。
- 版本等于 3：不信版本号，查实际的列和索引（`PRAGMA table_xinfo`、`sqlite_master`），缺什么在写锁里补什么，结构完整时什么都不写。所以先前的提交建出来的 schema 3 库，在之后的版本上打开也会补齐；每一步都能重复执行。`v` 列（`INTEGER NOT NULL DEFAULT 0`）也在这一级补：缺就加，已有的行是 0。
- 版本比 3 高：抛错，不打开。旧代码不认识新结构，写进去可能写坏；升级本包即可。
- 几个进程共用一个库时的升级顺序：**读的一方先升**。结构迁移不可逆（改列名、换索引），没有降级路径——库一旦被新版本打开过，旧版本就打不开了，所以要所有进程都能换成新版本再升。条目格式（`v`）另算：新版本写了新格式的行之后，还没升级的进程读那个会话会抛 `unsupported_version`，过渡期可以给它开 `unreadable: 'placeholder'`。

应用传进来的 `database` 上已经有事务时，迁移用 SAVEPOINT，随应用的事务一起提交或回滚。

## 多进程

自己开库时设 `journal_mode = WAL` 和 `busy_timeout`（缺省 5000 毫秒），几个进程可以同时写同一个库，等锁而不是报 `SQLITE_BUSY`。切 WAL 这一步 SQLite 不调 busy handler（库还是 rollback 模式、别的连接正持有写锁时立刻 `SQLITE_BUSY`，几个进程同时打开一个新库就会碰上），本包自己重试，最多等 `busy_timeout` 那么久。传进来的 `database` 归应用管：本包缺省不改它的 `journal_mode` 和 `busy_timeout`，要多进程写请应用自己设（或传 `busyTimeoutMs`）。写入每批第一条语句就是 INSERT，所以拿写锁时会等 `busy_timeout`；应用自己的事务如果先读后写，升级写锁时仍可能直接 `SQLITE_BUSY`，应该用 `BEGIN IMMEDIATE`。

## 记忆存储

`createSqliteMemoryStore(options)` 实现协议的 `MemoryStore`（笔记、事实、程序、画像），返回 `SqliteMemoryStore`：`MemoryStore` 加上 `database` 和 `close()`。选项和会话存储一样：`path` 或 `database`、`busyTimeoutMs`、`id`；`prefix` 缺省 `memory_`。可以和会话存储共用同一个 `DatabaseSync`：

```ts
const db = new DatabaseSync('yoyo.db');
const sessions = createSqliteStore({ database: db, prefix: 'ctx_' });
const memory = createSqliteMemoryStore({ database: db, prefix: 'memory_' });
```

| 表                   | 内容                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<prefix>notes`      | 每行一条笔记：`seq`（自增，写入顺序）、`id`、`scope`、`session`、`from_seq`、`up_to`、`at`、`salience`、`kind`、`topic`、`settled_at`、`attempts`、`error`、`failed_at`。索引 `(scope, session, up_to)`（`head`）、`(scope, seq)`；唯一索引 `(scope, session, from_seq, up_to)`（同一段只有一条）；部分索引 `(scope, seq) WHERE settled_at IS NULL AND failed_at IS NULL`（待处理的）                                                                            |
| `<prefix>facts`      | 每行一条事实：`id`（主键）、`scope`、`subject`、`predicate`、`text`、`topic`、`valid_from`、`valid_to`、`superseded_by`、`confidence`、`salience`、`sources`（JSON）、`recalls`（JSON）、`archived_at`、`fact_key`（幂等键）。部分唯一索引 `(scope, fact_key) WHERE fact_key IS NOT NULL`；索引 `(scope, id)`、`(scope, subject, id)`、`(scope, topic, id)`；部分索引 `(scope, id) WHERE valid_to IS NULL AND archived_at IS NULL`（`open`）和 `(superseded_by)` |
| `<prefix>procedures` | 每行一条程序：`seq`、`id`、`scope`、`topic`、`when_text`、`do_text`、`evidence`（JSON）、`confirmations`、`at`、`retired_at`。索引 `(scope, seq)`、`(scope, topic, seq)`                                                                                                                                                                                                                                                                                         |
| `<prefix>core`       | 每次 `core.set` 一行：`seq`、`scope`、`text`、`at`；一个作用域里最后一行是它当前的版本。索引 `(scope, seq)`                                                                                                                                                                                                                                                                                                                                                      |
| `<prefix>fact_docs`  | 检索的索引，进了索引的事实一条一行：`doc`（整数主键，倒排表里用的短编号）、`scope`、`fact_id`（唯一）、`terms`（这条事实切出了几个不同的词）                                                                                                                                                                                                                                                                                                                     |
| `<prefix>fact_terms` | 倒排表，一个词一行：`scope`、`term`、`doc`，主键 `(scope, term, doc)`，没有 rowid。一个作用域的查询只碰自己的词                                                                                                                                                                                                                                                                                                                                                  |
| `<prefix>meta`       | 结构版本 `memory_schema`                                                                                                                                                                                                                                                                                                                                                                                                                                         |

- 作用域（`store.scope(name)`）是每张表上的一列 `scope`，每条语句都带它，按 `id` 找的也带：别的作用域的 `id` 和不存在的一样。各作用域共用一个连接和写锁；`database`、`close()` 只在 `createSqliteMemoryStore` 返回的那个对象上，`scope()` 返回的是普通的 `MemoryStore`。
- `facts.list` 按 `id` 升序（BINARY 比较 UTF-8 字节，和码点序一致），`subject`、`topic`、`open`、`after` 都走索引。
- `facts.search` 走倒排索引。事实写入时用协议包的 `searchTerms` 切成词（先 NFKC 归一、转小写；字母数字连成的一串是一个词，中日韩文字每相邻两个字是一个词），一个词在 `fact_terms` 里一行；查询切成同样的词（最多 `MAX_SEARCH_TERMS` = 256 个，更多时取头尾各一半），每个词按主键查一次。分数是 `termOverlap`：共同的词数除以查询和事实里词少的那一边，0..1；从高到低，同分时共同的词多的在前，再相同按 `id`。和 `ctx-memory` 的内存存储是同一套切词和打分。
  - 中文问句能命中：「我平时喜欢喝什么茶？」找得回「主人喜欢喝乌龙茶」。英文按整词，`Postgre` 不命中 `PostgreSQL`；标点不是词，只有标点的查询什么都不命中。
  - 多长的查询都不报错：词是当一个 JSON 参数传进去的（`json_each`），语句的形状不随词数变。
  - 不扫事实表：只有命中的事实才读。3 万条事实时一个常见词的查询约 7 毫秒，罕见词不到 1 毫秒。索引占的地方大约是事实本身的七成。
  - 不用 FTS5：它不是每个 Node 自带的 SQLite 都编进去了，自带的分词器也切不了中文（`unicode61` 不切，`trigram` 匹配不到两个字的词）。倒排表是普通的表，`engines` 写的最低版本上一样能用。
- `facts.touch` 只留最近 `MAX_FACT_RECALLS`（32）个召回时刻，一行不随召回次数变长；`facts.restore` 清掉 `archived_at`。
- 每个写方法在一个 `BEGIN IMMEDIATE` 里做完（库上已有应用的事务时用 SAVEPOINT），单个方法是原子的：`supersede` 写新的、关旧的在同一个事务里。`notes.add` 遇到同一段的笔记 `ON CONFLICT DO NOTHING` 后返回已有的那条，`facts.add` 遇到已有的 `fact_key` 返回已有的那条：几个进程同时门控、同时整理不写出重复的。`touch`、`cite`、`confirm` 在写锁里读后写，几个进程同时写不丢；`add` 和 `forget` 在同一个事务里改索引，失败时一起回滚。
- 结构版本独立于会话存储：`<prefix>meta` 里的键是 `memory_schema`，当前是 `4`，和会话存储的 `schema` 不同，所以两边用同一个前缀也不冲突。打开时的规则和会话存储一样：版本不高于 4 时查实际的表、列和索引，缺什么在写锁里补什么；比 4 高时抛错，不打开。老库打开时自动升级，升级后旧版本的 `ctx-sqlite` 打不开这个库：
  - 版本 1（没有 `scope` 列）：四张表各加一列，已有的行都落在缺省的作用域里，索引换成以 `scope` 开头的。
  - 版本 2（没有检索的索引）：建 `fact_docs`、`fact_terms`，已有的事实（各个作用域的，含关闭、归档的）补进索引；`recalls` 超过 32 个的截到最近的那些。事实多的库第一次打开会慢一些（3 万条约 1 秒），都在一个事务里，中途失败就整个回滚。
  - 版本 3（没有失败的列和幂等键）：`notes` 加 `attempts`、`error`、`failed_at`，`facts` 加 `fact_key`；同一个作用域、会话、区间的重复笔记只留最早写的那条，再建唯一索引；待处理的部分索引换成也排除死信的。
- 通过协议包的契约测试 `describeMemoryStoreContract`。

## 导出

| 导出                                            | 说明                                                                                            |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `createSqliteStore(options)`                    | 返回 `SqliteSessionStore`：`SessionStore`（含 `watch`）加上 `database`、`vacuum()` 和 `close()` |
| `SqliteStoreOptions`、`SqliteSessionStore`      | 类型                                                                                            |
| `createSqliteMemoryStore(options)`              | 返回 `SqliteMemoryStore`：`MemoryStore` 加上 `database` 和 `close()`                            |
| `SqliteMemoryStoreOptions`、`SqliteMemoryStore` | 类型                                                                                            |
