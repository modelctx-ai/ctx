---
type: Specification
title: '协议层'
description: '九个协议的职责、签名、JSON 形状、激活度公式、契约测试、托管矩阵和 HTTP 线上形态；`packages/protocol` 以它为准'
tags: [protocol, specification]
status: stable
---

# 协议层

`@modelctx-ai/ctx-protocol` 定义九个协议（七个组件的六个，加记忆的 `MemoryStore`、`DecisionModel`、`ExtractionModel`）、随它们走的 JSON 形状、只依赖这些形状的纯函数，以及每个协议的契约测试。它不含实现。模型用 AI SDK 的 `LanguageModel`，不另定义；消息是 ctx 自己的 JSON 格式（见[消息格式和版本](#消息格式和版本)），协议包不依赖 AI SDK 的消息类型。

本文是协议的说明；类型以包里的 `.d.ts` 为准，下面的签名省略了 `readonly` 和注释。包的用法和契约测试一览见 [`packages/protocol`](../packages/protocol/README.md)。

## 总则

| 规则         | 说明                                                                                                                                                                                                                 |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 接口加工厂   | 协议是 `interface`，实现是 `createX(options): X`。不用类继承                                                                                                                                                         |
| 只收发 JSON  | 方法参数和返回值都能 `JSON.stringify`。例外：`AbortSignal`、进程内的 `LanguageModel`。跨边界时模型用名字字符串                                                                                                       |
| 消息         | ctx 自己的 `Message`，全是 JSON（二进制是 base64 字符串，URL 是字符串），存储和线上都不需要编码；和 AI SDK 互转在 `@modelctx-ai/ctx`                                                                                 |
| 字符串身份   | `session`、工具名、执行环境名、`runId` 都是字符串                                                                                                                                                                    |
| 流是事件序列 | 流式结果用 `AsyncIterable<Event>` 表达，跨边界是 NDJSON 或 SSE                                                                                                                                                       |
| 可选方法     | 协议里标 `?` 的方法实现可以不提供，调用方要检查                                                                                                                                                                      |
| 取消         | 需要取消的方法收 `signal?: AbortSignal`                                                                                                                                                                              |
| 错误         | 抛 `Error`；跨边界时是 `{ error: ErrorInfo }`，`ErrorInfo` 是 `{ message, type?, retryable?, statusCode?, responseBody? }`；`type` 是机器可读的类别（`not_found`、`conflict`、`session_busy`、`context_overflow`……） |
| 契约测试     | `@modelctx-ai/ctx-protocol/testing` 的 `describeXContract(name, factory, { describe, test })`，实现跑它（见[契约测试](#契约测试)）                                                                                   |
| 版本         | 线上协议的版本是 `PROTOCOL_VERSION`（当前 `0.3`，和包的 minor 版本一起走）；客户端连上先读 `GET /protocol`，版本不同直接报错                                                                                         |
| 语言无关     | 线上形状有 JSON Schema（`PROTOCOL_SCHEMA`），路径有 OpenAPI；别的语言的实现对着一个地址跑同一套契约测试（`ctx-conformance`）                                                                                         |

## 会话 `SessionStore`

只追加的事件日志，详细语义见 [ADR 0003](adr/0003-context-model.md)；例外只有删除（`clear`、`truncate`、`remove`）和涂改（`redact`），见下面的[擦除](#擦除)和 [ADR 0007](adr/0007-deletion-and-retention.md)。

```ts
interface EntryBase {
  id: string; // 全局唯一；不给就由存储生成
  session: string; // 由存储填
  v: number; // 写入这一行时的格式版本，读出来的形状永远是当前版本；新条目是 `ENTRY_VERSION`（1），由存储填
  seq: number; // 会话内位置，由存储按写入顺序填：会话内严格递增、从 1 起，删除之后不回退、不复用；0 是会话开头
  at: number; // 逻辑时间（毫秒），缺省写入时刻；只用于投影排序和展示，可以早于已有的条目
  key?: string; // 幂等键：同一会话里键相同的第二条跳过
  source?: string; // 谁写的：user、model、harness、应用名
  meta?: JsonObject;
}
interface MessageEntry extends EntryBase {
  type: 'message';
  message: Message;
}
interface EventEntry extends EntryBase {
  type: 'event';
  kind: string;
  text?: string;
  data?: JsonValue;
}
interface SummaryEntry extends EntryBase {
  type: 'summary';
  text: string;
  covers: number; // seq ≤ covers 的条目由这段摘要代替
}
type Entry = MessageEntry | EventEntry | SummaryEntry;
type EntryType = Entry['type'];
/** 追加时传入：id、at 可选，session、seq 由存储填。 */
type NewEntry = NewMessageEntry | NewEventEntry | NewSummaryEntry;

interface ListOptions {
  after?: number; // seq，不含
  last?: number; // seq 最大的 N 条，仍按 seq 升序；向下取整，不是有限正数时返回空
  limit?: number; // 过滤之后 seq 最小的 N 条；和 after 配合向前翻页；和 last 同时给时先取 last
  types?: readonly EntryType[];
  kinds?: readonly string[]; // 只要事件，且 kind 在其中；与 types 取交集；空列表什么都不匹配
  atAfter?: number; // 只要 at 大于它的（不含）；NaN 不过滤
}
interface SessionsOptions {
  prefix?: string; // 字面前缀，不是通配符
  after?: string; // 上一页最后一个名字，不含
  limit?: number; // 向下取整，不是正数时返回空；不给就不限
}
interface WatchOptions {
  after?: number; // seq，不含
  signal?: AbortSignal; // 中止后迭代正常结束
}

interface AppendOptions {
  expectSeq?: number; // 仅当会话当前最后一条的 seq 等于它才写（空会话是 0），否则整批不写，抛 conflict
}

interface SessionStore {
  append(session: string, entries: readonly NewEntry[], options?: AppendOptions): Promise<Entry[]>;
  list(session: string, options?: ListOptions): Promise<Entry[]>;
  clear(session: string): Promise<number>; // 清空整个会话，返回删掉的条数
  truncate(session: string, upTo: number): Promise<number>; // 删掉 seq ≤ upTo 的条目
  remove(session: string, ids: readonly string[]): Promise<number>; // 按 id 真删
  redact(session: string, ids: readonly string[]): Promise<number>; // 按 id 涂改：位置留着，内容换成 ctx.redacted
  sessions(options?: SessionsOptions): Promise<string[]>; // 名字升序
  /** 先给出 after 之后已有的条目，再持续给出新写入的；远端流式读用。 */
  watch?(session: string, options?: WatchOptions): AsyncIterable<Entry>;
}
```

- 会话名是任意非空字符串，但不能是 `.` 和 `..`：这三种放不进 URL 的一段路径（空的一段没有了，`.`、`..` 被规范化折叠掉），经远端存储读不到也删不掉。存储的每个方法（`sessions` 除外）遇到它们抛 `invalid_request`，`checkSessionName(session)` 是这条规则的实现；带 `/`、`%`、空格、中文的名字都行。
- 存进去的是拷贝，读出来的也是：调用方 `append` 之后改自己手里的草稿、改 `list` 或 `watch` 给的条目，日志都不变。只追加不靠调用方自觉，原地改消息的钩子在各个实现上表现一样。
- `append` 对一批条目是原子的：不会只写一半，也不会和并发的另一批交错。崩溃后续跑依赖这一点。
- `expectSeq` 是写入的前提条件，不是租约：不满足时整批不写，抛 `CtxError('conflict')`（`retryable: true`；HTTP 是 409）。前提的检查先于去重，所以重试一批已经成功的写入，如果其间别人又写了，仍然是 `conflict`，调用方重读就能看到自己的条目已在。不给就不检查。它无状态，崩溃的 harness 什么都不用释放；`seq` 本身就是围栏令牌。纯函数 `headSeq(store, session)`（`list({ last: 1 })`，空会话 0）读当前末尾，`isConflict(error)` 认 `conflict`（本地和远端客户端转出来的都认）。内存存储在同一个同步段里检查和写，`ctx-sqlite` 在 `BEGIN IMMEDIATE` 里（应用已有事务时用 SAVEPOINT）。
- 去重不算失败：`id` 重复（全局）或 `key` 重复（同一会话，含同一批里的）的那一条静默跳过，同批其余照写；返回值就是真正写入的条目。重试一批时靠它不重复记。
- `list` 和 `watch` 都按 `seq` 升序返回，也就是写入顺序。带旧 `at` 导入的条目排在写入的位置（所以 `after` 之后一定看得到新写入的），模型看到的逻辑顺序由投影按 `(at, seq)` 重排（`compareEntries`）。`seq` 只要求会话内单调，消费者不能跨会话比较。
- `sessions` 只列有内容的会话，按名字升序（码点序，也就是 UTF-8 字节序）。翻页：`after` 给上一页最后一个名字，`prefix` 按字面匹配，`limit` 限条数。
- `limit` 用来翻页：`list({ after, limit })` 读一页，下一页的 `after` 是这一页最后一条的 `seq`，读到不满一页为止。长会话不必一次读进内存；`ctx-sqlite` 的 `watch` 和 `ctx-remote` 的服务端都这样一页一页读。
- `kinds` 只返回事件，消息和摘要没有 `kind`；和 `types` 取交集，`types` 里没有 `event` 就什么都不返回；`last` 在过滤之后取，所以 `{ kinds: [a, b], last: 1 }` 是这些事件里最后写的一条。
- `atAfter` 按 `at` 筛，结果仍按 `seq` 升序；和别的条件取交集，`last`、`limit` 在过滤之后取。只读尾部的一方靠它找写得早、`at` 却排在尾部之后的条目（把到期时间当 `at` 的提醒），见 `projectSession`。
- 生效的摘要是 `covers` 最大的那条；`covers` 相同时 `seq` 大的（后写的）生效。
- 事件 `kind` 用 `{domain}.{action}`。框架保留 `ctx.` 前缀，常量是 `CTX_EVENTS`：

| `kind`            | 谁写          | `data`                                                                                                                                                                             |
| ----------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ctx.run.started` | harness       | `RunStartedData`：`{ runId, agent, owner?, parent?, harness? }`，`agent` 是 `agentSpecToJson(spec)`，`harness` 是外部 harness 的身份 `HarnessInfo`：`{ name, version?, session? }` |
| `ctx.run.ended`   | harness       | `RunEndedData`：`{ runId, stopReason, usage?, executors? }`，`executors` 是 `requires_action` 时留给外部执行环境的调用归谁：调用 `id` → 执行环境的名字                             |
| `ctx.compacted`   | 上下文        | `CompactedData`：`{ covers, summaryId }`                                                                                                                                           |
| `ctx.error`       | harness、编排 | `CtxErrorData`：`{ runId?, message, type? }`                                                                                                                                       |
| `ctx.unreadable`  | （不写入）    | `UnreadableData`：`{ v?, type?, error: { type, message } }`，见下面                                                                                                                |
| `ctx.erased`      | 存储          | `ErasedData`：`{ op, upTo?, seqs?, count }`，见[擦除](#擦除)                                                                                                                       |
| `ctx.redacted`    | 存储          | `RedactedData`：`{ type?, role? }`，被涂改的条目留下的占位                                                                                                                         |

这些事件缺省对模型不可见，和应用事件一样由投影规则决定要不要渲染。

`ctx.unreadable` 不是写进去的条目，是读的时候给的占位：存储读到解不了的一行（格式版本比自己认识的高、带不认识的部件）时，缺省抛错——调用方看得到问题，不会拿着缺了一块的历史接着跑。实现可以另给宽松模式（`UnreadableMode` 的 `placeholder`，`ctx-sqlite` 和 `ctx-remote` 客户端的 `unreadable` 选项），这时那一行读成一条 `ctx.unreadable` 事件：`id`、`session`、`seq`、`at` 是那一行自己的，所以 `after`、`watch`、`expectSeq` 照常能用，会话其余部分照常能读；`data` 记着原来的 `v`、`type` 和错误。它是事件，缺省不进模型上下文；因为不是存进去的 `kind`，`list({ kinds })` 筛不出它。`readEntry(raw, mode?, fallback?)` 是这条规则的实现（`upgradeEntry` 加上占位），`unreadableEntry(raw, error)` 构造占位条目。

纯函数：`upgradeEntry`（见下）；`userEntry`、`assistantEntry`、`messageEntry`、`eventEntry`、`summaryEntry` 构造条目；`runStartedEntry`、`runEndedEntry`、`compactedEntry`、`ctxErrorEntry`、`erasedEntry` 构造框架事件（可选字段不给时不出现在 `data` 里）；`isFrameworkKind`；`isEvent(entry, kind)`、`runIdOf(entry)` 认一条事件是哪种、属于哪一轮，`ctxEventData(entry, kind)` 按 `CtxEventData`（框架事件的 `kind` 到 `data` 的类型）读回 `data`：必填字段不对返回 `undefined`，可选字段只留类型对的，`ctx.run.started` 的 `agent` 缺了给 `{}`；`lastHarnessRun(lifecycle, name)` 找名叫 `name` 的外部 harness 最近一轮记下的 `harness.session`；`compareEntries`、`textOf`；`filterEntries(entries, options)` 是 `ListOptions` 的语义，`filterSessions(names, options)` 是 `SessionsOptions` 的语义，`eraseEntries(entries, erasure)` 是三个擦除方法的语义，内存里的存储可以直接用；`redactedEntry(raw)` 构造涂改之后的占位，`isErased(data, seq)` 判断一条擦除记录动没动某个位置。

### 擦除

```ts
type EraseOp = 'truncate' | 'remove' | 'redact';
interface ErasedData {
  op: EraseOp;
  upTo?: number; // truncate：被删掉的条目里最大的 seq
  seqs?: readonly number[]; // remove、redact：动了的条目的 seq，升序
  count: number; // 动了多少条
}
interface RedactedData {
  type?: string; // 原来的类型：message、event、summary
  role?: string; // 原来是消息时它的角色
}
type Erasure = { op: 'truncate'; upTo: number } | { op: 'remove' | 'redact'; ids: readonly string[] };
function eraseEntries(
  entries: readonly Entry[],
  erasure: Erasure,
): { entries: Entry[]; touched: Entry[]; erased?: ErasedData };
```

`clear` 之外的三个方法合称擦除。各自做什么：

| 方法                   | 做什么                                                                                                                                                                                                              |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `truncate(session, n)` | 删掉 `seq ≤ n` 的条目。`n` 小数向下取整，不是有限数时什么都不删。清理被摘要盖住的历史时 `n` 给摘要的 `covers`                                                                                                       |
| `remove(session, ids)` | 按 `id` 真删。删掉之后它的 `id` 和 `key` 可以再用（和 `clear` 一样）                                                                                                                                                |
| `redact(session, ids)` | 按 `id` 涂改：条目变成一条 `ctx.redacted` 事件，`id`、`session`、`seq`、`at`、`key`、`source` 留着，`v` 是当前版本，消息、文字、数据、`meta` 都去掉，`data` 是 `RedactedData`。已经涂改过的跳过，所以重复调是空操作 |

共同的规则：

- 都返回真正动了的条数。认不得的 `id`、别的会话的 `id` 跳过，不算错；重复的 `id` 只算一次。
- 只按 `id`、`seq` 这些列操作，不解码正文：读不了的行（`unsupported_version`、`unsupported_part`）也删得掉、涂得掉，涂改之后就读得了。坏行的 `id` 从宽松模式的 `ctx.unreadable` 占位上拿。
- **原子**：要么都做，要么都不做，不和并发的 `append` 交错。
- **留一条记录**：真的动了条目时，存储在同一次操作里追加一条 `ctx.erased`（`ErasedData`，`source: 'store'`），只有位置，没有内容。什么都没动（返回 0）就不追加。
- **`seq`**：不回退、不复用，剩下的条目 `id`、`seq`、`at` 都不变。因为有那条记录，擦除之后会话的末尾一定往前走一格——哪怕删掉的是最后一条、哪怕整个会话都删了（这时会话里只剩那条记录，`sessions` 还列它）。
- **`expectSeq`**：所以拿着擦除之前的末尾当前提的写入一定 `conflict` 一次，重读就看得到记录。擦除自己不收 `expectSeq`。
- **`watch`**：订阅方收得到 `ctx.erased`，照着它改自己手里的副本（镜像、界面）；被删、被涂改的条目本身不会重发。
- **摘要的 `covers`**：`truncate(session, covers)` 之后摘要照常生效，它代替的条目不在了而已。比 `covers` 小的位置上的更早的摘要也一起删掉。擦除不改摘要的文字：摘要是从被盖住的条目算出来的，删掉条目不会把内容从摘要里拿掉；要一起清，把摘要也 `redact` 掉再重新压缩。被 `redact` 的摘要不再是摘要，被它盖住、还在的条目重新可见。
- **涂改之后的投影**：`ctx.redacted` 是事件，缺省不进模型上下文；工具调用和结果少了一边由投影补齐或去掉（见[上下文](#上下文-contextbuilder)）。想在原位留一句「已删除」，给 `ctx.redacted` 写一条事件规则，`data.role` 是原来的角色。
- **生命周期事件**：删掉一轮的 `ctx.run.ended` 而留着它的 `ctx.run.started`，会话会被当成有未结束的运行，要 `recover` 才解开。
- **运行中的 harness**：见 [Harness](#harness) 的写入规则——这一轮自己写的条目被擦除，它在下一次写入时停下。

`clear` 不在这几条里：它不留记录，会话回到空，末尾回到 0（`seq` 仍然不复用），`sessions` 不再列它，`watch` 的订阅方收不到通知。运行中的 harness 靠「自己的 `ctx.run.started` 不在了」发现它。要留痕迹的清空用 `truncate(session, 末尾)`。

擦除管的是存储里的条目。摘要里的文字、记忆里从这些条目提取的事实、备份，都不在这个保证里；各实现在介质上擦到什么程度见它们的说明（`ctx-sqlite` 见[包说明](../packages/sqlite/README.md#删除和文件大小)）。

### 导出、导入、复制

```ts
interface SessionExportHeader {
  format: 'ctx.session';
  version: number; // SESSION_EXPORT_VERSION，当前是 1
  session: string; // 导出时的会话名
  exportedAt: number;
}
interface SessionExportEnd {
  end: true;
  entries: number; // 中间的条目行数
}

function exportSession(
  store: Pick<SessionStore, 'list'>,
  session: string,
  options?: { pageSize?: number; unreadable?: 'throw' | 'skip'; now?: () => number; signal?: AbortSignal },
): AsyncGenerator<string>;

type ImportIds = 'keep' | 'new' | ((id: string) => string);
function importSession(
  store: Pick<SessionStore, 'append' | 'list'>,
  source: string | Iterable<string> | AsyncIterable<string>,
  options?: { session?: string; ids?: ImportIds; batchSize?: number; signal?: AbortSignal },
): Promise<{
  session: string;
  header: SessionExportHeader;
  read: number;
  written: number;
  skipped: number;
  remap(seq: number): number;
}>;

function copySession(
  source: Pick<SessionStore, 'list'>,
  from: string,
  target: Pick<SessionStore, 'append' | 'list'>,
  to: string,
  options?,
): Promise<ImportSessionResult>;
```

`seq` 是各个存储自己分配的，所以把会话搬到别的存储（换实现、备份恢复、分叉、改名）不能 `list` 再 `append`：摘要的 `covers` 还是源存储的 `seq`，到了目标存储要么盖住不该盖的，要么什么都盖不住。这三个函数只用 `list` 和 `append`，对任何实现都能用，搬的时候把引用 `seq` 的字段换掉。

**格式**是 JSON Lines（一行一个 JSON 对象，`\n` 结尾）：第一行 `SessionExportHeader`，中间每行一条条目（`list` 返回的形状，按 `seq` 升序，`v` 是导出时的 `ENTRY_VERSION`），最后一行 `SessionExportEnd`。没有结束行的文件是截断的。

**导出**分页读（`pageSize`，缺省 500），不是快照：导出期间别人写进来的条目读到哪算哪。读到 `ctx.unreadable` 占位（存储在宽松模式下解不了的行）缺省抛 `unreadable`，不把缺了一块的历史当成完整的导出去；`unreadable: 'skip'` 跳过那一行。

**导入**的规则：

- `source` 是整份文本，或者按任意位置切开的文本块（文件流、`exportSession` 的返回值）。
- 目标会话缺省是头里记的名字，`session` 改名。`at`、`key`、`source`、`meta` 原样保留，`session`、`seq`、`v` 由目标存储填。
- **`seq` 的引用跟着换**：摘要的 `covers`、`ctx.compacted` 的 `covers` 换成 `remap(旧值)`——源会话里 `seq` 小于等于它的条目中最后一条在目标会话里的 `seq`，一条都没有（盖住的条目已经被 `truncate` 掉）是 0。所以源会话里被摘要盖住的条目，导过去还是那些被盖住。`ctx.erased` 的 `upTo` 同样换；`seqs` 只留文件里还在的位置（涂改的占位），被删掉的条目没有位置可指。返回值里的 `remap` 给会话之外引用 `seq` 的东西用（记忆的 `SourceRef`、应用自己存的位置）。
- **`id`**：`keep`（缺省）保留。`id` 全局唯一，所以同一份文件导两次只有一份，中途失败之后拿完整的文件再导一次就接上；也因此不能在同一个存储里复制——条目的 `id` 已经在别的会话里时抛 `conflict`，不静默丢掉。`new` 让目标存储重新生成，重复导入会写出第二份。给函数就按它换（同样的输入要给同样的输出），重复导入还是只有一份。`ctx.compacted` 的 `summaryId` 跟着摘要的新 `id` 走。
- **不是原子的**：按批 `append`（`batchSize`，缺省 200），中途失败时已经写的留在目标会话里。截断的文件读到头抛 `invalid_request`，读到的部分已经写进去。
- 行的 `v` 比自己的 `ENTRY_VERSION` 低就升级（同 `upgradeEntry`），高就抛 `unsupported_version`；头的 `version` 比 `SESSION_EXPORT_VERSION` 高同样抛。不是导出文件、行的顺序不对、条数和结束行对不上，抛 `invalid_request`。
- 不检查目标会话是不是空的：往有内容的会话里导，导进来的摘要会把原有的条目一起盖住。

`copySession` 是导出接导入。两个存储是同一个对象时 `ids` 缺省 `new`，否则 `keep`；同一个库的两个客户端看不出来是同一个，自己给 `ids`。

### 消息格式和版本

协议包定义 ctx 自己的 `Message`（`system`、`user`、`assistant`、`tool` 四种角色），是 AI SDK `ModelMessage` 的子集，但全是 JSON：

| 部件                                 | 形状                                                                                                                                                |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `text`、`reasoning`                  | `{ type, text, providerOptions? }`；推理签名放在 `providerOptions`，原样保存，回传时要用                                                            |
| `file`                               | `{ type, mediaType, data: ToolFileData, filename?, providerOptions? }`；`mediaType` 可以只写 `image`；AI SDK 已弃用的 `image` 并入 `file`           |
| `reasoning-file`                     | 同 `file`，但 `data` 只有字节（`data`）和地址（`url`）两种，和 AI SDK 一致                                                                          |
| `custom`                             | `{ type, kind, providerOptions? }`，服务商自定义内容                                                                                                |
| `tool-call`                          | `{ type, id, name, input, providerExecuted?, providerOptions? }`，字段名同 `ToolCall`                                                               |
| `tool-result`                        | `{ type, id, name, output: ToolOutput, providerOptions? }`                                                                                          |
| `tool-approval-request`、`-response` | `approvalId`、`callId`、`reason?`、`approved`……；请求另带 `isAutomatic?`、`signature?`、`inputSchemaInput?`（签名把批准绑定到调用上，丢了就验不过） |

`ToolFileData` 是 `{ type: 'data', data: base64 } | { type: 'url', url } | { type: 'reference', reference } | { type: 'text', text }`。`tool-result.output` 里的 `providerOptions` 和 `custom` 内容分段没有可序列化的内容，转换时丢掉。

- 和 AI SDK 互转在 `@modelctx-ai/ctx`：`toModelMessages`、`fromModelMessages`（`createContext()` 仍收 AI SDK 的 `UserContent`，在边界上转）。遇到子集之外的部件（AI SDK 以后新加的）抛 `unsupported_part`，不静默丢；harness 把这一轮以 `error` 结束，写 `ctx.error`，不写半截的产出。核心包里有编译期的穷尽检查（`AI_SDK_PART_TYPES`）：AI SDK 在 `UserContent`、`AssistantContent`、`ToolContent` 里加了部件，核心包编译不过。
- `ENTRY_VERSION = 1`，每个条目带 `v`。存储写新行时写 `v: 1`，读时对每一行调 `upgradeEntry(raw)` 升到当前形状，**不回写**旧行。没有 `v` 读作 0（0.2 及以前的写法：AI SDK 消息原样，二进制和 URL 用 `\u0000ctx` 标记，摘要的 `covers` 是 `{ at, seq }`）；0 → 1 把消息转成 `Message`，`covers` 取 `covers.seq`。读出来的 `Entry.v` 是这一行写入时的版本（旧行是 0），形状已是当前的；比自己认识的更高的 `v` 抛 `unsupported_version`，升级 ctx 再读（宽松模式下读成 `ctx.unreadable`，见上面）。远端客户端按同一条规则检查服务端给的条目。
- 滚动升级：新旧版本共用一个库（或一个远端）时，**读的一方先升**。新版本一旦写了新格式的行，旧进程对这个会话的 `list`、`view`、`watch` 都会抛 `unsupported_version`；要让旧进程在过渡期继续工作，给它开 `unreadable: 'placeholder'`，代价是新格式的条目它看不到。没有降级路径：`ctx-sqlite` 的结构迁移（改列名、换索引）不可逆，旧版本打不开升过级的库。
- 0 版的摘要按 `at` 盖住旧条目，1 版按 `seq`，所以补写的旧记录可能被旧摘要盖住。`@modelctx-ai/ctx` 的 `findLossySummaries(store, { session? })` 只读，列出 `v` 为 0 且有条目被盖住的摘要 `{ session, summaryId, covers, hidden: seq[] }`；`recompactLossy(builder, finding, options)` 追加一条 `covers` 相同的新摘要（输入是旧摘要的文字加上被盖住的条目），靠「`covers` 相同时后写的生效」取代旧摘要。新摘要是 `v: 1`，所以 `findLossySummaries` 跑第二次找不到东西，可以放在启动阶段反复跑。

## 上下文 `ContextBuilder`

把会话日志、来源取到的事实、这一轮的输入组装成一次调用。它持有一个 `SessionStore`，harness 只给它会话名。

```ts
interface WindowOptions {
  maxMessages?: number; // 摘要不算
  maxTokens?: number; // 估算，摘要计入
  truncate?: boolean; // 放不下时截短消息，不只是整条丢；缺省不截
}
interface BuildRequest {
  session: string;
  input?: MessageContent; // 这一轮的输入；已经写进日志时不传
  instructions?: string; // AgentSpec 的指令
  prompt?: MessageContent; // 最后一条临时用户消息，不写日志
  tools?: readonly ToolDefinition[]; // 候选工具，builder 可以再筛
  window?: WindowOptions;
  facts?: boolean | FactsSpec; // 是否收集来源，缺省收集；FactsSpec 另选来源、位置、标题
  projection?: string; // 投影配置名，缺省 default；不认识的名字 build 以 not_found 失败，不回退
  signal?: AbortSignal;
}
interface PreparedCall {
  instructions?: string; // 指令 + 事实 + 投影里的 system 文字
  messages: Message[]; // 不再含 system 消息
  tools: readonly string[]; // 这次给模型的工具名
  facts: readonly Fact[];
  projection: Projection;
  tokens?: number; // 整次调用的估算：指令、事实、工具定义、消息；校准过的话乘上了 calibration；harness 的超窗检查用它
  calibration?: number; // 按上一轮的实际用量校准时乘上的倍数（大于 1）；没校准时不出现
}
interface CompactOptions {
  model?: ModelRef;
  keep?: number; // 最近多少条原样保留
  minimum?: number; // 更早的少于这么多条就不压缩
  instructions?: string;
  maxInputTokens?: number; // 一次交给摘要模型的输入的上限（估算）；历史超过它就分段滚动摘要
  maxOutputTokens?: number; // 每次摘要输出的上限
  timeoutMs?: number; // 整次压缩，分段时含每一段
  signal?: AbortSignal;
}
type CompactStatus = 'compacted' | 'not_needed' | 'truncated' | 'empty' | 'input_too_long';
interface CompactResult {
  status: CompactStatus;
  summary?: SummaryEntry; // 这次写下的最后一条摘要（现在生效的）；一条都没写时没有
  calls: number; // 调了几次摘要模型
  compacted: number; // 已经进了摘要的消息条数
  remaining: number; // 该进、这次没进去的条数
  shortened: number; // 进摘要的输入之前被截短的消息条数
}
interface ContextBuilder {
  build(request: BuildRequest): Promise<PreparedCall>;
  /** 当前视图：摘要 + 之后的条目，按规则渲染。网关用它。 */
  view(session: string, options?: { window?: WindowOptions; projection?: string }): Promise<Projection>;
  /** 把较早的历史压成摘要并追加，同时记 ctx.compacted。这次没写下摘要时返回 null。 */
  compact?(session: string, options?: CompactOptions): Promise<SummaryEntry | null>;
  /** 同 compact，返回怎么收场的。 */
  compactDetailed?(session: string, options?: CompactOptions): Promise<CompactResult>;
}

interface ContextSource {
  name: string;
  collect(context: { session: string; signal?: AbortSignal }): Awaitable<string | null | undefined>;
}
interface Fact {
  source: string;
  text: string;
}

// 投影：纯函数 project(entries, options) 的输入输出
interface ProjectionOptions {
  events?: Record<string, EventRule>; // 没有规则的事件不进上下文
  summary?: (entry: SummaryEntry) => Message;
  message?: (entry: MessageEntry) => Message | null | undefined;
  window?: WindowOptions & { estimate?: (message: Message) => number }; // ProjectionWindow
}
interface EventRule {
  fold?: boolean;
  render(events: readonly EventEntry[]): Message | readonly Message[] | null | undefined;
}
interface Projection {
  messages: Message[];
  items: readonly ProjectedMessage[]; // 每条带 from、upTo、at、pinned、tokens
  tokens: number;
  dropped: number; // 被窗口丢掉的消息条数；projectSession 只读了尾部时只数读到的部分
  truncated: number; // 因为 window.truncate 被截短的消息条数
  summary?: SummaryEntry;
}
```

- 参考实现 = 投影规则（事件渲染、摘要渲染、消息改写、窗口）+ 来源 + 压缩，就是今天 `createContext` 里的 `prepare`、`view`、`compact`。
- 投影、来源收集、token 估算和截短是纯函数，放在协议包：`project(entries, options)`、`projectSession(store, session, options)`、`latestSummary`、`defaultSummaryMessage`、`collectFacts(sources, { session, timeoutMs?, only?, logger?, onError? })`（`only` 按名字挑来源，`logger` 记出错、超时和没注册的名字）、`renderFacts`、`defineSource`、`estimateTokens`、`estimateTextTokens`、`estimateFileTokens`、`truncateText`、`truncateMessage`。语义见[架构](architecture.md#投影)。
- 长会话不必整段读出来：`projectSession` 读生效的摘要和它之后的条目再投影，结果和读出来再 `project` 一样，但有窗口时只读够用的尾部。按 `seq` 读最后 N 条（`last`），用 `atAfter` 补上写得更早、`at` 却排在这 N 条之后的条目，这样读到的是投影顺序里完整的一段尾巴；窗口把开头可能不完整的那组（同类事件合成的一组被切开，或者工具结果的调用在更前面）和后面至少一个完整的组都挤掉了，就说明更早的部分不会再进窗口，否则读 4 倍那么多再来。没有窗口（或者是 `{}`）时读整段。参考实现的 `view`、`build` 用它。
- 投影的输出是模型接口收得下的消息序列，不管日志里是什么样、窗口裁在哪：工具结果找不到对应的调用（调用被裁掉了、或者本来就没有）就去掉；工具调用没有结果（运行断在中间）就补一条错误结果（`No result was recorded for this tool call.`），服务商自己执行的调用（`providerExecuted`）除外；窗口裁剪之后，开头不留孤立的工具结果，没有摘要时也不以助手消息开头（接着裁到下一条用户消息）。工具确认的两个部件（`tool-approval-request`、`tool-approval-response`）只给应用看，投影时去掉（`withoutApprovals(message)`，去掉之后空了的消息不要）：确认了的调用由 harness 执行、写下结果，模型看到的是调用和结果。
- 窗口的两处配置：请求里的 `window`（`BuildRequest`、`ViewOptions`、`AgentSpec`）给了就**整个换掉** builder 配置的上限，`{}` 表示不裁剪；`estimate` 是函数、过不了线，始终用 builder 的。`build` 的 `maxTokens` 管的是整次调用：指令、事实、工具定义、`input`、`prompt` 的估算先从里面扣掉，剩下的才是历史的预算；`view` 没有这些，`maxTokens` 就是历史的预算。
- `window.truncate`：缺省窗口只会整组地丢，至少留下最后一组，哪怕它自己就超预算（一条 25 万 token 的工具结果、一段粘贴进来的长文）。给了 `truncate: true`（要同时有 `maxTokens`）就再多做两步：先给单条消息封顶，超过历史预算一半的截到一半，免得它把别的历史全挤掉；丢到只剩最后一组还超，从最大的消息接着截，直到放得下。截短用 `truncateMessage(message, maxTokens, estimate?)`：文字留头尾、中间写明省略了多少字符（`truncateText(text, maxTokens, estimate?)`），工具结果先把内联的文件换成一句说明、再把内容写成文字截短（错误结果只截信息、去掉 `data`），消息里内联的文件换成说明；推理、工具调用的输入、服务商自定义内容不动（截了签名对不上、调用不再合法），所以结果仍可能超。截短只发生在这一次投影里，日志不变；`Projection.truncated` 是被截短的条数。
- 压缩（`compact?`、`compactDetailed?`）：
  - **分段。** 要压的历史超过 `maxInputTokens`（压缩指令、已有的摘要、这一段记录合起来的估算）就一段一段滚动摘要：每段连同到目前为止的摘要交给模型，得到的新摘要带进下一段。工具调用的输入和工具结果在进摘要的输入之前截短；单条消息就超过一段的预算时也截短，不然永远过不去。
  - **检查点。** 每段压完就追加一条 `summary` 和一条 `ctx.compacted`（`covers` 落在这一段和下一段之间；工具调用和它的结果不切到两边）。中途模型出错、超时、被截断，已经压好的留着，再调一次从那里接着压。所以一次压缩可以留下多条摘要，生效的只有最后一条。
  - **收场。** `compactDetailed` 的 `status`：`compacted` 该压的都进了摘要；`not_needed` 历史不够长，没调模型；`truncated` 某一段的摘要被 `maxOutputTokens` 截断，那一段不写、停在那里；`empty` 模型没给出文字，同样不写；`input_too_long` 分段之后还是放不下——已有的摘要加指令就占满了 `maxInputTokens`，或者摘要模型自己报上下文过长、一段减半到底也不行。`compact` 是它的简写：返回这次写下的最后一条摘要，一条都没写就是 `null`。模型调用本身的错误（网络、超时）照常抛出。
  - **`at` 在未来的条目。** 把到期时间当 `at` 的事件一直排在视图的最后。数「最近 `keep` 条」时不算它们：写在切点之前的进摘要，写在切点之后的照常留在视图里。以前它的 `seq` 会把 `covers` 钉在自己前面，之后写的消息永远压不了。`ProjectedMessage.at` 是这条消息来自的条目里最晚的 `at`。
- token 估算不分词：中日韩文字一个字算 1，ASCII 4 个字符算 1，其余文字 2 个字符算 1；附件按 `estimateFileTokens(mediaType, data)`——内联文字按字数，base64 按解码后的大小（图片 64 KiB 以内 256、更大 1600；文本类按字节数除以 4；其余每 20 字节 1 个、至少 256），地址和服务商引用不知道大小，按 256。要准就在 `window.estimate` 里接分词器。harness 把第一步请求的估算记进 `StepMeta.estimatedInputTokens`，和 `usage.inputTokens` 一比就知道偏了多少；参考实现的 builder 拿这个比值收紧下一轮的 `maxTokens`（`PreparedCall.calibration`，只往小里收），见[架构](architecture.md#调用)。
- `ProjectionOptions` 里有函数，是进程内 builder 的配置，不经过协议方法；协议方法里只出现能序列化的 `WindowOptions`。
- 提示缓存：事实追加在指令末尾会让 system 前缀每次都变，参考实现提供把事实放进最后一条临时用户消息的选项。

## 工具 `ToolRegistry`

工具目录。目录里是定义，不是函数；每个定义绑一个执行环境的名字。

```ts
interface ToolDefinition {
  name: string; // [a-zA-Z0-9_-]{1,64}
  description?: string;
  inputSchema: JsonObject; // JSON Schema
  executor: string; // 执行环境的名字
  source?: string; // local、mcp:<server>、process…
  tags?: readonly string[];
}
/** 能序列化的筛选：每一项里任一个命中即可，给了的几项都要命中。 */
type ToolSelection =
  | boolean
  | readonly string[]
  | { names?: readonly string[]; tags?: readonly string[]; sources?: readonly string[] };
/** 进程内还可以用函数。 */
type ToolFilter = ToolSelection | ((tool: ToolDefinition) => boolean);

interface ToolRegistry {
  size: number;
  add(definition: ToolDefinition, options?: { replace?: boolean }): ToolRegistry;
  remove(name: string): boolean;
  removeSource(source: string): number;
  has(name: string): boolean;
  get(name: string): ToolDefinition | undefined;
  list(): ToolDefinition[]; // 按加入的顺序
  select(filter?: ToolFilter): ToolDefinition[]; // 同 selectTools(list(), filter)
  executor?: Executor; // 注册表自带的执行环境（参考实现放 addTool 的函数），harness 和自己的执行环境一起用
}
```

- `add` 在名字不合法、或同名已存在且没给 `replace` 时抛错。目录是同步的：它跟着 harness 走，不单独跨边界。
- 纯函数：`isValidToolName`、`matchesTool`、`selectTools`。
- 参考实现另给糖：`registry.addTool(name, aiSdkTool, meta)` 把 zod 工具转成 JSON Schema 定义，执行函数放进一个进程内的函数执行环境。
- 命名约定来自 Anthropic 的工具设计文章：按服务和资源加前缀（MCP 工具是 `<server>__<tool>`），参数名不含糊（`user_id` 不是 `user`），说明写给新同事看。

## 执行环境 `Executor`

工具调用真正发生的地方。

```ts
interface ToolCall {
  id: string;
  name: string;
  input: JsonValue;
}
type ToolOutput =
  | { type: 'text'; text: string }
  | { type: 'json'; value: JsonValue }
  | { type: 'content'; parts: readonly ToolContentPart[] }
  | { type: 'error'; message: string; retryable?: boolean; data?: JsonValue };
type ToolContentPart =
  | { type: 'text'; text: string }
  | { type: 'file'; mediaType: string; data: ToolFileData; filename?: string };
type ToolFileData =
  | { type: 'data'; data: string } // base64
  | { type: 'url'; url: string }
  | { type: 'reference'; reference: Record<string, string> } // 服务商的文件引用
  | { type: 'text'; text: string };

interface ExecutionContext {
  session: string;
  runId?: string;
  signal?: AbortSignal;
}
interface Executor {
  name: string;
  /** 它能执行哪些工具。MCP、子进程这类执行环境自己报；函数执行环境报注册进来的。 */
  tools?(): Promise<ToolDefinition[]>;
  /** 不认识的工具、signal 已中止都返回 { type: 'error' }。 */
  execute(call: ToolCall, context: ExecutionContext): Promise<ToolOutput>;
  provision?(): Promise<void>; // 可以重复调
  dispose?(): Promise<void>;
  /** 为一个会话准备好（起容器、建工作目录）；可以重复调。满足不了 environment 时抛 invalid_request。 */
  open?(session: string, options?: ExecutorSessionOptions): Promise<void>;
  close?(session: string): Promise<void>; // 可以重复调，之后还能再 open
}
interface ExecutorSessionOptions {
  environment?: EnvironmentSpec;
  signal?: AbortSignal;
}
interface EnvironmentSpec {
  name?: string;
  image?: string; // 镜像或模板
  packages?: Record<string, string[]>; // 按包管理器：{ pip: ['pandas'] }
  network?: { allow?: string[] }; // 出站白名单
  env?: string[]; // 要哪些环境变量的名字，值由部署方给
  meta?: JsonObject; // 实现自己的配置
}
```

- 执行出错返回 `{ type: 'error' }` 而不是抛：模型要看到错误才能接着做。抛出表示执行环境本身坏了。错误信息要能照着做（「文件不存在：/a/b，当前目录有 …」），不是错误码。
- 工具边界上的两件事各归谁：
  - **输入**由 harness 在执行前按 `ToolDefinition.inputSchema` 校验，不合的不执行，把问题作为 `{ type: 'error' }` 回给模型重试。这样只给 JSON Schema 的执行环境（远端、MCP、子进程）不用各写各的，模型看到的错误也是同一种写法。纯函数 `checkJsonSchema(schema, value, limit?)` 返回问题的列表，只查认识的关键字（`type`、`enum`、`const`、`required`、`properties`、`patternProperties`、`additionalProperties`、`items`、`prefixItems`、长度和数值的上下限、`pattern`、`allOf`、`anyOf`、`oneOf`、`nullable`），其余一概放行：报出来的一定是真问题，没报不等于完全合规。执行环境对自己在意的约束仍然要自己查，直接调 `execute` 的调用方不经过这一层。执行环境手里有比 JSON Schema 更准的 schema、自己会校验的（参考实现里 `addTool` 的 zod 工具），harness 可以不重复查。
  - **输出**由执行环境截断或分页，再交给模型：它知道怎么截才有用（命令输出留头尾、文件按行分页）。harness 另兜一层底：一次结果超过上限（可配，缺省 `DEFAULT_MAX_TOOL_OUTPUT_CHARS`，20 万字符）时截断并注明省略了多少，免得哪个执行环境忘了就把上下文塞满。纯函数 `limitToolOutput(output, maxChars)`：文字和错误信息直接截，`json` 序列化后超了换成截断的文字，`content` 各段合起来算、放不下的内联文件换成一句说明。
- 和 AI SDK 互转：`toolOutputToAiSdk(output)` 得到工具结果的 `output`（`text`、`json`、`error-text`、`error-json`、`content`），`toolOutputFromAiSdk` 转回来。协议 → AI SDK → 协议不丢信息：只有文字的错误是 `error-text`，带 `retryable` 或 `data` 的是 `error-json` 的 `{ message, retryable?, data? }`；`URL` 规范化会改写法时原串放进 `originalUrl`。反方向：二进制变 base64，已弃用的 `image-data`、`file-url` 等换成 `file`，`execution-denied` 变成错误，任意形状的 `error-json` 整个放进 `data`，`providerOptions` 和 `custom` 分段丢掉。
- `errorOutput(message, { retryable?, data? })` 构造错误结果。
- `Executors` 是执行环境的集合：数组按各自的 `name`，对象按键。`executorMap(executors, registry?)` 给出按名字查的表，注册表自带的（`ToolRegistry.executor`）也加进来，同名的以 `executors` 为准；`executorTools(executors)` 是各执行环境 `tools()` 报的定义，同名的只留第一个。
- **每会话的执行环境（[ADR 0009](adr/0009-hosted-prerequisites.md)）。** `provision`、`dispose` 管整个执行环境，`open`、`close` 管一个会话：每个会话一个容器、一个工作目录。harness 在一轮里第一次把调用交给某个执行环境之前调一次它的 `open(session, { environment: agent.environment })`；`open` 抛错时这一轮交给它的调用都得到错误结果，模型看得到原因，这一轮照常往下走。会话什么时候结束由应用决定，框架不猜：应用调各个执行环境的 `close`（参考实现的 `closeExecutorSessions(executors, session)`）。闲置回收是执行环境自己的策略。`EnvironmentSpec` 满足不了（没有那个镜像、不支持白名单、要的变量没配）时 `open` 抛 `invalid_request`，不静默降级。
- **凭证不进执行环境。** 凭证不出现在 `ToolCall`、`ExecutionContext`、`AgentSpec` 里，日志里也就没有；`EnvironmentSpec.env` 只有变量的名字。需要凭证的工具放在 harness 这一侧执行（函数执行环境、MCP 服务器），模型生成的代码碰不到；一定要在沙箱里用的，由部署方在出口替换：沙箱里只有占位符，出站代理换成真的。交给子进程的环境变量模型生成的代码读得到。
- 实现：进程内函数（核心包）、MCP 服务器（`ctx-mcp`）、本机子进程（`ctx-exec`，`sessionCwd` 时每个会话一个工作目录）、HTTP 远端（`ctx-remote`）。反方向：`ctx-mcp` 的 `createMcpServer` 把执行环境包成 MCP 服务器（stdio 或 Streamable HTTP），自带循环的程序经它调 ctx 的工具；调用方不经过 harness，所以输入检查、结果截断、执行前 `open` 会话（`open`）和 `deny`（`permissions`）都在它这边做。`listenMcpHttp` 在本机起一个带一次性令牌的 HTTP 服务器，给自己起的子进程连。
- 远端执行环境有两种接法：harness 调它（它是服务），或它从 harness 领工作（它是只需出站连接的 worker，像 Managed Agents 的自托管沙箱）。协议相同，`ctx-remote` 两种都有：服务端挂 `executors`，或者 worker 按名字领工作（`POST /work/:executor/claim`，见下面「工具调用经日志往返」）。

## Harness

一轮运行。

```ts
type ModelRef = string | Exclude<LanguageModel, string>; // 跨边界只能是名字

interface CallSettings {
  temperature?: number;
  maxOutputTokens?: number;
  topP?: number;
  topK?: number;
  presencePenalty?: number;
  frequencyPenalty?: number;
  seed?: number;
  stopSequences?: readonly string[];
  maxRetries?: number;
  timeoutMs?: number; // 整轮（含工具步骤）
  headers?: Record<string, string>;
  providerOptions?: Record<string, JsonObject>;
}
interface AgentSpec {
  name?: string;
  model: ModelRef;
  instructions?: string;
  tools?: ToolSelection; // 缺省全部
  maxSteps?: number; // 缺省：有工具 5，没有 1
  window?: WindowOptions;
  context?: ContextSpec; // 这个 agent 的上下文怎么组装
  settings?: CallSettings;
  version?: string; // 应用给这份配置的版本标识，记进 ctx.run.started
  output?: OutputSpec; // 结构化输出
  toolChoice?: ToolChoice; // 缺省 auto
  permissions?: ToolPermissions; // 按工具名的允许、询问、拒绝
  budget?: RunBudget; // 整轮的上限，在步骤之间检查
  environment?: EnvironmentSpec; // 交给执行环境的 open，见「执行环境」
}
interface OutputSpec {
  schema: JsonObject; // JSON Schema
  name?: string;
  description?: string;
}
type ToolChoice = 'auto' | 'none' | 'required' | { tool: string };
type ToolPermission = 'allow' | 'ask' | 'deny';
interface ToolPermissions {
  default?: ToolPermission; // 缺省 allow
  tools?: Record<string, ToolPermission>;
}
interface RunBudget {
  maxTotalTokens?: number; // 所有步骤加起来的 totalTokens
  maxDurationMs?: number; // 从这一轮开始算的墙钟时间
}
interface ContextSpec {
  facts?: boolean | FactsSpec; // false 不收事实；缺省收
  projection?: string; // builder 里注册的投影配置名；缺省 default
  overflow?: OverflowSpec; // 整次调用超过模型窗口时怎么办；缺省不检查
  inherit?: InheritSpec; // 把另一个会话（一般是父会话）的投影接在前面
}
interface InheritSpec {
  session: string;
  upTo?: number; // 只取到这个 seq，缺省全部
}
interface OverflowSpec {
  maxTokens: number; // 整次调用估算 token 的上限：模型的窗口减去留给输出的，再留余量
  strategy?: 'compact' | 'trim' | 'error'; // 缺省 compact：先压缩，还超再裁剪
  compact?: Pick<
    CompactOptions,
    'keep' | 'minimum' | 'instructions' | 'maxInputTokens' | 'maxOutputTokens' | 'timeoutMs'
  >;
}
interface FactsSpec {
  sources?: readonly string[]; // 只用这些来源（ContextSource.name）；缺省全部
  placement?: 'instructions' | 'prompt';
  heading?: string; // 事实前面的标题行
}
interface RunRequest {
  session: string;
  agent: AgentSpec;
  input?: MessageContent;
  inputKey?: string; // 输入的幂等键，重试不重复记
  prompt?: MessageContent; // 临时的最后一条，不写日志
  record?: boolean; // 缺省写日志
  runId?: string; // 不给就生成
  owner?: string; // 编排器实例名
  parent?: RunParent; // 这一轮是别的 agent 派来的
  signal?: AbortSignal;
}
interface RunParent {
  session: string; // 父会话
  runId: string; // 父运行
  toolCallId?: string; // 父会话里派它的那次工具调用
}
type StopReason = 'end_turn' | 'max_steps' | 'max_tokens' | 'max_budget' | 'requires_action' | 'aborted' | 'error';
interface Usage {
  inputTokens?: number; // 含缓存读到的和写进缓存的
  outputTokens?: number;
  totalTokens?: number;
  cacheReadTokens?: number; // 输入里从提示缓存读到的
  cacheWriteTokens?: number; // 输入里写进提示缓存的
  reasoningTokens?: number; // 输出里推理用掉的
}
interface StepMeta {
  // harness 写进每一步助手消息的 meta.step
  runId: string;
  step: number; // 从 0 数
  provider?: string;
  modelId?: string; // 服务商响应里的模型标识
  finishReason?: string;
  usage?: Usage; // 这一步的用量
  estimatedInputTokens?: number; // 只有第一步有：这次请求的估算（PreparedCall.tokens）
  calibration?: number; // 只有第一步有：估算里乘上的校准倍数
}
interface RunResult {
  runId: string;
  text: string;
  messages: Message[]; // 这一轮模型产出的消息
  recorded: readonly Entry[];
  stopReason: StopReason;
  usage?: Usage;
  output?: JsonValue; // 给了 agent.output 时解析出来的回答
  pending?: readonly ToolCall[]; // stopReason 是 requires_action 时，等着别处执行的调用
  approvals?: readonly ToolApproval[]; // pending 里等人确认的调用
  error?: ErrorInfo; // stopReason 是 error 时；上游 HTTP 接口出错时带 statusCode 和 responseBody；上下文过长时 type 是 context_overflow
}
interface ToolApproval {
  approvalId: string; // 写在调用的助手消息里的 tool-approval-request
  callId: string;
  reason?: string; // 给确认的人看
}
type RunEvent =
  | { type: 'run.started'; runId: string; session: string; seq?: number }
  | { type: 'model.started'; runId: string; step: number }
  | { type: 'text.delta'; runId: string; text: string }
  | { type: 'reasoning.delta'; runId: string; text: string }
  | { type: 'tool.called'; runId: string; call: ToolCall }
  | { type: 'tool.returned'; runId: string; callId: string; output: ToolOutput }
  | { type: 'model.ended'; runId: string; step: number; usage?: Usage; seq?: number }
  | { type: 'run.ended'; runId: string; result: Omit<RunResult, 'messages' | 'recorded'>; seq?: number }
  | { type: 'error'; runId: string; message: string };

type ToolDecision =
  | { allow: true; input?: JsonValue }
  | { allow: false; reason: string }
  | { ask: true; reason?: string };
interface ModelHookContext {
  runId: string;
  session: string;
  step: number;
  signal?: AbortSignal;
}
interface Hooks {
  beforeModel?(call: PreparedCall, context: ModelHookContext): Awaitable<PreparedCall | void>;
  beforeTool?(call: ToolCall, context: ExecutionContext): Awaitable<ToolDecision | void>;
  afterTool?(call: ToolCall, output: ToolOutput, context: ExecutionContext): Awaitable<ToolOutput | void>;
}
interface Harness {
  run(request: RunRequest): Promise<RunResult>;
  stream?(request: RunRequest): AsyncIterable<RunEvent>;
}
```

- `AgentSpec.context` 按一轮选事实和投影。函数（来源的 `collect`、投影的 `render`）不能序列化，所以只按名字选，和 `ToolSelection` 同一个思路：代码里向 builder 注册（`createContextBuilder({ sources, projection, projections })`），`context` 里引用名字。harness 把 `agent.context` 原样放进 `BuildRequest`；`RunRequest` 不加字段，`agent` 本来就是完整的。`context` 是 JSON，`ctx.run.started` 的 `agent` 会记下这一轮用的配置，远端不用改路由。第三方 builder 忽略 `context` 会静默回到缺省，harness 契约测试用「不认识的投影名必须以 `not_found` 结束」暴露它。
- 一轮里 harness 做的事：`ctx.run.started` → 记输入 → `ContextBuilder.build` →（配了 `context.overflow` 时）超窗检查 → 调模型 → 对每个工具调用：`beforeTool` → 找到绑定的执行环境 → `execute` → `afterTool` → 工具结果回到模型，直到停下 → `ctx.run.ended`。
- **每一步即时落日志。** 产出不等这一轮结束：模型这一步要调工具时，调用（助手消息）在工具执行之前写下；步骤结束时写这一步剩下的（工具结果，或者没有工具调用时的助手消息）；最后写 `ctx.run.ended`。每次写入都带 `expectSeq`。所以进程在任何时刻崩掉，日志里都有已经做完的步骤，至少有「调用已发出、结果未知」。这一轮半路结束（出错、被取消）时，已经写下的步骤留着；写下了调用、还没等到结果的工具调用先补一条错误结果，再写 `ctx.error` 和 `ctx.run.ended`。
- 模型出错、被取消也写 `ctx.run.ended`，`run` 照常返回，`stopReason` 和 `error` 说明原因；只有写日志本身失败才 reject。远端调用方因此总拿到同一种形状。
- `stream` 交出 `RunEvent`：调用方提前不读了，这一轮就中止。`streamRun(request, run)` 把边跑边交出事件的一轮（`run(request, emit)`）包成 `stream`，中止、等它结束和抛错都按这一条。
- **`AgentSpec` 里只能用 JSON 表达的能力**，换一个 harness、过一次 remote 都还在（#47）：
  - `version`：应用自己的版本标识，原样记进 `ctx.run.started`，回看时知道这一轮跑的是哪一版。
  - `output`：结构化输出。最后的回答按 `schema` 生成（服务商支持的话约束解码）、解析、按 `checkJsonSchema` 校验，放在 `RunResult.output`；不是 JSON 或不合 schema 时这一轮以 `error` 结束，`error.type` 是 `invalid_output`（`retryable: false`）。只在 `end_turn` 时解析：停在工具调用（`requires_action`、`max_steps`、`max_budget`）的没有回答可解析。
  - `toolChoice`：`auto`、`none`、`required`，或者 `{ tool }` 点名一个；点名的工具不在这一轮的工具里时 `invalid_request`。没有工具时忽略。
  - `permissions`：按工具名的 `allow`、`ask`、`deny`（`default` 缺省 `allow`；纯函数 `toolPermission(permissions, name)` 给出一个工具的）。`deny` 的不执行，模型看到拒绝，这一轮继续，绑到外部执行环境的工具也一样（`deny` 优先）；`ask` 的不执行，写下调用和确认请求后以 `requires_action` 停下，等应用的决定（见下面「人工确认」）。`Hooks.beforeTool` 在 `allow` 之后照常调。
  - `budget`：`maxTotalTokens`（所有步骤的 `totalTokens` 之和，没有时用输入加输出）、`maxDurationMs`（墙钟）。只在步骤之间检查：超了就不再走下一步，`stopReason` 是 `max_budget`；正在进行的模型调用和工具不会被打断，硬上限用 `settings.timeoutMs`。成本的上限不在这里：价格表是应用的事，用 `meta.step` 的用量自己算。
  - `environment`：这个 agent 要的执行环境，harness 原样交给执行环境的 `open`（见上面「执行环境」）。记进 `ctx.run.started`。
  - 这几项的值不对（预算不是正数、权限不是三个值之一、`output.schema` 不是对象）时这一轮以 `invalid_request` 结束。不支持某一项的 harness 不能静默忽略：要么以 `invalid_request` 结束，要么在一致性等级里注明。
- **工具调用经日志往返（[ADR 0008](adr/0008-tool-calls-through-the-log.md)）。** 绑定到「外部执行环境」的工具（由 harness 的实现配置，参考实现是 `createHarness({ external })`）交给模型，但不在 harness 这一侧执行：模型调用了它们，这一轮写下调用后以 `requires_action` 结束，`pending` 列出这些调用，不占会话。执行方追加结果：`toolResultEntry(call, output)` 是一条 `tool` 消息，带幂等键 `ctx.tool-result:<id>`（`TOOL_RESULT_KEY_PREFIX`），同一次调用只记一条。结果齐了以后，下一轮不带输入接着跑。`pendingToolCalls(entries)` 是纯函数，给出等待中的调用（`PendingToolCall`：`call`、`runId`、带调用的条目的 `seq`、`executor?`）：以 `requires_action` 结束的那一轮留下的，去掉后面已经追加了结果的；之后又有运行以别的原因结束，之前等着的就作废。结果一直不来时由应用决定：照常提交下一轮，投影给缺结果的调用补一条「没有记录到结果」。
  - **按名字领工作。** 以 `requires_action` 结束时，harness 在 `ctx.run.ended` 里记下留给外部执行环境的调用归谁（`RunEndedData.executors`：调用 `id` → 执行环境的名字，`ToolDefinition.executor`），`PendingToolCall.executor` 带着它；在 harness 里执行的调用（包括等确认的）不记。执行方据此按自己的名字找工作，不用知道有哪些会话：`ctx-remote` 的 `POST /work/:executor/claim`（见「线上形态」）。
- **人工确认（#21）。** 要等人决定的调用也走这条路：`ask` 权限的调用，和 `beforeTool` 按输入回了 `{ ask: true, reason? }` 的调用（输入不合 `inputSchema` 的先回给模型，不问钩子，也不问人）。这次调用不执行，harness 在这次调用的助手消息里写下确认请求（`tool-approval-request`：`approvalId`、`callId`、`reason`），这一步走完以 `requires_action` 结束，`pending` 里有这次调用，`approvals` 列出确认请求（`ToolApproval`）。
  1. 应用的决定是一条 `tool` 消息：`toolApprovalEntry(approvalId, { approved, reason? })`（`tool-approval-response`），带幂等键 `ctx.tool-approval:<approvalId>`（`TOOL_APPROVAL_KEY_PREFIX`），同一个请求只认先到的决定。追加以后提交下一轮，带不带新输入都行。
  2. 下一轮开头、记输入之前，harness 先处理上一轮留下的决定：确认了、在这里执行的调用照常执行（不再问 `beforeTool`，这一轮的 `deny` 仍然优先），拒绝的写上 `approvalDeniedOutput(call, reason)`（`Tool call "<name>" was not approved: <reason>`），都是 `toolResultEntry`；确认了、绑到外部执行环境的留给执行方。流式时这些结果在 `run.started` 之后作为 `tool.returned` 发出，调用在上一轮的流里报过。还没决定的不动：模型看到缺结果，这一轮以别的原因结束后它就作废，迟到的决定不算数。
  3. `PendingToolCall.approval`（`PendingApproval`：`approvalId`、`reason`、应用追加的 `decision`）说一次等待中的调用在等谁；`readPendingToolCalls(store, session)` 读会话里现在等着的调用（最后一个生命周期事件是以 `requires_action` 结束的那一轮时）。执行方只执行没有确认请求的、或者已经确认了的调用：没决定的、被拒绝的不碰。`isAutomatic` 的确认请求不算。
  4. 确认部件只给应用看，投影时去掉（见上面「上下文」）。
- **超窗兜底（`AgentSpec.context.overflow`，缺省关着）。** `build` 之后 harness 估算整次调用（`PreparedCall.tokens`；builder 不给时用 `estimateTokens`、`estimateTextTokens` 自己算指令、消息和交给模型的工具定义），不超过 `maxTokens` 就照常往下走。超了按 `strategy`：
  1. `compact`（缺省）：调 `ContextBuilder.compact`（参数取 `overflow.compact`，`keep` 至少按 1 算——这一轮刚记下的输入不进摘要），写下了摘要就重新 `build`。摘要模型用 builder 配的；builder 没配时用这一轮的模型，所以配置里不带模型名，远端的调用方不能借它指定任意模型。builder 没有 `compact`、压缩没做成（记一条告警）、压完还超，都接着走下一步。不写日志的运行（`record: false`）跳过这一步：压缩要追加摘要，而它一条都不该写。
  2. 裁剪（`compact` 的下一步，或者 `strategy: 'trim'` 直接到这里）：带着 `window: { ...agent.window, maxTokens, truncate: true }` 重新 `build`，从最旧的消息丢起，单条消息超预算时截短。什么都不写。
  3. 还超（指令、工具定义、`input` 本身就放不下），或者 `strategy: 'error'`：这一轮不调模型，以 `stopReason: 'error'`、`error.type: 'context_overflow'`（`retryable: false`）结束，照常写 `ctx.error` 和 `ctx.run.ended`。
     配置全是 JSON，随 `agent.context` 过线、记进 `ctx.run.started`；`maxTokens` 不是正数、`strategy` 不认识时这一轮以 `invalid_request` 结束。检查只在第一次调模型之前做：工具步骤里长出来的上下文靠工具结果的长度上限和下面的错误映射兜着。
- **上下文过长的错误。** 服务商拒绝一次调用、说上下文超过了模型的窗口时，harness 把它映射成 `stopReason: 'error'`、`error.type: 'context_overflow'`、`retryable: false`（`ctx.error` 的 `type` 同样），`statusCode`、`responseBody` 照旧带着。不另加 `StopReason`：它和 `session_busy`、`not_found` 一样是「这一轮没跑成」的一种，已有的 `stopReason === 'error'` 分支（编排器的 `failed`、远端的状态码）都不用改，要区分的看 `error.type`。纯函数 `isContextOverflow(error)` 只看 `type`，`CtxError`、`ErrorInfo`、远端客户端转出来的错误都认；常量 `CONTEXT_OVERFLOW`。`isContextOverflowText(text, status?)` 认上游的原始报错：HTTP 413 算，401、403、404、429 不算，其余看文字里有没有各服务商常见的错误码和消息。AI SDK 没有专门的错误类型，参考实现拿接口错误的消息和响应正文交给它（见[架构](architecture.md#harness)），外部 harness 的适配器拿程序转出来的报错交给它，**各服务商的错误形状没有对真实服务验证**；认不出来的照旧是 `api_call`。应用看到 `context_overflow` 之后的下一步：`compactDetailed` 压缩再重试，或者给 agent 配上 `context.overflow`。
- **失败的重试不让历史变长。** 输入在调模型之前就写进日志，这一轮失败了它也留着。重试有两种认法：给了 `inputKey` 的由存储按键去重；没给的，harness 看上一轮是不是以 `error` 或 `aborted` 结束、日志里最后一条不是框架写的条目是不是同样内容的用户消息（它后面只有 `ctx.*` 事件和没盖住它的摘要），是就不再记一遍，`recorded` 里也没有它。上一轮成功了、换了一句话、两轮之间应用写过别的条目，都照常记。以前不带 `inputKey` 的重试每失败一次历史就长一条，上下文过长时越重试越长。纯函数 `endedInFailure(lifecycle)` 认上一轮失败，`repeatsFailedInput(tail, input, { key?, harness? })` 认这一句是不是失败那一轮留下的；外部 harness 给 `harness`，它自己写的事件（`<harness>.*`）也跳过。
- **一个会话最多一个未结束的运行，跨进程也成立**（只对 `record` 不为 `false` 的运行；`record: false` 的运行不碰日志，不占会话，不会遇到 `session_busy`，也不会被 `recover` 看到）：
  1. 开始：读最后一个生命周期事件（`list({ kinds: [ctx.run.started, ctx.run.ended], last: 1 })`）。是 `started` 就说明有未结束的运行，`run` 以 `ErrorInfo.type: 'session_busy'`（`retryable: true`）结束，不写任何东西；否则带 `expectSeq` 追加 `ctx.run.started`，冲突就重读重判。
  2. 运行中：每次写入带 `expectSeq`（本轮上一次写入之后的末尾）。冲突时读自己的 `ctx.run.started` 起的生命周期事件和擦除记录（`kinds: [ctx.run.started, ctx.run.ended, ctx.erased]`）：自己的 `runId` 已经有 `ctx.run.ended`，说明被别人当作断掉的运行收走了；自己的 `ctx.run.started` 不在了，说明会话中途被 `clear` 了，或者 `truncate`、`remove` 删到了它；有 `ctx.erased` 动了这一轮自己写的条目（`isErased`，`redact` 也算），说明这一轮的输入或产出被删了。三种都是被围栏，停下，`stopReason: 'aborted'`，不再写 `ctx.run.ended`、`ctx.error` 和产出——针对已删内容的回答不会写回来。都不是就只是别人写了应用事件，或者擦除的是这一轮之前的历史、别人在这期间写的条目，用新的末尾重试。已经建好的上下文不重建：这一轮的模型仍然看得到被擦除的更早的内容，要一并挡住就先取消这一轮再删。纯函数 `isFenced(lifecycle, run)` 是这条规则（`run` 是 `RunPosition`：`runId`、`started`、`recorded`），`afterConflict(store, session, run)` 连读带判：被围栏返回 `undefined`，否则返回新的末尾。
  3. 同一个 harness 实例自己维护一条进程内的每会话串行队列（只排 `record` 不为 `false` 的运行）：同一进程里的第二个运行等前一个结束再开始，所以 `session_busy` 只会在跨进程或别的 harness 实例上出现。排队时 `signal` 中止，这一轮直接以 `aborted` 结束，什么都不写。队列只是少打一次冲突；编排器自己的队列保留，两层串行不冲突。`createSessionQueue()` 是这条队列：`enter(session, signal?)` 轮到时返回 `release`，排队时中止返回 `undefined`。
  4. 进程崩溃留下的未结束运行会让该会话一直 `session_busy`，直到有编排器 `recover` 它。**所以用 `record` 缺省（写日志）的应用，进程启动时要先 `recover()` 再接新的 `submit`。** 不写日志的运行没有这个要求。
  5. 续跑：`recover` 给断掉的运行写下了调用、没有结果的工具调用补一条错误结果（「这一轮在工具返回之前结束了，结果未知」），和 `ctx.run.ended` 一批写；要续跑的，在同一个会话上提交一轮不带新输入的运行，模型从日志里看到已经做完的步骤和那条错误结果，接着往下走。已经有结果的工具不会再执行；结果未知的那次由模型决定要不要重试，有副作用的工具应当自己幂等。
  6. `RunRequest.owner` 写进 `ctx.run.started` 的 `owner`（编排器按自己的 `owner` 填）。
- `text.delta`、`reasoning.delta` 不落日志，像 Managed Agents 的 event delta；其余事件各有对应的日志条目。`run.started`、`model.ended`、`run.ended` 带 `seq`，是流和日志对齐的点：发出它的时候日志已经写到这个 `seq`（`ctx.run.started`、这一步的最后一条、`ctx.run.ended`）。流断了，从最后收到的 `seq` 起 `watch(session, { after })` 或 `list({ after })` 接着读日志，不会漏也不会重；不写日志的运行没有 `seq`。
- **用量。** `Usage` 的缓存和推理三项是可选的，服务商不给或者是 0 就没有（服务商没给明细时 AI SDK 的适配也常填 0，分不出来）；`inputTokens` 含缓存读到的和写进缓存的，算费用时按各家的价格分开算。整轮的合计在 `RunResult.usage` 和 `ctx.run.ended` 的 `usage`；每一步的在这一步助手消息的 `meta.step`（`StepMeta`，`stepMetaToJson(meta)` 写、`stepMetaOf(entry)` 读），还带服务商响应里的模型标识——请求的是别名、走了回落时看得出实际用了哪个。价格表不在协议里：应用按 `provider`、`modelId` 和这几项自己算。各服务商的用量字段经 AI SDK 映射过来，**没有对真实服务验证**。
- 纯函数：`modelName(model)` 把进程内模型记成 `<provider>/<modelId>`；`agentSpecToJson(spec)` 是写进 `ctx.run.started` 的可序列化部分。`settings.headers` 只留名字，值换成 `REDACTED_HEADER`（`[redacted]`）：请求头里常有凭证，而日志只追加、读得到会话的人都看得到。
- **父子运行**（#48）。一个 agent 把活交给另一个 agent，是父运行里的一次工具调用在子会话上跑一轮。两边各记一半：
  - 子会话：`RunRequest.parent`（父会话、父 `runId`、那次工具调用的 id）原样记进 `ctx.run.started` 的 `parent`。形状不对（`runParentProblem(parent)` 给出原因）时这一轮以 `invalid_request` 结束，`parent` 不记。
  - 父会话：那次工具调用的结果是 `ChildRunResult`：`{ child: { session, runId }, stopReason, text?, output?, usage?, error? }`。`childRunOutput(child, result)` 生成它，子运行以 `error` 或 `aborted` 结束时是 `type: 'error'` 的输出、`ChildRunResult` 放在 `data`。`childRunsOf(entries)` 从父会话的条目里找出这些结果，回看父会话就找得到每个子会话。
  - 用量不自动往上加：`RunResult.usage` 只是这一轮自己的，子运行的在 `ChildRunResult.usage`。要整棵树的就 `addUsage(parent.usage, ...childRunsOf(entries).map((run) => run.usage))`，再往下一层照样读子会话。
  - 取消沿着链往下传：父运行被取消，它派出、还没结束的子运行跟着取消。进程内经工具调用的 `signal`；经编排器派的，`cancel(父 runId)` 一并取消以它为 `parent` 的运行（递归）。跨进程的取消靠执行方：拿着父的 `signal` 去调远端的 `cancel`。
  - `recover` 仍然一个会话一个会话地收，`InterruptedRun.parent` 带上 `ctx.run.started` 里的 `parent`，续不续跑由 `resume` 决定：父运行多半也断了，父运行续跑时模型会重新决定派不派。
  - 子 agent 的上下文是应用的决定：全新（缺省，子会话里只有它自己的），带一段摘要（写进子运行的输入），或者带父会话的投影（`AgentSpec.context.inherit`：`build` 时先投影 `inherit.session` 里 `seq` 不超过 `upTo` 的条目，再接本会话的历史；窗口先给本会话，放不下时先丢父会话最旧的）。`inherit` 只读不写，形状不对是 `invalid_request`。
  - 进程级的 harness（Claude Code、dsh 这类）自己起子代理时，适配器把子代理的轨迹写进子会话、带同样的 `parent`，父会话那一侧写 `ChildRunResult`，回看时和进程内派的一样。
  - 不做的：编排模式（路由、群聊、层级）是应用的事，协议只约定父子关系怎么记。
- **一致性等级**（#23）。harness 不一定是这里的循环：进程级的程序（Claude Code、pi、dsh）自带循环、自带工具、自己管上下文，托管服务的循环在别人那里。所以 harness 的契约按能力分级，适配器跑自己做到的几级，并在文档里写明（`describeHarnessContract(name, factory, api, { levels })`，`HarnessLevel`，常量 `HARNESS_LEVELS`；缺省全跑）：
  - `trace`：一轮写进会话日志：生命周期事件、输入、回复、错误、取消、`runId`、`owner`、`parent`，`record: false` 不写，流的事件顺序。做到这一级，日志可看，记忆可用，别的组件可以订阅。其余几级都以它为前提。
  - `execute`：工具调用交给 ctx 的 `Executor`，执行前按 `inputSchema` 查输入，结果超过上限时截断并注明，每一步结束就落日志。进程级的程序经 MCP 拿到 ctx 的执行环境（`ctx-mcp` 的 `createMcpServer`）；它自己执行的内置工具只进日志。
  - `resume`：一个会话一个未结束的运行（`session_busy`）、输入的幂等（`inputKey`，失败的重试不再记输入），崩溃后能从日志接着跑。
  - `context`：用 `ContextBuilder` 组装上下文（`agent.context` 的投影名和事实、`context.overflow`）。自己管上下文的 harness 不跑这一项。
  - `output`：`AgentSpec.output` 的结构化输出和 `version`。
  - `approval`：人工确认经日志往返（上面「人工确认」）：`ask` 的调用不执行，确认请求和调用在同一条助手消息里，`RunResult.approvals` 列出；追加决定以后，下一轮先执行确认了的、给拒绝的写上拒绝。整轮在别的程序里跑完的 harness 不跑这一项。
    参考实现全过；`ctx-conformance --harness-levels` 对一个地址按等级跑。
- **外部 harness 的身份。** 适配器在 `ctx.run.started` 写 `harness`（`HarnessInfo`）：`name`（`claude-code`、`pi`、`pydantic-ai`、`managed-agents`）、`version`、它自己的会话 `session`。自己存对话的程序把 ctx 的一个会话对到它的一个会话上，下一轮从最近一次记下的 `session` 接着跑；它记录里的位置这类只有适配器用的东西放条目的 `meta`。不存对话的框架每一轮从 ctx 的日志投影历史，不写 `session`。参考实现不写。已有的适配器：`ctx-claude-code`、`ctx-pi`、`ctx-managed-agents`（TypeScript）和 `ctx-pydantic-ai`（Python，经线上协议对外），都过 `trace`、`execute`、`resume`、`output`，`ctx-pydantic-ai` 还过 `context`、`approval`，`ctx-managed-agents` 还过 `approval`，做法和取舍见 [ADR 0010](adr/0010-external-harness-adapters.md)。
- `Hooks` 是 harness 实现的构造参数，不在 `RunRequest` 里：它们是函数，不能跨边界。
- 权限确认是 `beforeTool` 的一种实现：返回 `{ allow: false }` 时工具结果是一条错误，模型会看到原因，这一轮继续；要等人决定的返回 `{ ask: true, reason? }`（上面「人工确认」）。
- 参考实现基于 AI SDK 的 `generateText` / `streamText`：把选中的 `ToolDefinition` 包成 AI SDK 工具，`execute` 转给执行环境。
- 远端 harness（`ctx-remote`）：`POST /runs` 收去掉 `signal` 的 `RunRequest`（模型是名字），回 `RunResult`；`stream` 是 `POST /runs?stream=1` 的 NDJSON。`signal` 中止时客户端发 `DELETE /runs/:runId`，同一个请求照常回 `stopReason: aborted`；客户端断开时服务端也中止这一轮。

## 编排 `Orchestrator`

跨轮次、跨会话的调度。协议只定最小的一组，模式（链式、路由、并行、编排者-工作者）由应用用 `Harness.run` 组合。

```ts
type RunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
interface RunHandle {
  runId: string;
  session: string;
  done: Promise<RunResult>; // 进程内的等待方式；跨边界时用 status 或 events
}
interface OrchestratorEvent {
  type: `run.${RunStatus}`;
  runId: string;
  session: string;
}

interface Orchestrator {
  /** 同一会话的运行串行，不同会话并行。 */
  submit(request: RunRequest): Promise<RunHandle>;
  status(runId: string): Promise<RunStatus | undefined>;
  cancel(runId: string): Promise<boolean>;
  /** 崩溃后：找到日志里有 ctx.run.started 没有 ctx.run.ended 的运行，给悬空的工具调用补错误结果、补一条 ctx.run.ended（stopReason error），续不续跑由实现决定。 */
  recover?(): Promise<RecoveredRun[]>; // 只处理 owner 与自己相同的运行
  events?(options?: { signal?: AbortSignal }): AsyncIterable<OrchestratorEvent>;
  close(): Promise<void>;
}
interface RecoveredRun {
  session: string;
  runId: string;
  resumed?: string; // 续跑时，接着这个会话提交的那一轮的 runId
}
```

- `completed` 是跑完了；`failed` 是 `stopReason: error` 或 harness 抛错；`cancelled` 是被 `cancel` 或 `signal` 取消（被围栏停下的运行也是 `aborted`，算 `cancelled`）。
- `owner`：`createOrchestrator({ owner })` 是部署者给的稳定实例名（例如 `yoyo`），写进每个运行的 `ctx.run.started`。`recover()` 只处理 `owner` 与自己相同的断掉的运行（都没配置也算相同），所以两个进程共用一个库时各配一个名字，互不收对方的运行。写 `ctx.run.ended` 时带 `expectSeq`（读到断点之后再读的末尾）：读和写之间会话有了新条目，说明那个运行其实在动，跳过它；就算判错，活着的运行下一次写入会发现自己被结束并停下（围栏）。`recover` 对每个会话只读最后一个生命周期事件（`kinds`、`last: 1`），找到断点的才多读一次末尾。`owner` 配错（两个进程同名，或都不配）就退回只靠围栏兜底。
- `cancel(runId)` 同时取消这个编排器里以它为 `parent` 的运行（`RunRequest.parent.runId`），一层层往下。
- 参考实现是进程内队列：每个会话一条队列，一个 harness。
- yoyo 的 `createYoyoOrchestrator` 是一个应用级的编排器，实现这个协议：定时、让路、收件箱。碎碎念和回复是同一个 harness 跑的两份 `AgentSpec`，导演只剩舞台动作，常驻循环只管进程。
- 远端编排器（`ctx-remote`）：路径放在 `/orchestrator` 下，和 harness 的 `/runs` 分开：`POST /orchestrator/runs`、`GET /orchestrator/runs/:id`（`?wait=` 长轮询，结束后带 `result`，客户端的 `done` 靠它）、`DELETE /orchestrator/runs/:id`、`POST /orchestrator/recover`、`GET /orchestrator/events`（NDJSON）。

## 记忆 `MemoryStore`、`DecisionModel`、`ExtractionModel`、`Memory`

第八个组件。记忆只读会话日志、从不改它；存储、两个 System One 模型和门面各一个协议，全部只收发 JSON。为什么这样分见[记忆](memory.md)和 [ADR 0006](adr/0006-memory.md)，参考实现见[架构](architecture.md#记忆)。下面的签名省略了 `readonly` 和部分注释，以 `ctx-protocol` 的 `.d.ts` 为准。

### 存储 `MemoryStore`

记忆的存储。四个集合，每个集合几个方法；全部只收发 JSON，可以放到进程边界另一侧。身份是字符串。

一份存储按**作用域**分开：`store.scope(name)` 是同一份数据上名叫 `name` 的作用域的视图，四个集合都在作用域里面。一个用户、租户或项目一个作用域，名字由应用定（字符串，最长 `MAX_MEMORY_SCOPE_LENGTH` = 256 个字符，原样比较）；不调 `scope` 时用的是缺省的作用域 `DEFAULT_MEMORY_SCOPE`（空串）。

- 一个作用域读不到、搜不到、改不了、删不掉另一个作用域的东西：`list`、`search`、`head`、`core.get`、`core.history` 只看自己的；别的作用域的 `id` 和不存在的 `id` 一样对待（`close`、`supersede`、`cite`、`confirm`、`retire` 抛 `not_found`，`settle`、`fail`、`retry`、`touch`、`archive`、`restore`、`reopen`、`forget` 跳过），`supersededBy` 也不能指向别的作用域。实现给 `search` 建的索引也要按作用域分开。
- 名字是绝对的，不嵌套：`store.scope('a').scope('b')` 就是 `store.scope('b')`。从没写过的作用域是空的，不用先建。名字不合法（`checkMemoryScope`）抛 `invalid_request`。
- `id` 在整份存储里不重复，不只是在一个作用域里。
- 作用域是隔离，不是鉴权：谁能用哪个作用域由应用决定（远端的 `/memory/*` 只配了访问令牌时，拿到令牌就能用任何作用域；配了主体时按它的 `memoryScopes` 查，见「线上形态」）。
- 证据（`SourceRef`）指向会话日志，会话本身不分作用域：哪个会话归哪个作用域由应用保证，参考实现的 `createMemory` 有 `ownsSession` 可以再挡一道。

```ts
/** 指向会话日志里的一段，证据永远指向原文。1 ≤ from ≤ upTo。 */
interface SourceRef {
  session: string;
  from: number; // seq，含
  upTo: number; // seq，含
}

interface Note {
  id: string;
  session: string;
  from: number;
  upTo: number;
  at: number; // 打分时刻（毫秒）
  salience: number; // 0..1
  kind?: string; // 应用定义：pref、obs、fail、ok…
  topic?: string; // 应用定义的主题名
  settledAt?: number; // 夜里处理过的时刻；没有、也没进死信就是待处理
  attempts?: number; // 处理失败过几次（fail 记）
  error?: string; // 最后一次失败的原因
  failedAt?: number; // 失败次数到上限、进死信的时刻
}
/** 门控没过的那段也写一条，settledAt 等于 at：head 照样前进，打过的分留作阈值的分布。失败的记录只能由 fail 写。 */
type NewNote = Omit<Note, 'id' | 'attempts' | 'error' | 'failedAt'>;
interface NoteQuery {
  session?: string;
  pending?: boolean; // true 只要待处理的（没处理过、不是死信），false 只要处理过的；缺省不限
  failed?: boolean; // true 只要死信，false 不要死信；缺省不限
  since?: number; // 只要 at 不早于它的
  limit?: number; // 最早写入的 N 条
}

interface MemoryFact {
  id: string;
  key?: string; // 幂等键，一个作用域里不重复
  subject: string; // "user"、"project:agent"…应用定义
  predicate?: string;
  text: string; // 一句能独立成立的话
  topic?: string;
  at: number; // 写进记忆的时刻，激活度从它算起
  validFrom: number; // 从何时起成立
  validTo?: number; // 没有就是仍然成立
  supersededBy?: string; // 被哪条事实取代
  confidence: number; // 0..1
  salience: number; // 0..1，激活度公式里的 s
  sources: readonly SourceRef[]; // 必填，不允许没有证据的事实
  recalls: readonly number[]; // 最近几次被召回的时刻（最多 MAX_FACT_RECALLS = 32 个），激活度公式里的 t_i
  archivedAt?: number; // 归档的时刻；没有就是没归档
}
// at 不给时存储记成 validFrom
type NewMemoryFact = Omit<MemoryFact, 'id' | 'at' | 'validTo' | 'supersededBy' | 'recalls' | 'archivedAt'> & {
  at?: number;
};
interface FactHit {
  fact: MemoryFact;
  score: number; // 0..1，越大越相关；recall 用它当相似度
}

interface Procedure {
  id: string;
  topic?: string;
  when: string; // 触发条件
  do: string; // 动作
  evidence: readonly SourceRef[];
  confirmations: number; // 独立确认次数，add 时是 1；应用决定几次算生效
  at: number;
  retiredAt?: number;
}
type NewProcedure = Omit<Procedure, 'id' | 'confirmations' | 'retiredAt'>;
interface ProcedureQuery {
  topic?: string;
  active?: boolean; // true 只要没退役的；false 或缺省不限
}

/** 结果按 id 升序（码点序），翻页和 SessionStore.sessions 一样。 */
interface FactQuery {
  subject?: string;
  topic?: string;
  open?: boolean; // true 只要 validTo 为空且未归档；false 或缺省不限
  after?: string; // 上一页最后一个 id，不含
  limit?: number;
}
interface SearchQuery {
  text: string; // 实现决定用全文、向量还是两者；至少和事实有共同的词（searchTerms）时命中，多长都不报错
  topic?: string;
  k?: number; // 缺省 10
  open?: boolean; // 缺省 true；false 连同关闭、归档的一起搜
  archived?: boolean; // true 时仍然成立的里面连归档的一起搜，关闭的还是不看；缺省 false
}

interface CoreVersion {
  text: string;
  at: number;
}

interface MemoryStore {
  /** 同一份数据上另一个作用域的视图；名字是绝对的。 */
  scope(scope: string): MemoryStore;
  notes: {
    /** 同一个会话、同样的 from 和 upTo 已经有笔记时不再写，返回已有的那条。 */
    add(notes: readonly NewNote[]): Promise<Note[]>;
    list(query?: NoteQuery): Promise<Note[]>; // 按写入顺序
    /** 返回这次真正标上的条数；处理过的、死信不改。 */
    settle(ids: readonly string[], at: number): Promise<number>;
    /** 记一次失败：attempts 加 1、记下 error；加完不小于 maxAttempts 时 failedAt = at，进死信。返回改了的笔记。 */
    fail(ids: readonly string[], at: number, options: { error: string; maxAttempts: number }): Promise<Note[]>;
    /** 死信放回待处理：清掉 failedAt、attempts、error。 */
    retry(ids: readonly string[]): Promise<number>;
    /** 删掉这个会话的笔记，不给会话删掉全部；head 回到 0。 */
    forget(session?: string): Promise<number>;
    /** 这个会话的笔记（含处理过的、死信）覆盖到的最大 seq；没有就是 0。gate 从它之后读。 */
    head(session: string): Promise<number>;
  };
  facts: {
    /** key 已经有了时不写，返回已有的那条。 */
    add(fact: NewMemoryFact): Promise<MemoryFact>;
    /** 原子的「加新关旧」：写入 fact，把 id 那条 close(id, at, { supersededBy: 新的 })。id 认不得时什么都不写。 */
    supersede(id: string, fact: NewMemoryFact, at: number): Promise<MemoryFact>;
    /** 关闭有效期。事实的文字永不改写：变了就 supersede（或 add 新的、close 旧的）。已关闭的不改。 */
    close(id: string, at: number, options?: { supersededBy?: string }): Promise<void>;
    /** 追加证据（并入时用），文字不变；相同的区间跳过。 */
    cite(id: string, sources: readonly SourceRef[]): Promise<MemoryFact>;
    /** 记一次召回；recalls 超过 MAX_FACT_RECALLS 个时丢掉最早的。 */
    touch(ids: readonly string[], at: number): Promise<void>;
    archive(ids: readonly string[], at: number): Promise<number>;
    /** 恢复归档的事实（清掉 archivedAt），返回真正恢复的条数；有效期不动。 */
    restore(ids: readonly string[]): Promise<number>;
    /** 撤销关闭：清掉 validTo 和 supersededBy，返回真正重新打开的条数。关错了的改回来。 */
    reopen(ids: readonly string[]): Promise<number>;
    /** 真删除，连同指向它的 supersededBy 一起清掉。主人的权利。 */
    forget(ids: readonly string[]): Promise<number>;
    list(query?: FactQuery): Promise<MemoryFact[]>;
    search(query: SearchQuery): Promise<FactHit[]>; // 按 score 从高到低
  };
  procedures: {
    add(procedure: NewProcedure): Promise<Procedure>;
    /** confirmations 加 1；相同的证据不算又一次确认。 */
    confirm(id: string, evidence: readonly SourceRef[]): Promise<Procedure>;
    retire(id: string, at: number): Promise<void>;
    forget(ids: readonly string[]): Promise<number>; // 真删除
    list(query?: ProcedureQuery): Promise<Procedure[]>; // 按写入顺序
  };
  core: {
    get(): Promise<CoreVersion | null>;
    /** 追加一个版本，旧版本保留；回滚就是把旧文字再 set 一次。 */
    set(text: string, at: number): Promise<void>;
    /** 按写入顺序；last 和 ListOptions.last 一样。 */
    history(options?: { last?: number }): Promise<CoreVersion[]>;
    /** 删掉全部版本（真删除），get 回到 null。 */
    clear(): Promise<number>;
  };
}
```

- **事实不 UPDATE。** 变了就 `supersede`：新的写进去、旧的关掉，`supersededBy` 连起来。「上个月用的是哪个数据库」永远能查。关错了用 `reopen` 改回来。
- **写进来的时刻和成立的时刻分开。** `at` 是事实写进记忆的时刻，`validFrom` 是它从何时起成立：夜里从日志提取的事实可能早就成立了。`at` 不给时存储记成 `validFrom`（导入的、手写的事实不知道是什么时候记下的）。
- **每个方法单独是原子的。** `supersede` 的加新关旧要么都成，要么都不成：分成 `add` 再 `close` 两步时，第二步失败会留下两条都成立的事实。
- **几个进程写同一份存储不重复。** 同一段日志（会话加 `from`、`upTo`）只有一条笔记，`notes.add` 遇到已有的返回已有的；事实带 `key` 时一个作用域里只有一条，`add`、`supersede` 遇到已有的键返回已有的、什么都不改。两个进程同时门控、同时夜里处理同一批笔记，结果和一个进程一样。
- **失败和死信。** 处理一批笔记失败时调用方 `fail`：记次数和原因，笔记还是待处理的；次数到了上限进死信（`failedAt`），不再算待处理，`list({ failed: true })` 列出来，修好原因后 `retry` 放回去。这样一段总让模型出错的日志不会每夜重试、也不会被悄悄标成处理过。
- **证据必填。** `MemoryFact.sources`、`Procedure.evidence` 指向会话日志的 `seq` 区间。没有证据的事实不进存储，这是防编造的第一道闸。
- **归档不删除，也不是找不回。** `archive` 只是让它退出 `open` 的查询，`forget` 才删。归档的事实 `search` 带 `archived: true` 还搜得到（存储不降权，分数怎么打折由调用方定），`restore` 把它恢复成没归档的。
- **`recalls` 有上限。** `touch` 只留最近 `MAX_FACT_RECALLS`（32）个时刻，早的丢掉：一条事实不随召回次数无限变长，激活度也就有了上界。
- **删除是真删除。** `facts.forget`、`procedures.forget`、`notes.forget`、`core.clear` 都删掉行，不留墓碑。画像是事实压出来的文字，删事实时画像里可能还有：门面的 `forget` 把画像的历史一起清掉（见下面的门面）。
- **错误。** 参数不合法（没有证据、`from > upTo`）是 `CtxError` 的 `invalid_request`，认不得的 `id` 是 `not_found`；批量方法（`settle`、`fail`、`retry`、`touch`、`archive`、`restore`、`reopen`、`forget`）跳过认不得的 `id`。存储不看钟，时刻都由调用方给。
- **记忆不写会话日志。** 记忆是日志的读者。应用要在日志里留痕（例如「今晚整理了 12 条」）自己追加事件，这是明确的选择。
- `search` 的实现自定：全文、向量、两者混合。协议约定输入是文字，以及三条底线（契约测试都查）：
  - **有共同的词就命中。** 词按 `searchTerms(text)` 切：先 NFKC 归一、转小写；字母和数字连成的一串是一个词，中日韩文字没有空白分词，每相邻两个字算一个词（落单的一个字自成一个）。所以「我平时喜欢喝什么茶？」找得回「主人喜欢喝乌龙茶」（共同的词是「喜欢」「欢喝」）。英文按整词：`Postgre` 不命中 `PostgreSQL`。
  - **共同的词占得多的在前。** 全文的分数用 `termOverlap(shared, a, b)`：重叠系数 `shared / min(a, b)`，一边的词全在另一边里就是 1。短的查询对长的事实、长长的一段话对短的事实都打得出分。
  - **多长的查询都不报错。** 实现最多看 `MAX_SEARCH_TERMS`（256）个不同的词：`searchTerms(text, MAX_SEARCH_TERMS)` 在词更多时取开头的一半和结尾的一半。
- 记忆里的事实叫 `MemoryFact`，和来源取到的事实 `Fact`（`{ source, text }`，只用于一次调用）是两回事：前者持久、有有效期，后者是「现在」。
- 纯函数：`activation(fact, now, options?)`、`retrievability(fact, now, options?)`（见[激活度](#激活度-activationretrievability)，缺省参数是 `ACTIVATION_DEFAULTS`）、`rankFacts(facts, scores, options?)`（`scores` 是事实 `id` → 相似度，一般取 `FactHit.score`）、`renderCore(facts, budget, { now })` 的缺省写法（按激活度排，`estimateTextTokens` 超过 `budget` 前停下）、`sourceRef(session, entries)`；检索用的 `searchTerms`、`termOverlap`（常量 `MAX_SEARCH_TERMS`）；另有存储实现用的 `checkSourceRef`、`checkEvidence`、`sameSourceRef`、`inSourceRef`、`isOpenFact`、`filterFacts`、`inSearchScope`（`SearchQuery` 的 `topic`、`open`、`archived` 写成的判断）和常量 `MAX_FACT_RECALLS`。
- 远端记忆存储（`ctx-remote`）：服务端挂 `memory`，路径在 `/memory/notes`、`/memory/facts`、`/memory/procedures`、`/memory/core` 下，作用域用查询参数 `?scope=`（不带就是缺省的）；客户端是 `createRemoteMemoryStore`。批量和按 `id` 的方法各一条 `POST`：`/memory/notes/{settle,fail,retry,forget}`、`/memory/facts/{search,touch,archive,restore,reopen,forget}`、`/memory/facts/:id/{close,supersede,cite}`、`/memory/procedures/forget`、`/memory/procedures/:id/{confirm,retire}`；`DELETE /memory/core` 是 `core.clear`。决策、提取模型没有线上形态，按名字在各自的进程里造。

### 决策和提取模型 `DecisionModel`、`ExtractionModel`

记忆回路里的多数判断不是开放生成，而是分类、打分、填字段。这些交给单次前向、返回概率的模型（Cloudflare 叫 System One：决策模型 Clef、Jev，提取模型 Clairic），只有归纳和措辞留给 `LanguageModel`。ctx 为它们各定一个协议，形状跟着 System One API 走，适配器因此很薄；但类型是 ctx 自己的，全是 JSON，不依赖任何服务商的 SDK。

```ts
const MAX_DECISION_QUESTIONS = 64;

type DecisionQuestion =
  | { type: 'noul'; instructions: string } // 是 / 否，返回 P(是)
  | { type: 'choice'; instructions: string; criteria: Record<string, string> } // 选一个，至少一个选项
  | { type: 'score'; instructions: string; criteria: readonly string[] }; // 有序量表，从低到高，至少两档
type DecisionAnswer =
  | { type: 'noul'; noul: number }
  | { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: 'score'; score: number; probabilities: readonly number[] }; // score = Σ pᵢ · i / (n − 1)

interface DecisionRequest {
  state: JsonValue; // 文字或 JSON
  questions: Record<string, DecisionQuestion>; // 一次最多 64 个，并行
  signal?: AbortSignal; // 中止后 reject
}
interface DecisionModel {
  name: string;
  decide(request: DecisionRequest): Promise<Record<string, DecisionAnswer>>;
}

// 找到时 value 的形状：text 字符串；number 数；date 'YYYY-MM-DD'；datetime ISO 8601；duration 秒数；list 数组
type ExtractionField =
  | { type: 'text'; instructions?: string }
  | { type: 'number'; instructions?: string; integer?: boolean; decimals?: number; unit?: string }
  | { type: 'date' | 'datetime' | 'duration'; instructions?: string }
  | { type: 'list'; items: 'text' | 'number'; instructions?: string };
interface ExtractionAnswer {
  value: JsonValue; // 没找到是 null
  pNull: number; // 输入里不存在这个值的概率
  confidence: number;
}
interface ExtractionRequest {
  state: JsonValue;
  fields: Record<string, ExtractionField>; // 数量不限
  signal?: AbortSignal;
}
interface ExtractionModel {
  name: string;
  extract(request: ExtractionRequest): Promise<Record<string, ExtractionAnswer>>;
}
```

- 两个协议都不产出文字，只收输入 token，适合每轮都调。
- 输出总是合法的，但未必正确：调用方用 `confidence`、`pNull` 决定自动化到哪一步，低于阈值的升级给 `LanguageModel`。
- 拿不到可用的回答（服务回的不是 JSON、被截断）时 reject，`type` 是 `invalid_response`，不要拿一个「不确定」的答案顶上：调用方分不出那是判断还是故障，提取就会当成「什么都没说」把这段记忆丢掉。个别问题、字段缺了或形状不对时，那一项给低置信度的合法答案。
- 跨边界时模型用名字字符串，和 `ModelRef` 一样。
- 没有 System One 服务时有两种退路：启发式实现（不联网，见[架构](architecture.md#模型)），或者用 `LanguageModel` 装成一个决策模型（让它输出 JSON，慢、贵，但接口一样）。

### 门面 `Memory`

五个操作收在一个门面里，门面本身是一个 `Executor`。协议只定形状；参考实现是 `@modelctx-ai/ctx-memory` 的 `createMemory`，见[架构](architecture.md#记忆)。

```ts
interface Memory extends Executor {
  /**
   * 白天：读 session 里 notes.head 之后的新条目，打分，写笔记，返回写下的笔记。不改日志。
   * 没过阈值的那段也写一条已处理的笔记（settledAt = at），head 照样前进；没有新条目时返回空。
   */
  gate(session: string, options?: GateOptions): Promise<Note[]>; // GateOptions = { signal? }
  /**
   * 白天：按文字召回仍然成立的事实，按 rankFacts 排序，记一次 touch；带上匹配主题的程序。
   * 归档的事实也找（相似度打折），被召回的那些恢复成没归档的；confidence 低于 minConfidence 的不召回。
   */
  recall(query: string, options?: RecallOptions): Promise<Recalled>;
  /**
   * 夜里：处理待处理的笔记，衰减归档，重写 core。整体可重复执行。按批隔离：一批失败不挡后面的，
   * 失败的笔记 fail，次数到上限进死信。
   */
  consolidate(options?: ConsolidateOptions): Promise<ConsolidateReport>; // ConsolidateOptions = { now?, signal? }
  /** 删除；和 consolidate 不交错。 */
  forget(request: ForgetRequest): Promise<ForgetReport>;
  /**
   * 作为来源：core 加按 query 召回的事实，渲染成文字；什么都没有时返回空。
   * 来源每一轮都跑，它带出的事实不能每次都记 touch：实现要限制频率（参考实现是同一条事实一天记一次）。
   */
  source(options?: MemorySourceOptions): ContextSource;
  /** 作为工具：recall（MEMORY_RECALL_TOOL），绑定到这个执行环境。 */
  tools(): Promise<ToolDefinition[]>;
  execute(call: ToolCall, context: ExecutionContext): Promise<ToolOutput>;
}
interface MemorySourceOptions {
  name?: string; // 缺省 memory
  query?: (session: string) => Promise<string>; // 缺省取会话最近一条用户消息的文字
  k?: number;
}
interface RecallOptions {
  topic?: string;
  k?: number;
  budgetTokens?: number;
  minConfidence?: number; // MemoryFact.confidence 低于它的不召回；缺省由实现定（参考实现 0.5），给 0 不筛
  evidence?: boolean; // 带回证据原文；工具调用时带，作为来源时不带
  signal?: AbortSignal;
}
interface Recalled {
  facts: readonly MemoryFact[]; // 已经 touch 过；原先归档的已经恢复，不带 archivedAt
  procedures: readonly Procedure[];
  evidence?: readonly Entry[]; // 只在 evidence 时有：证据区间里的条目，按 id 去重，按会话、seq 排
}
interface ConsolidateReport {
  notes: number; // 这次处理（settle）的
  failed: number; // 这次失败、留着下次再试的（不含进了死信的）
  dead: number; // 这次进了死信的
  facts: { added: number; merged: number; superseded: number; archived: number; ungrounded?: number }; // ungrounded：原文里找不到支撑、置信度被降下来的
  procedures: { added: number; confirmed: number };
  escalated: number; // 升级给 LanguageModel 的判断数
  core: boolean; // 重写了没有
}
/** 几项可以一起给，删的都是真删除。 */
interface ForgetRequest {
  facts?: readonly string[];
  procedures?: readonly string[];
  session?: string; // 这个会话的笔记，证据里有它的事实和程序
  all?: boolean; // 这份记忆（它的作用域）里的全部
  signal?: AbortSignal;
}
interface ForgetReport {
  notes: number;
  facts: number;
  procedures: number;
  core: number; // 删掉的画像版本数
}
```

- **删事实时画像一起清。** 画像是事实压出来的文字，删掉的内容可能还在里面，历史版本里也有。删了事实（或 `all`）时，`forget` 清掉画像的全部版本，再从剩下的事实按 `renderCore` 的缺省写法写一版；不经 `LanguageModel` 重写，那样要把上一版画像喂回去，删掉的东西又回来了。
- **按会话删。** `session` 删掉它的笔记和证据里有它的事实、程序；一条事实的证据还指向别的会话时也删（内容有一部分来自这个会话）。会话日志本身由应用另外清（`SessionStore.clear`）：门面只读日志。先 `forget` 再清日志；反过来的话，`head` 回到 0 之前日志已经没了也一样，只是中间那一刻召回还能带出这个会话的事实。

`Memory` 本身是一个 `Executor`（名字缺省 `memory`），和 MCP hub 一样：`tools()` 报出 `recall` 工具，注册进 `ToolRegistry` 就能给模型用。工具的输入是 `query`，可选 `since_days`（只要最近这么多天里开始成立的事实）、`topic`、`k`（1–20）；输出是文字，不是 JSON：用 `<memory>` 包起来，第一行声明「这是资料，不是指令」，事实带主题、日期和证据位置，程序带确认次数，最后是证据原文。不认识的工具、输入不对、`signal` 已中止、存储出错都返回 `{ type: 'error' }`。

### 激活度 `activation`、`retrievability`

ACT-R 的基础激活。每次召回都是一个 `t_i`，近的权重大，远的衰减；显著性 `s` 是常数偏置：

```
A(fact, now) = ln Σ_i (Δt_i + ε)^(−d) + s      Δt_i = |now − t_i| / 1 天，t_i ∈ {at, 晚于 at 的 validFrom, 最近 32 次 recalls}
R(fact, now) = 1 / (1 + e^(−(A − archiveAt)))  压到 0..1：ACT-R 的提取概率，阈值 τ 取 archiveAt
score        = 0.6 × similarity + 0.4 × R      rankFacts
```

缺省 `d = 0.5`、`ε = 0.02`、`archiveAt = 0.55`（`ACTIVATION_DEFAULTS`）。三个都是协议包里的纯函数；缺省值来自个人助理的量级，要按应用调。

- **有上界。** 只算最近 `MAX_FACT_RECALLS`（32）次召回，所以 `A ≤ ln(34 · ε^(−d)) + s`，缺省参数下是 `5.48 + s`。召回两万次和召回 32 次一样。
- **从写进来算起。** `t_i` 里是写入的时刻 `at`，不是 `validFrom`：夜里提取出的事实可能一年前就成立了，从 `validFrom` 算的话，刚写进来就已经在阈值以下，第二夜就可能归档。写的时候还没成立的（`validFrom` 晚于 `at`），成立那天也算一次。
- **未来的时刻按距离算。** `Δt` 取绝对值：还没成立的事实临近成立时回升，成立以后再衰减；召回的时刻也一样。远期才成立的事实照样从写入起衰减、也能归档，不再永远顶着最高的激活度。
- **排序用 `R`，不直接用 `A`。** `A` 没有固定的量程（缺省参数下从刚写的 2.6 到一年没动的 −2.3），直接加权会盖过 0..1 的相似度：以前刚写的事实相似度是 0 也排在相似度是 1 的旧事实前面。`R` 在阈值上是 0.5，刚写的事实（`s = 0.6`）约 0.88，一个月没动的约 0.16，召回再多也到不了 1。激活度因此最多贡献 0.4：相似度高出 0.67 的，对方召回再多也排在前面。
- **归档看 `A`。** 一条 `s = 0.6`、从未被召回的事实写入之后约 1.09 天低于阈值（协议包的单元测试固定了「1 天时还在、1.2 天时已低于」）；写入之后一天内被召回一次，约到第 4.4–4.9 天才低于阈值。低于阈值是归档的必要条件，不是充分条件：参考实现还要求这条事实错过了足够多次被召回的机会（见[架构](architecture.md#记忆)的「巩固」），不然新事实头两天没碰上相关的问题就没了。

## 契约测试

`@modelctx-ai/ctx-protocol/testing`，用法见[包说明](../packages/protocol/README.md#实现一个协议)。

| 契约测试                          | 工厂                                                                    | 覆盖                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `describeSessionStoreContract`    | `({ now }) => SessionStore`                                             | 存进去的是拷贝、会话名（空串、`.`、`..` 每个方法都拒绝，别的名字往返）、排序、同一时刻、去重、一批里有重复时其余照写、并发两批不交错、`after`/`last`/`limit`/`types`/`kinds`、往返、全是 JSON 的消息、`expectSeq`（对得上才写、冲突整批不写、先于去重、并发恰好一个成功）、`clear`、擦除（`truncate`、`remove`、`redact` 的条数和剩下的条目、`ctx.erased` 记录、什么都没动时不留记录、末尾前进和旧 `expectSeq` 冲突、`id`/`key` 让不让出来、和并发 `append` 不交错）、`sessions` 的升序和翻页、导出再导入（另一个存储里 `covers` 指对位置、投影一致、重复导入只有一份、截断的文件接得上、同一个存储里复制、擦除记录的位置）、`watch?` 的读已有、读新写入、读擦除记录、中止                                                                |
| `describeExecutorContract`        | `() => { executor, echo }`                                              | 有名字、`tools?()` 列出回显工具并绑定自己、`execute` 回显且能 JSON 往返、未知工具和已中止的 `signal` 返回 `{ type: 'error' }` 不抛、`provision?` 可重复、`open?`、`close?` 可重复且 `close` 之后能再 `open`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `describeToolRegistryContract`    | `() => ToolRegistry`                                                    | 增查和顺序、名字校验、同名和 `replace`、`remove`/`removeSource`、`select` 与 `selectTools` 一致                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `describeHarnessContract`         | `({ script }) => { harness, store, agent }`                             | 按等级（`levels`）分组：一轮的日志顺序和 `recorded`、`runId`、工具调用经执行环境、模型出错照常返回 `error` 并写 `ctx.run.ended`、每一步结束就落日志（工具调用之后模型出错，前一步留在日志里）、不合 `inputSchema` 的工具输入不执行（问题作为 `{ type: 'error' }` 回给模型）、超过上限（`maxToolOutputChars`）的结果截断并注明、`inputKey` 重试、不带 `inputKey` 的失败重试不再记输入、模型报上下文过长是 `context_overflow`、`context.overflow`（超了选 `error` 不调模型、`trim` 裁到放得下）、`record: false`、已中止的 `signal`、`stream?` 的事件顺序和出错、`session_busy`、`owner`、`record: false` 不受影响、人工确认（确认请求和调用在同一条助手消息里、确认了的下一轮先执行、拒绝的模型看到原因、流的 `run.ended` 带 `approvals`） |
| `describeContextBuilderContract`  | `({ script }) => { builder, store }`                                    | `build` 的消息顺序（历史、`input`、`prompt`）、指令、工具名单、不改日志、全是 JSON；不认识的投影名 `not_found`；`view` 里没有规则的事件不可见、摘要代替它盖住的条目；`window` 的 `maxMessages`、`{}`、`truncate`；`tokens?`；`compact?` 的不够长、写摘要和 `ctx.compacted`、被截断不写、超过 `maxInputTokens` 分段；`compactDetailed?` 的 `status`                                                                                                                                                                                                                                                                                                                                                                                        |
| `describeOrchestratorContract`    | `({ script }) => { orchestrator, store, agent }`                        | `submit`/`status`、同一会话串行、取消排队中的、`events?`、`recover?` 给悬空的工具调用补错误结果、补 `ctx.run.ended`（含会话多于一页、只收同一个 `owner` 的）、`close` 后不收                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `describeMemoryStoreContract`     | `({ now }) => MemoryStore`                                              | 作用域隔离（含检索的索引、归档和恢复）；笔记的 `head`、`pending`、`settle`、同一段只写一次、`fail` 计数和死信、`retry`、`failed` 和 `since`、按会话 `forget`；事实不改写、`at` 不给时是 `validFrom`、`key` 幂等、`supersede` 原子（认不得的 `id` 什么都不写）、`reopen`、`close` 和 `supersededBy`、`cite` 去重、`touch` 追加且只留最近 `MAX_FACT_RECALLS` 个、`archive` 退出 `open`、`restore` 恢复、`forget` 真删、`list` 翻页；`search` 的全文命中、中文问句、超长查询（上千个不同的词）、按相关度排、`archived`；程序 `confirm` 计数、`forget`；`core` 历史、`clear`                                                                                                                                                                  |
| `describeDecisionModelContract`   | `() => DecisionModel`                                                   | 三种问题的形状、概率和为 1、`choice` 是概率最大的、`signal` 中止                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `describeExtractionModelContract` | `() => ExtractionModel`                                                 | 每种字段的 `value` 形状、找不到时 `value: null` 且 `pNull` 高、`signal` 中止                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `describeMemoryContract`          | `(setup: { sessions, decision, extraction, now }) => { memory, store }` | `gate` 不改日志、笔记指向正确的 `seq` 区间、`head` 前进；`consolidate` 幂等、取代不覆盖、证据指回日志、写下的事实 `at` 是这次的 `now`；`recall` 后 `recalls` 多一个、归档的也召回并恢复、`minConfidence`；`source` 连着带出几轮 `recalls` 不跟着涨；`source`、`tools` 的形状                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

harness、编排器和上下文的工厂收到一份模型剧本 `script`（`ModelScriptStep[]`：`text`（带 `truncated` 时是被 `maxOutputTokens` 截断的输出）、调用回显工具的 `tool-call`、`error`），按它造模型和回显工具（回显工具的 `inputSchema` 要求 `text` 是字符串，结果里原样带着输入；harness 一次工具结果的上限不是 `DEFAULT_MAX_TOOL_OUTPUT_CHARS` 的，在 `describeHarnessContract` 的第四个参数里给 `maxToolOutputChars`）；`@modelctx-ai/ctx/testing` 的 `createScriptedModel` 是现成的。上下文的工厂给出一个缺省配置的 builder 和它读的存储，剧本是给 `compact` 的摘要模型的。记忆的契约用协议包 `/testing` 里的剧本模型 `createScriptedDecisionModel`、`createScriptedExtractionModel`：`describeMemoryContract` 自己造好它们和一个内存会话日志交给工厂。谁跑：记忆存储的契约由 `ctx-memory` 的内存存储（带和不带 `embed`）、`createSqliteMemoryStore`、`createRemoteMemoryStore` 跑；决策模型的由剧本模型、启发式、`decisionFromLanguageModel`、`ctx-models` 的两个 provider（假 `fetch`）跑；提取模型的由剧本模型、`extractionFromLanguageModel`、`ctx-models` 的 `cloudflare` 跑；`describeMemoryContract` 由 `createMemory` 加内存存储跑，门控阈值固定在 0.1..0.9 之间，`LanguageModel` 可以不给。上下文的契约由 `createContextBuilder` 加内存存储跑；它只管协议方法里看得见的行为，投影规则这些进程内配置（事件怎么渲染、摘要怎么写）不在里面，由 `project` 的单元测试管。

## 托管矩阵

每个组件三种形态。「进程内」是 `@modelctx-ai/ctx` 和各适配包；「本机另一进程 / 远端」靠 `ctx-remote` 的 HTTP 服务端和客户端，或者别人按协议实现的服务。

不是每个组件都有线上协议。能跨进程、有线上形态和一致性测试的是会话、执行环境、harness、编排、记忆存储。上下文、工具目录、模型不是线上协议：`ContextBuilder` 的行为大半在投影规则这些函数里，没有一致性测试，跟着 harness 走；工具目录是同步的进程内对象，远端执行环境用 `tools()` 报定义；模型直接用 AI SDK 的 `LanguageModel`，跨边界只传名字。这不是缺陷：它们本来就和 harness 在同一个进程里。

| 组件           | 进程内                                                            | 另一进程 / 远端                                                                                                         | 第三方托管                                                           |
| -------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| 会话           | 内存、SQLite                                                      | `ctx-remote`：服务端挂 `store` / `createRemoteSessionStore`（含 `watch`）                                               | 实现 `SessionStore` 的任何存储服务                                   |
| 上下文         | 投影 + 来源                                                       | 跟着 harness 走；也可单独成服务                                                                                         | —                                                                    |
| 工具           | 注册表                                                            | 跟着 harness 走；远端执行环境的 `tools()` 报定义，加进本地注册表                                                        | —                                                                    |
| 执行环境       | 函数、子进程（`ctx-exec`）、MCP                                   | `ctx-remote`：服务端挂 `executors` / `createRemoteExecutor`；只有出站连接的 worker 按名字领工作（`createRemoteWorker`） | 容器平台、Managed Agents 的沙箱                                      |
| Harness        | AI SDK 循环                                                       | `ctx-remote`：服务端挂 `harness` / `createRemoteHarness`（含 `stream`）                                                 | `ctx-managed-agents`：Managed Agents                                 |
| 编排           | 进程内队列                                                        | `ctx-remote`：服务端挂 `orchestrator` / `createRemoteOrchestrator`（含 `recover`、`events`）                            | 任何任务队列                                                         |
| 模型           | AI SDK                                                            | 名字 → 远端 harness 自己造                                                                                              | 各服务商                                                             |
| 记忆           | 内存（`ctx-memory`）、SQLite（`ctx-sqlite`）；门面 `createMemory` | `ctx-remote`：服务端挂 `memory` / `createRemoteMemoryStore`                                                             | 实现 `MemoryStore` 的记忆服务                                        |
| 决策、提取模型 | 启发式、`LanguageModel` 装成的（`ctx-memory`）                    | 名字 → 各进程自己造                                                                                                     | `ctx-models`：Cloudflare（Clef、Clairic）、TypeSafe（Jev，只做决策） |

服务端是 `@modelctx-ai/ctx-remote/server` 的 `startRemote(options)` 或 `createRemoteHandler(options)`：给了哪些组件就挂哪些路径，一个服务可以同时挂几样。

一个典型的分布式部署：编排器在本机，harness 是一个服务，会话在托管的数据库，执行环境是公有云上的容器或本机的一个子进程，模型是任何服务商。每一侧都只认协议。

## 线上形态

`ctx-remote` 用 HTTP 承载协议。JSON 请求和响应，流式用 NDJSON（每行一个值，出错时最后一行是 `{ error }`；空行是心跳，读的一方跳过）；错误正文是 `{ error: ErrorInfo }`，客户端转成带 `status` 的 `Error`。鉴权用 `Authorization: Bearer <token>`，缺省只听本机，Host 只认监听地址，带 `Origin` 的请求缺省 403。消息本身就是 JSON，线上不做编码（0.3 起；0.2 的客户端和服务端不能混用）。路径按组件分组，可以整体挂在一个前缀下：

- **版本和能力发现。** `GET /protocol` 回 `ProtocolInfo`：`protocol`（`PROTOCOL_VERSION`）、`entryVersion`（`ENTRY_VERSION`）、`components`（挂了的组件和可选方法：`sessions: { watch }`、`executors: { names }`、`harness: { stream }`、`orchestrator: { recover, events }`、`memory: {}`）。客户端第一次请求之前读它（`checkProtocolInfo`）：版本不同、对方的条目格式比这一端新、没有这个入口，都以 `unsupported_version` 失败，不去猜对方的形状。
- **形状和路径的规范。** `GET /protocol/schema` 是线上形状的 JSON Schema（2020-12），`$defs` 的名字和 TypeScript 的类型名一样，只描述过线的形状（`AgentSpec.model` 只能是名字，`RunRequest` 没有 `signal`），对象不收没列出的键；`GET /protocol/openapi` 是 OpenAPI 3.1，每条路径一项，引用同一批形状。两份的副本在仓库根的 [`schema/`](../schema)。手写，不从类型生成；一致靠测试：副本和代码一致，线上的真实值（会话、harness、流、编排器、执行环境、记忆、发现）都合 schema，OpenAPI 列出的每条路径服务端都认。

| 组件     | 方法              | 路径                                                               | 请求体 → 响应                                                                                                                               |
| -------- | ----------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 会话     | `append`          | `POST /sessions/:session/entries`                                  | `{ entries, expectSeq? }` → `{ entries }`；前提不满足 409（`type: conflict`，`retryable`）                                                  |
|          | `list`            | `GET /sessions/:session/entries?after=&last=&limit=&types=&kinds=` | → `{ entries, more? }`；`types`、`kinds` 逗号分隔（`kind` 里不能有逗号）；一次最多一页，`more: true` 时用最后一条的 `seq` 当 `after` 接着读 |
|          | `watch`           | `GET /sessions/:session/entries/stream?after=`                     | → NDJSON `Entry`；存储没有 `watch` 时服务端轮询 `list`                                                                                      |
|          | `clear`           | `DELETE /sessions/:session`                                        | → `{ deleted }`                                                                                                                             |
|          | `truncate`        | `POST /sessions/:session/entries/truncate`                         | `{ upTo }` → `{ deleted }`；`upTo` 不是数字 400                                                                                             |
|          | `remove`          | `POST /sessions/:session/entries/remove`                           | `{ ids }` → `{ removed }`；`ids` 不是字符串数组 400                                                                                         |
|          | `redact`          | `POST /sessions/:session/entries/redact`                           | `{ ids }` → `{ redacted }`                                                                                                                  |
|          | `sessions`        | `GET /sessions?prefix=&after=&limit=`                              | → `{ sessions }`；名字升序                                                                                                                  |
| 执行环境 | （列出名字）      | `GET /executors`                                                   | → `{ executors }`                                                                                                                           |
|          | `tools`           | `GET /executors/:name/tools`                                       | → `{ tools }`                                                                                                                               |
|          | `execute`         | `POST /executors/:name/execute`                                    | `{ call, context: { session, runId? } }` → `{ output }`；断开即中止                                                                         |
|          | `open`            | `POST /executors/:name/sessions/:session/open`                     | `{ environment? }` → `{}`；执行环境没有 `open` 时什么都不做                                                                                 |
|          | `close`           | `DELETE /executors/:name/sessions/:session`                        | → `{}`                                                                                                                                      |
|          | （领工作）        | `POST /work/:executor/claim`                                       | `{ limit?, waitMs?, leaseMs? }` → `{ calls }`（`ClaimedToolCall[]`）；见下面                                                                |
| Harness  | `run`             | `POST /runs`                                                       | `RunRequest` 去掉 `signal`（可带 `aborted: true`）→ `RunResult`                                                                             |
|          | `stream`          | `POST /runs?stream=1`                                              | 同上 → NDJSON `RunEvent`；断开即中止                                                                                                        |
|          | 取消（`signal`）  | `DELETE /runs/:runId`                                              | → `{ cancelled }`                                                                                                                           |
| 编排     | `submit`          | `POST /orchestrator/runs`                                          | 同 `POST /runs` → `{ runId, session }`                                                                                                      |
|          | `status` / `done` | `GET /orchestrator/runs/:runId?wait=<ms>&session=`                 | → `{ runId, status, session?, result?, error? }`；`wait` 是长轮询；给了 `session` 时结果可以从会话日志还原                                  |
|          | `cancel`          | `DELETE /orchestrator/runs/:runId`                                 | → `{ cancelled }`                                                                                                                           |
|          | `recover`         | `POST /orchestrator/recover`                                       | → `{ recovered }`                                                                                                                           |
|          | `events`          | `GET /orchestrator/events`                                         | → NDJSON `OrchestratorEvent`                                                                                                                |
| 记忆     | `notes.*`         | `/memory/notes` 下                                                 | 每个方法一条路径，逐条见 [`packages/remote`](../packages/remote/README.md)                                                                  |
|          | `facts.*`         | `/memory/facts` 下                                                 | 同上                                                                                                                                        |
|          | `procedures.*`    | `/memory/procedures` 下                                            | 同上                                                                                                                                        |
|          | `core.*`          | `/memory/core` 下                                                  | 同上                                                                                                                                        |

几条跨路径的规则：

- 等很久才有结果的两个请求（`POST /runs`、`POST /executors/:name/execute`）会在结果出来之前先发 200 的响应头，隔一段时间写一个换行当心跳，最后才是 JSON 正文（JSON 允许前面有空白）。头发出去之后才出的错改不了状态码，正文是 `{ error, status }`，`status` 是本来该回的状态码。
- **主体（[ADR 0009](adr/0009-hosted-prerequisites.md)）。** 服务端可以把请求映射到一个主体 `Principal { id, sessionPrefixes?, memoryScopes?, admin? }`（`ctx-remote` 的 `authenticate`，和单一的访问令牌二选一）。认不出是 401。带会话的入口都按 `sessionPrefixes` 查，超出的回 403 `permission_error`：会话的路径、`execute` 的 `context.session`、执行环境会话的 `open` 和 `close`、提交运行时的 `session`、`parent.session` 和 `agent.context.inherit.session`、按 `runId` 取消和查状态时那一轮的会话。`GET /sessions` 只列范围里的，领工作只扫范围里的会话，编排器的事件流只发范围里的；`/memory/*` 的作用域按 `memoryScopes` 查；`recover` 横跨所有会话，只有 `admin` 能调。身份怎么来（JWT、mTLS、网关传来的头）是部署方的事。
- **领工作。** `POST /work/:executor/claim` 扫主体看得见的会话，给出最后一轮以 `requires_action` 停下、`ctx.run.ended` 记着归这个执行环境、现在就能执行（不等确认，或者已经确认了）的调用，每个带上它的会话（`ClaimedToolCall`：`PendingToolCall` 加 `session`）。领到的在租约内（`leaseMs`，缺省是服务端的配置，`ctx-remote` 是 5 分钟）不再给别的领取；执行方把结果追加回会话（`toolResultEntry`），它就不再等了。一个都没有时长轮询，最多等 `waitMs`（30 秒封顶）。`limit` 缺省 16、最多 100。租约只是让几个 worker 少做重复的事：它在服务端进程的内存里，同一次调用的结果只记一条靠的是幂等键。服务端要挂了会话存储，没挂是 404。
- 到了并发上限回 429（`type: rate_limit_error`，`retryable: true`）。
- 500 的 `message` 只有一句通用的话和一个编号，原文在服务端的日志里；协议错误（`invalid_request`、`not_found`、`conflict`）照旧带着自己的 `type` 和文字。
- 客户端可以放心重试的：所有 `GET`、带着 `id` 的 `append`（存储按 `id` 去重）、两个取消。提交运行、执行工具、领工作、记忆的写入不幂等，不重试。会话的 `clear` 和三个擦除重发一遍不会多删，但第二次回的条数是 0，本包的客户端不自动重试，调用方想重试可以自己重发。

**对一个地址跑一致性测试。** 被测的服务以一致性模式运行，多一个入口 `POST /conformance/instances`：请求体是 `ConformanceSetup`（`components`、模型剧本 `script`、模型的延迟 `delayMs`、存储的钟 `clock`），回一个新的隔离实例（`baseUrl` 是相对路径，另给契约用的 `agent` 和 `executor: { name, echo }`）。`ctx-conformance --url <地址>`（`@modelctx-ai/ctx-remote`）给每个用例建一个实例，用客户端跑会话、执行环境、harness、编排器、记忆存储的契约测试。任何语言写的服务端，提供这个入口、实现了线上形态，就能这样验证（Python 的 `ctx-pydantic-ai` 就这样验证它的 harness，见 [`python/pydantic-ai`](../python/pydantic-ai/README.md#一致性等级)）；剧本的语义见 [`packages/remote`](../packages/remote/README.md#对一个地址跑一致性测试)。

编排器放在 `/orchestrator` 下，不和 harness 共用 `/runs`：同一个服务可以同时挂两者，「现在跑一轮、等结果」和「排进队列」是两件事。细节（取消的时序、长轮询的上限、安全缺省）见 [`packages/remote`](../packages/remote/README.md)。

WebSocket 传输在之后加，协议不变。
