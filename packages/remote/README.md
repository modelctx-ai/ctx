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
  host: '0.0.0.0', // 容器里要对外听；这时一定要给 accessToken，并按需给 allowedHosts
  port: 8080,
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

| 选项              | 缺省             | 说明                                                                                                                                               |
| ----------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `store`           | —                | `SessionStore`，挂在 `/sessions`                                                                                                                   |
| `executors`       | —                | `Executor[]` 或 `{ 名字: Executor }`，挂在 `/executors/:name`                                                                                      |
| `harness`         | —                | `Harness`，挂在 `/runs`                                                                                                                            |
| `orchestrator`    | —                | `Orchestrator`，挂在 `/orchestrator`                                                                                                               |
| `memory`          | —                | `MemoryStore`，挂在 `/memory`（见「记忆」）                                                                                                        |
| `accessToken`     | —                | 要求 `Authorization: Bearer <token>`，常量时间比较；方案名不分大小写                                                                               |
| `allowedHosts`    | 监听地址         | 只接受这些 `Host`（`host:port`），挡 DNS rebinding。`startRemote` 监听本机时认 `localhost`、`127.0.0.1`、`[::1]`；`createRemoteHandler` 不给就不查 |
| `allowedOrigins`  | 无               | 带 `Origin` 的请求只放行这些来源；缺省浏览器网页发来的请求一律 403                                                                                 |
| `maxBodyBytes`    | 4 MiB            | 请求体上限，超过 413                                                                                                                               |
| `basePath`        | `''`             | 路径前缀                                                                                                                                           |
| `pollIntervalMs`  | 250              | 存储没有 `watch` 时，`entries/stream` 轮询 `list(after)` 的间隔                                                                                    |
| `retainResultsMs` | 10 分钟          | 经这个服务提交给编排器的运行，结束后结果留多久（客户端的 `done` 从这里取）                                                                         |
| `logger`          | 不出声           | 协议的 `Logger`，处理出错时 `warn`                                                                                                                 |
| `host`、`port`    | `127.0.0.1`、`0` | 只有 `startRemote`：监听地址；返回 `{ origin, baseUrl, close }`，`close` 断开所有连接、不关组件                                                    |

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

| 工厂                                                                    | 行为                                                                                                                                                                                                                                         |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createRemoteSessionStore({ baseUrl, accessToken?, fetch?, headers? })` | `SessionStore`。`watch` 读 NDJSON 流，`signal` 中止后迭代正常结束；服务端的存储没有 `watch` 时由服务端轮询                                                                                                                                   |
| `createRemoteExecutor({ …, name })`                                     | `Executor`：`tools()`、`execute()`。连不上返回 `{ type: 'error', retryable: true }`，服务端拒绝（4xx/5xx）返回错误结果（5xx 可重试），都不抛；`signal` 中止时断开请求，服务端的执行跟着中止                                                  |
| `createRemoteHarness(…)`                                                | `Harness`：`run`、`stream`。`agent.model` 不是字符串就抛。`signal` 中止时发 `DELETE /runs/:runId`，`run` 照常返回 `stopReason: aborted`；`stream` 提前不读就断开连接，服务端同样中止并写 `ctx.run.ended`                                     |
| `createRemoteOrchestrator({ …, waitMs? })`                              | `Orchestrator`：`submit`、`status`、`cancel`、`recover`、`events`、`close`。`done` 用长轮询 `GET /orchestrator/runs/:id?wait=` 实现（每次最多等 `waitMs`，缺省 25 秒）；`close` 只关这个客户端：不再提交、结束它的事件流、等它提交的运行结束 |

服务端返回的 `{ error }` 变成抛出的 `RemoteError`：一个 `Error`，带 `status`（HTTP 状态码）、`type`、`retryable?`、`statusCode?`、`responseBody?`（后两个是上游接口的状态码和响应正文，服务端有才带；`status` 仍是本次 HTTP 响应的）；`isRemoteError(error)` 判断。NDJSON 流中途出错时最后一行是 `{ error }`，客户端同样抛出。

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

每个协议方法恰好一个端点。路径里的 `:id` 用 `encodeURIComponent` 转义；查询参数不给就不传给存储，布尔是 `true` / `false`，数字原样（`limit=1.9` 由存储向下取整）。

| 集合 | 协议方法  | HTTP                                                    | 请求体                                         | 响应                            |
| ---- | --------- | ------------------------------------------------------- | ---------------------------------------------- | ------------------------------- |
| 笔记 | `add`     | `POST /memory/notes`                                    | `{ notes: NewNote[] }`                         | `{ notes: Note[] }`             |
|      | `list`    | `GET /memory/notes?session=&pending=&limit=`            | —                                              | `{ notes: Note[] }`             |
|      | `settle`  | `POST /memory/notes/settle`                             | `{ ids: string[], at }`                        | `{ settled: number }`           |
|      | `head`    | `GET /memory/notes/head?session=`（必填）               | —                                              | `{ head: number }`              |
| 事实 | `add`     | `POST /memory/facts`                                    | `{ fact: NewMemoryFact }`                      | `{ fact: MemoryFact }`          |
|      | `list`    | `GET /memory/facts?subject=&topic=&open=&after=&limit=` | —                                              | `{ facts: MemoryFact[] }`       |
|      | `search`  | `POST /memory/facts/search`                             | `SearchQuery`（`{ text, topic?, k?, open? }`） | `{ hits: FactHit[] }`           |
|      | `close`   | `POST /memory/facts/:id/close`                          | `{ at, supersededBy? }`                        | `{}`                            |
|      | `cite`    | `POST /memory/facts/:id/cite`                           | `{ sources: SourceRef[] }`                     | `{ fact: MemoryFact }`          |
|      | `touch`   | `POST /memory/facts/touch`                              | `{ ids: string[], at }`                        | `{}`                            |
|      | `archive` | `POST /memory/facts/archive`                            | `{ ids: string[], at }`                        | `{ archived: number }`          |
|      | `forget`  | `POST /memory/facts/forget`                             | `{ ids: string[] }`                            | `{ forgotten: number }`         |
| 程序 | `add`     | `POST /memory/procedures`                               | `{ procedure: NewProcedure }`                  | `{ procedure: Procedure }`      |
|      | `list`    | `GET /memory/procedures?topic=&active=`                 | —                                              | `{ procedures: Procedure[] }`   |
|      | `confirm` | `POST /memory/procedures/:id/confirm`                   | `{ evidence: SourceRef[] }`                    | `{ procedure: Procedure }`      |
|      | `retire`  | `POST /memory/procedures/:id/retire`                    | `{ at }`                                       | `{}`                            |
| 画像 | `get`     | `GET /memory/core`                                      | —                                              | `{ core: CoreVersion \| null }` |
|      | `set`     | `PUT /memory/core`                                      | `{ text, at }`                                 | `{}`                            |
|      | `history` | `GET /memory/core/history?last=`                        | —                                              | `{ versions: CoreVersion[] }`   |

错误：存储抛的 `CtxError` 按 `type` 映射状态码，正文的 `type` 原样保留：`invalid_request` 400、`not_found` 404、`conflict` 409。服务端自己查出的输入不对（缺字段、`limit` 不是数、`pending` 不是 `true` / `false`、`head` 没给 `session`）也是 400 `invalid_request`。客户端把这三种 `type` 转回同 `type` 的 `CtxError`（批量方法照协议跳过认不得的 `id`，不报错）；别的错误照常是 `RemoteError`，例如服务端没挂记忆是 404 `not_found_error`、方法不对是 405 `method_not_allowed`，调用方据此区分「这个 `id` 不存在」和「这个服务没有记忆」。

## 线上形态

JSON 请求和响应，流式用 NDJSON（`application/x-ndjson`，每行一个值）。路径里的会话名、执行环境名、`runId` 用 `encodeURIComponent` 转义。

| 组件     | 协议方法         | HTTP                                                              | 请求体                                             | 响应                                                         |
| -------- | ---------------- | ----------------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------ |
| 会话     | `append`         | `POST /sessions/:session/entries`                                 | `{ entries: NewEntry[], expectSeq? }`              | `{ entries: Entry[] }`                                       |
|          | `list`           | `GET /sessions/:session/entries?after=&last=&types=a,b&kinds=x,y` | —                                                  | `{ entries: Entry[] }`                                       |
|          | `watch`          | `GET /sessions/:session/entries/stream?after=`                    | —                                                  | NDJSON，每行一个 `Entry`                                     |
|          | `clear`          | `DELETE /sessions/:session`                                       | —                                                  | `{ deleted: number }`                                        |
|          | `sessions`       | `GET /sessions?prefix=&after=&limit=`                             | —                                                  | `{ sessions: string[] }`                                     |
| 执行环境 | （列出）         | `GET /executors`                                                  | —                                                  | `{ executors: string[] }`                                    |
|          | `tools`          | `GET /executors/:name/tools`                                      | —                                                  | `{ tools: ToolDefinition[] }`                                |
|          | `execute`        | `POST /executors/:name/execute`                                   | `{ call: ToolCall, context: { session, runId? } }` | `{ output: ToolOutput }`                                     |
| Harness  | `run`            | `POST /runs`                                                      | `RunRequest` 去掉 `signal`，可加 `aborted: true`   | `RunResult`                                                  |
|          | `stream`         | `POST /runs?stream=1`                                             | 同上                                               | NDJSON，每行一个 `RunEvent`                                  |
|          | （`signal`）     | `DELETE /runs/:runId`                                             | —                                                  | `{ cancelled: boolean }`                                     |
| 编排     | `submit`         | `POST /orchestrator/runs`                                         | 同 `POST /runs`                                    | `{ runId, session }`                                         |
|          | `status`、`done` | `GET /orchestrator/runs/:runId?wait=<ms>`                         | —                                                  | `{ runId, status, session?, result?, error? }`，不认识的 404 |
|          | `cancel`         | `DELETE /orchestrator/runs/:runId`                                | —                                                  | `{ cancelled: boolean }`                                     |
|          | `recover`        | `POST /orchestrator/recover`                                      | —                                                  | `{ recovered: RecoveredRun[] }`                              |
|          | `events`         | `GET /orchestrator/events`                                        | —                                                  | NDJSON，每行一个 `OrchestratorEvent`                         |

- 消息是 ctx 的 JSON 格式（二进制是 base64 字符串），线上不做编码，`JSON.stringify`、`JSON.parse` 直接用。0.2 的编码（带 `\u0000ctx` 标记的对象）删掉了，所以客户端和服务端要一起升到 0.3。条目带 `v`，客户端读到比自己认识的更高的版本时抛 `unsupported_version`。
- `append` 带 `expectSeq` 而前提不满足时，服务端回 409（`{ error: { type: 'conflict', retryable: true } }`），客户端转成协议的 `conflict`（`CtxError`，`isConflict(error)` 认得），调用方不必认识 HTTP。
- harness 的取消：客户端断开（`stream` 不读了、进程崩了）时服务端中止这一轮；`signal` 中止时客户端发 `DELETE /runs/:runId`，同一个 `POST /runs` 照常回 `RunResult`（`stopReason: aborted`）。`DELETE` 比 `POST` 先到时服务端记一分钟，那一轮到了就以已中止开始。`signal` 在发出前已经中止时请求体带 `aborted: true`，服务端照样写 `ctx.run.started` / `ctx.run.ended`。
- `GET /orchestrator/runs/:runId?wait=<ms>` 是长轮询：这一轮没结束时最多等 `wait` 毫秒（上限 30 秒）再回；结束了就带上 `result`（或 harness 抛错时的 `error`）。
- `GET /orchestrator/events` 先订阅再回响应头：客户端拿到响应头以后提交的运行，事件一定在这条流里。客户端在提交前会等自己正在建立的事件流连上。
- 编排器的路径放在 `/orchestrator` 下，和 harness 的 `/runs` 分开：同一个服务可以同时挂两者，`POST /runs` 是「现在跑一轮、等结果」，`POST /orchestrator/runs` 是「排队」。

## 鉴权和安全缺省

照 `ctx-gateway` 的做法：

- `startRemote` 缺省只听 `127.0.0.1`。要对外听（容器、内网）时改 `host`，这时一定给 `accessToken`，最好放在 TLS 终结的反向代理后面。
- `Authorization: Bearer <accessToken>`，常量时间比较；没带或不对 401。
- `Host` 只认监听地址（`allowedHosts`），挡 DNS rebinding；不对 403。
- 带 `Origin` 的请求一律 403，除非在 `allowedOrigins` 里：浏览器网页不能顺手调本机的服务。
- 请求体上限 4 MiB（`maxBodyBytes`），超过 413。
- 错误正文统一 `{ error: { message, type } }`，`type` 是 `invalid_request_error`、`authentication_error`、`permission_error`、`not_found_error`、`method_not_allowed`、`conflict_error`、`request_too_large`、`server_error`、`harness_error` 之一；会话的 `append` 冲突是 `conflict`，`/memory/*` 转发的协议错误是 `invalid_request`、`not_found`、`conflict`（见「记忆」）。

服务端不替组件做隔离：挂一个 `ctx-exec` 执行环境就是把这台机器上的命令行交给持有 token 的人。要隔离，把执行环境的服务端放进容器。

## 之后

- **worker 拉取模式**：执行环境只需出站连接，从 harness 领工作再交回结果（像 Managed Agents 的自托管沙箱），适合没有入站端口的环境。
- **WebSocket 传输**：一条连接上双向收发事件。

两者都是传输方式的变化，协议不变：客户端拿到的仍是同样的 `Executor`、`Harness`，契约测试照样跑。

## 测试

客户端一侧跑协议包的契约测试，服务端挂核心包、`ctx-exec` 的实现：`describeSessionStoreContract`（服务端的存储有 `watch` 和没有 `watch` 两种）、`describeExecutorContract`（函数执行环境和子进程执行环境）、`describeHarnessContract`、`describeOrchestratorContract`、`describeMemoryStoreContract`（服务端挂 `ctx-memory` 的内存存储）全部通过。另有一例端到端：会话存储、子进程执行环境、harness 各在一个 `startRemote` 里，harness 经客户端用另外两个，按剧本调用 `run_command` 跑 `echo hello`，日志里有工具结果。
