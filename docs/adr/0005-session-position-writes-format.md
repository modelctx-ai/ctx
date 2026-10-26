# ADR 0005：会话位置、并发写入、消息格式版本、AgentSpec 上下文配置

- 状态：提议（待用户审；审过后才实施，本 ADR 不改代码）
- 日期：2026-10-26
- 范围：`ctx-protocol`、`@modelctx-ai/ctx`、`ctx-sqlite`、`ctx-remote`、`ctx-gateway`；yoyo 作为实践

## 背景

[ADR 0004](0004-protocol-and-implementation.md) 把协议和实现分开后，`SessionStore`、`Harness`、`Orchestrator` 可以放在进程边界的另一侧，也可以有多个进程共用一个存储。下面五个问题在单进程、单个调用方的用法里不出现，跨进程和长期运行时会出现。第 1 到 3 项是 bug 或一致性缺口，第 4 项是 yoyo 报告的能力缺口，第 5 项是规模问题。

本节区分已验证的事实和从代码读出的推断。

**1. 补写旧记录会丢。** 场景：在内存存储上先写 a、b，压缩（摘要覆盖到 b），再补写一条 `at` 早于 b 的旧记录 late，再写 c。我在内存存储上跑了这个场景：`list()` 的顺序是 `a, late, b, summary, c`；`list(after: summary.covers)` 只返回 `summary, c`；`project()` 得到 `["Summary…sum of a,b", "c"]`，late 排在 b 之前，被 `covers` 盖住，但摘要文字里没有它。任务描述另报告了 `watch` 的结果：已经看过 b 的 `watch` 只收到 `a, b, summary, c`，漏了 late（我没有重跑 `watch`，从代码看原因相同）。原因：`watch(after)`、`list(after)` 和 `summary.covers` 都按 `(at, seq)` 比较，而 `at` 是调用方给的逻辑时间，可以是过去（[ADR 0003](0003-context-model.md) 把幂等导入旧记录当作功能，yoyo 每拍都在做）。`(at, seq)` 同时承担两个用途：投影里的逻辑先后，和日志里的写入位置。第二个用途要求"新写入的一定在游标之后"，补写旧记录破坏了这一点。

**2. 多进程写同一个会话没有保护。** 从代码读出：`SessionStore.append` 没有写入前提条件，"同一会话的运行串行"只在 `createOrchestrator` 的进程内队列里成立。`recover()` 只跳过本进程编排器自己知道的运行（`packages/core/src/orchestrator.ts`），所以两个进程共用一个 sqlite 库时，一个进程恢复会给另一个进程正在跑的运行补 `ctx.run.ended`，被补的运行之后照常写入，日志里出现 ended 之后的产出。我没有在两个进程上实际复现，结论来自代码。

**3. 消息格式绑定 AI SDK。** 从代码读出：`MessageEntry.message` 是 AI SDK v7 的 `ModelMessage` 原样；`packages/protocol` 的 `session.ts`、`context.ts`、`harness.ts`、`tokens.ts` 都 import `ai` 的类型。消息里可以有 `Uint8Array`、`URL`，所以 `ctx-sqlite` 和 `ctx-remote` 的 `wire.ts` 各有一份带 `\u0000ctx` 标记的编码，两份代码一样。这和 [概念](../concepts.md) 设计约束 2「协议只收发 JSON」不一致。另外：行里没有格式版本（sqlite 的 `meta.schema` 只管表结构），AI SDK 下一个大版本改了 `ModelMessage`，旧日志就没有可靠的读法。`ToolOutput` 已经有自己的 JSON 形状和与 AI SDK 的互转，消息没有。

**4. 事实的收法只能在建 builder 时定。** 任务描述转述了 yoyo 的 PR（modelctx-ai/yoyo#7、#9，我没有读这两个 PR）：`RunRequest`、`AgentSpec` 不能按一轮指定事实收不收、放在哪。从代码确认：`factsPlacement`、`sources`、`projection` 都是 `createContextBuilder` 的选项；`BuildRequest` 只有一个 `facts?: boolean`。

**5. 规模。** 从代码读出：`sessions()` 没有分页和前缀；`list` 只能按 `type` 过滤，不能按事件 `kind`；`recover` 每次读全部会话的全部事件。

## 决定

### 1. 位置只用 `seq`；`at` 只是逻辑时间

```ts
interface EntryBase {
  seq: number; // 会话内位置
  at: number; // 逻辑时间，只用于投影排序和展示
  // …
}
interface SummaryEntry extends EntryBase {
  covers: number; // 所有 seq ≤ covers 的条目由这段摘要代替
}
interface ListOptions {
  after?: number; // seq，不含
  last?: number;
  types?: readonly EntryType[];
  kinds?: readonly string[]; // 见决定 5
}
interface WatchOptions {
  after?: number; // seq，不含
  signal?: AbortSignal;
}
```

`Cursor`、`compareCursor`、`cursorOf` 删除。规则：

- `seq` 在一个会话内严格递增，按写入顺序分配，从 1 开始；0 表示"会话开头"。`(session, seq)` 唯一。不要求连续（回滚会留空洞），不要求全局递增，但 `clear` 之后不回退、不复用。
- `list` 和 `watch` 都按 `seq` 升序返回；`last: N` 是 `seq` 最大的 N 条。存储不再需要 `(at, seq)` 索引，一个 `(session, seq)` 索引够用。
- 投影仍按 `(at, seq)` 排序（新的纯函数 `compareEntries`），所以补写的旧记录在模型看到的历史里仍排回原来的位置。
- `compact` 按日志顺序定切点：先按现在的规则选出要保留的消息，`covers` 取"保留的条目里最小的 `seq` 减 1"，摘要输入是投影里 `seq ≤ covers` 的部分。这样"seq ≤ covers 的都进了摘要"始终成立。
- 摘要之后补写的旧记录 `seq > covers`，压缩后仍然可见，按 `at` 排在摘要后的条目里。它不在这次摘要的文字里，下一次压缩会收进去。

同一个场景在新规则下：`watch(after: 0)` 收到 `a, b, summary, late, c`；`project()` 得到 `["Summary…sum of a,b", "late", "c"]`。契约测试固定这个结果。

**`seq` 要全局单调还是会话内单调？** 只要求会话内单调。全局单调需要一个中心计数器，和按会话分片的存储（每个会话一条流、一个 Durable Object、一个分区）不兼容；会话内单调在这些存储上都是免费的。现有的内存存储和 sqlite 是全局递增，满足会话内单调。协议文字写"会话内"，消费者不能依赖跨会话比较。

### 2. 写入前提条件，不用租约

```ts
interface AppendOptions {
  /** 仅当会话当前最后一条的 seq 等于它才写（空会话是 0），否则整批不写，抛 conflict。 */
  expectSeq?: number;
}
append(session: string, entries: readonly NewEntry[], options?: AppendOptions): Promise<Entry[]>
```

- 前提不满足时整批不写，抛 `ErrorInfo.type: 'conflict'`、`retryable: true` 的错误；HTTP 是 409。前提先于去重检查：重试一批已经成功的写入，如果其间别人又写了，仍然得到 `conflict`，调用方重读就能看到自己的条目已在。
- 协议包导出纯函数 `headSeq(store, session)`（用 `list({ last: 1 })`），不加新的接口方法；存储以后可以优化。
- 不给 `expectSeq` 的 `append` 行为不变。

**为什么前提条件，不是租约。** 目标是"harness 可丢弃、从日志续跑"（约束 4）。租约要有过期时间和续约：持有者崩溃后租约占着会话直到过期，续跑要等；持有者只是暂停（垃圾回收、网络分区）而没有死，过期后它仍然会写，要防住它还得再加一个递增的围栏令牌，而 `seq` 本身就是这个令牌。租约还引入存储之外的时钟和一个需要保活的状态。前提条件无状态，崩溃的 harness 什么都不用释放，新 harness 读到日志就能接着做。租约作为应用层约定仍然可以建在它上面，协议不预设。

Harness 契约（写进协议文字和契约测试）：

1. 开始：读最后一个运行生命周期事件（`list(kinds: [started, ended], last: 1)`）。是 `started` 就说明有未结束的运行，`run` 以 `ErrorInfo.type: 'session_busy'`（`retryable: true`）失败，不写任何东西。否则追加 `ctx.run.started`，带 `expectSeq`。冲突就重读、重判。因此一个会话最多一个未结束的运行，跨进程也成立。
2. 运行中：每次写入带 `expectSeq`（本轮最后一次写入返回的 `seq`）。冲突时读 `after` 之后的生命周期事件：如果自己的 `runId` 已有 `ctx.run.ended`，说明被别人当作断掉的运行收走了（围栏），停下，`stopReason: 'aborted'`，不再写 ended；否则别人只是写了应用事件，采用新的末尾 `seq` 重试。
3. 同一进程内的 per-session 队列保留，它只是少打一次冲突。
4. 进程崩溃留下的未结束运行会让该会话一直 `session_busy`，直到有编排器 `recover` 它（见下）。所以进程启动时要先 `recover` 再接新的 `submit`；这是对应用的新要求，要写进文档。

**`recover` 加所有者。** `RunStartedData` 加可选的 `owner`，`createOrchestrator` 加选项 `owner`（部署者给的稳定实例名，例如 `yoyo-main`）。`recover()` 只处理 `owner` 与自己相同的断掉的运行（都没配置也算相同），所以两个进程共用一个库时各配一个名字，互不收对方的运行。写 `ctx.run.ended` 时带 `expectSeq`：如果读到写入之间会话有新条目，说明那个运行其实在动，跳过它。围栏（上一节第 2 点）兜底：即使判错，活着的运行下一次写入也会发现自己被结束并停下。`recover` 对每个会话只读最后一个生命周期事件（`last: 1`），随之需要决定 5 的 `kinds` 过滤。

### 3. 消息格式：ctx 自己的 JSON 子集，带版本

```ts
type Message =
  | { role: 'system'; content: string; providerOptions?: ProviderOptions }
  | { role: 'user'; content: string | UserPart[]; providerOptions?: ProviderOptions }
  | { role: 'assistant'; content: string | AssistantPart[]; providerOptions?: ProviderOptions }
  | { role: 'tool'; content: ToolResultPart[]; providerOptions?: ProviderOptions };

type UserPart = TextPart | FilePart;
type AssistantPart = TextPart | FilePart | ReasoningPart | ToolCallPart;
// TextPart       { type: 'text', text }
// FilePart       { type: 'file', mediaType, data: ToolFileData, filename? }   图片也是 file，靠 mediaType 区分
// ReasoningPart  { type: 'reasoning', text, providerOptions? }
// ToolCallPart   { type: 'tool-call', id, name, input: JsonValue }            字段名同 ToolCall
// ToolResultPart { type: 'tool-result', id, name, output: ToolOutput }
```

- `Message` 全是 JSON：二进制是 base64 字符串（复用 `ToolFileData`），URL 是字符串。`providerOptions` 按服务商名分组、原样保存，用来带推理签名这类必须回传的服务商字段。
- 转换函数 `toModelMessages` / `fromModelMessages` 放在 `@modelctx-ai/ctx`（它依赖 `ai`），和 `ToolOutput` 与 AI SDK 的互转同一个做法。`ctx → AI SDK` 总能转；`AI SDK → ctx` 遇到子集之外的部件（例如工具审批部件）抛 `unsupported_part`，harness 把这一轮以 `error` 结束，不静默丢。
- 协议包不再 import `ai` 的消息类型：`ModelMessage`、`UserContent` 换成 `Message`、`MessageContent`（`PreparedCall.messages`、`RunResult.messages`、`RunRequest.input`/`prompt`、`ProjectionOptions` 的回调、`textOf`、`estimateTokens`）。协议包对 `ai` 的 peer 依赖只剩 `ModelRef` 里的 `LanguageModel`，即 ADR 0004 §3 声明的那个进程内例外。
- `@modelctx-ai/ctx` 的 `createContext()` 面向应用，继续收 AI SDK 的 `UserContent` 并在边界转换；不要求应用改调用写法。
- 部件清单是 v1 的设计目标。实施时必须对照 `ai@7.0.150` 的 `ModelMessage` 定义逐项核对，有遗漏就补，不在本 ADR 里臆测。

**版本。** `EntryBase` 加 `v: number`，当前版本 1；没有 `v` 的行读作 0，即现状（AI SDK 的 `ModelMessage`、`covers` 是 `{ at, seq }`、二进制和 URL 用 `\u0000ctx` 标记）。协议包导出 `ENTRY_VERSION` 和纯函数 `upgradeEntry(raw): Entry`，把低版本一步步升到当前版本；读到比自己认识的更高的 `v` 时抛 `unsupported_version`，不猜。

**旧日志怎么升级。** 读时升级，不改存量行（日志只追加，约束 1）。存储把读出来的原始 JSON 交给 `upgradeEntry`；新写入的行带 `v: 1`。`upgradeEntry` 的 0 → 1 规则：

- 消息：`toolCallId`/`toolName` 改 `id`/`name`；工具结果的 `output` 经现有的 `toolOutputFromAiSdk`；`image` 部件改 `file`；`\u0000ctx` 的 bytes 变 `{ type: 'data', data: <base64> }`，url 变 `{ type: 'url', url }`；
- 摘要：`covers` 取 `covers.seq`（见下面的已知差异）；
- 事件：不变。

0 → 1 有两处不能无损，实施时要写进迁移说明：

- 旧摘要的 `covers` 原来按 `(at, seq)` 比较，现在按 `seq`。差异只出现在"摘要之前就有补写旧记录"的会话：seq 小于切点、`at` 大于切点的条目，原来可见，现在被覆盖。提供一个只读检查函数 `findLossySummaries(store)`，列出受影响的会话；处理办法是重新压缩一次（原条目还在，新摘要会把旧摘要一起收进去）。yoyo 受影响的会话数未知，要在 `yoyo.db` 上跑检查才知道。
- AI SDK 的 `image` 部件、`data` 是字符串时可能是 base64、也可能是 URL 字符串。升级时按 `http(s):`、`data:` 前缀判 URL，其余当 base64。

`ctx-sqlite` 和 `ctx-remote` 里两份 `\u0000ctx` 编解码删掉，标记只留在 `upgradeEntry` 读 v0 的那一处。

### 4. `AgentSpec.context`：按一轮选择事实和投影

函数（来源的 `collect`、投影的 `render`）不能序列化，所以配置只做"按名字选"，和 `ToolSelection` 同一个思路。代码里注册，`AgentSpec` 里引用名字。

```ts
interface ContextSpec {
  /** false 不收事实；缺省收。 */
  facts?: boolean | FactsSpec;
  /** builder 里注册的投影配置名；缺省 'default'。 */
  projection?: string;
}
interface FactsSpec {
  /** 只用这些来源（按 ContextSource.name）；缺省全部。 */
  sources?: readonly string[];
  placement?: 'instructions' | 'prompt';
  heading?: string;
}
interface AgentSpec {
  // …
  context?: ContextSpec;
}
interface BuildRequest {
  facts?: boolean | FactsSpec; // 原来只有 boolean
  projection?: string;
}
interface ContextBuilderOptions {
  projections?: Record<string, ProjectionOptions>; // 'default' 缺省取原来的 projection 选项
}
```

- `RunRequest` 本来就带完整的 `agent: AgentSpec`，所以"按一轮指定"由 `agent.context` 解决，`RunRequest` 不加字段。Harness 把 `agent.context` 原样放进 `BuildRequest`。
- `factsPlacement` 选项变成缺省值；`FactsSpec.placement` 覆盖它。`projection` 名字不认识时 `build`/`view` 以 `not_found` 失败，不回退到缺省。
- `context` 是 JSON，`ctx-remote` 的路由和 `agentSpecToJson` 都不用改（后者要多放一个字段），`ctx.run.started` 因此会记下这一轮用的上下文配置。

### 5. 分页和按事件 `kind` 过滤

```ts
sessions(options?: { prefix?: string; after?: string; limit?: number }): Promise<string[]>
// 返回按名字升序；after 是上一页最后一个名字（不含）。
// ListOptions.kinds：给了就只返回 kind 在其中的事件条目，消息和摘要不返回；与 types 取交集。
```

- `ctx-remote`：`GET /sessions?prefix=&after=&limit=`，`GET …/entries?kinds=a,b`（逗号分隔，同 `types`）。
- `ctx-sqlite`：`kind` 用生成列 `kind TEXT GENERATED ALWAYS AS (json_extract(body, '$.kind')) VIRTUAL` 加索引 `(session, kind, seq)`，不需要回填；旧版本写入的行也自动有 `kind`。前缀用范围查询（`session >= ? AND session < ?`），不用 `LIKE`，避免转义。
- 内存存储：`sessions()` 现在是插入顺序，改成名字升序。
- `recover` 用 `sessions({ limit })` 翻页，每个会话一次 `list(kinds: [started, ended], last: 1)`，不再读消息正文。仍然是"每个会话一次查询"，规模到几万个会话以内可以接受；更大的规模要存储自己提供"有未结束运行的会话"的索引，等有需求再加。
- 旧日志里可能有多个未结束的运行（决定 2 的 bug 的产物）。`last: 1` 只看最后一个生命周期事件，漏掉被后续运行盖过的老断点。这些不影响会话继续使用，接受。

## 破坏面

| 改动                  | 协议包                                                                                                                | 内存存储（core）                        | ctx-sqlite                                                                                                                     | ctx-remote                                                  | ctx-gateway                                       | yoyo（推断，未读代码）                                                                        |
| --------------------- | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| 1 `seq` 位置          | 不兼容：删 `Cursor`/`compareCursor`/`cursorOf`；`covers`、`after`、`upTo`、`CompactedData.covers` 改数字              | 去掉 `insertSorted`，按追加顺序存       | 索引换 `(session, seq)`；`covers` 存数字；`after` 条件简化                                                                     | `after.at`/`after.seq` 查询参数改 `after`；`cursorParam` 改 | 无                                                | 凡用 `cursorOf` 或 `after: {at,seq}` 的地方改成 `after: entry.seq`；投影规则不受影响          |
| 2 `expectSeq`         | 加 `AppendOptions`、`conflict`/`session_busy`；Harness 和 Orchestrator 契约改                                         | 加前提检查                              | 加前提检查；写入要用 `BEGIN IMMEDIATE`（外层已有事务时仍用 SAVEPOINT），否则两进程读后写会得到 `SQLITE_BUSY` 而不是 `conflict` | `POST …/entries` 带 `expectSeq`；409 映射为 `conflict`      | 无                                                | 不给 `expectSeq` 的调用不变；yoyo 若有两个进程共用库，要给编排器配 `owner`                    |
| 3 `Message` 与 `v`    | 不兼容：全部 `ModelMessage`/`UserContent` 换成 `Message`；加 `upgradeEntry`、`ENTRY_VERSION`                          | 无编码问题，类型跟着换                  | 加 `v` 列，`meta.schema` 1 → 2（`ALTER TABLE ADD COLUMN`）；删编码；读时 `upgradeEntry`                                        | 删 `wire.ts` 的二进制标记；条目带 `v`；新旧版本不能混用     | `messages.ts`、`rewrite.ts` 改成与 `Message` 互转 | 传 `Uint8Array`/`URL` 图片的地方改用 `FilePart`；直接读 `ctx_entries.body` 的代码要改（若有） |
| 4 `AgentSpec.context` | 加性：`ContextSpec`、`FactsSpec`、`BuildRequest` 放宽；第三方 builder 若忽略 `context` 会静默回到缺省，靠契约测试暴露 | 无                                      | 无                                                                                                                             | 无（`context` 是 `AgentSpec` 里的 JSON）                    | 无                                                | 能解决 yoyo#7、#9 报告的缺口；不用也不受影响                                                  |
| 5 分页和 `kinds`      | 加性：`sessions(options?)`、`ListOptions.kinds`；`sessions()` 缺省顺序写成"名字升序"                                  | `sessions()` 顺序从插入顺序变成名字升序 | 加生成列和索引                                                                                                                 | 加两个查询参数                                              | 无                                                | 无                                                                                            |

版本：按 [ADR 0002](0002-packages.md)，不兼容改动升 minor，所有包 0.2 → 0.3，一起发。不留 `Cursor` 的弃用别名：它的类型从对象变成数字，别名只会让旧代码编译通过、运行出错。

不支持滚动升级：同一个 sqlite 库的所有进程要一起停、一起升。旧版 `ctx-sqlite` 打开 schema 2 的库不会报错（它不检查 `meta.schema` 的值），也会读错新行；实施时让新版在 `meta.schema` 写入 `2`，并在发布说明里写明。旧版写入的行没有 `v`，默认 0，仍然是合法的旧行。

对旧 ADR 的影响（本 ADR 被采纳后再改旧文）：

- [ADR 0003](0003-context-model.md) 决定 1「`ModelMessage` 原样保存」改成 `Message`；决定 3「`covers` 指向位置」改成 `seq`；"多处同时写"一行里"顺序由 `(at, seq)` 决定"改成"日志顺序由 `seq` 决定，投影顺序由 `(at, seq)` 决定"。
- [ADR 0004](0004-protocol-and-implementation.md)「没有采用：自定义消息格式代替 `ModelMessage`」的前提是 `ModelMessage` 已经是 JSON，实际不是（二进制和 URL）。该条改成指向本 ADR。
- [协议层](../protocol.md)、[架构](../architecture.md)、[概念](../concepts.md)的术语表（`Cursor` 条）随实施一起改。

## 实施与验证

由后续任务"按 ADR 0005 改协议和实现"做，建议顺序：1（位置）→ 5（分页、`kinds`，和 1 一起动 sqlite 的索引）→ 3（消息与版本）→ 2（`expectSeq`、围栏、`owner`）→ 4（`context`）。每一步先写契约测试，再改实现：

- 位置：补写旧记录后 `watch`、`list(after)`、`project()` 的结果与"决定 1"一节的场景一致；`clear` 后 `seq` 不回退；`compact` 切点满足"seq ≤ covers 的都进了摘要"。
- 前提条件：`expectSeq` 不满足时整批不写；两个 `createSqliteStore` 句柄指向同一个文件，并发 `append` 带同一个 `expectSeq`，恰好一个成功；两个编排器配不同 `owner` 共用一个库，一个 `recover` 不动另一个的运行；被 `recover` 结束的运行在下一次写入时停下，且不重复写 ended。
- 版本：v0 的黄金样例（含 `Uint8Array`、`URL`、工具调用和结果）经 `upgradeEntry` 后与手写的 v1 期望相等；未知 `v` 抛 `unsupported_version`；`findLossySummaries` 在构造的数据上能找出受影响的会话。
- `context`：同一个 builder 上两个不同的 `AgentSpec.context` 得到不同的事实和位置；未知投影名得到 `not_found`。
- 全量：`pnpm check`（格式、lint、类型、测试、构建）通过，远程客户端上的四个协议契约测试仍然通过。

## 代价

- 一次不兼容升级，yoyo 要改一次；读时升级让每次读多一步转换，换来不改存量日志。
- `Message` 是我们自己维护的一套格式：AI SDK 加新部件时，要决定加不加、怎么转。子集比一一对应少一个维护面，代价是 `fromModelMessages` 遇到未知部件会让这一轮出错。
- `expectSeq` 让每次写入多一个比较；冲突时要多读一次。换来跨进程不互相覆盖和可靠的围栏。
- 逻辑顺序和日志顺序现在是两个概念：`list` 返回日志顺序，投影返回逻辑顺序。使用者要分清；"最近 N 条"在有补写时指最近写入的 N 条，不是 `at` 最大的 N 条。
- `owner` 靠部署者配置，配错（两个进程同名、或都不配）就退回今天的行为，围栏只能减轻后果。

## 没有采用

- 保留 `(at, seq)` 做游标，另外禁止调用方设置过去的 `at`：和 ADR 0003 的幂等导入冲突，导入的条目会排到最后，和应用事件的先后关系丢了。
- 保留 `(at, seq)`，再加一个单独的 `ts` 字段给逻辑时间：和决定 1 同效，但要同时保留两个游标；改成只用 `seq` 更简单。
- `seq` 全局单调：见决定 1，不兼容分片存储。
- 租约加心跳：见决定 2。
- 加互斥锁服务或在 `Orchestrator` 里做跨进程选主：多出一个要部署的组件，协议里只需要一个比较。
- 消息格式与 AI SDK 一一对应（`Message = ModelMessage` 的 JSON 化拷贝）：每次 AI SDK 改动都要同步，没有少一个维护面；子集加明确的失败更可控。
- 继续用 AI SDK 的 `ModelMessage` 并只在版本字段上记 AI SDK 的主版本：协议仍然不是 JSON，二进制编码仍然两处重复。
- 一次性迁移脚本改写存量行：违背只追加，也有停机窗口；读时升级不动存量数据，出问题时数据本身没有被破坏。
- 在 `RunRequest` 里加 `facts`、`projection` 字段：`RunRequest` 已经带完整的 `AgentSpec`，再加一处会有两处可以指定。

## 待用户确认

1. 消息格式取子集（决定 3）而不是一一对应，且 `fromModelMessages` 遇未知部件让这一轮出错：同意吗？这是最大的一项改动，涉及协议包里所有消息类型。
2. 旧摘要的 `covers` 按 `covers.seq` 解释，已知差异用 `findLossySummaries` 加重新压缩处理：同意吗？是否需要先在 yoyo 的真实库上量一下受影响的会话数。
3. `recover` 靠 `owner` 约定区分进程，不做心跳：同意吗？
4. 版本一起升 0.3、不留 `Cursor` 别名：同意吗？
