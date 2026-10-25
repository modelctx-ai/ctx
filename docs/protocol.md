# 协议层

`@modelctx-ai/ctx-protocol` 定义六个协议、随它们走的 JSON 形状、只依赖这些形状的纯函数，以及每个协议的契约测试。它不含实现。模型用 AI SDK 的 `LanguageModel`，不另定义。

本文是协议的说明；类型以包里的 `.d.ts` 为准。下面的签名是定稿前的草案，实现阶段按实际收敛后回来更新。

## 总则

| 规则         | 说明                                                                                                               |
| ------------ | ------------------------------------------------------------------------------------------------------------------ |
| 接口加工厂   | 协议是 `interface`，实现是 `createX(options): X`。不用类继承                                                       |
| 只收发 JSON  | 方法参数和返回值都能 `JSON.stringify`。例外：`AbortSignal`、进程内的 `LanguageModel`。跨边界时模型用名字字符串     |
| 字符串身份   | `session`、工具名、执行环境名、`runId` 都是字符串                                                                  |
| 流是事件序列 | 流式结果用 `AsyncIterable<Event>` 表达，跨边界是 NDJSON 或 SSE                                                     |
| 可选方法     | 协议里标 `?` 的方法实现可以不提供，调用方要检查                                                                    |
| 取消         | 需要取消的方法收 `signal?: AbortSignal`                                                                            |
| 错误         | 抛 `Error`；跨边界时是 `{ error: { message, type, retryable? } }`                                                  |
| 契约测试     | 每个协议在 `@modelctx-ai/ctx-protocol/testing` 有 `describeXContract(name, factory, { describe, test })`，实现跑它 |

## 会话 `SessionStore`

只追加的事件日志。详细语义见 [ADR 0003](adr/0003-context-model.md)。

```ts
interface Cursor {
  readonly at: number;
  readonly seq: number;
}

interface EntryBase {
  readonly id: string; // 全局唯一；不给就由存储生成
  readonly session: string; // 由存储填
  readonly seq: number; // 由存储填
  readonly at: number; // 逻辑时间（毫秒），缺省写入时刻
  readonly key?: string; // 幂等键：同一会话里键相同的第二条跳过
  readonly source?: string; // 谁写的：user、model、harness、应用名
  readonly meta?: JsonObject;
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
  covers: Cursor;
}
type Entry = MessageEntry | EventEntry | SummaryEntry;

interface ListOptions {
  after?: Cursor;
  last?: number;
  types?: EntryType[];
}

interface SessionStore {
  append(session: string, entries: readonly NewEntry[]): Promise<Entry[]>;
  list(session: string, options?: ListOptions): Promise<Entry[]>;
  clear(session: string): Promise<number>;
  sessions(): Promise<string[]>;
  /** 从某个游标起持续读新条目；远端流式用。 */
  watch?(session: string, options?: { after?: Cursor; signal?: AbortSignal }): AsyncIterable<Entry>;
}
```

- `append` 对一批条目是原子的：要么都写，要么都不写。崩溃后续跑依赖这一点。
- 事件 `kind` 用 `{domain}.{action}`。框架保留 `ctx.` 前缀：

| `kind`            | 谁写          | `data`                                       |
| ----------------- | ------------- | -------------------------------------------- |
| `ctx.run.started` | harness       | `{ runId, agent: AgentSpec 的可序列化部分 }` |
| `ctx.run.ended`   | harness       | `{ runId, stopReason, usage? }`              |
| `ctx.compacted`   | 上下文        | `{ covers, summaryId }`                      |
| `ctx.error`       | harness、编排 | `{ runId?, message, type? }`                 |

这些事件缺省对模型不可见，和应用事件一样由投影规则决定要不要渲染。

纯函数：`compareCursor`、`cursorOf`、`userEntry`、`assistantEntry`、`messageEntry`、`eventEntry`、`textOf`。

## 上下文 `ContextBuilder`

把会话日志、来源取到的事实、这一轮的输入组装成一次调用。它持有一个 `SessionStore`，harness 只给它会话名。

```ts
interface BuildRequest {
  readonly session: string;
  readonly input?: UserContent; // 这一轮的输入；已经写进日志时不传
  readonly instructions?: string; // AgentSpec 的指令
  readonly prompt?: UserContent; // 最后一条临时用户消息，不写日志
  readonly tools?: readonly ToolDefinition[]; // 候选工具，builder 可以再筛
  readonly window?: WindowOptions;
  readonly signal?: AbortSignal;
}
interface PreparedCall {
  readonly instructions?: string; // 指令 + 事实 + 投影里的 system 文字
  readonly messages: ModelMessage[];
  readonly tools: readonly string[]; // 这次给模型的工具名
  readonly facts: readonly Fact[];
  readonly projection: Projection;
}
interface ContextBuilder {
  build(request: BuildRequest): Promise<PreparedCall>;
  /** 当前视图：摘要 + 之后的条目，按规则渲染。网关用它。 */
  view(session: string, options?: { window?: WindowOptions }): Promise<Projection>;
  /** 把较早的历史压成一条摘要。历史不够长时返回 null。 */
  compact?(session: string, options?: CompactOptions): Promise<SummaryEntry | null>;
}
interface ContextSource {
  readonly name: string;
  collect(context: { session: string; signal?: AbortSignal }): Awaitable<string | null | undefined>;
}
```

- 参考实现 = 投影规则（事件渲染、摘要渲染、消息改写、窗口）+ 来源 + 压缩，就是今天 `createContext` 里的 `prepare`、`view`、`compact`。
- 投影和 token 估算是纯函数，放在协议包：`project(entries, options)`、`estimateTokens`。
- 提示缓存：事实追加在指令末尾会让 system 前缀每次都变，参考实现提供把事实放进最后一条临时用户消息的选项。

## 工具 `ToolRegistry`

工具目录。目录里是定义，不是函数；每个定义绑一个执行环境的名字。

```ts
interface ToolDefinition {
  readonly name: string; // [a-zA-Z0-9_-]{1,64}
  readonly description?: string;
  readonly inputSchema: JsonObject; // JSON Schema
  readonly executor: string; // 执行环境的名字
  readonly source?: string; // local、mcp:<server>、process…
  readonly tags?: readonly string[];
}
type ToolFilter = boolean | readonly string[] | ((tool: ToolDefinition) => boolean);

interface ToolRegistry {
  readonly size: number;
  add(definition: ToolDefinition, options?: { replace?: boolean }): ToolRegistry;
  remove(name: string): boolean;
  removeSource(source: string): number;
  has(name: string): boolean;
  list(): ToolDefinition[];
  select(filter?: ToolFilter): ToolDefinition[];
}
```

- 参考实现另给糖：`registry.add(name, aiSdkTool, meta)` 把 zod 工具转成 JSON Schema 定义，执行函数放进一个进程内的函数执行环境。
- 命名约定来自 Anthropic 的工具设计文章：按服务和资源加前缀（MCP 工具是 `<server>__<tool>`），参数名不含糊（`user_id` 不是 `user`），说明写给新同事看。

## 执行环境 `Executor`

工具调用真正发生的地方。

```ts
interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly input: JsonValue;
}
type ToolOutput =
  | { type: 'text'; text: string }
  | { type: 'json'; value: JsonValue }
  | { type: 'content'; parts: readonly ToolContentPart[] } // 文字、图片
  | { type: 'error'; message: string; retryable?: boolean; data?: JsonValue };

interface ExecutionContext {
  readonly session: string;
  readonly runId?: string;
  readonly signal?: AbortSignal;
}
interface Executor {
  readonly name: string;
  /** 它能执行哪些工具。MCP、子进程这类执行环境自己报；函数执行环境报注册进来的。 */
  tools?(): Promise<ToolDefinition[]>;
  execute(call: ToolCall, context: ExecutionContext): Promise<ToolOutput>;
  provision?(): Promise<void>;
  dispose?(): Promise<void>;
}
```

- 执行出错返回 `{ type: 'error' }` 而不是抛：模型要看到错误才能接着做。抛出表示执行环境本身坏了。错误信息要能照着做（「文件不存在：/a/b，当前目录有 …」），不是错误码。
- 大输出由执行环境截断或分页，再交给模型。
- 实现：进程内函数（核心包）、MCP 服务器（`ctx-mcp`）、本机子进程（`ctx-exec`）、HTTP 远端（`ctx-remote`）。
- 远端执行环境有两种接法：harness 调它（它是服务），或它从 harness 领工作（它是只需出站连接的 worker，像 Managed Agents 的自托管沙箱）。协议相同，`ctx-remote` 先做前者。

## Harness

一轮运行。

```ts
interface AgentSpec {
  readonly model: string | LanguageModel;   // 跨边界只能是名字
  readonly instructions?: string;
  readonly tools?: ToolFilter;
  readonly maxSteps?: number;               // 缺省：有工具 5，没有 1
  readonly settings?: CallSettings;         // temperature、maxOutputTokens、timeoutMs…
}
interface RunRequest {
  readonly session: string;
  readonly agent: AgentSpec;
  readonly input?: UserContent;
  readonly inputKey?: string;               // 输入的幂等键，重试不重复记
  readonly prompt?: UserContent;            // 临时的最后一条，不写日志
  readonly record?: boolean;                // 缺省写日志
  readonly runId?: string;                  // 不给就生成
  readonly signal?: AbortSignal;
}
type StopReason = 'end_turn' | 'max_steps' | 'aborted' | 'error' | 'hook_denied';
interface RunResult {
  readonly runId: string;
  readonly text: string;
  readonly messages: ModelMessage[];        // 这一轮模型产出的消息
  readonly recorded: readonly Entry[];
  readonly stopReason: StopReason;
  readonly usage?: { inputTokens?: number; outputTokens?: number };
}
type RunEvent =
  | { type: 'run.started'; runId: string }
  | { type: 'model.started'; runId: string; step: number }
  | { type: 'text.delta'; runId: string; text: string }
  | { type: 'tool.called'; runId: string; call: ToolCall }
  | { type: 'tool.returned'; runId: string; callId: string; output: ToolOutput }
  | { type: 'model.ended'; runId: string; step: number; usage?: … }
  | { type: 'run.ended'; runId: string; result: Omit<RunResult, 'messages' | 'recorded'> }
  | { type: 'error'; runId: string; message: string };

interface Hooks {
  beforeModel?(call: PreparedCall, context: { runId; session; step }): Awaitable<PreparedCall | void>;
  beforeTool?(call: ToolCall, context: ExecutionContext): Awaitable<{ allow: true; input?: JsonValue } | { allow: false; reason: string } | void>;
  afterTool?(call: ToolCall, output: ToolOutput, context: ExecutionContext): Awaitable<ToolOutput | void>;
}
interface Harness {
  run(request: RunRequest): Promise<RunResult>;
  stream?(request: RunRequest): AsyncIterable<RunEvent>;
}
```

- 一轮里 harness 做的事：`ctx.run.started` → 记输入 → `ContextBuilder.build` → 调模型 → 对每个工具调用：`beforeTool` → 找到绑定的执行环境 → `execute` → `afterTool` → 工具结果回到模型，直到停下 → 记产出 → `ctx.run.ended`。
- `text.delta` 不落日志，像 Managed Agents 的 event delta；其余事件各有对应的日志条目。
- 权限确认是 `beforeTool` 的一种实现：返回 `{ allow: false }` 时工具结果是一条错误，模型会看到原因。
- 参考实现基于 AI SDK 的 `generateText` / `streamText`：把选中的 `ToolDefinition` 包成 AI SDK 工具，`execute` 转给执行环境。
- 远端 harness：`POST /runs` 收 `RunRequest`（模型是名字），回 `RunResult`；`stream` 是同一个路径的 NDJSON。

## 编排 `Orchestrator`

跨轮次、跨会话的调度。协议只定最小的一组，模式（链式、路由、并行、编排者-工作者）由应用用 `Harness.run` 组合。

```ts
type RunStatus = 'queued' | 'running' | 'idle' | 'failed' | 'cancelled';
interface RunHandle { readonly runId: string; readonly session: string; readonly done: Promise<RunResult> }

interface Orchestrator {
  /** 同一会话的运行串行，不同会话并行。 */
  submit(request: RunRequest): Promise<RunHandle>;
  status(runId: string): Promise<RunStatus | undefined>;
  cancel(runId: string): Promise<boolean>;
  /** 崩溃后：找到日志里有 ctx.run.started 没有 ctx.run.ended 的会话，补一条 ctx.run.ended（stopReason error）或续跑。 */
  recover?(): Promise<{ session: string; runId: string }[]>;
  events?(options?: { signal?: AbortSignal }): AsyncIterable<{ type: 'run.' + RunStatus; runId: string; session: string }>;
  close(): Promise<void>;
}
```

- 参考实现是进程内队列：每个会话一条队列，一个 harness。
- yoyo 的常驻循环和导演是一个应用级的编排器：定时、让路、收件箱。它应当实现这个协议，而不是另一套。
- 远端编排器：`POST /runs`、`GET /runs/:id`、`DELETE /runs/:id`、`GET /events`（SSE）。

## 托管矩阵

每个组件三种形态。「进程内」是 `@modelctx-ai/ctx` 和各适配包；「本机另一进程 / 远端」靠 `ctx-remote` 的 HTTP 服务端和客户端，或者别人按协议实现的服务。

| 组件     | 进程内                          | 另一进程 / 远端                                                                 | 第三方托管                         |
| -------- | ------------------------------- | ------------------------------------------------------------------------------- | ---------------------------------- |
| 会话     | 内存、SQLite                    | `ctx-remote`：`serveSessionStore` / `createRemoteSessionStore`                  | 实现 `SessionStore` 的任何存储服务 |
| 上下文   | 投影 + 来源                     | 跟着 harness 走；也可单独成服务                                                 | —                                  |
| 工具     | 注册表                          | 跟着 harness 走                                                                 | —                                  |
| 执行环境 | 函数、子进程（`ctx-exec`）、MCP | `ctx-remote`：`serveExecutor` / `createRemoteExecutor`；worker 拉取模式（计划） | 容器平台、Managed Agents 的沙箱    |
| Harness  | AI SDK 循环                     | `ctx-remote`：`serveHarness` / `createRemoteHarness`                            | Managed Agents（计划）             |
| 编排     | 进程内队列                      | 同上（计划）                                                                    | 任何任务队列                       |
| 模型     | AI SDK                          | 名字 → 远端 harness 自己造                                                      | 各服务商                           |

一个典型的分布式部署：编排器在本机，harness 是一个服务，会话在托管的数据库，执行环境是公有云上的容器或本机的一个子进程，模型是任何服务商。每一侧都只认协议。

## 线上形态

`ctx-remote` 用 HTTP 承载协议。JSON 请求和响应，流式用 NDJSON；鉴权用 `Authorization: Bearer <token>`，缺省只听本机。路径按组件分组：

| 组件     | 方法                           | 路径                                                               |
| -------- | ------------------------------ | ------------------------------------------------------------------ |
| 会话     | `append`                       | `POST /sessions/:session/entries`                                  |
|          | `list`                         | `GET /sessions/:session/entries?after.at=&after.seq=&last=&types=` |
|          | `watch`                        | `GET /sessions/:session/entries/stream`                            |
|          | `clear`                        | `DELETE /sessions/:session`                                        |
|          | `sessions`                     | `GET /sessions`                                                    |
| 执行环境 | `tools`                        | `GET /executors/:name/tools`                                       |
|          | `execute`                      | `POST /executors/:name/execute`                                    |
| Harness  | `run`                          | `POST /runs`                                                       |
|          | `stream`                       | `POST /runs?stream=1`（NDJSON）                                    |
| 编排     | `submit` / `status` / `cancel` | `POST /runs`、`GET /runs/:id`、`DELETE /runs/:id`                  |

WebSocket 传输、执行环境的 worker 拉取模式在之后加，协议不变。
