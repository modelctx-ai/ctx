# @modelctx-ai/ctx-mcp

把 MCP 服务器接成 ctx 的执行环境：hub 本身实现协议的 `Executor`，工具定义写进 `ToolRegistry`。沿用常见的 `mcpServers` 配置写法：有 `command` 走 stdio，有 `url` 走 Streamable HTTP，`type: 'sse'` 走 SSE。基于 `@ai-sdk/mcp`。

## 安装

```sh
pnpm add @modelctx-ai/ctx-mcp @modelctx-ai/ctx-protocol
```

Node ≥22。只依赖 `@modelctx-ai/ctx-protocol` 和 `@ai-sdk/mcp`；下面的例子另外用到核心包 `@modelctx-ai/ctx`。

## 用法

```ts
import { createToolRegistry } from '@modelctx-ai/ctx';
import { createMcpHub, type McpServers } from '@modelctx-ai/ctx-mcp';

const servers: McpServers = {
  notes: { command: 'node', args: ['./mcp/notes-server.js'], env: { NOTES_DIR: './notes' } },
  docs: {
    url: 'https://mcp.example.com/mcp',
    headers: { authorization: `Bearer ${process.env.DOCS_TOKEN}` },
    include: ['search'],
    timeoutMs: 5_000, // 这台单独限时
  },
  legacy: { url: 'https://old.example.com/sse', type: 'sse', exclude: ['delete_all'] },
  off: { command: 'node', args: ['./mcp/slow-server.js'], enabled: false },
};

const hub = createMcpHub(servers, { clientName: 'my-app', timeoutMs: 10_000, callTimeoutMs: 30_000 });
for (const status of await hub.connect()) console.log(status.name, status.state);

const registry = createToolRegistry();
const added = hub.registerInto(registry); // notes__…、docs__search、legacy__…，来源 mcp:<server>，执行环境 mcp
console.log(`写入 ${added} 个工具`);

// hub 是执行环境：交给 createContext({ tools: registry, executors: [hub] }) 或 createHarness({ …, executors: [hub] })
const output = await hub.execute({ id: 'c1', name: 'docs__search', input: { query: 'ctx' } }, { session: 'demo' });
console.log(output); // { type: 'text', text: … }；服务器报错是 { type: 'error', message }

// 服务器断了以后状态是 failed，它的工具从 hub 和注册表里撤掉；再调 connect() 重连（连着的不动），比如每轮开始前调一次
await hub.connect();
// 服务器不发 list_changed 时手动重新列工具
await hub.refresh('docs');

// 退出时关掉，工具也从注册表里撤掉
await hub.close();
```

## 选项

`createMcpHub(servers, options?)` 的 `options`（`McpHubOptions`）。时限和上限里 `0` 或 `Infinity` 都是不限。

| 选项                  | 缺省             | 说明                                                                           |
| --------------------- | ---------------- | ------------------------------------------------------------------------------ |
| `name`                | `mcp`            | 作为执行环境的名字，工具定义的 `executor` 指向它                               |
| `connector`           | `connectorFor()` | 怎么连一台服务器，测试时换成假的                                               |
| `namespace`           | `namespaced`     | 工具名怎么加服务器前缀；`false` 保留原名，也可以传 `(server, tool) => string`  |
| `logger`              | 不记             | 连接失败、断开、刷新失败、关闭失败、注册时重名都走 `warn`                      |
| `clientName`          | `ctx`            | 连接时报给服务器的客户端名字                                                   |
| `timeoutMs`           | `15_000`         | 每台服务器连接加列工具最多等多久，刷新时列工具也用它                           |
| `callTimeoutMs`       | `60_000`         | 一次工具调用最多等多久，到点返回错误并取消底层请求                             |
| `maxDescriptionChars` | `2_000`          | 工具说明最多多少个字符，超过的截断并在末尾注明                                 |
| `maxOutputChars`      | `100_000`        | 一次结果里的文字最多多少个字符，超过的截断并注明省略了多少                     |
| `maxFileBytes`        | 5 MiB            | 一次结果里的图片、音频（解码后）合计最多多少字节，放不下的那个换成一段说明文字 |

每台服务器的配置（`McpServerConfig`）除了 `command`、`args`、`env`、`cwd`（stdio）或 `url`、`type`、`headers`（远程），还有：

| 字段                 | 缺省                   | 说明                            |
| -------------------- | ---------------------- | ------------------------------- |
| `enabled`            | `true`                 | `false` 时不连，状态 `disabled` |
| `include`、`exclude` | 全部                   | 按服务器上的原名挑工具          |
| `timeoutMs`          | hub 的 `timeoutMs`     | 这台服务器连接加列工具的时限    |
| `callTimeoutMs`      | hub 的 `callTimeoutMs` | 这台服务器一次工具调用的时限    |

## 行为

- `connect()` 并行连接所有启用的服务器，从不因为单台服务器抛错：失败记为 `{ state: 'failed', error }`，`enabled: false` 记为 `disabled`；`status()` 按配置顺序。再调一次会重试没连上的和断开的，已连上的不动；同一台服务器同一时间只有一次连接在进行。
- 每台服务器连接加列工具有时限：先看服务器自己的 `timeoutMs`，再看 hub 的 `timeoutMs`，缺省 15 秒；`0` 或 `Infinity` 不限时。超时记为失败（`timed out after …ms`）。
- 连上以后任何一步失败（列工具出错、超时）都关掉连接，stdio 服务器的进程跟着结束；超时以后才连上的也马上关掉。
- 连上以后服务器自己断了（stdio 进程退出；Streamable HTTP 的会话过期，服务器对带旧会话号的请求回 404；SSE 的事件流断了）：连接摘掉，状态变成 `{ state: 'failed', error: 'disconnected: …' }`，它的工具从 `tools()`、`toolSet()` 和写过的注册表里去掉，`logger.warn` 记一条。这之后调它的工具返回说明服务器断开了的错误，断开那一刻还在跑的调用也是。hub 不自己重连：再调 `connect()`（或 `provision()`）才重连，连上以后工具回到注册表里。远程服务器只是不可达（网络断了、服务器没起来）时没有「连接关闭」这回事，调用各自报错或超时，状态不变。
- 服务器发 `notifications/tools/list_changed` 时 hub 重新列它的工具，`tools()`、状态和写过的注册表跟着变；`refresh(name?)` 手动做同一件事，返回全部状态，只管连着的服务器（没连上的、不认识的名字不动）。同一台服务器的刷新一次接一次：正在列的时候又来了通知或 `refresh()`，列完再列一次，等的人拿到的都是最后一次的结果。列不出来（出错，或超过 `timeoutMs`）时不断开，保留原来的工具，原因记在状态的 `refreshError` 里，下次刷新成功就没有了。
- 远程服务器的连接、列工具、调用在 2026-11-15 对一台公开的 Streamable HTTP 服务器验证过（`@ai-sdk/mcp` 2.0.83，见 [`live/`](https://github.com/modelctx-ai/ctx/blob/main/live/README.md)，每晚重跑）。`list_changed`、会话过期和事件流断开没有对真实服务验证，只对测试里起的本地服务器验证过；SSE 传输也没有对真实服务验证。`@ai-sdk/mcp` 的客户端不处理服务器发来的通知，不报连接关闭，也不导出远程传输的类：`connectorFor` 从客户端上取它内部的传输来接通知，SSE 的断开按它报的错误信息来认。它改了内部结构或错误信息时，远程服务器就收不到 `list_changed`、认不出 SSE 断开（stdio 和 HTTP 的会话过期不受影响），这时用 `refresh()`。
- 工具名缺省是 `<server>__<tool>`，非法字符换成 `_`，截到 64；`namespace: false` 保留原名，也可以传 `(server, tool) => string`。改名后重名的按配置顺序留第一个，后面的原名记在那台服务器状态的 `skipped` 里。
- `include`、`exclude` 按服务器上的原名过滤。
- hub 是一个执行环境，名字缺省 `mcp`（选项 `name` 可改；一个应用开几个 hub 时各起一个名字）。选了「一个 hub 一个执行环境」而不是每台服务器一个 `mcp:<server>`：工具名已经带服务器前缀，`execute` 按名字找到服务器，应用只要把 hub 交给 harness 一次。`source` 仍是 `mcp:<server>`，按服务器筛选、移除用它。
- `tools()` 报全部工具的 `ToolDefinition`（`inputSchema` 是服务器给的 JSON Schema，`executor` 指向 hub）。工具说明是服务器写的，超过 `maxDescriptionChars` 的截断，末尾加 `… [description truncated, N more characters]`。`toolSet()` 是 `@ai-sdk/mcp` 给出的原样工具：说明不截断，直接调它们也不受下面的时限和上限约束。
- `execute(call, context)` 调对应服务器的工具，从不抛：不认识的工具、`signal` 中止、超时、服务器断开、调用出错都返回 `{ type: 'error' }`。结果按 `toolOutputFromMcp` 转：全是文字时合成一段 `text`，图片、音频是 `file`（base64），其余分段写成 JSON 文字，`isError` 是错误。`provision()` / `dispose()` 就是 `connect()` / `close()`。
- 一次调用最多等 `callTimeoutMs`（先看服务器自己的，再看 hub 的，缺省 60 秒）。到点返回的错误写明是哪台服务器的哪个工具、等了多久，同时中止传给工具的 `abortSignal`，客户端不再等这个请求；MCP 的取消通知没有发，服务器可能还在跑。调用方的 `signal` 中途中止也一样马上返回。
- 结果是第三方内容，进上下文之前按上限收：文字合起来超过 `maxOutputChars` 的截断，另起一行写 `[… truncated N more characters; …]`；`content` 里几段文字合起来算，超的那一段截断，后面的文字不要了；图片、音频按解码后的字节合起来算，超过 `maxFileBytes` 时放不下的那个换成一段说明文字；不是 `content` 形状的结果（`json`）序列化后超了换成截断的文字；错误信息同样截断。工具的输入结构和工具个数没有上限，信不过的服务器用 `include` 只留要的工具。
- `registerInto(registry)` 先删掉这个 hub 之前写进去的工具再写入，写的是绑定到 hub 的 `ToolDefinition`，来源记为 `mcp:<server>`。注册表里已有别的来源的同名工具时不替换，跳过并告警。返回实际写入的条数。之后 hub 的工具有变化（重连、断开、`list_changed`、`refresh()`）时，写过的注册表按同样的规则重写一遍，不用再调；手动从注册表里删掉的 MCP 工具会在重写时回来，要去掉某个工具用 `exclude`。
- `close()` 中止还在进行的连接，断开全部连接，清空状态，并从写过的每个注册表里删掉这些工具。
- stdio 的 `env` 只写额外的变量，`PATH`、`HOME` 等会自动带上。

## 反方向：把执行环境交给 MCP 客户端

自带循环的程序（Claude Code、pi 这类进程级的 harness）只认 MCP。`createMcpServer` 把 ctx 的执行环境包成 MCP 服务器，它们调的工具就落在 ctx 的执行环境上：

```ts
import { createServer } from 'node:http';

import { createMcpHttpHandler, createMcpServer, serveMcpStdio } from '@modelctx-ai/ctx-mcp';

const server = createMcpServer({
  executors: [local, box], // 工具按定义的 executor 找执行环境
  context: { session: 'user:42', runId }, // 调用记在哪个会话、哪一轮
  onResult: (call, output) => console.log(call.name, output.type), // 适配器在这里把调用记进日志
});

// Streamable HTTP：POST /mcp
createServer(createMcpHttpHandler(server, { accessToken: process.env.MCP_TOKEN })).listen(7801, '127.0.0.1');
// 或者 stdio：一行一条
await serveMcpStdio(server);
```

- 只做工具：`initialize`、`ping`、`tools/list`、`tools/call` 和客户端的 `notifications/cancelled`（中止那次调用）。不依赖 MCP 的 SDK。协议版本认 `MCP_PROTOCOL_VERSIONS`（`2025-06-18`、`2025-03-26`、`2024-11-05`），客户端要的不在里面就回最新的。
- 工具：`tools` 给了就交出这些定义，不给就是各执行环境 `tools()` 报的全部，同名的留第一个。调用前按 `inputSchema` 查输入（`validateInput: false` 关掉），结果超过 `maxOutputChars`（缺省 `DEFAULT_MAX_TOOL_OUTPUT_CHARS`，20 万字符；0 不限）时截断并注明省略了多少（`limitToolOutput`），`onResult` 收到的是截过的：MCP 客户端不经过 harness 的那一层。
- 结果按 `toolOutputToMcp` 转：文字是 `text`；`json` 是它的 JSON 文字，值是对象时另放进 `structuredContent`；图片、音频是它们自己的块，别的内联文件是嵌入的资源，地址是 `resource_link`；`{ type: 'error' }` 是 `isError: true` 的结果（`retryable`、`data` 跟在信息后面），不是 JSON-RPC 错误，模型看得到。执行环境抛错也是这样。
- `createMcpHttpHandler(server, { path?, accessToken?, allowedOrigins?, maxBodyBytes? })`：只认 `POST <path>`（缺省 `/mcp`），请求回 `application/json`，通知回 202；`GET`、`DELETE` 回 405（不开服务器发起的流，不建会话）。带 `Origin` 的请求缺省 403，给了 `accessToken` 要 `Authorization: Bearer`。客户端断开时那次调用中止。
- `serveMcpStdio(server, { input?, output? })`：缺省 `process.stdin`、`process.stdout`，输入结束时 resolve，正在跑的调用中止。请求不排队，慢的调用不挡 `ping` 和取消。日志别写 stdout。
- 用本包的 hub（`@ai-sdk/mcp` 的客户端）验证过 HTTP 和 stdio 两种传输；Claude Code、pi 这些真实的客户端没有验证。

## 导出

| 导出                                                                                                                                                         | 说明                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createMcpHub(servers, options?)`                                                                                                                            | 返回 `McpHub`：`Executor`（`name`、`tools()`、`execute`、`provision`、`dispose`）加 `connect()`、`refresh(name?)`、`status()`、`toolSet()`、`registerInto(registry)`、`close()`                                                                                            |
| `McpHubOptions`                                                                                                                                              | 见上面「选项」                                                                                                                                                                                                                                                             |
| `toolOutputFromMcp(result, limits?)`                                                                                                                         | MCP 的 `CallToolResult` 转成协议的 `ToolOutput`。不给 `limits` 原样转；给了按 `McpOutputLimits` 截断                                                                                                                                                                       |
| `McpOutputLimits`                                                                                                                                            | `{ maxOutputChars?, maxFileBytes? }`，没给的那一项不限                                                                                                                                                                                                                     |
| `McpConnector`                                                                                                                                               | `(name, config, { signal, onClose, onToolsChanged }) => Promise<McpConnection>`；超时或 `close()` 时 `signal` 中止。连接自己断了调 `onClose(reason?)`，服务器发 `list_changed` 调 `onToolsChanged()`，自己写的连接器不调这两个就没有断开检测和自动刷新。测试时可以换成假的 |
| `connectorFor(clientName?)`                                                                                                                                  | 缺省的连接器，基于 `@ai-sdk/mcp` 的 `createMCPClient`                                                                                                                                                                                                                      |
| `namespaced(server, tool)`                                                                                                                                   | 缺省的命名规则                                                                                                                                                                                                                                                             |
| `isStdioConfig(config)`                                                                                                                                      | 是不是 stdio 配置                                                                                                                                                                                                                                                          |
| `McpServers`、`McpServerConfig`、`StdioServerConfig`、`RemoteServerConfig`、`McpServerStatus`、`McpConnection`、`McpConnectOptions`、`McpTool`、`McpToolSet` | 类型                                                                                                                                                                                                                                                                       |
| `createMcpServer(options)`、`McpServer`、`McpServerOptions`、`McpCallContext`                                                                                | 把执行环境包成 MCP 服务器：`handle(message, { signal? })` 处理一条 JSON-RPC 消息，`close()` 中止正在跑的调用                                                                                                                                                               |
| `createMcpHttpHandler(server, options?)`、`McpHttpOptions`                                                                                                   | Streamable HTTP 的处理函数，挂到 `node:http` 上                                                                                                                                                                                                                            |
| `serveMcpStdio(server, options?)`、`McpStdioOptions`                                                                                                         | 走 stdio                                                                                                                                                                                                                                                                   |
| `toolOutputToMcp(output)`                                                                                                                                    | `ToolOutput` 转成 MCP 的 `CallToolResult`                                                                                                                                                                                                                                  |
| `MCP_PROTOCOL_VERSIONS`                                                                                                                                      | 认得的 MCP 协议版本，新的在前                                                                                                                                                                                                                                              |
