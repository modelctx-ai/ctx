# @modelctx-ai/ctx-mcp

把 MCP 服务器接成 ctx 的工具。沿用常见的 `mcpServers` 配置写法：有 `command` 走 stdio，有 `url` 走 Streamable HTTP，`type: 'sse'` 走 SSE。基于 `@ai-sdk/mcp`。

## 安装

```sh
pnpm add @modelctx-ai/ctx-mcp @modelctx-ai/ctx zod
```

Node ≥22。

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
const added = hub.registerInto(registry); // notes__…、docs__search、legacy__…，来源 mcp:<server>
console.log(`写入 ${added} 个工具`);

// 交给 createContext({ tools: registry })；退出时关掉，工具也从注册表里撤掉
await hub.close();
```

## 行为

- `connect()` 并行连接所有启用的服务器，从不因为单台服务器抛错：失败记为 `{ state: 'failed', error }`，`enabled: false` 记为 `disabled`；`status()` 按配置顺序。再调一次会重试没连上的，已连上的不动；同一台服务器同一时间只有一次连接在进行。
- 每台服务器连接加列工具有时限：先看服务器自己的 `timeoutMs`，再看 hub 的 `timeoutMs`，缺省 15 秒；`0` 或 `Infinity` 不限时。超时记为失败（`timed out after …ms`）。
- 连上以后任何一步失败（列工具出错、超时）都关掉连接，stdio 服务器的进程跟着结束；超时以后才连上的也马上关掉。
- 工具名缺省是 `<server>__<tool>`，非法字符换成 `_`，截到 64；`namespace: false` 保留原名，也可以传 `(server, tool) => string`。改名后重名的按配置顺序留第一个，后面的原名记在那台服务器状态的 `skipped` 里。
- `include`、`exclude` 按服务器上的原名过滤。
- `registerInto(registry)` 先删掉这个 hub 之前写进去的工具再写入，来源记为 `mcp:<server>`。注册表里已有别的来源的同名工具时不替换，跳过并告警。返回实际写入的条数。
- `close()` 中止还在进行的连接，断开全部连接，清空状态，并从写过的每个注册表里删掉这些工具。
- stdio 的 `env` 只写额外的变量，`PATH`、`HOME` 等会自动带上。

## 导出

| 导出                                                                                                                                | 说明                                                                                                          |
| ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `createMcpHub(servers, options?)`                                                                                                   | 返回 `connect()`、`status()`、`tools()`、`registerInto(registry)`、`close()`                                  |
| `McpHubOptions`                                                                                                                     | `connector`、`namespace`、`logger`、`clientName`（缺省 `ctx`）、`timeoutMs`（缺省 15 秒）                     |
| `McpConnector`                                                                                                                      | `(name, config, { signal }) => Promise<McpConnection>`；超时或 `close()` 时 `signal` 中止。测试时可以换成假的 |
| `connectorFor(clientName?)`                                                                                                         | 缺省的连接器，基于 `@ai-sdk/mcp` 的 `createMCPClient`                                                         |
| `namespaced(server, tool)`                                                                                                          | 缺省的命名规则                                                                                                |
| `isStdioConfig(config)`                                                                                                             | 是不是 stdio 配置                                                                                             |
| `McpServers`、`McpServerConfig`、`StdioServerConfig`、`RemoteServerConfig`、`McpServerStatus`、`McpConnection`、`McpConnectOptions` | 类型                                                                                                          |
