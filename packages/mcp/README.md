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

const hub = createMcpHub(servers, { clientName: 'my-app', timeoutMs: 10_000 });
for (const status of await hub.connect()) console.log(status.name, status.state);

const registry = createToolRegistry();
const added = hub.registerInto(registry); // notes__…、docs__search、legacy__…，来源 mcp:<server>，执行环境 mcp
console.log(`写入 ${added} 个工具`);

// hub 是执行环境：交给 createContext({ tools: registry, executors: [hub] }) 或 createHarness({ …, executors: [hub] })
const output = await hub.execute({ id: 'c1', name: 'docs__search', input: { query: 'ctx' } }, { session: 'demo' });
console.log(output); // { type: 'text', text: … }；服务器报错是 { type: 'error', message }

// 退出时关掉，工具也从注册表里撤掉
await hub.close();
```

## 行为

- `connect()` 并行连接所有启用的服务器，从不因为单台服务器抛错：失败记为 `{ state: 'failed', error }`，`enabled: false` 记为 `disabled`；`status()` 按配置顺序。再调一次会重试没连上的，已连上的不动；同一台服务器同一时间只有一次连接在进行。
- 每台服务器连接加列工具有时限：先看服务器自己的 `timeoutMs`，再看 hub 的 `timeoutMs`，缺省 15 秒；`0` 或 `Infinity` 不限时。超时记为失败（`timed out after …ms`）。
- 连上以后任何一步失败（列工具出错、超时）都关掉连接，stdio 服务器的进程跟着结束；超时以后才连上的也马上关掉。
- 工具名缺省是 `<server>__<tool>`，非法字符换成 `_`，截到 64；`namespace: false` 保留原名，也可以传 `(server, tool) => string`。改名后重名的按配置顺序留第一个，后面的原名记在那台服务器状态的 `skipped` 里。
- `include`、`exclude` 按服务器上的原名过滤。
- hub 是一个执行环境，名字缺省 `mcp`（选项 `name` 可改；一个应用开几个 hub 时各起一个名字）。选了「一个 hub 一个执行环境」而不是每台服务器一个 `mcp:<server>`：工具名已经带服务器前缀，`execute` 按名字找到服务器，应用只要把 hub 交给 harness 一次。`source` 仍是 `mcp:<server>`，按服务器筛选、移除用它。
- `tools()` 报全部工具的 `ToolDefinition`（`inputSchema` 是服务器给的 JSON Schema，`executor` 指向 hub）；`toolSet()` 是 `@ai-sdk/mcp` 给出的原样工具。
- `execute(call, context)` 调对应服务器的工具，从不抛：不认识的工具、`signal` 已中止、调用出错都返回 `{ type: 'error' }`。结果按 `toolOutputFromMcp` 转：全是文字时合成一段 `text`，图片、音频是 `file`（base64），其余分段写成 JSON 文字，`isError` 是错误。`provision()` / `dispose()` 就是 `connect()` / `close()`。
- `registerInto(registry)` 先删掉这个 hub 之前写进去的工具再写入，写的是绑定到 hub 的 `ToolDefinition`，来源记为 `mcp:<server>`。注册表里已有别的来源的同名工具时不替换，跳过并告警。返回实际写入的条数。
- `close()` 中止还在进行的连接，断开全部连接，清空状态，并从写过的每个注册表里删掉这些工具。
- stdio 的 `env` 只写额外的变量，`PATH`、`HOME` 等会自动带上。

## 导出

| 导出                                                                                                                                                         | 说明                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createMcpHub(servers, options?)`                                                                                                                            | 返回 `McpHub`：`Executor`（`name`、`tools()`、`execute`、`provision`、`dispose`）加 `connect()`、`status()`、`toolSet()`、`registerInto(registry)`、`close()` |
| `McpHubOptions`                                                                                                                                              | `name`（缺省 `mcp`）、`connector`、`namespace`、`logger`、`clientName`（缺省 `ctx`）、`timeoutMs`（缺省 15 秒）                                               |
| `toolOutputFromMcp(result)`                                                                                                                                  | MCP 的 `CallToolResult` 转成协议的 `ToolOutput`                                                                                                               |
| `McpConnector`                                                                                                                                               | `(name, config, { signal }) => Promise<McpConnection>`；超时或 `close()` 时 `signal` 中止。测试时可以换成假的                                                 |
| `connectorFor(clientName?)`                                                                                                                                  | 缺省的连接器，基于 `@ai-sdk/mcp` 的 `createMCPClient`                                                                                                         |
| `namespaced(server, tool)`                                                                                                                                   | 缺省的命名规则                                                                                                                                                |
| `isStdioConfig(config)`                                                                                                                                      | 是不是 stdio 配置                                                                                                                                             |
| `McpServers`、`McpServerConfig`、`StdioServerConfig`、`RemoteServerConfig`、`McpServerStatus`、`McpConnection`、`McpConnectOptions`、`McpTool`、`McpToolSet` | 类型                                                                                                                                                          |
