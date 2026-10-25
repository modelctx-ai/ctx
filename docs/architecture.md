# 架构：进程内参考实现

ctx 分三层：协议（`@modelctx-ai/ctx-protocol`，只有接口）、实现（`@modelctx-ai/ctx` 和 `ctx-*`）、实践（yoyo）。组件和协议的说明见[概念](concepts.md)和[协议层](protocol.md)。本文写的是实现层里进程内的那一份：`@modelctx-ai/ctx` 的会话存储、投影、来源、工具、harness，以及 sqlite、models、mcp、gateway 四个适配包。

```mermaid
flowchart TB
  subgraph protocol["协议  @modelctx-ai/ctx-protocol"]
    p1["SessionStore"]
    p2["ContextBuilder"]
    p3["ToolRegistry · Executor"]
    p4["Harness · Orchestrator"]
  end
  subgraph impl["实现"]
    core["@modelctx-ai/ctx<br/>内存存储、投影、来源、注册表、函数执行器、AI SDK harness、进程内编排器、createContext()"]
    sqlite["ctx-sqlite"]
    mcp["ctx-mcp"]
    exec["ctx-exec"]
    remote["ctx-remote"]
    gateway["ctx-gateway"]
    models["ctx-models"]
  end
  subgraph practice["实践"]
    yoyo["modelctx-ai/yoyo"]
  end
  impl --> protocol
  practice --> impl
  practice --> protocol
```

> 术语：日志的名字叫会话 `session`，原来叫 `thread`。下文的 `thread` 在实现阶段统一改名，见 [ADR 0004](adr/0004-protocol-and-implementation.md)。

## 概念

| 概念                      | 说明                                                                                   |
| ------------------------- | -------------------------------------------------------------------------------------- |
| 线程 `thread`             | 一段对话的名字，例如 `pet:main`、`user:42`。条目按线程存放                             |
| 条目 `ContextEntry`       | 线程里的一条记录，分 `message`、`event`、`summary` 三种，写入后不再修改                |
| 游标 `Cursor`             | `{ at, seq }`。`at` 是逻辑时间（毫秒），`seq` 是存储分配的写入序号，同一时刻靠它排先后 |
| 存储 `ContextStore`       | 只追加的持久化边界：`append`、`list`、`clear`、`threads`                               |
| 投影 `project()`          | 把条目渲染成这一次交给模型的 `ModelMessage[]`，每次调用重新计算，不改日志              |
| 来源 `ContextSource`      | 调用那一刻才去取的上下文，取到的文字叫事实 `Fact`，不写日志                            |
| 工具注册表 `ToolRegistry` | 本地工具和 MCP 工具放在一处，每次调用挑一部分交给模型                                  |
| 上下文 `Context`          | `createContext()` 的返回值：绑定一个存储和一个线程，带投影规则、来源、工具和缺省模型   |

## 组件

```mermaid
flowchart LR
  subgraph core["@modelctx-ai/ctx"]
    context["Context<br/>createContext()"]
    projection["project()"]
    sources["ContextSource"]
    registry["ToolRegistry"]
    store["ContextStore"]
    memory["createMemoryStore()"]
  end
  sqlite["ctx-sqlite<br/>createSqliteStore()"]
  models["ctx-models<br/>createModel()"]
  mcp["ctx-mcp<br/>createMcpHub()"]
  gateway["ctx-gateway<br/>startGateway()"]
  ai["ai@7<br/>generateText / streamText"]

  context --> store
  context --> projection
  context --> sources
  context --> registry
  context --> ai
  memory -. 实现 .-> store
  sqlite -. 实现 .-> store
  models -- LanguageModel --> context
  mcp -- registerInto --> registry
  gateway -- "view()" --> context
```

实线是调用或提供，虚线是实现接口。

## 一次 generate

```mermaid
sequenceDiagram
  participant App as 应用
  participant Ctx as Context
  participant Store as ContextStore
  participant Src as 上下文来源
  participant SDK as AI SDK
  App->>Ctx: generate(instructions, input, inputKey)
  Note over Ctx: 没有模型就报错，什么都不写
  Ctx->>Store: append 用户这句（inputKey 作幂等键）
  Ctx->>Src: collect（并行，单个超时 2 秒）
  Src-->>Ctx: 事实
  Ctx->>Store: list（从最近一条摘要读起）
  Store-->>Ctx: 条目
  Note over Ctx: project 得到历史消息<br/>事实、投影出的 system 消息接到指令后面<br/>按 tools 挑工具
  Ctx->>SDK: generateText（instructions、messages、tools、stopWhen）
  SDK-->>Ctx: text、responseMessages
  Ctx->>Store: append 回复、工具调用和结果
  Ctx-->>App: text、messages、recorded、raw
```

`Context` 的方法：

| 方法                 | 作用                                                                |
| -------------------- | ------------------------------------------------------------------- |
| `append(...entries)` | 追加条目，返回真正写入的那些                                        |
| `entries(options?)`  | 读原始条目，参数同 `ContextStore.list`                              |
| `view({ window? })`  | 当前交给模型的历史：最近一条摘要和它之后的条目，按投影规则渲染      |
| `facts(signal?)`     | 收集一次事实                                                        |
| `prepare(options)`   | 组装指令、消息和工具，不调用模型                                    |
| `generate(options)`  | `prepare` → `generateText` → 记录                                   |
| `stream(options)`    | `prepare` → `streamText`，流结束后记录；返回 `{ result, recorded }` |
| `compact(options)`   | 把较早的历史压成一条摘要                                            |

## 条目

| 类型      | 字段                                | 怎么进模型上下文                                                   |
| --------- | ----------------------------------- | ------------------------------------------------------------------ |
| `message` | `message: ModelMessage`             | AI SDK 消息原样保存（文字、图片、工具调用和结果），投影时原样带上  |
| `event`   | `kind`、`text?`、`data?: JsonValue` | 应用自己的事件。缺省不可见，`projection.events[kind]` 有规则才渲染 |
| `summary` | `text`、`covers: Cursor`            | 压缩点：代替 `covers` 及之前的全部条目，固定在第一条               |

公共字段：

| 字段            | 说明                                                                 |
| --------------- | -------------------------------------------------------------------- |
| `id`            | 全局唯一；不给就由存储生成                                           |
| `thread`、`seq` | 由存储填                                                             |
| `at`            | 逻辑时间，缺省是写入时刻。导入的旧记录写原来的时间，会排回原来的位置 |
| `key`           | 幂等键：同一线程里键相同的第二条被跳过                               |
| `source`        | 谁写的，例如 `user`、`model`、`dsh-pet`                              |
| `meta`          | 任意 JSON 对象                                                       |

用 `userEntry(content)`、`assistantEntry(text)`、`messageEntry(message)`、`eventEntry(kind, { text, data })` 构造条目，都接受 `{ id, at, key, source, meta }`。摘要条目一般由 `compact()` 写。

## 存储

| 方法                                   | 行为                                                                                                                          |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `append(thread, entries)`              | 追加。`id` 重复或同线程 `key` 重复的条目静默跳过；返回真正写入的条目（已带 `id`、`seq`、`at`）                                |
| `list(thread, { after, last, types })` | 按 `(at, seq)` 从旧到新。`after` 不含该位置；`last` 取最后 N 条，仍从旧到新，小数向下取整，不是有限正数时返回空；三者可以组合 |
| `clear(thread)`                        | 删掉整个线程，返回条数                                                                                                        |
| `threads()`                            | 有内容的线程                                                                                                                  |

实现有 `createMemoryStore()`（核心包，进程内）和 `createSqliteStore()`（ctx-sqlite）。条目只追加；除了 `clear`，没有删除和修改。

## 投影

`project(entries, options)` 按顺序做五步：

1. 按 `(at, seq)` 排序。
2. 选摘要：`covers` 最大的那条生效。`covers` 及之前的条目不再出现；摘要用 `options.summary` 渲染（缺省是一条用户消息 `Summary of the earlier conversation:\n…`），固定在第一条，不参与裁剪。
3. 消息条目原样带上。`options.message(entry)` 可以改写，返回空就丢掉。
4. 事件条目：没有规则的 `kind` 跳过，也不打断前后同类事件的合并。`fold: true` 的规则把连续的同类事件合成一组交给 `render(events)`；`render` 返回一条消息、多条消息，或者空（丢掉）。
5. 窗口：开头孤立的工具结果（它的调用已经被摘要盖住或被裁掉）总是丢掉。设了 `maxMessages` 或 `maxTokens` 时，从最旧的消息开始整组丢弃直到不超；带工具调用的助手消息和紧跟的工具结果是一组。至少留下最后一组，宁可超预算也不交出空上下文。

例子：`whisper` 有 `fold` 规则，`clipboard` 没有规则。

| 日志（按 `at, seq`）           | 投影                                                        |
| ------------------------------ | ----------------------------------------------------------- |
| `user` 早先的问题              | 被摘要代替                                                  |
| `assistant` 早先的回答         | 被摘要代替                                                  |
| `summary`，`covers` 指向上一条 | `user` Summary of the earlier conversation: …（固定第一条） |
| `event whisper` 在呢           | `assistant` 碎碎念：在呢 / 喝水（合成一条）                 |
| `event clipboard`              | 不可见，也不打断合并                                        |
| `event whisper` 喝水           | 并进上面那条                                                |
| `user` 今天呢？                | `user` 今天呢？                                             |

| 选项                 | 说明                                                                  |
| -------------------- | --------------------------------------------------------------------- |
| `events`             | `Record<kind, EventRule>`，`EventRule` 是 `{ fold?, render(events) }` |
| `summary`            | 摘要渲染成哪条消息                                                    |
| `message`            | 改写或过滤消息条目                                                    |
| `window.maxMessages` | 最多保留几条消息，摘要不算                                            |
| `window.maxTokens`   | 估算 token 的预算，摘要计入                                           |
| `window.estimate`    | 换掉缺省的 `estimateTokens`                                           |

不设 `window` 就不裁剪：最近一条摘要之后的历史全部带上。

投影照常输出 `system` 消息（例如摘要渲染成 `system`）；组装调用时 `prepare` 把它们从消息里拿出来，接到指令后面（见[调用](#调用)）。

结果 `Projection`：`messages`；`items`，每条带 `upTo`（覆盖到的最后一个条目的游标）、`pinned`、`tokens`；`tokens` 合计；`dropped` 被丢掉的消息条数；`summary` 生效的摘要条目。

缺省的 token 估算不依赖分词器：中日韩文字一个字约 1 token，其他字符约 4 个 1 token，每条消息另加 4，图片、文件每个按 256（工具结果里的也一样，不去数 base64）。只用于预算和裁剪，不用于计费。

## 调用

`prepare(options)` 组装一次调用：

1. 收集事实（`facts: false` 跳过）。
2. 读视图：只读最近一条摘要和它之后的条目，再投影。`window` 可以覆盖投影里的窗口设置。
3. 指令：`instructions` 是字符串时，事实追加在后面，用空行隔开；是函数时把事实传进去，由函数决定怎么写。
4. 投影里的 `system` 消息（摘要、事件规则或 `message` 钩子渲染成的，以及存成消息条目的）不放进 `messages`，文字按顺序接在指令最后，同样用空行隔开。
5. 消息：视图 + `input`（这一轮用户说的话）+ `prompt`（最后一条临时用户消息；可以是函数，拿到事实）。
6. 工具：`tools` 缺省是注册表里全部；`false` 不给；名字列表或 `(info) => boolean` 筛选。

`instructions` 和 `prompt` 只要有一个是函数，事实就不再自动追加到指令后面；投影出的 `system` 消息照样接上。

```ts
import { readFile } from 'node:fs/promises';

import { createContext, createMemoryStore, defineSource, renderFacts, type LanguageModel } from '@modelctx-ai/ctx';

declare const model: LanguageModel;

const context = createContext({
  store: createMemoryStore(),
  thread: 'pet:main',
  model,
  sources: [
    defineSource('task', () => '当前任务：写周报'),
    // 读不到就抛错：这一次跳过它，记一条告警
    defineSource('todo', async ({ signal }) => `待办：${await readFile('todo.txt', { encoding: 'utf8', signal })}`),
  ],
});

// 指令后面跟着事实：「你是桌宠。\n\n当前任务：写周报\n待办：…」
await context.generate({ instructions: '你是桌宠。', input: '在吗？' });

// 事实放进最后一条临时用户消息；指令里没有事实，prompt 不写日志
const { text } = await context.generate({
  instructions: '只说一句碎碎念。',
  prompt: (facts) => `${renderFacts(facts)}\n请再说一句碎碎念。`,
  record: false,
});
console.log(text);
```

`generate` 和 `stream` 用 AI SDK v7 的 `instructions` 传系统指令、`messages` 传历史，其余设置对应如下：

| `GenerateOptions`                                                                                             | AI SDK                                                     |
| ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `model`                                                                                                       | `model`。缺省用 `createContext` 的 `model`，都没有就报错   |
| `maxSteps`                                                                                                    | `stopWhen: stepCountIs(n)`。缺省有工具 5 步，没有工具 1 步 |
| `timeoutMs`                                                                                                   | `timeout`（整次调用，含工具步骤）                          |
| `signal`                                                                                                      | `abortSignal`                                              |
| `temperature`、`maxOutputTokens`、`topP`、`seed`、`stopSequences`、`maxRetries`、`headers`、`providerOptions` | 同名                                                       |

### 记录

| 情况     | `record: true`（缺省）                                                       | `record: false`                                            |
| -------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `input`  | 调用模型之前写入日志，组装时已经在视图里；`inputKey` 是它的幂等键            | 只放进这一次的消息                                         |
| 模型产出 | `responseMessages` 全部写入：助手消息、工具调用和工具结果，`source: 'model'` | 不写。从 `result.messages` 拿，由应用决定什么时候 `append` |
| 模型报错 | `input` 已经在日志里，没有回复；用同一个 `inputKey` 重试，这句不会再记一遍   | 日志不变                                                   |
| 没有模型 | 直接报错，什么都不写                                                         | 直接报错                                                   |

- `generate` 返回 `{ text, messages, recorded, raw }`：`recorded` 是这次真正写进日志的条目，`raw` 是 `generateText` 的原始结果。
- `await context.stream()` 得到 `{ result, recorded }`。`result` 是 AI SDK 的 `StreamTextResult`；`recorded` 在回复写进日志以后给出这次写入的全部条目（含先写的用户这句）：流出错或中止时只有用户这句，`record: false` 时是 `[]`，只在写日志失败时 reject（同时告警）。读 `recorded` 和读 `result.text` 一样会让流跑完。
- 流出错时调 `onError`；没给 `onError`、上下文也没配 `logger` 时沿用 AI SDK 的缺省处理（`console.error`），配了 `logger` 就记一条告警。
- `prompt` 和事实从不写日志。
- `createContext({ source })`：经这个上下文追加、又没写 `source` 的条目（包括自动记录的 `input`）记成它。

副作用必须先成功的场景用 `record: false`，成功以后再自己追加：

```ts
import { createContext, createMemoryStore, eventEntry, type LanguageModel } from '@modelctx-ai/ctx';

declare const model: LanguageModel;
declare function speak(text: string): Promise<void>; // 应用自己的副作用：合成语音、投喂给桌宠

const context = createContext({ store: createMemoryStore(), thread: 'pet:main', model });

const { text } = await context.generate({ instructions: '只说一句。', prompt: '请说一句碎碎念。', record: false });
await speak(text); // 失败就抛出，日志里不会多出一句没说出口的话
await context.append(eventEntry('whisper', { text }));
```

## 压缩

`compact(options)` 把较早的历史压成一条摘要条目，原条目保留：

1. 取完整视图（不裁剪）：当前摘要 + 之后的消息。
2. 最近 `keep`（缺省 12）条原样保留。切点往前挪，保留的部分不以工具结果开头。
3. 切点之前没有消息，或者不到 `minimum`（缺省 8）条，就不压缩、不调模型，返回 `null`。
4. 把旧摘要和切点之前的消息转成纯文本记录（图片、文件只写占位，例如 `[image image/png]`，不带数据），用 `instructions`（缺省是内置的压缩指令）、`temperature: 0`、`maxOutputTokens`（缺省 1024）调一次模型。`model` 缺省用上下文的模型。
5. 摘要被 `maxOutputTokens` 截断（`finishReason` 是 `length`）时不写，告警并返回 `null`；否则追加一条 `summary`，`covers` 是最后一条被压缩消息的 `upTo`。

新摘要已经包含旧摘要，所以只有最新的一条生效；之后 `view()` 从它读起。什么时候压缩由应用决定（例如定时、超过阈值），ctx 不自动压缩。

窗口和压缩的区别：窗口只影响这一次交给模型的内容，什么都不写；压缩写下一个检查点，以后每次投影都从它开始，被压缩的原条目仍在日志里。

## 上下文来源

- 每次 `prepare`、`generate`、`stream`（以及 `facts()`）都重新收集，来源之间并行，结果按来源列表的顺序排。
- 返回 `null`、空串或只有空白的来源跳过；文字去掉前后空白。
- 单个来源出错或超时（缺省 2 秒，`createContext({ sourceTimeoutMs })` 可改）只影响它自己，记一条告警。
- `collect` 拿到 `{ thread, signal }`，`signal` 来自这次调用的 `signal`。
- 事实不写日志。它们描述的是“现在”：当前任务、粘贴板、天气，写进历史下一轮就过期了。

## 工具与 MCP

```ts
import { createContext, createMemoryStore, createToolRegistry, tool, type LanguageModel } from '@modelctx-ai/ctx';
import { createMcpHub } from '@modelctx-ai/ctx-mcp';
import { z } from 'zod';

declare const model: LanguageModel;

const registry = createToolRegistry().add(
  'remember',
  tool({
    description: '记一条备忘',
    inputSchema: z.object({ text: z.string() }),
    execute: async ({ text }) => ({ saved: text }),
  }),
  { tags: ['memo'] },
);

const hub = createMcpHub({
  notes: { command: 'node', args: ['./mcp/notes-server.js'], include: ['search_notes'] },
  docs: { url: 'https://mcp.example.com/mcp', headers: { authorization: `Bearer ${process.env.DOCS_TOKEN}` } },
});
await hub.connect(); // 单个服务器失败只记在 hub.status() 里
hub.registerInto(registry); // notes__search_notes、docs__…，来源 mcp:notes、mcp:docs

const context = createContext({ store: createMemoryStore(), thread: 'user:42', model, tools: registry });
await context.generate({ input: '我之前记过周报的事吗？', tools: (info) => info.source.startsWith('mcp:') });
await context.generate({ input: '记一下：周五交周报', tools: ['remember'] });
await hub.close();
```

| 调用时的 `tools`    | 交给模型的工具                          |
| ------------------- | --------------------------------------- |
| 不给或 `true`       | 注册表里全部                            |
| `false`             | 不给                                    |
| 名字列表            | 按名字挑，不存在的名字忽略              |
| `(info) => boolean` | 按 `ToolInfo { name, source, tags }` 筛 |

- 工具名只能是 `[a-zA-Z0-9_-]`，最长 64（各家接口的共同限制）。重名报错，`{ replace: true }` 覆盖。`source` 缺省 `local`，`removeSource(source)` 整批移除。
- `createMcpHub(servers)` 收常见的 `mcpServers` 写法：有 `command` 走 stdio（`env` 只写额外的变量，`PATH`、`HOME` 等自动带上），有 `url` 走 Streamable HTTP，`type: 'sse'` 走 SSE。
- `connect()` 并行连接，从不因为单个服务器抛错：失败记为 `failed` 和错误信息，`enabled: false` 记为 `disabled`；`status()` 按配置顺序。再调一次 `connect()` 会重试没连上的，已连上的不动。
- 每台服务器连接加列工具最多等 `timeoutMs`：服务器配置里的优先，其次 hub 的，缺省 15 秒；`0` 或 `Infinity` 不限时。超时记为失败。连上以后任何一步失败都关掉连接，stdio 服务器的进程跟着结束。
- 工具名缺省加服务器前缀 `<server>__<tool>`，非法字符换成 `_`，截到 64；`namespace: false` 保留原名。`include`、`exclude` 用服务器上的原名。改名后重名的按配置顺序留第一个，后面的原名记进那台服务器状态的 `skipped`。
- `registerInto(registry)` 写进注册表，来源 `mcp:<server>`；重复调用先删掉这个 hub 之前写的工具再写。注册表里已有别的来源的同名工具时不替换，跳过并告警；返回实际写入的条数。
- `close()` 断开全部连接、清空状态，并从写过的每个注册表里删掉这些工具。
- MCP 工具和本地工具一样走 AI SDK 的多步工具循环，调用和结果作为消息写进日志。

## 网关

ctx-gateway 给只会说 OpenAI Chat Completions、又自己截断历史的客户端用（例如 dsh-pet 的右键对话）：

```mermaid
sequenceDiagram
  participant Client as 客户端
  participant GW as ctx-gateway
  participant Ctx as Context
  participant Up as 上游
  Client->>GW: POST /v1/chat/completions（本机令牌、截断的历史、这一句）
  GW->>Ctx: view()
  Ctx-->>GW: 完整上下文
  Note over GW: 保留调用方的 system，<br/>历史换成完整上下文，<br/>接上从这一句起的尾巴
  GW->>Up: POST /chat/completions（真密钥）
  Up-->>GW: SSE
  GW-->>Client: SSE，边收边转
```

按顺序检查：

| 请求                                                                                        | 处理                                                                          |
| ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `Host` 不在 `allowedHosts` 里                                                               | 403                                                                           |
| 带 `Origin` 头，又不在 `allowedOrigins` 里（缺省一个都不放）                                | 403                                                                           |
| 路径不在 `basePath`（缺省 `/v1`；`''` 或 `/` 挂在根上）下                                   | 404                                                                           |
| 设了 `accessToken`，`Authorization: Bearer` 没带或不对（`Bearer` 不分大小写，常量时间比较） | 401                                                                           |
| 请求体超过 `maxBodyBytes`（缺省 4 MiB）                                                     | 413                                                                           |
| `POST <basePath>/chat/completions`，设了 `rewrite`                                          | 请求体不是 JSON，或不是带 `messages` 数组的对象：400；否则 `rewrite` 以后转发 |
| 其他                                                                                        | 原样转发：方法、路径、查询串、请求体                                          |
| 上游连不上                                                                                  | 502                                                                           |

- `startGateway` 缺省只认监听地址的 `Host`（`host:port`，不分大小写），挡 DNS rebinding；监听本机时 `localhost`、`127.0.0.1`、`[::1]` 加端口都认。`createGatewayHandler` 不知道端口，没给 `allowedHosts` 就不查 `Host`，`Origin` 照查。浏览器网页发来的请求带 `Origin`，缺省一律拒绝。
- 只转发调用方的 `content-type`、`accept`，加上 `upstream.headers`；有 `upstream.apiKey` 时设 `Authorization: Bearer <apiKey>`。调用方的令牌不会到上游，上游的密钥不会到调用方。
- 响应的状态码和头原样转回（去掉逐跳头和 `content-encoding`、`content-length`），正文边收边转，SSE 不缓冲。调用方中途断开时取消上游请求，不算出错。
- 错误正文是 OpenAI 的形状：`{ "error": { "message", "type" } }`，`type` 是 `authentication_error`（401）、`permission_error`（403）或 `gateway_error`。
- 缺省只听 `127.0.0.1`、随机端口。`createGatewayHandler(options)` 返回 `(req, res) => Promise<void>`，可以挂到已有的 HTTP 服务上。

`replaceHistory(history, { keepSystem })` 生成改写函数：保留调用方的 `system` / `developer` 消息（`keepSystem: false` 时去掉），中间换成 `toChatMessages(await history())`（去掉其中的 `system`），再接上调用方从最后一句用户话起的尾巴：这句话，以及它之后的工具调用、工具结果和预填的助手话。完整历史的最后一条和这句用户话内容完全相同（图片也比）时，这句不重复带。`withContext(context)` 就是 `replaceHistory(async () => (await context.view()).messages)`。

网关只读上下文，不写日志。调用方自己保存的问答要另外并进上下文，例如 yoyo 每拍把 dsh-pet 的对话记忆按幂等键导入（见 [ADR 0003](adr/0003-context-model.md)）。

`toChatMessages()` 的转换：

| AI SDK                                | OpenAI Chat Completions                                                                                                                                                                            |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `system`                              | `system`                                                                                                                                                                                           |
| `user` 文字                           | `text` 段（纯字符串保持字符串）                                                                                                                                                                    |
| `user` 图片、`image` / `image/*` 文件 | `image_url`：URL 原样；base64 和二进制转 data URL（类型只写到 `image` 或带 `*` 时用 `image/png`）。AI SDK v7 带标签的 `{ type: 'data' }`、`{ type: 'url' }` 也认；服务商侧的文件引用和其他分段丢掉 |
| `assistant` 文字、工具调用            | `content` + `tool_calls`（`arguments` 是 JSON 字符串）；只有工具调用时 `content: null`。推理和服务商执行的工具调用丢掉，什么都不剩的消息整条丢掉                                                   |
| `tool` 工具结果                       | 每个结果一条 `{ role: 'tool', tool_call_id, content }`：文字原样，JSON 序列化，拒绝执行写明原因                                                                                                    |

## 错误和日志

- `describeError(error, { secrets, max })` 给日志和界面用：重试错误取最后一次；接口错误带 `status` 和截短的响应正文 `detail`；`secrets` 里的密钥换成 `***`，空白合并，截到 `max`（缺省 180）字。
- `redact(text, secrets)` 单独做去密钥。
- 框架只通过 `Logger { warn, debug? }` 出声，缺省静默（`silentLogger`）。`createContext`、`createMcpHub` 都接受 `logger`。

## 扩展点

| 扩展点                 | 接口                | 做法                                                                                                     |
| ---------------------- | ------------------- | -------------------------------------------------------------------------------------------------------- |
| 存储                   | `ContextStore`      | 实现四个方法，跑 `describeStoreContract`                                                                 |
| 模型服务商             | `ModelFactory`      | `createModelRegistry().register(name, factory)`；或者直接给 `createContext` 任何 AI SDK `LanguageModel`  |
| 事件渲染               | `EventRule`         | `projection.events[kind]`                                                                                |
| 摘要、消息、token 估算 | `ProjectionOptions` | `summary`、`message`、`window.estimate`                                                                  |
| 上下文来源             | `ContextSource`     | `defineSource(name, collect)`                                                                            |
| 工具                   | AI SDK `Tool`       | `registry.add(name, tool(...), { source, tags })`                                                        |
| MCP 连接               | `McpConnector`      | `createMcpHub(servers, { connector })`；连接器收到 `{ signal }`，超时或 `close()` 时中止。测试时换成假的 |
| 网关改写               | `Rewrite`           | `(request) => request`，转发前任意改写                                                                   |
| 日志                   | `Logger`            | `{ warn, debug? }`                                                                                       |

### 自定义存储

实现 `ContextStore`，再用核心包的契约测试验证行为和内置存储一致。工厂要用传进来的 `now` 作为缺省的 `at`。

```ts
// pg-store.test.ts。describe、test 从你用的测试框架取：vitest、node:test、Jest、Bun 都行
import { describe, test } from 'vitest';

import { describeStoreContract } from '@modelctx-ai/ctx/testing';

import { createPgStore } from './pg-store.ts';

describeStoreContract('pg', ({ now }) => createPgStore({ url: 'postgres://localhost/ctx_test', now }), {
  describe,
  test,
});
```

| 用例         | 要求                                                                                                                                                   |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 排序         | 按 `(at, seq)`；带旧 `at` 导入的条目排回原来的位置                                                                                                     |
| 同一时刻     | 按写入先后                                                                                                                                             |
| 去重         | 同线程重复的 `key`、全局重复的 `id` 跳过，只返回真正写入的；键按线程隔离                                                                               |
| 查询         | `after`、`last`、`types` 可以组合；`last` 向下取整，`0`、负数、`NaN`、`Infinity` 返回空                                                                |
| 往返         | 消息分段（含工具调用的对象入参、图片 `URL`）、事件 `data`、摘要 `covers`、`source`、`meta` 原样读回；`seq` 递增                                        |
| 二进制和 URL | `Buffer`、`ArrayBuffer`、带标签的 `{ type: 'data' }` 读回来字节不变（容器可以换成 `Uint8Array`）；`URL`（包括 `{ type: 'url' }` 里的）读回来还是 `URL` |
| 像标记的数据 | 事件 `data` 里 `{ $url }`、`{ $bytes }` 这类普通对象原样读回                                                                                           |
| 线程         | `clear` 返回删掉的条数；`threads()` 只列有内容的线程                                                                                                   |

### 模型服务商

```ts
import { createOpenAI } from '@ai-sdk/openai';
import { createModelRegistry } from '@modelctx-ai/ctx-models';

const models = createModelRegistry().register('openai', (spec) =>
  createOpenAI({ apiKey: spec.apiKey, baseURL: spec.baseUrl })(spec.model),
);

const model = models.create({ provider: 'openai', model: 'gpt-5-mini', apiKey: process.env.OPENAI_API_KEY });
console.log(models.providers()); // ['openai-compatible', 'anthropic', 'openai']
```

### 事件规则和渲染

```ts
import type { ProjectionOptions } from '@modelctx-ai/ctx';

export const projection: ProjectionOptions = {
  events: {
    // 连续的碎碎念合成一条助手消息
    whisper: {
      fold: true,
      render: (events) => ({ role: 'assistant', content: `碎碎念：\n${events.map((event) => event.text).join('\n')}` }),
    },
    // 每条提醒单独一条用户消息；返回 null 的不进上下文
    reminder: {
      render: ([event]) => (event?.text ? { role: 'user', content: `[提醒] ${event.text}` } : null),
    },
  },
  // 渲染成 system 时，调用会把它从消息里拿出来，接到指令后面
  summary: (entry) => ({ role: 'system', content: `前情提要：\n${entry.text}` }),
  window: { maxTokens: 16_000 },
};
```

## 设计约束

| 约束                             | 落在哪                                                                                                                                                                                                                  |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 核心包只依赖 `ai`                | `@modelctx-ai/ctx` 的 dependencies 只有 `ai`（`zod` 是 `ai` 要的 peer）。主入口不用 `node:` 模块，只用 `crypto.randomUUID`、`setTimeout`、`AbortSignal` 这类标准全局对象                                                |
| Node 专属的东西放在适配包        | `node:sqlite` 在 ctx-sqlite；`node:http`、`node:crypto`、`node:stream` 在 ctx-gateway；stdio 子进程在 ctx-mcp；`node:assert` 在 `@modelctx-ai/ctx/testing` 子路径（测试框架由调用方传入）                               |
| 适配包把核心包当 peer dependency | ctx-sqlite、ctx-mcp、ctx-gateway 的 `peerDependencies` 是 `@modelctx-ai/ctx`；ctx-models 不依赖核心包，把 `ai` 当 peer。应用里只有一份核心包、一份 `ai`，`ContextStore`、`ToolRegistry`、`LanguageModel` 都是同一个类型 |
| AI SDK 的工具函数从核心包拿      | `tool`、`dynamicTool`、`jsonSchema`、`zodSchema`、`stepCountIs` 和 `ModelMessage`、`LanguageModel`、`ToolSet` 等类型从 `@modelctx-ai/ctx` 转出，应用不用单独依赖 `ai`                                                   |
| 只追加                           | 条目写入后不改；压缩是追加摘要；只有 `clear(thread)` 删除                                                                                                                                                               |
| 存储和渲染分开                   | 存储只存原始条目，怎么交给模型由投影决定；改规则不用迁移数据，对旧条目同样生效                                                                                                                                          |
| 局部失败不打断调用               | 来源出错或超时跳过；MCP 服务器连不上或超时只记状态；流式回复写日志失败只告警（`recorded` reject）                                                                                                                       |
| 函数加接口                       | 公开 API 是函数（`createX()` / `startX()` 工厂和 `project()` 这类纯函数）和接口，没有要继承或 `new` 的类                                                                                                                |
