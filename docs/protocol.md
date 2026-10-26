# 协议层

`@modelctx-ai/ctx-protocol` 定义六个协议、随它们走的 JSON 形状、只依赖这些形状的纯函数，以及每个协议的契约测试。它不含实现。模型用 AI SDK 的 `LanguageModel`，不另定义。

本文是协议的说明；类型以包里的 `.d.ts` 为准，下面的签名省略了 `readonly` 和注释。包的用法和契约测试一览见 [`packages/protocol`](../packages/protocol/README.md)。

## 总则

| 规则         | 说明                                                                                                                               |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| 接口加工厂   | 协议是 `interface`，实现是 `createX(options): X`。不用类继承                                                                       |
| 只收发 JSON  | 方法参数和返回值都能 `JSON.stringify`。例外：`AbortSignal`、进程内的 `LanguageModel`。跨边界时模型用名字字符串                     |
| 消息         | `ModelMessage` 原样用 AI SDK 的；其中的二进制和 `URL` 由跨边界的一方编码（如 `ctx-sqlite` 的 `$bytes`、`$url`）                    |
| 字符串身份   | `session`、工具名、执行环境名、`runId` 都是字符串                                                                                  |
| 流是事件序列 | 流式结果用 `AsyncIterable<Event>` 表达，跨边界是 NDJSON 或 SSE                                                                     |
| 可选方法     | 协议里标 `?` 的方法实现可以不提供，调用方要检查                                                                                    |
| 取消         | 需要取消的方法收 `signal?: AbortSignal`                                                                                            |
| 错误         | 抛 `Error`；跨边界时是 `{ error: ErrorInfo }`，`ErrorInfo` 是 `{ message, type?, retryable?, statusCode?, responseBody? }`         |
| 契约测试     | `@modelctx-ai/ctx-protocol/testing` 的 `describeXContract(name, factory, { describe, test })`，实现跑它（见[契约测试](#契约测试)） |

## 会话 `SessionStore`

只追加的事件日志。详细语义见 [ADR 0003](adr/0003-context-model.md)。

```ts
interface EntryBase {
  id: string; // 全局唯一；不给就由存储生成
  session: string; // 由存储填
  seq: number; // 会话内位置，由存储按写入顺序填：会话内严格递增、从 1 起，`clear` 后不回退；0 是会话开头
  at: number; // 逻辑时间（毫秒），缺省写入时刻；只用于投影排序和展示，可以早于已有的条目
  key?: string; // 幂等键：同一会话里键相同的第二条跳过
  source?: string; // 谁写的：user、model、harness、应用名
  meta?: JsonObject;
}
interface MessageEntry extends EntryBase {
  type: 'message';
  message: ModelMessage;
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

interface SessionStore {
  append(session: string, entries: readonly NewEntry[]): Promise<Entry[]>;
  list(session: string, options?: ListOptions): Promise<Entry[]>;
  clear(session: string): Promise<number>;
  sessions(options?: SessionsOptions): Promise<string[]>; // 名字升序
  /** 先给出 after 之后已有的条目，再持续给出新写入的；远端流式读用。 */
  watch?(session: string, options?: WatchOptions): AsyncIterable<Entry>;
}
```

- `append` 对一批条目是原子的：不会只写一半，也不会和并发的另一批交错。崩溃后续跑依赖这一点。
- 去重不算失败：`id` 重复（全局）或 `key` 重复（同一会话，含同一批里的）的那一条静默跳过，同批其余照写；返回值就是真正写入的条目。重试一批时靠它不重复记。
- `list` 和 `watch` 都按 `seq` 升序返回，也就是写入顺序。带旧 `at` 导入的条目排在写入的位置（所以游标之后一定看得到新写入的），模型看到的逻辑顺序由投影按 `(at, seq)` 重排（`compareEntries`）。`seq` 只要求会话内单调，消费者不能跨会话比较。
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

纯函数：`userEntry`、`assistantEntry`、`messageEntry`、`eventEntry`、`summaryEntry` 构造条目；`runStartedEntry`、`runEndedEntry`、`compactedEntry`、`ctxErrorEntry` 构造框架事件（可选字段不给时不出现在 `data` 里）；`isFrameworkKind`；`compareEntries`、`textOf`；`filterEntries(entries, options)` 是 `ListOptions` 的语义，`filterSessions(names, options)` 是 `SessionsOptions` 的语义，内存里的存储可以直接用。

## 上下文 `ContextBuilder`

把会话日志、来源取到的事实、这一轮的输入组装成一次调用。它持有一个 `SessionStore`，harness 只给它会话名。

```ts
interface WindowOptions {
  maxMessages?: number; // 摘要不算
  maxTokens?: number; // 估算，摘要计入
}
interface BuildRequest {
  session: string;
  input?: UserContent; // 这一轮的输入；已经写进日志时不传
  instructions?: string; // AgentSpec 的指令
  prompt?: UserContent; // 最后一条临时用户消息，不写日志
  tools?: readonly ToolDefinition[]; // 候选工具，builder 可以再筛
  window?: WindowOptions;
  facts?: boolean; // 是否收集来源，缺省收集
  signal?: AbortSignal;
}
interface PreparedCall {
  instructions?: string; // 指令 + 事实 + 投影里的 system 文字
  messages: ModelMessage[]; // 不再含 system 消息
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
  view(session: string, options?: { window?: WindowOptions }): Promise<Projection>;
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
  summary?: (entry: SummaryEntry) => ModelMessage;
  message?: (entry: MessageEntry) => ModelMessage | null | undefined;
  window?: WindowOptions & { estimate?: (message: ModelMessage) => number }; // ProjectionWindow
}
interface EventRule {
  fold?: boolean;
  render(events: readonly EventEntry[]): ModelMessage | readonly ModelMessage[] | null | undefined;
}
interface Projection {
  messages: ModelMessage[];
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
- 参考实现另给糖：`registry.add(name, aiSdkTool, meta)` 把 zod 工具转成 JSON Schema 定义，执行函数放进一个进程内的函数执行环境。
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
  settings?: CallSettings;
}
interface RunRequest {
  session: string;
  agent: AgentSpec;
  input?: UserContent;
  inputKey?: string; // 输入的幂等键，重试不重复记
  prompt?: UserContent; // 临时的最后一条，不写日志
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
  messages: ModelMessage[]; // 这一轮模型产出的消息
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

- 一轮里 harness 做的事：`ctx.run.started` → 记输入 → `ContextBuilder.build` → 调模型 → 对每个工具调用：`beforeTool` → 找到绑定的执行环境 → `execute` → `afterTool` → 工具结果回到模型，直到停下 → 记产出 → `ctx.run.ended`。
- 模型出错、被取消也写 `ctx.run.ended`，`run` 照常返回，`stopReason` 和 `error` 说明原因；只有写日志本身失败才 reject。远端调用方因此总拿到同一种形状。
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
  recover?(): Promise<{ session: string; runId: string }[]>;
  events?(options?: { signal?: AbortSignal }): AsyncIterable<OrchestratorEvent>;
  close(): Promise<void>;
}
```

- `completed` 是跑完了；`failed` 是 `stopReason: error` 或 harness 抛错；`cancelled` 是被 `cancel` 或 `signal` 取消。
- 参考实现是进程内队列：每个会话一条队列，一个 harness。
- yoyo 的 `createYoyoOrchestrator` 是一个应用级的编排器，实现这个协议：定时、让路、收件箱。碎碎念和回复是同一个 harness 跑的两份 `AgentSpec`，导演只剩舞台动作，常驻循环只管进程。
- 远端编排器（`ctx-remote`）：路径放在 `/orchestrator` 下，和 harness 的 `/runs` 分开：`POST /orchestrator/runs`、`GET /orchestrator/runs/:id`（`?wait=` 长轮询，结束后带 `result`，客户端的 `done` 靠它）、`DELETE /orchestrator/runs/:id`、`POST /orchestrator/recover`、`GET /orchestrator/events`（NDJSON）。

## 契约测试

`@modelctx-ai/ctx-protocol/testing`，用法见[包说明](../packages/protocol/README.md#实现一个协议)。

| 契约测试                       | 工厂                                             | 覆盖                                                                                                                                                                                                |
| ------------------------------ | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `describeSessionStoreContract` | `({ now }) => SessionStore`                      | 排序、同一时刻、去重、一批里有重复时其余照写、并发两批不交错、`after`/`last`/`types`/`kinds`、往返、二进制和 URL、像标记的数据、`clear`、`sessions` 的升序和翻页、`watch?` 的读已有、读新写入、中止 |
| `describeExecutorContract`     | `() => { executor, echo }`                       | 有名字、`tools?()` 列出回显工具并绑定自己、`execute` 回显且能 JSON 往返、未知工具和已中止的 `signal` 返回 `{ type: 'error' }` 不抛、`provision?` 可重复                                             |
| `describeToolRegistryContract` | `() => ToolRegistry`                             | 增查和顺序、名字校验、同名和 `replace`、`remove`/`removeSource`、`select` 与 `selectTools` 一致                                                                                                     |
| `describeHarnessContract`      | `({ script }) => { harness, store, agent }`      | 一轮的日志顺序和 `recorded`、`runId`、工具调用经执行环境、模型出错照常返回 `error` 并写 `ctx.run.ended`、`inputKey` 重试、`record: false`、已中止的 `signal`、`stream?` 的事件顺序和出错            |
| `describeOrchestratorContract` | `({ script }) => { orchestrator, store, agent }` | `submit`/`status`、同一会话串行、取消排队中的、`events?`、`recover?` 补 `ctx.run.ended`（含会话多于一页）、`close` 后不收                                                                           |

harness 和编排器的工厂收到一份模型剧本 `script`（`ModelScriptStep[]`：`text`、调用回显工具的 `tool-call`、`error`），按它造模型和回显工具；`@modelctx-ai/ctx/testing` 的 `createScriptedModel` 是现成的。`ContextBuilder` 的契约还没写：它的行为大半在投影规则这些进程内配置里。

## 托管矩阵

每个组件三种形态。「进程内」是 `@modelctx-ai/ctx` 和各适配包；「本机另一进程 / 远端」靠 `ctx-remote` 的 HTTP 服务端和客户端，或者别人按协议实现的服务。

| 组件     | 进程内                          | 另一进程 / 远端                                                                              | 第三方托管                         |
| -------- | ------------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------- |
| 会话     | 内存、SQLite                    | `ctx-remote`：服务端挂 `store` / `createRemoteSessionStore`（含 `watch`）                    | 实现 `SessionStore` 的任何存储服务 |
| 上下文   | 投影 + 来源                     | 跟着 harness 走；也可单独成服务                                                              | —                                  |
| 工具     | 注册表                          | 跟着 harness 走；远端执行环境的 `tools()` 报定义，加进本地注册表                             | —                                  |
| 执行环境 | 函数、子进程（`ctx-exec`）、MCP | `ctx-remote`：服务端挂 `executors` / `createRemoteExecutor`；worker 拉取模式之后加           | 容器平台、Managed Agents 的沙箱    |
| Harness  | AI SDK 循环                     | `ctx-remote`：服务端挂 `harness` / `createRemoteHarness`（含 `stream`）                      | Managed Agents（之后）             |
| 编排     | 进程内队列                      | `ctx-remote`：服务端挂 `orchestrator` / `createRemoteOrchestrator`（含 `recover`、`events`） | 任何任务队列                       |
| 模型     | AI SDK                          | 名字 → 远端 harness 自己造                                                                   | 各服务商                           |

服务端是 `@modelctx-ai/ctx-remote/server` 的 `startRemote(options)` 或 `createRemoteHandler(options)`：给了哪些组件就挂哪些路径，一个服务可以同时挂几样。

一个典型的分布式部署：编排器在本机，harness 是一个服务，会话在托管的数据库，执行环境是公有云上的容器或本机的一个子进程，模型是任何服务商。每一侧都只认协议。

## 线上形态

`ctx-remote` 用 HTTP 承载协议。JSON 请求和响应，流式用 NDJSON（每行一个值，出错时最后一行是 `{ error }`）；错误正文是 `{ error: ErrorInfo }`，客户端转成带 `status` 的 `Error`。鉴权用 `Authorization: Bearer <token>`，缺省只听本机，Host 只认监听地址，带 `Origin` 的请求缺省 403。消息里的二进制和 `URL` 编码成带标记的对象（`{"\u0000ctx": "bytes", "base64"}`、`{"\u0000ctx": "url", "href"}`），两头还原。路径按组件分组，可以整体挂在一个前缀下：

| 组件     | 方法              | 路径                                                        | 请求体 → 响应                                                       |
| -------- | ----------------- | ----------------------------------------------------------- | ------------------------------------------------------------------- |
| 会话     | `append`          | `POST /sessions/:session/entries`                           | `{ entries }` → `{ entries }`                                       |
|          | `list`            | `GET /sessions/:session/entries?after=&last=&types=&kinds=` | → `{ entries }`；`types`、`kinds` 逗号分隔（`kind` 里不能有逗号）   |
|          | `watch`           | `GET /sessions/:session/entries/stream?after=`              | → NDJSON `Entry`；存储没有 `watch` 时服务端轮询 `list`              |
|          | `clear`           | `DELETE /sessions/:session`                                 | → `{ deleted }`                                                     |
|          | `sessions`        | `GET /sessions?prefix=&after=&limit=`                       | → `{ sessions }`；名字升序                                          |
| 执行环境 | （列出名字）      | `GET /executors`                                            | → `{ executors }`                                                   |
|          | `tools`           | `GET /executors/:name/tools`                                | → `{ tools }`                                                       |
|          | `execute`         | `POST /executors/:name/execute`                             | `{ call, context: { session, runId? } }` → `{ output }`；断开即中止 |
| Harness  | `run`             | `POST /runs`                                                | `RunRequest` 去掉 `signal`（可带 `aborted: true`）→ `RunResult`     |
|          | `stream`          | `POST /runs?stream=1`                                       | 同上 → NDJSON `RunEvent`；断开即中止                                |
|          | 取消（`signal`）  | `DELETE /runs/:runId`                                       | → `{ cancelled }`                                                   |
| 编排     | `submit`          | `POST /orchestrator/runs`                                   | 同 `POST /runs` → `{ runId, session }`                              |
|          | `status` / `done` | `GET /orchestrator/runs/:runId?wait=<ms>`                   | → `{ runId, status, result?, error? }`；`wait` 是长轮询             |
|          | `cancel`          | `DELETE /orchestrator/runs/:runId`                          | → `{ cancelled }`                                                   |
|          | `recover`         | `POST /orchestrator/recover`                                | → `{ recovered }`                                                   |
|          | `events`          | `GET /orchestrator/events`                                  | → NDJSON `OrchestratorEvent`                                        |

编排器放在 `/orchestrator` 下，不和 harness 共用 `/runs`：同一个服务可以同时挂两者，「现在跑一轮、等结果」和「排进队列」是两件事。细节（取消的时序、长轮询的上限、安全缺省）见 [`packages/remote`](../packages/remote/README.md)。

WebSocket 传输、执行环境的 worker 拉取模式在之后加，协议不变。
