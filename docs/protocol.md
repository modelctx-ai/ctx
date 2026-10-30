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

| 规则         | 说明                                                                                                                                 |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| 接口加工厂   | 协议是 `interface`，实现是 `createX(options): X`。不用类继承                                                                         |
| 只收发 JSON  | 方法参数和返回值都能 `JSON.stringify`。例外：`AbortSignal`、进程内的 `LanguageModel`。跨边界时模型用名字字符串                       |
| 消息         | ctx 自己的 `Message`，全是 JSON（二进制是 base64 字符串，URL 是字符串），存储和线上都不需要编码；和 AI SDK 互转在 `@modelctx-ai/ctx` |
| 字符串身份   | `session`、工具名、执行环境名、`runId` 都是字符串                                                                                    |
| 流是事件序列 | 流式结果用 `AsyncIterable<Event>` 表达，跨边界是 NDJSON 或 SSE                                                                       |
| 可选方法     | 协议里标 `?` 的方法实现可以不提供，调用方要检查                                                                                      |
| 取消         | 需要取消的方法收 `signal?: AbortSignal`                                                                                              |
| 错误         | 抛 `Error`；跨边界时是 `{ error: ErrorInfo }`，`ErrorInfo` 是 `{ message, type?, retryable?, statusCode?, responseBody? }`           |
| 契约测试     | `@modelctx-ai/ctx-protocol/testing` 的 `describeXContract(name, factory, { describe, test })`，实现跑它（见[契约测试](#契约测试)）   |

## 会话 `SessionStore`

只追加的事件日志。详细语义见 [ADR 0003](adr/0003-context-model.md)。

```ts
interface EntryBase {
  id: string; // 全局唯一；不给就由存储生成
  session: string; // 由存储填
  v: number; // 写入这一行时的格式版本，读出来的形状永远是当前版本；新条目是 `ENTRY_VERSION`（1），由存储填
  seq: number; // 会话内位置，由存储按写入顺序填：会话内严格递增、从 1 起，`clear` 后不回退；0 是会话开头
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
  types?: readonly EntryType[];
  kinds?: readonly string[]; // 只要事件，且 kind 在其中；与 types 取交集；空列表什么都不匹配
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
  clear(session: string): Promise<number>;
  sessions(options?: SessionsOptions): Promise<string[]>; // 名字升序
  /** 先给出 after 之后已有的条目，再持续给出新写入的；远端流式读用。 */
  watch?(session: string, options?: WatchOptions): AsyncIterable<Entry>;
}
```

- `append` 对一批条目是原子的：不会只写一半，也不会和并发的另一批交错。崩溃后续跑依赖这一点。
- `expectSeq` 是写入的前提条件，不是租约：不满足时整批不写，抛 `CtxError('conflict')`（`retryable: true`；HTTP 是 409）。前提的检查先于去重，所以重试一批已经成功的写入，如果其间别人又写了，仍然是 `conflict`，调用方重读就能看到自己的条目已在。不给就不检查。它无状态，崩溃的 harness 什么都不用释放；`seq` 本身就是围栏令牌。纯函数 `headSeq(store, session)`（`list({ last: 1 })`，空会话 0）读当前末尾，`isConflict(error)` 认 `conflict`（本地和远端客户端转出来的都认）。内存存储在同一个同步段里检查和写，`ctx-sqlite` 在 `BEGIN IMMEDIATE` 里（应用已有事务时用 SAVEPOINT）。
- 去重不算失败：`id` 重复（全局）或 `key` 重复（同一会话，含同一批里的）的那一条静默跳过，同批其余照写；返回值就是真正写入的条目。重试一批时靠它不重复记。
- `list` 和 `watch` 都按 `seq` 升序返回，也就是写入顺序。带旧 `at` 导入的条目排在写入的位置（所以 `after` 之后一定看得到新写入的），模型看到的逻辑顺序由投影按 `(at, seq)` 重排（`compareEntries`）。`seq` 只要求会话内单调，消费者不能跨会话比较。
- `sessions` 只列有内容的会话，按名字升序（码点序，也就是 UTF-8 字节序）。翻页：`after` 给上一页最后一个名字，`prefix` 按字面匹配，`limit` 限条数。
- `kinds` 只返回事件，消息和摘要没有 `kind`；和 `types` 取交集，`types` 里没有 `event` 就什么都不返回；`last` 在过滤之后取，所以 `{ kinds: [a, b], last: 1 }` 是这些事件里最后写的一条。
- 生效的摘要是 `covers` 最大的那条；`covers` 相同时 `seq` 大的（后写的）生效。
- 事件 `kind` 用 `{domain}.{action}`。框架保留 `ctx.` 前缀，常量是 `CTX_EVENTS`：

| `kind`            | 谁写          | `data`                                                                   |
| ----------------- | ------------- | ------------------------------------------------------------------------ |
| `ctx.run.started` | harness       | `RunStartedData`：`{ runId, agent }`，`agent` 是 `agentSpecToJson(spec)` |
| `ctx.run.ended`   | harness       | `RunEndedData`：`{ runId, stopReason, usage? }`                          |
| `ctx.compacted`   | 上下文        | `CompactedData`：`{ covers, summaryId }`                                 |
| `ctx.error`       | harness、编排 | `CtxErrorData`：`{ runId?, message, type? }`                             |

这些事件缺省对模型不可见，和应用事件一样由投影规则决定要不要渲染。

纯函数：`upgradeEntry`（见下）；`userEntry`、`assistantEntry`、`messageEntry`、`eventEntry`、`summaryEntry` 构造条目；`runStartedEntry`、`runEndedEntry`、`compactedEntry`、`ctxErrorEntry` 构造框架事件（可选字段不给时不出现在 `data` 里）；`isFrameworkKind`；`compareEntries`、`textOf`；`filterEntries(entries, options)` 是 `ListOptions` 的语义，`filterSessions(names, options)` 是 `SessionsOptions` 的语义，内存里的存储可以直接用。

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
- `ENTRY_VERSION = 1`，每个条目带 `v`。存储写新行时写 `v: 1`，读时对每一行调 `upgradeEntry(raw)` 升到当前形状，**不回写**旧行。没有 `v` 读作 0（0.2 及以前的写法：AI SDK 消息原样，二进制和 URL 用 `\u0000ctx` 标记，摘要的 `covers` 是 `{ at, seq }`）；0 → 1 把消息转成 `Message`，`covers` 取 `covers.seq`。读出来的 `Entry.v` 是这一行写入时的版本（旧行是 0），形状已是当前的；比自己认识的更高的 `v` 抛 `unsupported_version`，升级 ctx 再读。
- 0 版的摘要按 `at` 盖住旧条目，1 版按 `seq`，所以补写的旧记录可能被旧摘要盖住。`@modelctx-ai/ctx` 的 `findLossySummaries(store, { session? })` 只读，列出 `v` 为 0 且有条目被盖住的摘要 `{ session, summaryId, covers, hidden: seq[] }`；`recompactLossy(builder, finding, options)` 追加一条 `covers` 相同的新摘要（输入是旧摘要的文字加上被盖住的条目），靠「`covers` 相同时后写的生效」取代旧摘要。新摘要是 `v: 1`，所以 `findLossySummaries` 跑第二次找不到东西，可以放在启动阶段反复跑。

## 上下文 `ContextBuilder`

把会话日志、来源取到的事实、这一轮的输入组装成一次调用。它持有一个 `SessionStore`，harness 只给它会话名。

```ts
interface WindowOptions {
  maxMessages?: number; // 摘要不算
  maxTokens?: number; // 估算，摘要计入
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
}
interface CompactOptions {
  model?: ModelRef;
  keep?: number; // 最近多少条原样保留
  minimum?: number; // 更早的少于这么多条就不压缩
  instructions?: string;
  maxOutputTokens?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}
interface ContextBuilder {
  build(request: BuildRequest): Promise<PreparedCall>;
  /** 当前视图：摘要 + 之后的条目，按规则渲染。网关用它。 */
  view(session: string, options?: { window?: WindowOptions; projection?: string }): Promise<Projection>;
  /** 把较早的历史压成一条摘要并追加，同时记 ctx.compacted。历史不够长时返回 null。 */
  compact?(session: string, options?: CompactOptions): Promise<SummaryEntry | null>;
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
  items: readonly ProjectedMessage[]; // 每条带 upTo、pinned、tokens
  tokens: number;
  dropped: number;
  summary?: SummaryEntry;
}
```

- 参考实现 = 投影规则（事件渲染、摘要渲染、消息改写、窗口）+ 来源 + 压缩，就是今天 `createContext` 里的 `prepare`、`view`、`compact`。
- 投影、来源收集和 token 估算是纯函数，放在协议包：`project(entries, options)`、`latestSummary`、`defaultSummaryMessage`、`collectFacts(sources, { session, timeoutMs?, onError? })`、`renderFacts`、`defineSource`、`estimateTokens`、`estimateTextTokens`。语义见[架构](architecture.md#投影)。
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
}
```

- 执行出错返回 `{ type: 'error' }` 而不是抛：模型要看到错误才能接着做。抛出表示执行环境本身坏了。错误信息要能照着做（「文件不存在：/a/b，当前目录有 …」），不是错误码。
- 大输出由执行环境截断或分页，再交给模型。
- 和 AI SDK 互转：`toolOutputToAiSdk(output)` 得到工具结果的 `output`（`text`、`json`、`error-text`、`error-json`、`content`），`toolOutputFromAiSdk` 转回来。协议 → AI SDK → 协议不丢信息：只有文字的错误是 `error-text`，带 `retryable` 或 `data` 的是 `error-json` 的 `{ message, retryable?, data? }`；`URL` 规范化会改写法时原串放进 `originalUrl`。反方向：二进制变 base64，已弃用的 `image-data`、`file-url` 等换成 `file`，`execution-denied` 变成错误，任意形状的 `error-json` 整个放进 `data`，`providerOptions` 和 `custom` 分段丢掉。
- `errorOutput(message, { retryable?, data? })` 构造错误结果。
- 实现：进程内函数（核心包）、MCP 服务器（`ctx-mcp`）、本机子进程（`ctx-exec`）、HTTP 远端（`ctx-remote`）。
- 远端执行环境有两种接法：harness 调它（它是服务），或它从 harness 领工作（它是只需出站连接的 worker，像 Managed Agents 的自托管沙箱）。协议相同，`ctx-remote` 先做前者。

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
}
interface ContextSpec {
  facts?: boolean | FactsSpec; // false 不收事实；缺省收
  projection?: string; // builder 里注册的投影配置名；缺省 default
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
  signal?: AbortSignal;
}
type StopReason = 'end_turn' | 'max_steps' | 'max_tokens' | 'aborted' | 'error';
interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}
interface RunResult {
  runId: string;
  text: string;
  messages: Message[]; // 这一轮模型产出的消息
  recorded: readonly Entry[];
  stopReason: StopReason;
  usage?: Usage;
  error?: ErrorInfo; // stopReason 是 error 时；上游 HTTP 接口出错时带 statusCode 和 responseBody
}
type RunEvent =
  | { type: 'run.started'; runId: string; session: string }
  | { type: 'model.started'; runId: string; step: number }
  | { type: 'text.delta'; runId: string; text: string }
  | { type: 'tool.called'; runId: string; call: ToolCall }
  | { type: 'tool.returned'; runId: string; callId: string; output: ToolOutput }
  | { type: 'model.ended'; runId: string; step: number; usage?: Usage }
  | { type: 'run.ended'; runId: string; result: Omit<RunResult, 'messages' | 'recorded'> }
  | { type: 'error'; runId: string; message: string };

type ToolDecision = { allow: true; input?: JsonValue } | { allow: false; reason: string };
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
- 一轮里 harness 做的事：`ctx.run.started` → 记输入 → `ContextBuilder.build` → 调模型 → 对每个工具调用：`beforeTool` → 找到绑定的执行环境 → `execute` → `afterTool` → 工具结果回到模型，直到停下 → 记产出 → `ctx.run.ended`。
- 模型出错、被取消也写 `ctx.run.ended`，`run` 照常返回，`stopReason` 和 `error` 说明原因；只有写日志本身失败才 reject。远端调用方因此总拿到同一种形状。
- **一个会话最多一个未结束的运行，跨进程也成立**（只对 `record` 不为 `false` 的运行；`record: false` 的运行不碰日志，不占会话，不会遇到 `session_busy`，也不会被 `recover` 看到）：
  1. 开始：读最后一个生命周期事件（`list({ kinds: [ctx.run.started, ctx.run.ended], last: 1 })`）。是 `started` 就说明有未结束的运行，`run` 以 `ErrorInfo.type: 'session_busy'`（`retryable: true`）结束，不写任何东西；否则带 `expectSeq` 追加 `ctx.run.started`，冲突就重读重判。
  2. 运行中：每次写入带 `expectSeq`（本轮上一次写入之后的末尾）。冲突时读 `after` 之后的 `ctx.run.ended`：自己的 `runId` 已经有了，说明被别人当作断掉的运行收走了（围栏），停下，`stopReason: 'aborted'`，不再写 `ctx.run.ended`、`ctx.error` 和产出；没有就只是别人写了应用事件，用新的末尾重试。
  3. 同一个 harness 实例自己维护一条进程内的每会话串行队列（只排 `record` 不为 `false` 的运行）：同一进程里的第二个运行等前一个结束再开始，所以 `session_busy` 只会在跨进程或别的 harness 实例上出现。排队时 `signal` 中止，这一轮直接以 `aborted` 结束，什么都不写。队列只是少打一次冲突；编排器自己的队列保留，两层串行不冲突。
  4. 进程崩溃留下的未结束运行会让该会话一直 `session_busy`，直到有编排器 `recover` 它。**所以用 `record` 缺省（写日志）的应用，进程启动时要先 `recover()` 再接新的 `submit`。** 不写日志的运行没有这个要求。
  5. `RunRequest.owner` 写进 `ctx.run.started` 的 `owner`（编排器按自己的 `owner` 填）。
- `text.delta` 不落日志，像 Managed Agents 的 event delta；其余事件各有对应的日志条目。
- 纯函数：`modelName(model)` 把进程内模型记成 `<provider>/<modelId>`；`agentSpecToJson(spec)` 是写进 `ctx.run.started` 的可序列化部分。
- `Hooks` 是 harness 实现的构造参数，不在 `RunRequest` 里：它们是函数，不能跨边界。
- 权限确认是 `beforeTool` 的一种实现：返回 `{ allow: false }` 时工具结果是一条错误，模型会看到原因，这一轮继续。
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
  /** 崩溃后：找到日志里有 ctx.run.started 没有 ctx.run.ended 的运行，补一条 ctx.run.ended（stopReason error）或续跑。 */
  recover?(): Promise<{ session: string; runId: string }[]>; // 只处理 owner 与自己相同的运行
  events?(options?: { signal?: AbortSignal }): AsyncIterable<OrchestratorEvent>;
  close(): Promise<void>;
}
```

- `completed` 是跑完了；`failed` 是 `stopReason: error` 或 harness 抛错；`cancelled` 是被 `cancel` 或 `signal` 取消（被围栏停下的运行也是 `aborted`，算 `cancelled`）。
- `owner`：`createOrchestrator({ owner })` 是部署者给的稳定实例名（例如 `yoyo`），写进每个运行的 `ctx.run.started`。`recover()` 只处理 `owner` 与自己相同的断掉的运行（都没配置也算相同），所以两个进程共用一个库时各配一个名字，互不收对方的运行。写 `ctx.run.ended` 时带 `expectSeq`（读到断点之后再读的末尾）：读和写之间会话有了新条目，说明那个运行其实在动，跳过它；就算判错，活着的运行下一次写入会发现自己被结束并停下（围栏）。`recover` 对每个会话只读最后一个生命周期事件（`kinds`、`last: 1`），找到断点的才多读一次末尾。`owner` 配错（两个进程同名，或都不配）就退回只靠围栏兜底。
- 参考实现是进程内队列：每个会话一条队列，一个 harness。
- yoyo 的 `createYoyoOrchestrator` 是一个应用级的编排器，实现这个协议：定时、让路、收件箱。碎碎念和回复是同一个 harness 跑的两份 `AgentSpec`，导演只剩舞台动作，常驻循环只管进程。
- 远端编排器（`ctx-remote`）：路径放在 `/orchestrator` 下，和 harness 的 `/runs` 分开：`POST /orchestrator/runs`、`GET /orchestrator/runs/:id`（`?wait=` 长轮询，结束后带 `result`，客户端的 `done` 靠它）、`DELETE /orchestrator/runs/:id`、`POST /orchestrator/recover`、`GET /orchestrator/events`（NDJSON）。

## 记忆 `MemoryStore`、`DecisionModel`、`ExtractionModel`、`Memory`

第八个组件。记忆只读会话日志、从不改它；存储、两个 System One 模型和门面各一个协议，全部只收发 JSON。为什么这样分见[记忆](memory.md)和 [ADR 0006](adr/0006-memory.md)，参考实现见[架构](architecture.md#记忆)。下面的签名省略了 `readonly` 和部分注释，以 `ctx-protocol` 的 `.d.ts` 为准。

### 存储 `MemoryStore`

记忆的存储。四个集合，每个集合几个方法；全部只收发 JSON，可以放到进程边界另一侧。身份是字符串。

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
  settledAt?: number; // 夜里处理过的时刻；没有就是待处理
}
/** 门控没过的那段也写一条，settledAt 等于 at：head 照样前进，打过的分留作阈值的分布。 */
type NewNote = Omit<Note, 'id'>;
interface NoteQuery {
  session?: string;
  pending?: boolean; // true 只要待处理的，false 只要处理过的；缺省不限
  limit?: number; // 最早写入的 N 条
}

interface MemoryFact {
  id: string;
  subject: string; // "user"、"project:agent"…应用定义
  predicate?: string;
  text: string; // 一句能独立成立的话
  topic?: string;
  validFrom: number;
  validTo?: number; // 没有就是仍然成立
  supersededBy?: string; // 被哪条事实取代
  confidence: number; // 0..1
  salience: number; // 0..1，激活度公式里的 s
  sources: readonly SourceRef[]; // 必填，不允许没有证据的事实
  recalls: readonly number[]; // 每次被召回的时刻，激活度公式里的 t_i
  archivedAt?: number; // 归档的时刻；没有就是没归档
}
type NewMemoryFact = Omit<MemoryFact, 'id' | 'validTo' | 'supersededBy' | 'recalls' | 'archivedAt'>;
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
  text: string; // 实现决定用全文、向量还是两者；至少子串（3 个字符以上）命中
  topic?: string;
  k?: number; // 缺省 10
  open?: boolean; // 缺省 true；false 连同关闭、归档的一起搜
}

interface CoreVersion {
  text: string;
  at: number;
}

interface MemoryStore {
  notes: {
    add(notes: readonly NewNote[]): Promise<Note[]>;
    list(query?: NoteQuery): Promise<Note[]>; // 按写入顺序
    /** 返回这次真正标上的条数；处理过的不改。 */
    settle(ids: readonly string[], at: number): Promise<number>;
    /** 这个会话的笔记（含处理过的）覆盖到的最大 seq；没有就是 0。gate 从它之后读。 */
    head(session: string): Promise<number>;
  };
  facts: {
    add(fact: NewMemoryFact): Promise<MemoryFact>;
    /** 关闭有效期。事实的文字永不改写：变了就 add 新的、close 旧的。已关闭的不改。 */
    close(id: string, at: number, options?: { supersededBy?: string }): Promise<void>;
    /** 追加证据（并入时用），文字不变；相同的区间跳过。 */
    cite(id: string, sources: readonly SourceRef[]): Promise<MemoryFact>;
    /** 记一次召回。 */
    touch(ids: readonly string[], at: number): Promise<void>;
    archive(ids: readonly string[], at: number): Promise<number>;
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
    list(query?: ProcedureQuery): Promise<Procedure[]>; // 按写入顺序
  };
  core: {
    get(): Promise<CoreVersion | null>;
    /** 追加一个版本，旧版本保留；回滚就是把旧文字再 set 一次。 */
    set(text: string, at: number): Promise<void>;
    /** 按写入顺序；last 和 ListOptions.last 一样。 */
    history(options?: { last?: number }): Promise<CoreVersion[]>;
  };
}
```

- **事实不 UPDATE。** 变了就 `close` 旧的、`add` 新的，`supersededBy` 连起来。「上个月用的是哪个数据库」永远能查。
- **证据必填。** `MemoryFact.sources`、`Procedure.evidence` 指向会话日志的 `seq` 区间。没有证据的事实不进存储，这是防编造的第一道闸。
- **归档不删除。** `archive` 只是让它退出 `open` 的查询，`forget` 才删。
- **错误。** 参数不合法（没有证据、`from > upTo`）是 `CtxError` 的 `invalid_request`，认不得的 `id` 是 `not_found`；批量方法（`settle`、`touch`、`archive`、`forget`）跳过认不得的 `id`。存储不看钟，时刻都由调用方给。
- **记忆不写会话日志。** 记忆是日志的读者。应用要在日志里留痕（例如「今晚整理了 12 条」）自己追加事件，这是明确的选择。
- `search` 的实现自定：全文、向量、两者混合。协议只约定输入是文字。
- 记忆里的事实叫 `MemoryFact`，和来源取到的事实 `Fact`（`{ source, text }`，只用于一次调用）是两回事：前者持久、有有效期，后者是「现在」。
- 纯函数：`activation(fact, now, options?)`（见[激活度](#激活度-activation)，缺省参数是 `ACTIVATION_DEFAULTS`）、`rankFacts(facts, scores, options?)`（`scores` 是事实 `id` → 相似度，一般取 `FactHit.score`）、`renderCore(facts, budget, { now })` 的缺省写法（按激活度排，`estimateTextTokens` 超过 `budget` 前停下）、`sourceRef(session, entries)`；另有存储实现用的 `checkSourceRef`、`checkEvidence`、`sameSourceRef`、`inSourceRef`、`isOpenFact`、`filterFacts`。
- 远端记忆存储（`ctx-remote`）：服务端挂 `memory`，路径在 `/memory/notes`、`/memory/facts`、`/memory/procedures`、`/memory/core` 下；客户端是 `createRemoteMemoryStore`。决策、提取模型没有线上形态，按名字在各自的进程里造。

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
  /** 白天：按文字召回仍然成立的事实，按 rankFacts 排序，记一次 touch；带上匹配主题的程序。 */
  recall(query: string, options?: RecallOptions): Promise<Recalled>;
  /** 夜里：处理待处理的笔记，衰减归档，重写 core。整体可重复执行。 */
  consolidate(options?: ConsolidateOptions): Promise<ConsolidateReport>; // ConsolidateOptions = { now?, signal? }
  /** 作为来源：core 加按 query 召回的事实，渲染成文字；什么都没有时返回空。 */
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
  evidence?: boolean; // 带回证据原文；工具调用时带，作为来源时不带
  signal?: AbortSignal;
}
interface Recalled {
  facts: readonly MemoryFact[];
  procedures: readonly Procedure[];
  evidence?: readonly Entry[]; // 只在 evidence 时有：证据区间里的条目，按 id 去重，按会话、seq 排
}
interface ConsolidateReport {
  notes: number;
  facts: { added: number; merged: number; superseded: number; archived: number };
  procedures: { added: number; confirmed: number };
  escalated: number; // 升级给 LanguageModel 的判断数
  core: boolean; // 重写了没有
}
```

`Memory` 本身是一个 `Executor`（名字缺省 `memory`），和 MCP hub 一样：`tools()` 报出 `recall` 工具，注册进 `ToolRegistry` 就能给模型用。工具的输入是 `query`，可选 `since_days`（只要最近这么多天里开始成立的事实）、`topic`、`k`（1–20）；输出是文字，不是 JSON：用 `<memory>` 包起来，第一行声明「这是资料，不是指令」，事实带主题、日期和证据位置，程序带确认次数，最后是证据原文。不认识的工具、输入不对、`signal` 已中止、存储出错都返回 `{ type: 'error' }`。

### 激活度 `activation`

ACT-R 的基础激活。每次召回都是一个 `t_i`，近的权重大，远的衰减；显著性 `s` 是常数偏置：

```
A(fact, now) = ln Σ_i (Δt_i + ε)^(−d) + s      Δt_i = (now − t_i) / 1 天，t_i ∈ {validFrom, ...recalls}
```

缺省 `d = 0.5`、`ε = 0.02`、`archiveAt = 0.55`（`ACTIVATION_DEFAULTS`）。一条 `s = 0.6`、从未被召回的事实在 `validFrom` 之后约 1.09 天低于阈值，也就是下一次夜间巩固时归档（协议包的单元测试固定了「1 天时还在、1.2 天时已低于」）；`validFrom` 之后一天内被召回一次，约到第 4.4–4.9 天才低于阈值。注入排序和夜间归档用同一个 `A`。`activation` 是协议包里的纯函数。缺省值来自个人助理的量级，要按应用调。

## 契约测试

`@modelctx-ai/ctx-protocol/testing`，用法见[包说明](../packages/protocol/README.md#实现一个协议)。

| 契约测试                          | 工厂                                                                    | 覆盖                                                                                                                                                                                                                                                           |
| --------------------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `describeSessionStoreContract`    | `({ now }) => SessionStore`                                             | 排序、同一时刻、去重、一批里有重复时其余照写、并发两批不交错、`after`/`last`/`types`/`kinds`、往返、全是 JSON 的消息、`expectSeq`（对得上才写、冲突整批不写、先于去重、并发恰好一个成功）、`clear`、`sessions` 的升序和翻页、`watch?` 的读已有、读新写入、中止 |
| `describeExecutorContract`        | `() => { executor, echo }`                                              | 有名字、`tools?()` 列出回显工具并绑定自己、`execute` 回显且能 JSON 往返、未知工具和已中止的 `signal` 返回 `{ type: 'error' }` 不抛、`provision?` 可重复                                                                                                        |
| `describeToolRegistryContract`    | `() => ToolRegistry`                                                    | 增查和顺序、名字校验、同名和 `replace`、`remove`/`removeSource`、`select` 与 `selectTools` 一致                                                                                                                                                                |
| `describeHarnessContract`         | `({ script }) => { harness, store, agent }`                             | 一轮的日志顺序和 `recorded`、`runId`、工具调用经执行环境、模型出错照常返回 `error` 并写 `ctx.run.ended`、`inputKey` 重试、`record: false`、已中止的 `signal`、`stream?` 的事件顺序和出错、`session_busy`、`owner`、`record: false` 不受影响                    |
| `describeOrchestratorContract`    | `({ script }) => { orchestrator, store, agent }`                        | `submit`/`status`、同一会话串行、取消排队中的、`events?`、`recover?` 补 `ctx.run.ended`（含会话多于一页、只收同一个 `owner` 的）、`close` 后不收                                                                                                               |
| `describeMemoryStoreContract`     | `({ now }) => MemoryStore`                                              | 笔记的 `head`、`pending`、`settle`；事实不改写、`close` 和 `supersededBy`、`cite` 去重、`touch` 追加、`archive` 退出 `open`、`forget` 真删、`list` 翻页；`search` 至少全文命中；程序 `confirm` 计数；`core` 历史                                               |
| `describeDecisionModelContract`   | `() => DecisionModel`                                                   | 三种问题的形状、概率和为 1、`choice` 是概率最大的、`signal` 中止                                                                                                                                                                                               |
| `describeExtractionModelContract` | `() => ExtractionModel`                                                 | 每种字段的 `value` 形状、找不到时 `value: null` 且 `pNull` 高、`signal` 中止                                                                                                                                                                                   |
| `describeMemoryContract`          | `(setup: { sessions, decision, extraction, now }) => { memory, store }` | `gate` 不改日志、笔记指向正确的 `seq` 区间、`head` 前进；`consolidate` 幂等、取代不覆盖、证据指回日志；`recall` 后 `recalls` 多一个；`source`、`tools` 的形状                                                                                                  |

harness 和编排器的工厂收到一份模型剧本 `script`（`ModelScriptStep[]`：`text`、调用回显工具的 `tool-call`、`error`），按它造模型和回显工具；`@modelctx-ai/ctx/testing` 的 `createScriptedModel` 是现成的。记忆的契约用协议包 `/testing` 里的剧本模型 `createScriptedDecisionModel`、`createScriptedExtractionModel`：`describeMemoryContract` 自己造好它们和一个内存会话日志交给工厂。谁跑：记忆存储的契约由 `ctx-memory` 的内存存储（带和不带 `embed`）、`createSqliteMemoryStore`、`createRemoteMemoryStore` 跑；决策模型的由剧本模型、启发式、`decisionFromLanguageModel`、`ctx-models` 的两个 provider（假 `fetch`）跑；提取模型的由剧本模型、`extractionFromLanguageModel`、`ctx-models` 的 `cloudflare` 跑；`describeMemoryContract` 由 `createMemory` 加内存存储跑，门控阈值固定在 0.1..0.9 之间，`LanguageModel` 可以不给。`ContextBuilder` 的契约还没写：它的行为大半在投影规则这些进程内配置里。

## 托管矩阵

每个组件三种形态。「进程内」是 `@modelctx-ai/ctx` 和各适配包；「本机另一进程 / 远端」靠 `ctx-remote` 的 HTTP 服务端和客户端，或者别人按协议实现的服务。

| 组件           | 进程内                                                            | 另一进程 / 远端                                                                              | 第三方托管                                                           |
| -------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| 会话           | 内存、SQLite                                                      | `ctx-remote`：服务端挂 `store` / `createRemoteSessionStore`（含 `watch`）                    | 实现 `SessionStore` 的任何存储服务                                   |
| 上下文         | 投影 + 来源                                                       | 跟着 harness 走；也可单独成服务                                                              | —                                                                    |
| 工具           | 注册表                                                            | 跟着 harness 走；远端执行环境的 `tools()` 报定义，加进本地注册表                             | —                                                                    |
| 执行环境       | 函数、子进程（`ctx-exec`）、MCP                                   | `ctx-remote`：服务端挂 `executors` / `createRemoteExecutor`；worker 拉取模式之后加           | 容器平台、Managed Agents 的沙箱                                      |
| Harness        | AI SDK 循环                                                       | `ctx-remote`：服务端挂 `harness` / `createRemoteHarness`（含 `stream`）                      | Managed Agents（之后）                                               |
| 编排           | 进程内队列                                                        | `ctx-remote`：服务端挂 `orchestrator` / `createRemoteOrchestrator`（含 `recover`、`events`） | 任何任务队列                                                         |
| 模型           | AI SDK                                                            | 名字 → 远端 harness 自己造                                                                   | 各服务商                                                             |
| 记忆           | 内存（`ctx-memory`）、SQLite（`ctx-sqlite`）；门面 `createMemory` | `ctx-remote`：服务端挂 `memory` / `createRemoteMemoryStore`                                  | 实现 `MemoryStore` 的记忆服务                                        |
| 决策、提取模型 | 启发式、`LanguageModel` 装成的（`ctx-memory`）                    | 名字 → 各进程自己造                                                                          | `ctx-models`：Cloudflare（Clef、Clairic）、TypeSafe（Jev，只做决策） |

服务端是 `@modelctx-ai/ctx-remote/server` 的 `startRemote(options)` 或 `createRemoteHandler(options)`：给了哪些组件就挂哪些路径，一个服务可以同时挂几样。

一个典型的分布式部署：编排器在本机，harness 是一个服务，会话在托管的数据库，执行环境是公有云上的容器或本机的一个子进程，模型是任何服务商。每一侧都只认协议。

## 线上形态

`ctx-remote` 用 HTTP 承载协议。JSON 请求和响应，流式用 NDJSON（每行一个值，出错时最后一行是 `{ error }`）；错误正文是 `{ error: ErrorInfo }`，客户端转成带 `status` 的 `Error`。鉴权用 `Authorization: Bearer <token>`，缺省只听本机，Host 只认监听地址，带 `Origin` 的请求缺省 403。消息本身就是 JSON，线上不做编码（0.3 起；0.2 的客户端和服务端不能混用）。路径按组件分组，可以整体挂在一个前缀下：

| 组件     | 方法              | 路径                                                        | 请求体 → 响应                                                                              |
| -------- | ----------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 会话     | `append`          | `POST /sessions/:session/entries`                           | `{ entries, expectSeq? }` → `{ entries }`；前提不满足 409（`type: conflict`，`retryable`） |
|          | `list`            | `GET /sessions/:session/entries?after=&last=&types=&kinds=` | → `{ entries }`；`types`、`kinds` 逗号分隔（`kind` 里不能有逗号）                          |
|          | `watch`           | `GET /sessions/:session/entries/stream?after=`              | → NDJSON `Entry`；存储没有 `watch` 时服务端轮询 `list`                                     |
|          | `clear`           | `DELETE /sessions/:session`                                 | → `{ deleted }`                                                                            |
|          | `sessions`        | `GET /sessions?prefix=&after=&limit=`                       | → `{ sessions }`；名字升序                                                                 |
| 执行环境 | （列出名字）      | `GET /executors`                                            | → `{ executors }`                                                                          |
|          | `tools`           | `GET /executors/:name/tools`                                | → `{ tools }`                                                                              |
|          | `execute`         | `POST /executors/:name/execute`                             | `{ call, context: { session, runId? } }` → `{ output }`；断开即中止                        |
| Harness  | `run`             | `POST /runs`                                                | `RunRequest` 去掉 `signal`（可带 `aborted: true`）→ `RunResult`                            |
|          | `stream`          | `POST /runs?stream=1`                                       | 同上 → NDJSON `RunEvent`；断开即中止                                                       |
|          | 取消（`signal`）  | `DELETE /runs/:runId`                                       | → `{ cancelled }`                                                                          |
| 编排     | `submit`          | `POST /orchestrator/runs`                                   | 同 `POST /runs` → `{ runId, session }`                                                     |
|          | `status` / `done` | `GET /orchestrator/runs/:runId?wait=<ms>`                   | → `{ runId, status, result?, error? }`；`wait` 是长轮询                                    |
|          | `cancel`          | `DELETE /orchestrator/runs/:runId`                          | → `{ cancelled }`                                                                          |
|          | `recover`         | `POST /orchestrator/recover`                                | → `{ recovered }`                                                                          |
|          | `events`          | `GET /orchestrator/events`                                  | → NDJSON `OrchestratorEvent`                                                               |
| 记忆     | `notes.*`         | `/memory/notes` 下                                          | 每个方法一条路径，逐条见 [`packages/remote`](../packages/remote/README.md)                 |
|          | `facts.*`         | `/memory/facts` 下                                          | 同上                                                                                       |
|          | `procedures.*`    | `/memory/procedures` 下                                     | 同上                                                                                       |
|          | `core.*`          | `/memory/core` 下                                           | 同上                                                                                       |

编排器放在 `/orchestrator` 下，不和 harness 共用 `/runs`：同一个服务可以同时挂两者，「现在跑一轮、等结果」和「排进队列」是两件事。细节（取消的时序、长轮询的上限、安全缺省）见 [`packages/remote`](../packages/remote/README.md)。

WebSocket 传输、执行环境的 worker 拉取模式在之后加，协议不变。
