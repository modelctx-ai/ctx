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
  },
  legacy: { url: 'https://old.example.com/sse', type: 'sse', exclude: ['delete_all'] },
  off: { command: 'node', args: ['./mcp/slow-server.js'], enabled: false },
};

const hub = createMcpHub(servers, { clientName: 'my-app' });
for (const status of await hub.connect()) console.log(status.name, status.state);

const registry = createToolRegistry();
hub.registerInto(registry); // notes__…、docs__search、legacy__…，来源 mcp:<server>

// 交给 createContext({ tools: registry })；退出时关掉
await hub.close();
```

## 行为

- `connect()` 并行连接所有启用的服务器；单个失败记为 `{ state: 'failed', error }`，不抛出，`enabled: false` 记为 `disabled`。再调一次会重试没连上的。
- 工具名缺省是 `<server>__<tool>`，非法字符换成 `_`，截到 64；`namespace: false` 保留原名，也可以传 `(server, tool) => string`。
- `include`、`exclude` 按服务器上的原名过滤。
- `registerInto(registry)` 先删掉这个服务器之前注册的工具再写入，来源记为 `mcp:<server>`，返回条数。
- stdio 的 `env` 只写额外的变量，`PATH`、`HOME` 等会自动带上。

## 导出

| 导出                                                                                                                           | 说明                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| `createMcpHub(servers, options?)`                                                                                              | 返回 `connect()`、`status()`、`tools()`、`registerInto(registry)`、`close()` |
| `McpHubOptions`                                                                                                                | `connector`、`namespace`、`logger`、`clientName`（缺省 `ctx`）               |
| `connectorFor(clientName?)`                                                                                                    | 缺省的连接器，基于 `@ai-sdk/mcp` 的 `createMCPClient`                        |
| `namespaced(server, tool)`                                                                                                     | 缺省的命名规则                                                               |
| `isStdioConfig(config)`                                                                                                        | 是不是 stdio 配置                                                            |
| `McpServers`、`McpServerConfig`、`StdioServerConfig`、`RemoteServerConfig`、`McpServerStatus`、`McpConnector`、`McpConnection` | 类型                                                                         |
