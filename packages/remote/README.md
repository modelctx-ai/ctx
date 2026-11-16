# @modelctx-ai/ctx-remote

把 ctx 的协议搬到 HTTP 上：会话存储、执行环境、harness、编排器、记忆存储都能放到进程边界的另一侧。服务端把进程内的协议对象挂成 HTTP 路径，客户端把这些路径还原成协议的接口。两头都只认协议：服务端挂的可以是核心包、`ctx-sqlite`、`ctx-exec` 或你自己的实现，客户端拿到的就是 `SessionStore`、`Executor`、`Harness`、`Orchestrator`、`MemoryStore`，交给任何认协议的代码用。只依赖 `@modelctx-ai/ctx-protocol`。

| 入口                             | 内容                                                                                                                                     | 运行环境                                                                       |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `@modelctx-ai/ctx-remote`        | 客户端：`createRemoteSessionStore`、`createRemoteExecutor`、`createRemoteHarness`、`createRemoteOrchestrator`、`createRemoteMemoryStore` | 任何有 `fetch` 的运行时（Node、Deno、Bun、浏览器、Workers），不用 `node:` 模块 |
| `@modelctx-ai/ctx-remote/server` | 服务端：`createRemoteHandler`、`startRemote`                                                                                             | Node ≥22（`node:http`）                                                        |

## 安装

```sh
pnpm add @modelctx-ai/ctx-remote @modelctx-ai/ctx-protocol
```

下面的例子另外用到核心包 `@modelctx-ai/ctx` 和 `@modelctx-ai/ctx-exec`。

## 服务端

给了哪些组件就挂哪些路径，其余 404。缺省只听 `127.0.0.1` 的随机端口。

```ts
import { randomBytes } from 'node:crypto';

import { createProcessExecutor } from '@modelctx-ai/ctx-exec';
import { startRemote } from '@modelctx-ai/ctx-remote/server';
import { createSqliteStore } from '@modelctx-ai/ctx-sqlite';

const accessToken = randomBytes(24).toString('base64url');

// 例如放在容器里：一个执行环境，一个会话存储
const server = await startRemote({
  executors: [createProcessExecutor({ name: 'sandbox', cwd: '/workspace' })],
  store: createSqliteStore({ path: '/data/ctx.db' }),
  accessToken,
  host: '0.0.0.0', // 容器里要对外听；这时不给 accessToken 会拒绝启动
  port: 8080,
  allowedHosts: ['10.0.0.2:8080'], // 客户端连的地址；监听 0.0.0.0 时缺省只认本机的几种写法
});
console.log(server.baseUrl);
```

harness 服务：`agent.model` 跨边界只能是名字，由服务端的 harness 自己造模型。

```ts
import { createContextBuilder, createHarness, createOrchestrator, createToolRegistry } from '@modelctx-ai/ctx';
import { createModel } from '@modelctx-ai/ctx-models';
import { createRemoteExecutor, createRemoteSessionStore } from '@modelctx-ai/ctx-remote';
import { startRemote } from '@modelctx-ai/ctx-remote/server';

const store = createRemoteSessionStore({ baseUrl: 'http://10.0.0.2:8080', accessToken });
const sandbox = createRemoteExecutor({ baseUrl: 'http://10.0.0.2:8080', accessToken, name: 'sandbox' });
const tools = createToolRegistry();
for (const definition of await sandbox.tools()) tools.add(definition);

const harness = createHarness({
  store,
  context: createContextBuilder({ store }),
  tools,
  executors: [sandbox],
  models: (name) =>
    createModel({ baseUrl: 'https://api.deepseek.com/v1', apiKey: process.env.DEEPSEEK_API_KEY, model: name }),
});
await startRemote({ harness, orchestrator: createOrchestrator({ harness, store }), accessToken });
```

挂到已有的 HTTP 服务上：`createRemoteHandler(options)` 返回 `(req, res) => Promise<void>`。它不知道监听的端口，要自己给 `allowedHosts`：

```ts
import { createServer } from 'node:http';

import { createRemoteHandler } from '@modelctx-ai/ctx-remote/server';

const handler = createRemoteHandler({ store, basePath: '/ctx', accessToken, allowedHosts: ['127.0.0.1:3000'] });
createServer((req, res) => {
  if (req.url?.startsWith('/ctx/')) void handler(req, res);
  else res.writeHead(404).end();
}).listen(3000, '127.0.0.1');
```

### 选项

| 选项                   | 缺省                       | 说明                                                                                                                                                                     |
| ---------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `store`                | —                          | `SessionStore`，挂在 `/sessions`                                                                                                                                         |
| `executors`            | —                          | `Executor[]` 或 `{ 名字: Executor }`，挂在 `/executors/:name`                                                                                                            |
| `harness`              | —                          | `Harness`，挂在 `/runs`                                                                                                                                                  |
| `orchestrator`         | —                          | `Orchestrator`，挂在 `/orchestrator`                                                                                                                                     |
| `memory`               | —                          | `MemoryStore`，挂在 `/memory`（见「记忆」）                                                                                                                              |
| `allowedModels`        | 不限                       | `/runs` 和 `/orchestrator/runs` 只收这些模型名，别的 400。模型名是调用方写的、密钥是服务端的，对外的服务该列出来                                                         |
| `allowedSettings`      | `DEFAULT_ALLOWED_SETTINGS` | 调用方的 `agent.settings` 里收哪些键，别的 400。缺省是采样参数、`maxRetries`、`timeoutMs`，不含 `headers` 和 `providerOptions`（它们会原样进服务端发给模型服务商的请求） |
| `accessToken`          | —                          | 要求 `Authorization: Bearer <token>`，常量时间比较；方案名不分大小写。空串（或全是空白）抛错                                                                             |
| `authenticate`         | —                          | `(request) => Principal \| undefined`（可以是 `Promise`）：把请求映射到主体，`undefined` 回 401。和 `accessToken` 二选一，两个都给时抛错。见「主体」                     |
| `allowUnauthenticated` | `false`                    | 只有 `startRemote` 看它：`host` 不是本机地址又没有 `accessToken` 或 `authenticate` 时拒绝启动，除非写 `true`                                                             |
| `allowedHosts`         | 监听地址                   | 只接受这些 `Host`（`host:port`），挡 DNS rebinding。`startRemote` 监听本机时认 `localhost`、`127.0.0.1`、`[::1]`；`createRemoteHandler` 不给就不查                       |
| `allowedOrigins`       | 无                         | 带 `Origin` 的请求只放行这些来源；缺省浏览器网页发来的请求一律 403                                                                                                       |
| `maxBodyBytes`         | 4 MiB                      | 请求体上限，超过 413                                                                                                                                                     |
| `basePath`             | `''`                       | 路径前缀                                                                                                                                                                 |
| `maxListEntries`       | 1000                       | `GET …/entries` 一次最多回多少条；更长时响应带 `more: true`，本包的客户端自己接着读                                                                                      |
| `pollIntervalMs`       | 250                        | 存储没有 `watch` 时，`entries/stream` 轮询 `list(after)` 的间隔                                                                                                          |
| `retainResultsMs`      | 10 分钟                    | 经这个服务提交给编排器的运行，结束后结果在内存里留多久（最多 1000 个）。过了这段时间或者服务重启过，挂着 `store` 时从会话日志的 `ctx.run.ended` 还原                     |
| `heartbeatMs`          | 15 秒                      | 没有数据可发时隔多久发一次心跳，0 是不发。见「长请求和断线」                                                                                                             |
| `maxRuns`              | 32                         | `POST /runs` 同时跑的上限，满了 429                                                                                                                                      |
| `maxExecutions`        | 64                         | `POST /executors/:name/execute` 同时跑的上限，满了 429                                                                                                                   |
| `maxStreams`           | 256                        | 同时开着的 `entries/stream` 和 `orchestrator/events` 流的上限，满了 429                                                                                                  |
| `logger`               | 不出声                     | 协议的 `Logger`。内部出的错在这里 `warn`，带着回给调用方的那个编号（`ref`）                                                                                              |
| `host`、`port`         | `127.0.0.1`、`0`           | 只有 `startRemote`：监听地址；返回 `{ origin, baseUrl, close }`，`close` 断开所有连接、不关组件                                                                          |

## 客户端

```ts
import {
  createRemoteExecutor,
  createRemoteHarness,
  createRemoteOrchestrator,
  createRemoteSessionStore,
} from '@modelctx-ai/ctx-remote';

const remote = { baseUrl: 'http://127.0.0.1:53001', accessToken };

const store = createRemoteSessionStore(remote); // SessionStore，含 watch
for await (const entry of store.watch('user:42', { signal: AbortSignal.timeout(60_000) })) console.log(entry.type);

const harness = createRemoteHarness(remote); // Harness，含 stream
const result = await harness.run({ session: 'user:42', agent: { model: 'deepseek-chat' }, input: '在吗' });
for await (const event of harness.stream({
  session: 'user:42',
  agent: { model: 'deepseek-chat' },
  input: '再说一遍',
})) {
  if (event.type === 'text.delta') process.stdout.write(event.text);
}

const orchestrator = createRemoteOrchestrator(remote); // Orchestrator，含 recover、events
const handle = await orchestrator.submit({ session: 'user:42', agent: { model: 'deepseek-chat' }, input: '总结一下' });
console.log((await handle.done).text);
await orchestrator.close(); // 只关这个客户端
```

| 工厂                                                                                         | 行为                                                                                                                                                                                                                                                                                                                                                                                                  |
| -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createRemoteSessionStore({ baseUrl, accessToken?, fetch?, headers?, retry?, unreadable? })` | `SessionStore`。`watch` 读 NDJSON 流，连接断了按最后读到的 `seq` 重连，`signal` 中止后迭代正常结束；服务端的存储没有 `watch` 时由服务端轮询。`list` 自己翻页。`append` 发出前给没有 `id` 的条目补上，响应丢了重试不会记两遍。`clear`、`truncate`、`remove`、`redact` 原样转给服务端的存储，不自动重试。`unreadable` 见下                                                                              |
| `createRemoteExecutor({ …, name })`                                                          | `Executor`：`tools()`、`execute()`、`open()`、`close()`。连不上返回 `{ type: 'error', retryable: true }`，服务端拒绝（4xx/5xx）返回错误结果（5xx 和 429 可重试），都不抛；`signal` 中止时断开请求，服务端的执行跟着中止。`execute` 不自动重试：工具可能已经跑了                                                                                                                                       |
| `createRemoteHarness(…)`                                                                     | `Harness`：`run`、`stream`。`agent.model` 不是字符串就抛。`signal` 中止时发 `DELETE /runs/:runId`，`run` 照常返回 `stopReason: aborted`；`stream` 提前不读就断开连接，服务端同样中止并写 `ctx.run.ended`                                                                                                                                                                                              |
| `createRemoteOrchestrator({ …, waitMs? })`                                                   | `Orchestrator`：`submit`、`status`、`cancel`、`recover`、`events`、`close`。`done` 用长轮询 `GET /orchestrator/runs/:id?wait=&session=` 实现（每次最多等 `waitMs`，缺省 25 秒），连不上时按 `retry` 重试，服务重启后结果从会话日志还原（服务端要挂着 `store`）；`close` 只关这个客户端：不再提交、结束它的事件流、等它提交的运行结束。`events` 断了不重连（事件没有位置可以续接），要不漏就看会话日志 |

选项的类型是 `RemoteClientOptions`（`baseUrl`、`accessToken?`、`headers?`、`fetch?`、`retry?: RetryOptions`、`checkProtocol?`），会话存储是 `RemoteSessionStoreOptions`（多一个 `unreadable?`），记忆存储是 `RemoteMemoryStoreOptions`（多一个 `scope?`），执行环境是 `RemoteExecutorOptions`（多一个 `name`），编排器是 `RemoteOrchestratorOptions`（多一个 `waitMs?`）。

客户端第一次请求之前读一次 `GET /protocol`（`checkProtocolInfo`）：协议版本和这一端的 `PROTOCOL_VERSION` 不同、对方写的条目格式比这一端新，或者服务端没有这个入口（0.3 之前的版本、不是 ctx 的服务），都抛 `unsupported_version`，不发后面的请求。连不上不算版本不对，下一次请求再握手。对面是只实现了部分路径的服务时给 `checkProtocol: false`。

服务端返回的 `{ error }` 变成抛出的 `RemoteError`：一个 `Error`，带 `status`（HTTP 状态码）、`type`、`retryable?`、`statusCode?`、`responseBody?`（后两个是上游接口的状态码和响应正文，服务端有才带；`status` 仍是本次 HTTP 响应的）；`isRemoteError(error)` 判断。NDJSON 流中途出错时最后一行是 `{ error }`，客户端同样抛出。

### 长请求和断线

- **心跳**。服务端在没有数据可发时每 `heartbeatMs`（缺省 15 秒）发一次心跳：NDJSON 流里是一个空行；`POST /runs` 和 `execute` 等结果时先发 200 的响应头，再隔一段时间写一个换行，最后才是 JSON 正文。所以一轮跑多久、一个工具跑多久，连接都不会因为空闲被掐。
- **Node 的 `fetch` 有 300 秒的缺省超时**（undici 的 `headersTimeout` 和 `bodyTimeout`：等响应头、等下一块正文各 300 秒）。服务端开着心跳时碰不到它；`heartbeatMs: 0`、或者中间的代理把心跳吃掉时，超过 5 分钟的请求会以 `fetch failed` 断开，服务端随之中止那一轮。这时换一个不设超时的 `fetch`：

  ```ts
  import { Agent } from 'undici';

  const dispatcher = new Agent({ headersTimeout: 0, bodyTimeout: 0 });
  const harness = createRemoteHarness({
    baseUrl,
    accessToken,
    fetch: (input, init) => fetch(input, { ...init, dispatcher } as RequestInit),
  });
  ```

- **长任务走编排器，不走 `POST /runs`**。同步的 `POST /runs` 在客户端断开时会中止这一轮：跑几十分钟的任务过不了带空闲超时、又会吃掉心跳的代理。长任务用 `POST /orchestrator/runs` 提交，`done` 靠 `GET /orchestrator/runs/:id?wait=` 的长轮询拿结果，断了重连不影响服务端那一轮。
- **在内网的执行环境**。执行环境只能出站连接时，不要把它挂成服务端的 `executors`：让 harness 把它列进 `external`（[ADR 0008](../../docs/adr/0008-tool-calls-through-the-log.md)），内网的 worker 用 `createRemoteSessionStore` 连过来，`runPendingTools` 执行等待中的调用、把结果追加回会话。
- **重试**。`retry: { retries?, minDelayMs?, maxDelayMs? }`（缺省 4 次，200 毫秒起每次翻倍、带抖动，最多 5 秒）。连不上、连接中途断了、服务端回 429/502/503/504 时重试，只用在重试了也不会多做一遍的请求上：所有 `GET`、会话的 `append`、两个取消、`watch` 的重连、编排器的 `done`。提交运行、执行工具、记忆的写入不重试。
- **`append` 重试后的返回值**。第一次其实写成功、只是响应丢了的条目，重试时会被存储按 `id` 去重跳过；客户端从会话末尾（最近 200 条）把它们找回来放进返回值。带 `expectSeq` 的一批重试时得到的冲突，如果自己的条目已经在了，算成功，不抛 `conflict`。
- **比客户端新的条目**。服务端先升级、条目的 `v` 比这个客户端认识的高时，`list`、`watch`、`append` 的返回值缺省抛 `unsupported_version`；`unreadable: 'placeholder'` 时那一条换成 `ctx.unreadable` 事件，其余照常（见[协议层](../../docs/protocol.md#会话-sessionstore)）。

## 记忆

服务端给了 `memory`（任何 `MemoryStore`，例如 `@modelctx-ai/ctx-memory` 的 `createMemoryStore()`）就挂 `/memory/*`，没给就是 404。客户端 `createRemoteMemoryStore(options)` 返回 `MemoryStore`，选项和 `createRemoteSessionStore` 一样（`baseUrl`、`accessToken?`、`headers?`、`fetch?`）。

```ts
import { createMemoryStore } from '@modelctx-ai/ctx-memory';
import { createRemoteMemoryStore } from '@modelctx-ai/ctx-remote';
import { startRemote } from '@modelctx-ai/ctx-remote/server';

const server = await startRemote({ memory: createMemoryStore(), accessToken });

const memory = createRemoteMemoryStore({ baseUrl: server.baseUrl, accessToken }); // MemoryStore
const hits = await memory.facts.search({ text: '乌龙茶', k: 5 });
await memory.facts.touch(
  hits.map((hit) => hit.fact.id),
  Date.now(),
);
console.log((await memory.core.get())?.text);
```

作用域：客户端的 `scope(name)`（或者选项 `scope`）让之后的每个请求带上 `?scope=<name>`，服务端据此取 `memory.scope(name)`；不带就是缺省的作用域。作用域只是隔离，不是鉴权——拿到访问令牌的调用方可以用任何作用域，要按用户限制的话在前面放一层自己的服务。

```ts
const alice = createRemoteMemoryStore({ baseUrl: server.baseUrl, accessToken, scope: 'user:alice' });
const bob = alice.scope('user:bob'); // 同一个连接，另一个作用域
```

每个协议方法恰好一个端点。路径里的 `:id` 用 `encodeURIComponent` 转义；查询参数不给就不传给存储，布尔是 `true` / `false`，数字原样（`limit=1.9` 由存储向下取整）。

| 集合 | 协议方法    | HTTP                                                        | 请求体                                                    | 响应                            |
| ---- | ----------- | ----------------------------------------------------------- | --------------------------------------------------------- | ------------------------------- |
| 笔记 | `add`       | `POST /memory/notes`                                        | `{ notes: NewNote[] }`                                    | `{ notes: Note[] }`             |
|      | `list`      | `GET /memory/notes?session=&pending=&failed=&since=&limit=` | —                                                         | `{ notes: Note[] }`             |
|      | `settle`    | `POST /memory/notes/settle`                                 | `{ ids: string[], at }`                                   | `{ settled: number }`           |
|      | `fail`      | `POST /memory/notes/fail`                                   | `{ ids: string[], at, error, maxAttempts }`               | `{ notes: Note[] }`             |
|      | `retry`     | `POST /memory/notes/retry`                                  | `{ ids: string[] }`                                       | `{ retried: number }`           |
|      | `forget`    | `POST /memory/notes/forget`                                 | `{ session? }`                                            | `{ forgotten: number }`         |
|      | `head`      | `GET /memory/notes/head?session=`（必填）                   | —                                                         | `{ head: number }`              |
| 事实 | `add`       | `POST /memory/facts`                                        | `{ fact: NewMemoryFact }`                                 | `{ fact: MemoryFact }`          |
|      | `list`      | `GET /memory/facts?subject=&topic=&open=&after=&limit=`     | —                                                         | `{ facts: MemoryFact[] }`       |
|      | `search`    | `POST /memory/facts/search`                                 | `SearchQuery`（`{ text, topic?, k?, open?, archived? }`） | `{ hits: FactHit[] }`           |
|      | `supersede` | `POST /memory/facts/:id/supersede`                          | `{ fact: NewMemoryFact, at }`                             | `{ fact: MemoryFact }`          |
|      | `close`     | `POST /memory/facts/:id/close`                              | `{ at, supersededBy? }`                                   | `{}`                            |
|      | `cite`      | `POST /memory/facts/:id/cite`                               | `{ sources: SourceRef[] }`                                | `{ fact: MemoryFact }`          |
|      | `touch`     | `POST /memory/facts/touch`                                  | `{ ids: string[], at }`                                   | `{}`                            |
|      | `archive`   | `POST /memory/facts/archive`                                | `{ ids: string[], at }`                                   | `{ archived: number }`          |
|      | `restore`   | `POST /memory/facts/restore`                                | `{ ids: string[] }`                                       | `{ restored: number }`          |
|      | `reopen`    | `POST /memory/facts/reopen`                                 | `{ ids: string[] }`                                       | `{ reopened: number }`          |
|      | `forget`    | `POST /memory/facts/forget`                                 | `{ ids: string[] }`                                       | `{ forgotten: number }`         |
| 程序 | `add`       | `POST /memory/procedures`                                   | `{ procedure: NewProcedure }`                             | `{ procedure: Procedure }`      |
|      | `list`      | `GET /memory/procedures?topic=&active=`                     | —                                                         | `{ procedures: Procedure[] }`   |
|      | `confirm`   | `POST /memory/procedures/:id/confirm`                       | `{ evidence: SourceRef[] }`                               | `{ procedure: Procedure }`      |
|      | `retire`    | `POST /memory/procedures/:id/retire`                        | `{ at }`                                                  | `{}`                            |
|      | `forget`    | `POST /memory/procedures/forget`                            | `{ ids: string[] }`                                       | `{ forgotten: number }`         |
| 画像 | `get`       | `GET /memory/core`                                          | —                                                         | `{ core: CoreVersion \| null }` |
|      | `set`       | `PUT /memory/core`                                          | `{ text, at }`                                            | `{}`                            |
|      | `history`   | `GET /memory/core/history?last=`                            | —                                                         | `{ versions: CoreVersion[] }`   |
|      | `clear`     | `DELETE /memory/core`                                       | —                                                         | `{ cleared: number }`           |

错误：存储抛的 `CtxError` 按 `type` 映射状态码，正文的 `type` 原样保留：`invalid_request` 400、`not_found` 404、`conflict` 409。服务端自己查出的输入不对（缺字段、`limit` 不是数、`pending` 不是 `true` / `false`、`head` 没给 `session`）也是 400 `invalid_request`。客户端把这三种 `type` 转回同 `type` 的 `CtxError`（批量方法照协议跳过认不得的 `id`，不报错）；别的错误照常是 `RemoteError`，例如服务端没挂记忆是 404 `not_found_error`、方法不对是 405 `method_not_allowed`，调用方据此区分「这个 `id` 不存在」和「这个服务没有记忆」。

## 线上形态

JSON 请求和响应，流式用 NDJSON（`application/x-ndjson`，每行一个值）。路径里的会话名、执行环境名、`runId` 用 `encodeURIComponent` 转义。会话名是空串、`.`、`..` 时客户端不发请求，直接抛 `invalid_request`（这三种放不进一段路径）。

| 组件     | 协议方法         | HTTP                                                                              | 请求体                                             | 响应                                                              |
| -------- | ---------------- | --------------------------------------------------------------------------------- | -------------------------------------------------- | ----------------------------------------------------------------- |
| 发现     | （握手）         | `GET /protocol`                                                                   | —                                                  | `ProtocolInfo`：`{ protocol, entryVersion, components }`          |
|          | （JSON Schema）  | `GET /protocol/schema`                                                            | —                                                  | `PROTOCOL_SCHEMA`                                                 |
|          | （OpenAPI）      | `GET /protocol/openapi`                                                           | —                                                  | `openApiDocument()`                                               |
| 会话     | `append`         | `POST /sessions/:session/entries`                                                 | `{ entries: NewEntry[], expectSeq? }`              | `{ entries: Entry[] }`                                            |
|          | `list`           | `GET /sessions/:session/entries?after=&last=&limit=&types=a,b&kinds=x,y&atAfter=` | —                                                  | `{ entries: Entry[], more?: true }`，一次最多 `maxListEntries` 条 |
|          | `watch`          | `GET /sessions/:session/entries/stream?after=`                                    | —                                                  | NDJSON，每行一个 `Entry`                                          |
|          | `clear`          | `DELETE /sessions/:session`                                                       | —                                                  | `{ deleted: number }`                                             |
|          | `truncate`       | `POST /sessions/:session/entries/truncate`                                        | `{ upTo: number }`                                 | `{ deleted: number }`                                             |
|          | `remove`         | `POST /sessions/:session/entries/remove`                                          | `{ ids: string[] }`                                | `{ removed: number }`                                             |
|          | `redact`         | `POST /sessions/:session/entries/redact`                                          | `{ ids: string[] }`                                | `{ redacted: number }`                                            |
|          | `sessions`       | `GET /sessions?prefix=&after=&limit=`                                             | —                                                  | `{ sessions: string[] }`                                          |
| 执行环境 | （列出）         | `GET /executors`                                                                  | —                                                  | `{ executors: string[] }`                                         |
|          | `tools`          | `GET /executors/:name/tools`                                                      | —                                                  | `{ tools: ToolDefinition[] }`                                     |
|          | `execute`        | `POST /executors/:name/execute`                                                   | `{ call: ToolCall, context: { session, runId? } }` | `{ output: ToolOutput }`                                          |
|          | `open`           | `POST /executors/:name/sessions/:session/open`                                    | `{ environment?: EnvironmentSpec }`                | `{}`；执行环境没有 `open` 时什么都不做                            |
|          | `close`          | `DELETE /executors/:name/sessions/:session`                                       | —                                                  | `{}`                                                              |
| Harness  | `run`            | `POST /runs`                                                                      | `RunRequest` 去掉 `signal`，可加 `aborted: true`   | `RunResult`                                                       |
|          | `stream`         | `POST /runs?stream=1`                                                             | 同上                                               | NDJSON，每行一个 `RunEvent`                                       |
|          | （`signal`）     | `DELETE /runs/:runId`                                                             | —                                                  | `{ cancelled: boolean }`                                          |
| 编排     | `submit`         | `POST /orchestrator/runs`                                                         | 同 `POST /runs`                                    | `{ runId, session }`                                              |
|          | `status`、`done` | `GET /orchestrator/runs/:runId?wait=<ms>&session=`                                | —                                                  | `{ runId, status, session?, result?, error? }`，不认识的 404      |
|          | `cancel`         | `DELETE /orchestrator/runs/:runId`                                                | —                                                  | `{ cancelled: boolean }`                                          |
|          | `recover`        | `POST /orchestrator/recover`                                                      | —                                                  | `{ recovered: RecoveredRun[] }`                                   |
|          | `events`         | `GET /orchestrator/events`                                                        | —                                                  | NDJSON，每行一个 `OrchestratorEvent`                              |

- `GET /protocol` 的 `components` 只列挂了的组件：`sessions: { watch }`（服务端在存储没有 `watch` 时轮询，所以总是 `true`）、`executors: { names }`、`harness: { stream }`、`orchestrator: { recover, events }`、`memory: {}`。它和另外两个文档都要鉴权，不改任何状态。
- 形状的规范是 `GET /protocol/schema`（JSON Schema 2020-12，`$defs` 的名字和类型名一样），路径的规范是 `GET /protocol/openapi`（OpenAPI 3.1，引用同一批形状）。仓库根的 [`schema/`](../../schema) 有两份的副本；测试保证副本和代码一致、线上的真实值都合 schema、OpenAPI 列出的每条路径服务端都认。
- 消息是 ctx 的 JSON 格式（二进制是 base64 字符串），线上不做编码，`JSON.stringify`、`JSON.parse` 直接用。0.2 的编码（带 `\u0000ctx` 标记的对象）删掉了，所以客户端和服务端要一起升到 0.3；0.3 起两边先握手，版本不同直接报错。条目带 `v`，客户端读到比自己认识的更高的版本时抛 `unsupported_version`（或者按 `unreadable: 'placeholder'` 换成占位条目）。
- NDJSON 流里的空行是心跳，跳过。`POST /runs` 和 `POST /executors/:name/execute` 的 JSON 正文前面可能有换行（也是心跳）；这时状态码已经是 200，之后才出的错写成 `{ error, status }`，`status` 是本来该回的状态码。
- `list` 的响应带 `more: true` 时后面还有：用最后一条的 `seq` 当 `after` 接着读。`last` 是从末尾数的，只读一页。
- `append` 带 `expectSeq` 而前提不满足时，服务端回 409（`{ error: { type: 'conflict', retryable: true } }`），客户端转成协议的 `conflict`（`CtxError`，`isConflict(error)` 认得），调用方不必认识 HTTP。
- `truncate`、`remove`、`redact` 的请求体不对（`upTo` 不是有限的数、`ids` 不是字符串数组）回 400，方法不是 `POST` 回 405。`truncate` 的 `upTo` 不是有限数时客户端不发请求，直接返回 0（`NaN`、`Infinity` 过不了 JSON）。这三个和 `clear` 重发一遍不会多删，但第二次拿到的条数是 0，所以客户端不自动重试；连不上时调用方可以自己重发。服务端是旧版本（没有这三条路径）时得到 404。
- harness 的取消：客户端断开（`stream` 不读了、进程崩了）时服务端中止这一轮；`signal` 中止时客户端发 `DELETE /runs/:runId`，同一个 `POST /runs` 照常回 `RunResult`（`stopReason: aborted`）。`DELETE` 比 `POST` 先到时服务端记一分钟，那一轮到了就以已中止开始。`signal` 在发出前已经中止时请求体带 `aborted: true`，服务端照样写 `ctx.run.started` / `ctx.run.ended`。
- `GET /orchestrator/runs/:runId?wait=<ms>` 是长轮询：这一轮没结束时最多等 `wait` 毫秒（上限 30 秒）再回；结束了就带上 `result`（或 harness 抛错时的 `error`）。结果不在内存里了（过了 `retainResultsMs`、服务重启过，或者编排器已经不认识这个 `runId`）而请求带着 `session`、服务端又挂着 `store` 时，从会话日志还原：找这一轮的 `ctx.run.ended`，`recorded` 是它和 `ctx.run.started` 之间的条目，`messages` 是其中模型写的消息，`status` 按 `stopReason` 推出来。
- `GET /orchestrator/events` 先订阅再回响应头：客户端拿到响应头以后提交的运行，事件一定在这条流里。客户端在提交前会等自己正在建立的事件流连上。
- 编排器的路径放在 `/orchestrator` 下，和 harness 的 `/runs` 分开：同一个服务可以同时挂两者，`POST /runs` 是「现在跑一轮、等结果」，`POST /orchestrator/runs` 是「排队」。

## 鉴权和安全缺省

照 `ctx-gateway` 的做法：

- `startRemote` 缺省只听 `127.0.0.1`。要对外听（容器、内网）时改 `host`，这时必须给 `accessToken`，否则拒绝启动；前面另有一层在鉴权时写 `allowUnauthenticated: true`。最好放在 TLS 终结的反向代理后面。
- `accessToken` 给了空串直接抛错：`process.env.X ?? ''` 这类写法不会悄悄变成不鉴权。
- `Authorization: Bearer <accessToken>`，常量时间比较；没带或不对 401。
- `Host` 只认监听地址（`allowedHosts`），挡 DNS rebinding；不对 403。
- 带 `Origin` 的请求一律 403，除非在 `allowedOrigins` 里：浏览器网页不能顺手调本机的服务。
- 请求体上限 4 MiB（`maxBodyBytes`），超过 413。
- 并发有上限（`maxRuns`、`maxExecutions`、`maxStreams`），满了 429（`rate_limit_error`，`retryable: true`）。
- 调用方能指定的东西过白名单：`allowedModels` 限模型名，`allowedSettings` 限 `agent.settings` 的键（缺省不收 `headers`、`providerOptions`）。
- 内部出的错（存储、harness、执行环境抛的）回给调用方的只有 `internal error (ref xxxxxxxx)`，原文连同编号进 `logger`：错误文字里常有路径、SQL、上游的响应。协议错误（`CtxError` 的 `invalid_request`、`not_found`、`conflict`）照旧带着自己的 `type` 和文字。
- 错误正文统一 `{ error: { message, type } }`，`type` 是 `invalid_request_error`、`authentication_error`、`permission_error`、`not_found_error`、`method_not_allowed`、`conflict_error`、`request_too_large`、`rate_limit_error`、`server_error`、`harness_error` 之一；会话的 `append` 冲突是 `conflict`，`/memory/*` 转发的协议错误是 `invalid_request`、`not_found`、`conflict`（见「记忆」）。

服务端不替组件做隔离：挂一个 `ctx-exec` 执行环境就是把这台机器上的命令行交给持有 token 的人。要隔离，把执行环境的服务端放进容器。

### 主体

一个 `accessToken` 只分得出「能进」和「不能进」。多个租户共用一个服务时给 `authenticate`：把请求映射到一个主体，主体限定能碰的会话和记忆作用域（[ADR 0009](https://github.com/modelctx-ai/ctx/blob/main/docs/adr/0009-hosted-prerequisites.md)）。身份怎么来（JWT、mTLS、网关传来的头）由你决定：

```ts
import { startRemote, type Principal } from '@modelctx-ai/ctx-remote/server';

const server = await startRemote({
  host: '0.0.0.0',
  store,
  harness,
  executors: [box],
  memory,
  authenticate: async (request): Promise<Principal | undefined> => {
    const tenant = await verify(request.headers.authorization); // 你的令牌校验
    if (!tenant) return undefined; // 401
    return { id: tenant, sessionPrefixes: [`${tenant}/`], memoryScopes: [tenant] };
  },
});
```

`Principal` 是 `{ id, sessionPrefixes?, memoryScopes?, admin? }`，不给的限制是不限。超出范围的回 403 `permission_error`：

- 带会话的入口按 `sessionPrefixes` 查（按字面的前缀）：`/sessions/:session/…`、`execute` 的 `context.session`、`/executors/:name/sessions/:session`、`POST /runs` 和 `POST /orchestrator/runs` 的 `session`、`parent.session`、`agent.context.inherit.session`，`DELETE /runs/:runId` 那一轮的会话。
- 编排器的 `status`、`cancel` 按 `runId` 找到经这个服务提交的那一轮的会话再查；限定了会话的主体碰不到不是经这个服务提交的运行（`status` 只能带 `session=` 从会话日志里还原自己的）。
- `GET /sessions` 只列范围里的；`GET /orchestrator/events` 只发范围里的。
- `/memory/*` 的 `scope` 按 `memoryScopes` 查。
- `POST /orchestrator/recover` 横跨所有会话，只有 `admin: true` 能调。
- `authenticate` 抛错按认不出算（401），原文进 `logger`。

租户隔离靠会话名的前缀：给每个租户的会话名加上前缀（`tenant-a/…`）。前缀之外的东西（同一个执行环境实例、同一个模型密钥）不隔离，要隔离就每个租户一套服务；执行环境按会话分开用 `ctx-exec` 的 `sessionCwd` 或者每会话一个容器的执行环境。

## 之后

- **worker 拉取模式**：执行环境只需出站连接，从 harness 领工作再交回结果（像 Managed Agents 的自托管沙箱），适合没有入站端口的环境。
- **WebSocket 传输**：一条连接上双向收发事件。

两者都是传输方式的变化，协议不变：客户端拿到的仍是同样的 `Executor`、`Harness`，契约测试照样跑。

## 对一个地址跑一致性测试

别的语言写的服务端，按线上形态实现了哪几个组件，就能对着它跑同一套契约测试：

```bash
ctx-conformance --url http://127.0.0.1:8080 --token "$TOKEN" --components sessions,harness
```

被测的服务要以一致性模式运行，多提供一个入口 `POST /conformance/instances`：每个用例请求一次，拿到一个新的隔离实例，实例的路径挂在 `/conformance/instances/<id>` 下，形态和正常的服务一样。请求体是 `ConformanceSetup`：

| 字段         | 意思                                                                                                                                                                 |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `components` | 这个用例要哪几个组件：`sessions`、`executors`、`harness`、`orchestrator`、`memory`                                                                                   |
| `script`     | harness、编排器的模型剧本：第 n 次调用模型回第 n 步。`text` 是回答（带 `truncated` 时 `finishReason` 是 `length`），`tool-call` 调用回显工具，`error` 是模型调用失败 |
| `delayMs`    | 模型每一步先等这么久。编排器的契约要在第一轮还在跑时提交、取消第二轮                                                                                                 |
| `clock`      | 存储的钟：`{ at, step }` 第 n 次读是 `at + n × step`；`real` 是真实时间                                                                                              |

响应是 `ConformanceInstance`：`baseUrl`（相对这个服务的路径）、harness 和编排器用的 `agent`（模型名对着按剧本回答的模型）、执行环境用的 `executor: { name, echo }`（回显工具把输入原样放进结果）。实例只给测试用，不该对外开放。

- 命令是 `@modelctx-ai/ctx-remote` 的 `ctx-conformance`，用 `node:test` 跑，失败时退出码非 0。令牌也可以放在 `CTX_ACCESS_TOKEN` 里；`--components` 缺省全部；`--harness-levels trace,execute` 只跑 harness 的这几级（`HarnessLevel`，缺省全部）。
- 在测试框架里跑：`@modelctx-ai/ctx-remote/conformance` 的 `describeConformance(baseUrl, { components?, harnessLevels?, accessToken?, … }, { describe, test })`，Vitest、`node:test` 都行。
- ctx 自己的服务端怎么进一致性模式：`@modelctx-ai/ctx-remote/server` 的 `createConformanceHandler({ create, accessToken?, maxInstances? })`，`create(setup)` 按请求建好要挂的组件（和 `createRemoteHandler` 的选项一样），另给 `agent`、`executor`。本包的测试用核心包的内存组件实现了 `create`，对它跑全部五个组件的契约。
- 导出：`/conformance` 有 `describeConformance`、`ConformanceOptions`、`CONFORMANCE_COMPONENTS`、`CONFORMANCE_PATH` 和类型 `ConformanceComponent`、`ConformanceSetup`、`ConformanceInstance`；`/server` 有 `createConformanceHandler`、`ConformanceHandlerOptions`、`ConformanceInstanceOptions`，以及 `openApiDocument()`（`GET /protocol/openapi` 的文档）、`openApiOperations()`（文档里的每条路径和方法）。
- 上下文、工具目录、模型、记忆的门面不在里面：它们不是线上协议（见[协议层的托管矩阵](../../docs/protocol.md#托管矩阵)）。

## 测试

客户端一侧跑协议包的契约测试，服务端挂核心包、`ctx-exec` 的实现：`describeSessionStoreContract`（服务端的存储有 `watch` 和没有 `watch` 两种）、`describeExecutorContract`（函数执行环境和子进程执行环境）、`describeHarnessContract`、`describeOrchestratorContract`、`describeMemoryStoreContract`（服务端挂 `ctx-memory` 的内存存储）全部通过。另有一例端到端：会话存储、子进程执行环境、harness 各在一个 `startRemote` 里，harness 经客户端用另外两个，按剧本调用 `run_command` 跑 `echo hello`，日志里有工具结果。`describeConformance` 对一致性模式的参考服务（`createConformanceHandler` 加核心包的内存组件）再跑一遍五个组件的契约，走的是别的语言的服务端会走的那条路。`schema.test.ts` 查 `schema/` 下的副本和代码一致、线上的真实值合 schema、OpenAPI 的每条路径服务端都认。
