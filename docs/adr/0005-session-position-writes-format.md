# ADR 0005：会话位置、并发写入、消息格式版本、AgentSpec 上下文配置

- 状态：已采纳（2026-10-26 用户审阅后按「决定记录」修订；实施由后续任务做，本 ADR 不改代码）
- 日期：2026-10-26
- 范围：`ctx-protocol`、`@modelctx-ai/ctx`、`ctx-sqlite`、`ctx-remote`、`ctx-gateway`；yoyo 作为实践
- 依据：对照了 yoyo `main`（5df53c9，含 PR #7、#9）的代码，和 ctx 的 sqlite 迁移分支（`tds/conv-01a1790d-1daf-72c0-9b01-4ffbec5de89e`，`meta.schema` 升到 2）

## 背景

[ADR 0004](0004-protocol-and-implementation.md) 把协议和实现分开后，`SessionStore`、`Harness`、`Orchestrator` 可以放在进程边界的另一侧，也可以有多个进程共用一个存储。下面五个问题在单进程、单个调用方的用法里不出现，跨进程和长期运行时会出现。第 1 到 3 项是 bug 或一致性缺口，第 4 项是 yoyo 报告的能力缺口，第 5 项是规模问题。

本节区分已验证的事实和从代码读出的推断。

**1. 补写旧记录会丢。** 场景：在内存存储上先写 a、b，压缩（摘要覆盖到 b），再补写一条 `at` 早于 b 的旧记录 late，再写 c。我在内存存储上跑了这个场景：`list()` 的顺序是 `a, late, b, summary, c`；`list(after: summary.covers)` 只返回 `summary, c`；`project()` 得到 `["Summary…sum of a,b", "c"]`，late 排在 b 之前，被 `covers` 盖住，但摘要文字里没有它。任务描述另报告了 `watch` 的结果：已经看过 b 的 `watch` 只收到 `a, b, summary, c`，漏了 late（我没有重跑 `watch`，从代码看原因相同）。原因：`watch(after)`、`list(after)` 和 `summary.covers` 都按 `(at, seq)` 比较，而 `at` 是调用方给的逻辑时间，可以是过去（[ADR 0003](0003-context-model.md) 把幂等导入旧记录当作功能，yoyo 每秒一拍，每拍 `syncPetChat` 都导入最近 200 条桌宠对话）。`(at, seq)` 同时承担两个用途：投影里的逻辑先后，和日志里的写入位置。第二个用途要求"新写入的一定在游标之后"，补写旧记录破坏了这一点。

**2. 多进程写同一个会话没有保护。** 从代码读出：`SessionStore.append` 没有写入前提条件，"同一会话的运行串行"只在 `createOrchestrator` 的进程内队列里成立。`recover()` 只跳过本进程编排器自己知道的运行（`packages/core/src/orchestrator.ts`），所以两个进程共用一个 sqlite 库时，一个进程恢复会给另一个进程正在跑的运行补 `ctx.run.ended`，被补的运行之后照常写入，日志里出现 ended 之后的产出。我没有在两个进程上实际复现，结论来自代码。

**3. 消息格式绑定 AI SDK。** 从代码读出：`MessageEntry.message` 是 AI SDK v7 的 `ModelMessage` 原样；`packages/protocol` 的 `session.ts`、`context.ts`、`harness.ts`、`tokens.ts` 都 import `ai` 的类型。消息里可以有 `Uint8Array`、`URL`，所以 `ctx-sqlite` 和 `ctx-remote` 的 `wire.ts` 各有一份带 `\u0000ctx` 标记的编码，两份代码一样。这和 [概念](../concepts.md) 设计约束 2「协议只收发 JSON」不一致。另外：行里没有格式版本（sqlite 的 `meta.schema` 只管表结构），AI SDK 下一个大版本改了 `ModelMessage`，旧日志就没有可靠的读法。`ToolOutput` 已经有自己的 JSON 形状和与 AI SDK 的互转，消息没有。

**4. 事实的收法只能在建 builder 时定。** 任务描述转述了 yoyo 的 PR（modelctx-ai/yoyo#7、#9）：`RunRequest`、`AgentSpec` 不能按一轮指定事实收不收、放在哪。从 ctx 代码确认：`factsPlacement`、`sources`、`projection` 都是 `createContextBuilder` 的选项；`BuildRequest` 只有一个 `facts?: boolean`。yoyo 的绕法在 yoyo `main` 里可见：`src/brain/harness.ts` 把 builder 包一层，强制 `facts: false`；`src/brain/compose.ts` 自己调 `context.facts()`，碎碎念把事实放进 `prompt`，回复把事实放进 `replyAgent` 的指令。

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
- 生效的摘要是 `covers` 最大的那条；`covers` 相同时 `seq` 大的（后写的）生效。现在的 `latestSummary` 在相同时取先出现的，要改。两个进程同时压缩各写一条摘要时，这条规则保证结果确定，不丢条目：`covers` 总是某个已有 `seq` 减 1，两条摘要覆盖的都是自己输入里的条目。

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

范围：只有 `record` 不为 `false` 的运行写 `ctx.run.*`，也只有它们受下面的规则约束。`record: false` 的运行不碰日志，不占会话，不会遇到 `session_busy`，也不会被 `recover` 看到。yoyo 的碎碎念和回复都是这种运行（见「对 yoyo 的核对」）。

1. 开始：读最后一个运行生命周期事件（`list(kinds: [started, ended], last: 1)`）。是 `started` 就说明有未结束的运行，`run` 以 `ErrorInfo.type: 'session_busy'`（`retryable: true`）失败，不写任何东西。否则追加 `ctx.run.started`，带 `expectSeq`。冲突就重读、重判。因此一个会话最多一个未结束的运行，跨进程也成立。
2. 运行中：每次写入带 `expectSeq`（本轮最后一次写入返回的 `seq`）。冲突时读 `after` 之后的生命周期事件：如果自己的 `runId` 已有 `ctx.run.ended`，说明被别人当作断掉的运行收走了（围栏），停下，`stopReason: 'aborted'`，不再写 ended；否则别人只是写了应用事件，采用新的末尾 `seq` 重试。
3. 同一进程内的 per-session 队列保留，它只是少打一次冲突。
4. 进程崩溃留下的未结束运行会让该会话一直 `session_busy`，直到有编排器 `recover` 它（见下）。所以用 `record` 缺省（写日志）的应用，进程启动时要先 `recover` 再接新的 `submit`；这是对应用的新要求，要写进文档。不写日志的运行没有这个要求。

**`recover` 加所有者。** `RunStartedData` 加可选的 `owner`，`createOrchestrator` 加选项 `owner`（部署者给的稳定实例名，例如 `yoyo`）；不配置时行为和今天一样。`recover()` 只处理 `owner` 与自己相同的断掉的运行（都没配置也算相同），所以两个进程共用一个库时各配一个名字，互不收对方的运行。写 `ctx.run.ended` 时带 `expectSeq`：如果读到写入之间会话有新条目，说明那个运行其实在动，跳过它。围栏（上一节第 2 点）兜底：即使判错，活着的运行下一次写入也会发现自己被结束并停下。`recover` 对每个会话只读最后一个生命周期事件（`last: 1`），随之需要决定 5 的 `kinds` 过滤。

### 3. 消息格式：ctx 自己的 JSON 子集，带版本

```ts
type Message =
  | { role: 'system'; content: string; providerOptions?: ProviderOptions }
  | { role: 'user'; content: string | UserPart[]; providerOptions?: ProviderOptions }
  | { role: 'assistant'; content: string | AssistantPart[]; providerOptions?: ProviderOptions }
  | { role: 'tool'; content: ToolPart[]; providerOptions?: ProviderOptions };

type UserPart = TextPart | FilePart;
type AssistantPart =
  | TextPart
  | FilePart
  | ReasoningPart
  | ReasoningFilePart
  | CustomPart
  | ToolCallPart
  | ToolResultPart
  | ToolApprovalRequestPart;
type ToolPart = ToolResultPart | ToolApprovalResponsePart;
```

部件逐项对照了 `ai@7.0.150` 依赖的 `@ai-sdk/provider-utils@5.0.67` 里的 `ModelMessage` 类型定义（`UserContent`、`AssistantContent`、`ToolContent`）：

| AI SDK 部件（出现在）                | ctx 部件                                                                                 | 转换规则                                                                                                                                                                                              |
| ------------------------------------ | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `text`（user、assistant）            | `{ type: 'text', text, providerOptions? }`                                               | 原样                                                                                                                                                                                                  |
| `image`（user）                      | `{ type: 'file', mediaType, data: ToolFileData }`                                        | 并入 `file`；`mediaType` 缺省写 `image`（同 `toolOutputFromAiSdk` 对 `image-url` 的做法）                                                                                                             |
| `file`（user、assistant）            | `{ type: 'file', mediaType, data: ToolFileData, filename?, providerOptions? }`           | `data` 是裸字节/`URL`/`ProviderReference` 时归一成 `ToolFileData` 的 `data`（base64）、`url`、`reference`                                                                                             |
| `reasoning`（assistant）             | `{ type: 'reasoning', text, providerOptions? }`                                          | 原样；`providerOptions` 带推理签名，必须保留                                                                                                                                                          |
| `reasoning-file`（assistant）        | `{ type: 'reasoning-file', mediaType, data: ToolFileData, providerOptions? }`            | 同 `file`                                                                                                                                                                                             |
| `custom`（assistant）                | `{ type: 'custom', kind, providerOptions? }`                                             | 原样                                                                                                                                                                                                  |
| `tool-call`（assistant）             | `{ type: 'tool-call', id, name, input: JsonValue, providerExecuted?, providerOptions? }` | `toolCallId` → `id`，`toolName` → `name`，字段名同 `ToolCall`                                                                                                                                         |
| `tool-result`（assistant、tool）     | `{ type: 'tool-result', id, name, output: ToolOutput, providerOptions? }`                | `output` 走现有的 `toolOutputFromAiSdk` / `toolOutputToAiSdk`；它对 `execution-denied`、`error-json` 的签名字段、`output` 内的 `providerOptions` 和 `custom` 内容分段的丢弃是现有的、有意的行为，沿用 |
| `tool-approval-request`（assistant） | `{ type: 'tool-approval-request', approvalId, callId, reason? }`                         | `toolCallId` → `callId`（它指向某个 `tool-call` 的 `id`）                                                                                                                                             |
| `tool-approval-response`（tool）     | `{ type: 'tool-approval-response', approvalId, approved, reason?, providerExecuted? }`   | 原样                                                                                                                                                                                                  |

按这张表，`ModelMessage` 里现有的部件类型全部有对应；"未知部件"只可能是 AI SDK 以后新加的。实施时要逐项对照类型定义写转换，并加一个测试：遍历 `UserContent`、`AssistantContent`、`ToolContent` 的所有 `type` 取值，断言每个都有转换（类型层面用穷尽检查，AI SDK 升级后加了新部件，编译就会失败）。

- `Message` 全是 JSON：二进制是 base64 字符串（复用 `ToolFileData`），URL 是字符串。`providerOptions` 按服务商名分组、原样保存，用来带推理签名这类必须回传的服务商字段。
- 转换函数 `toModelMessages` / `fromModelMessages` 放在 `@modelctx-ai/ctx`（它依赖 `ai`），和 `ToolOutput` 与 AI SDK 的互转同一个做法。`ctx → AI SDK` 总能转；`AI SDK → ctx` 遇到子集之外的部件（只可能是 AI SDK 之后新加的）抛 `unsupported_part`，harness 把这一轮以 `error` 结束，不静默丢。
- 协议包不再 import `ai` 的消息类型：`ModelMessage`、`UserContent` 换成 `Message`、`MessageContent`（`PreparedCall.messages`、`RunResult.messages`、`RunRequest.input`/`prompt`、`ProjectionOptions` 的回调、`textOf`、`estimateTokens`）。协议包对 `ai` 的 peer 依赖只剩 `ModelRef` 里的 `LanguageModel`，即 ADR 0004 §3 声明的那个进程内例外。
- `@modelctx-ai/ctx` 的 `createContext()` 面向应用，继续收 AI SDK 的 `UserContent` 并在边界转换；不要求应用改调用写法。

**版本。** `EntryBase` 加 `v: number`，当前版本 1；没有 `v` 的行读作 0，即现状（AI SDK 的 `ModelMessage`、`covers` 是 `{ at, seq }`、二进制和 URL 用 `\u0000ctx` 标记）。协议包导出 `ENTRY_VERSION` 和纯函数 `upgradeEntry(raw): Entry`，把低版本一步步升到当前版本；读到比自己认识的更高的 `v` 时抛 `unsupported_version`，不猜。

**旧日志怎么升级。** 读时升级，不改存量行（日志只追加，约束 1）。存储把读出来的原始 JSON 交给 `upgradeEntry`；新写入的行带 `v: 1`。`upgradeEntry` 的 0 → 1 规则：

- 消息：按上表逐项转换：`toolCallId`/`toolName` 改 `id`/`name`；工具结果的 `output` 经现有的 `toolOutputFromAiSdk`；`image` 部件改 `file`；`\u0000ctx` 的 bytes 变 `{ type: 'data', data: <base64> }`，url 变 `{ type: 'url', url }`；
- 摘要：`covers` 取 `covers.seq`（见下面的已知差异）；
- 事件：不变。

0 → 1 有两处不能无损，实施时要写进迁移说明：

- 旧摘要的 `covers` 原来按 `(at, seq)` 比较，现在按 `seq`。差异只出现在"摘要之前就有补写旧记录"的会话：`seq` 小于切点、`at` 大于切点的条目，原来可见，现在被覆盖。迁移提供两个函数（放在 `@modelctx-ai/ctx`）：
  - `findLossySummaries(store, { session? })` 只读，只看 `v` 为 0 的摘要，列出 `{ session, summaryId, hidden: seq[] }`，`hidden` 是被新规则盖住、旧规则下可见的条目；
  - `recompactLossy(builder, finding, options)` 对一条结果追加一条新摘要：`covers` 等于旧摘要的 `covers`，输入是旧摘要文字加上 `hidden` 里的条目，用决定 1 的"`covers` 相同时后写的生效"取代旧摘要。不能直接调普通的 `compact`：被误盖的条目如果还在"最近 N 条"里，普通 `compact` 算出的 `covers` 会比旧摘要小，取代不了它。
    新摘要写的是 `v: 1`，所以 `findLossySummaries` 跑第二次找不到东西，可以放在启动阶段反复跑。
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
- `ctx-sqlite`：结构版本 `meta.schema` 从 2（todo #1，分支 `tds/conv-01a1790d-1daf-72c0-9b01-4ffbec5de89e`，已把 `thread` → `session` 的迁移做进去并升到 2，新版遇到更高的版本拒绝打开）升到 3，在 #1 的迁移阶梯上加一级，同样在写锁里做（复用它的 `withWriteLock`）：`ALTER TABLE ADD COLUMN v INTEGER NOT NULL DEFAULT 0`、生成列 `kind`、删掉 `_order` 索引换成 `(session, seq)`、写入 `schema = 3`。`kind` 用生成列 `kind TEXT GENERATED ALWAYS AS (json_extract(body, '$.kind')) VIRTUAL` 加索引 `(session, kind, seq)`，不需要回填；旧版本写入的行也自动有 `kind`。前缀用范围查询（`session >= ? AND session < ?`），不用 `LIKE`，避免转义。
- 内存存储：`sessions()` 现在是插入顺序，改成名字升序。
- `recover` 用 `sessions({ limit })` 翻页，每个会话一次 `list(kinds: [started, ended], last: 1)`，不再读消息正文。仍然是"每个会话一次查询"，规模到几万个会话以内可以接受；更大的规模要存储自己提供"有未结束运行的会话"的索引，等有需求再加。
- 旧日志里可能有多个未结束的运行（决定 2 的 bug 的产物）。`last: 1` 只看最后一个生命周期事件，漏掉被后续运行盖过的老断点。这些不影响会话继续使用，接受。

## 破坏面

下表按改动列出对各实现的影响。yoyo 一列的依据在表后的「对 yoyo 的核对」。

| 改动                         | 协议包                                                                                                                                           | 内存存储（core）                    | ctx-sqlite                                                                                                                                                                   | ctx-remote                                                  | ctx-gateway                                       | yoyo                                                                                                              |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| 1 `seq` 位置                 | 不兼容：删 `Cursor`/`compareCursor`/`cursorOf`；`covers`、`after`、`upTo`、`CompactedData.covers` 改数字；`latestSummary` 相同 `covers` 取后写的 | 去掉 `insertSorted`，按追加顺序存   | `covers` 存数字；`after` 条件简化；索引见 5                                                                                                                                  | `after.at`/`after.seq` 查询参数改 `after`；`cursorParam` 改 | 无                                                | 非测试代码不用 `Cursor`、`after`；一处测试手写 `covers`；`context tail` 要自己按 `(at, seq)` 排                   |
| 2 `expectSeq`、围栏、`owner` | 加性：`AppendOptions`、`conflict`/`session_busy`；Harness、Orchestrator 契约改                                                                   | 加前提检查                          | 加前提检查；`append` 现在用 SAVEPOINT，要改成先 `withWriteLock`（`BEGIN IMMEDIATE`，库上已有应用事务时退回 SAVEPOINT），否则两进程读后写拿到 `SQLITE_BUSY` 而不是 `conflict` | `POST …/entries` 带 `expectSeq`；409 映射为 `conflict`      | 无                                                | 无冲突：yoyo 的运行全是 `record: false`，自己的写入不带前提                                                       |
| 3 `Message` 与 `v`           | 不兼容：`ModelMessage`/`UserContent` 换成 `Message`；加 `upgradeEntry`、`ENTRY_VERSION`                                                          | 类型跟着换                          | 加 `v` 列；读时 `upgradeEntry`；删编码（见 5 的结构版本）                                                                                                                    | 删 `wire.ts` 的二进制标记；条目带 `v`；新旧版本不能混用     | `messages.ts`、`rewrite.ts` 改成与 `Message` 互转 | 源码只用 `textOf`（两处），不传图片和字节；`context.test.ts` 里有 `ModelMessage` 类型要换                         |
| 4 `AgentSpec.context`        | 加性：`ContextSpec`、`FactsSpec`，`BuildRequest` 放宽；第三方 builder 忽略 `context` 会静默回到缺省，靠契约测试暴露                              | 无                                  | 无                                                                                                                                                                           | 无（`context` 是 `AgentSpec` 里的 JSON）                    | 无                                                | 可以删掉 `createYoyoHarness` 里 `facts: false` 的包装；不删也能跑                                                 |
| 5 分页、`kinds`              | 加性：`sessions(options?)`、`ListOptions.kinds`；`sessions()` 缺省顺序写成"名字升序"                                                             | `sessions()` 从插入顺序变成名字升序 | 结构版本 2 → 3（见决定 5）                                                                                                                                                   | 加两个查询参数                                              | 无                                                | 无新选项可用；测试里的 `store.sessions()` 自己排序，不受名字升序影响；`context.test.ts` 断言了旧索引和 `schema=1` |

版本：按 [ADR 0002](0002-packages.md)，不兼容改动升 minor，所有包 0.2 → 0.3，一起发。不留 `Cursor` 的弃用别名：它的类型从对象变成数字，别名只会让旧代码编译通过、运行出错。

**结构版本和升级顺序。** `ctx-sqlite` 的 `meta.schema` 在 #1 之后是 2（`thread` → `session`），本 ADR 的结构改动（`v` 列、生成列 `kind`、索引换成 `(session, seq)`）升到 3，不重复占用 2。#1 之后的 0.2.x 在打开 schema 3 的库时会拒绝（它的 `migrate()` 对更高的版本抛错）；更早的 0.2.0 不检查版本，会照常打开并读错新行。所以不支持滚动升级：同一个库的所有进程要先全部停下，再一起升到 0.3。旧版写入的行没有 `v`，默认 0，仍是合法的旧行；但新版写的行旧版读不了。

**对旧 ADR 的影响（实施任务完成时再改旧文）：**

- [ADR 0003](0003-context-model.md) 决定 1「`ModelMessage` 原样保存」改成 `Message`；决定 3「`covers` 指向位置」改成 `seq`；"多处同时写"一行里"顺序由 `(at, seq)` 决定"改成"日志顺序由 `seq` 决定，投影顺序由 `(at, seq)` 决定"。
- [ADR 0004](0004-protocol-and-implementation.md)「没有采用：自定义消息格式代替 `ModelMessage`」的前提是 `ModelMessage` 已经是 JSON，实际不是（二进制和 URL）。该条改成指向本 ADR。
- [协议层](../protocol.md)、[架构](../architecture.md)、[概念](../concepts.md)的术语表（`Cursor` 条）随实施一起改。

### 对 yoyo 的核对

读的是 yoyo `main`（5df53c9）的非测试代码，加上与本 ADR 有关的测试。结论：决定 2 与 yoyo 的用法不冲突，不需要改决定；改动落在下面几处。

1. **`Cursor`、`after`、`covers`。** 非测试代码里没有用 `Cursor`、`cursorOf`、`after`，也没有手写 `covers`。受影响的是：`src/brain/context.test.ts:351` 手写 `covers: { at: 1, seq: 1 }`，改成 `covers: 1`；`yoyo context tail`（`src/cli/commands.ts`）调 `context.entries({ last: 500 })`，现在按日志顺序返回，每拍导入的桌宠对话（`at` 是过去）会排在写入的位置，展示前要用协议包导出的 `compareEntries` 排序；`compactContext`（`src/runtime/compact.ts`）调 `context.compact({ keep, … })`，签名不变。
2. **`expectSeq` 会不会频繁冲突。** 不会，因为 yoyo 没有用到它。碎碎念（`whisperRequest`）和回复（`replyRequest`）都是 `record: false`（`src/brain/compose.ts`），harness 不写输入、产出和 `ctx.run.*`。yoyo 写日志的路径只有三条，都是不带前提的 `context.append`：`recordLine`（说出口以后记一句）、`recordUser`、`storePetChat`（`syncPetChat` 每拍导入最多 200 条，几乎全部按键跳过）。因此没有冲突，也没有重试成本。写同一个库的进程只有常驻进程和短命的命令行（`yoyo context compact` 追加摘要）；两个压缩同时发生时按决定 1 的规则取 `covers` 大的、相同取后写的，不丢条目。
3. **碎碎念和回复是不是同一个会话。** 是，都在 `pet:<id>`（`sessionFor`），提醒、天气、桌宠对话导入也写这个会话。但这不会触发 `session_busy`：一是 `record: false` 的运行不写 `ctx.run.started`，不占会话；二是即使以后改成写日志，一拍之内也是串行的——`tick` 有 `busy` 标志，`whisper()` 里先 `await` 碎碎念再 `await` 回复，ctx 的队列对同一会话串行。"30 秒让路"（`whisperStep`）是内存里 `lastTalk`、`nextWhisper` 的时间计算，只决定什么时候提交，不看会话；到点提醒走 `director.remind` → `speak`，不提交运行。所以它们和围栏、`session_busy` 不会打架。
4. **崩溃后的启动顺序。** yoyo 现在不需要改：`createYoyoOrchestrator` 只把 `recover` 透传（`src/runtime/orchestrator.ts`），非测试代码里没有调用方；而且 `record: false` 的运行不留下未结束的记录，没有东西可恢复。如果以后把 `record` 打开，要在 `src/app/container.ts` 里给编排器配 `owner: 'yoyo'`，并在 `start()` 和第一次 `submit` 之前 `await orchestrator.recover()`。
5. **有没有直接读 `ctx_entries`。** 没有读 `body`。直接碰表的只有两处：`src/brain/context.ts` 的 `migrateSessionColumn` 直接 `ALTER TABLE ctx_entries RENAME COLUMN`，#1 之后 `ctx-sqlite` 自己做，这段可以删；`src/brain/context.test.ts` 用 0.1 的建表语句造旧库，并断言 `ctx_entries_order (session, at, seq)` 索引和 `ctx_meta` 的 `schema=1`，升到结构版本 3 以后这几处断言要改（索引 `(session, seq)`、`schema=3`、多了 `v` 和 `kind` 两列）。yoyo 的 `db.ts` 自己设了 `busy_timeout = 5000`，传 `database` 给 `createSqliteStore` 时 #1 不会改它，所以 `append` 加写锁后，等锁的时间仍由 yoyo 决定。
6. **决定 4 的收益。** `createYoyoHarness` 里 `context.builder.build({ ...request, facts: false })` 和 `compose.ts` 手工收事实，是对 `AgentSpec` 不能选事实的绕法。有了 `AgentSpec.context.facts` 和 `placement`，可以改回让 builder 收，不改也能跑。
7. **升级时 yoyo 要做的事。** 常驻进程和命令行共用 `~/.yoyo/yoyo.db`，两者要同时升到 0.3（见上面的升级顺序）。启动阶段（`container.ts` 里创建上下文之后、`start()` 之前，只在常驻进程里）跑一次 `findLossySummaries(store, { session })`，有结果且有模型时用 yoyo 自己的 `COMPACT_INSTRUCTIONS` 调 `recompactLossy`；没有模型就记一条警告，等下次有模型的启动再做。命令行不跑这一步。

## 实施与验证

由后续任务"按 ADR 0005 改协议和实现"做，建议顺序：1（位置）→ 5（分页、`kinds`，和 1 一起动 sqlite 的索引）→ 3（消息与版本）→ 2（`expectSeq`、围栏、`owner`）→ 4（`context`）。每一步先写契约测试，再改实现：

- 位置：补写旧记录后 `watch`、`list(after)`、`project()` 的结果与"决定 1"一节的场景一致；`clear` 后 `seq` 不回退；`compact` 切点满足"seq ≤ covers 的都进了摘要"。
- 前提条件：`expectSeq` 不满足时整批不写；两个 `createSqliteStore` 句柄指向同一个文件，并发 `append` 带同一个 `expectSeq`，恰好一个成功；两个编排器配不同 `owner` 共用一个库，一个 `recover` 不动另一个的运行；被 `recover` 结束的运行在下一次写入时停下，且不重复写 ended。
- 版本：v0 的黄金样例（含 `Uint8Array`、`URL`、工具调用和结果）经 `upgradeEntry` 后与手写的 v1 期望相等；未知 `v` 抛 `unsupported_version`；`findLossySummaries` 在构造的数据上能找出受影响的会话和被盖住的条目，`recompactLossy` 之后这些条目重新可见（包括它们仍在「最近 N 条」里的情形），再跑一次 `findLossySummaries` 为空；`Message` 转换对 `UserContent`、`AssistantContent`、`ToolContent` 的所有部件类型穷尽。
- `context`：同一个 builder 上两个不同的 `AgentSpec.context` 得到不同的事实和位置；未知投影名得到 `not_found`。
- 升级：用 #1 之后的 schema 2 的库（含 yoyo 风格的 `thread` 旧库）升到 3，数据不丢；#1 之后的 0.2.x 打开 schema 3 的库被拒绝。
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

## 决定记录

用户审阅（2026-10-26）后的结论，已并入上文：

1. **消息格式取子集，遇到未知部件让这一轮出错：同意。** 附加条件：子集必须覆盖 `ai@7.0.150` 的 `ModelMessage` 里现有的全部部件类型，"未知"只可能是 AI SDK 以后新加的。决定 3 的对照表和穷尽测试落实这一条；对照时发现 `reasoning-file`、`custom`、`tool-approval-request`、`tool-approval-response` 在原稿里漏了，已补上。
2. **旧摘要的 `covers` 按 `covers.seq` 解释：同意。** 本机找不到 `yoyo.db`，没法事先量受影响的会话数，所以定为：yoyo 升级时在启动阶段跑一次 `findLossySummaries`，受影响的会话自动用 `recompactLossy` 重新压缩一次。核对 yoyo 代码时发现普通的 `compact` 做不到这一点（被误盖的条目若还在最近 N 条里，算出的 `covers` 比旧摘要小），所以加了 `recompactLossy` 和"`covers` 相同时后写的生效"。
3. **`recover` 靠 `owner` 约定区分进程，不做心跳：同意。** `owner` 缺省不设，行为和今天一样。
4. **所有包一起升 0.3，不留 `Cursor` 别名：同意。**
5. **结构版本。** `ctx-sqlite` 的 `meta.schema` 已被 #1 升到 2，本 ADR 的改动升到 3；#1 之后的 0.2.x 拒绝打开 schema 3 的库，更早的版本不检查，要停机后一起升级。
6. **yoyo 的破坏面按真实代码重写。** 结论是决定 2 与 yoyo 不冲突，因此没有改决定本身，只在决定 2 加了"只约束 `record` 不为 `false` 的运行"的范围说明。
