# ctx

LLM 应用的上下文管理框架。每个线程一份只追加的上下文日志，每次调用模型前把日志投影成 AI SDK 的消息；上下文来源、工具和 MCP 也在这一层接好。基于 Vercel AI SDK v7（`ai@7`）。

| 包                                             | 作用                                                                                                                          | 运行环境                          |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| [`@modelctx-ai/ctx`](packages/core)            | 上下文日志、`ContextStore` 接口和内存存储、投影、上下文来源、工具注册表、`createContext()`；`/testing` 子路径导出存储契约测试 | Node ≥22；主入口不用 `node:` 模块 |
| [`@modelctx-ai/ctx-sqlite`](packages/sqlite)   | 基于 `node:sqlite` 的 `ContextStore`，可以和应用共用一个库                                                                    | Node ≥22.13                       |
| [`@modelctx-ai/ctx-models`](packages/models)   | 按配置创建 `LanguageModel`：内置 `openai-compatible`、`anthropic`，可注册更多服务商                                           | Node ≥22                          |
| [`@modelctx-ai/ctx-mcp`](packages/mcp)         | 按常见的 `mcpServers` 配置连接 MCP 服务器（stdio、Streamable HTTP、SSE），工具写进注册表                                      | Node ≥22                          |
| [`@modelctx-ai/ctx-gateway`](packages/gateway) | 本机 OpenAI 兼容网关：转发 `chat/completions`，把调用方带来的历史换成 ctx 的上下文                                            | Node ≥22.13                       |

还没有发布到 npm，现在的用法见[在其他仓库里使用](#在其他仓库里使用)。

## 快速开始

```sh
pnpm add @modelctx-ai/ctx @modelctx-ai/ctx-models zod
```

`zod` 是 `ai` 的 peer dependency；下面用到的 `@modelctx-ai/ctx-sqlite`、`@modelctx-ai/ctx-gateway` 按需再装。发布之前用[同级目录链接](#现在同级目录链接)代替这一步。

### 对话

```ts
import { createContext, createMemoryStore } from '@modelctx-ai/ctx';
import { createModel } from '@modelctx-ai/ctx-models';

const context = createContext({
  store: createMemoryStore(),
  thread: 'demo',
  model: createModel({
    provider: 'openai-compatible',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: process.env.DEEPSEEK_API_KEY,
    model: 'deepseek-chat',
  }),
});

const first = await context.generate({ instructions: '回答控制在一句话。', input: '番茄是水果还是蔬菜？' });
console.log(first.text);

// 上一轮的问和答已经写进日志，这一轮自动带上
const second = await context.generate({ instructions: '回答控制在一句话。', input: '那做菜的时候呢？' });
console.log(second.text);
```

### 持久化、事件、来源、工具

```ts
import { DatabaseSync } from 'node:sqlite';

import { createContext, createToolRegistry, defineSource, eventEntry, tool } from '@modelctx-ai/ctx';
import { createModel } from '@modelctx-ai/ctx-models';
import { createSqliteStore } from '@modelctx-ai/ctx-sqlite';
import { z } from 'zod';

const db = new DatabaseSync('app.db'); // 应用自己的库，ctx 的表加 ctx_ 前缀

const tools = createToolRegistry().add(
  'weather',
  tool({
    description: '查城市天气',
    inputSchema: z.object({ city: z.string() }),
    execute: async ({ city }) => `${city}：晴，28°C`,
  }),
);

const context = createContext({
  store: createSqliteStore({ database: db, prefix: 'ctx_' }),
  thread: 'user:42',
  model: createModel({
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: process.env.DEEPSEEK_API_KEY,
    model: 'deepseek-chat',
  }),
  tools,
  // 每次调用时现取，追加在指令后面，不写日志
  sources: [defineSource('clock', () => `现在是 ${new Date().toLocaleString('zh-CN')}`)],
  projection: {
    // 事件默认对模型不可见，有规则的才渲染；fold 把连续的同类事件合成一条
    events: {
      reminder: {
        fold: true,
        render: (events) => ({ role: 'user', content: `已提醒：${events.map((event) => event.text).join('、')}` }),
      },
    },
    window: { maxTokens: 32_000 },
  },
});

await context.append(eventEntry('reminder', { text: '15:30 喝水' }));
const { text } = await context.generate({ instructions: '你是生活助手。', input: '台北下午要带伞吗？' });
console.log(text);
```

### 网关

给只会说 OpenAI 协议、自己截断历史的客户端用：客户端把接口地址填成网关，网关把它带来的历史换成 ctx 的完整上下文，再转发给真正的上游。

```ts
import { randomBytes } from 'node:crypto';

import { createContext, createMemoryStore } from '@modelctx-ai/ctx';
import { startGateway, withContext } from '@modelctx-ai/ctx-gateway';

const context = createContext({ store: createMemoryStore(), thread: 'pet:main' });
const accessToken = randomBytes(24).toString('base64url');

const gateway = await startGateway({
  upstream: { baseUrl: 'https://api.deepseek.com/v1', apiKey: process.env.DEEPSEEK_API_KEY },
  rewrite: withContext(context),
  accessToken, // 客户端带 Authorization: Bearer <accessToken>；真密钥只留在这个进程里
});

console.log(gateway.baseUrl); // http://127.0.0.1:<随机端口>/v1
```

概念、投影规则、记录和压缩的细节见[架构](docs/architecture.md)。

## 在其他仓库里使用

### 现在：同级目录链接

```
<workspace>/
├── ctx/     本仓库，先 pnpm install && pnpm build
└── yoyo/    使用方
```

使用方的 `package.json` 照常写版本范围（`"@modelctx-ai/ctx": "^0.1.0"`），在 `pnpm-workspace.yaml` 里用 `overrides` 指到同级目录：

```yaml
overrides:
  '@modelctx-ai/ctx': link:../ctx/packages/core
  '@modelctx-ai/ctx-gateway': link:../ctx/packages/gateway
  '@modelctx-ai/ctx-mcp': link:../ctx/packages/mcp
  '@modelctx-ai/ctx-models': link:../ctx/packages/models
  '@modelctx-ai/ctx-sqlite': link:../ctx/packages/sqlite
```

使用方读的是 `dist/`，改了 ctx 的源码要在 ctx 里重新 `pnpm build`。

### 发布以后

删掉 `overrides`，重新 `pnpm install`，同样的 `^0.1.0` 从 npm 解析。

## 开发

| 命令                                | 作用                                                                        |
| ----------------------------------- | --------------------------------------------------------------------------- |
| `pnpm install`                      | 安装依赖                                                                    |
| `pnpm typecheck`                    | `tsc` 检查全部包的源码和测试                                                |
| `pnpm test`                         | `node --test` 直接运行 `packages/*/src/**/*.test.ts`                        |
| `pnpm build`                        | 每个包用 tsdown 构建 `dist/`（ESM + `.d.ts`）                               |
| `pnpm format` / `pnpm format:check` | prettier 改写 / 检查                                                        |
| `pnpm check`                        | 依次 typecheck、test、format:check、build；CI 在 Node 22 和 24 上跑同样几步 |

仓库里各包互相引用时按源码解析（`@modelctx-ai/source` 条件，见 [ADR 0002](docs/adr/0002-packages.md)），类型检查和测试不用先构建。

## 要求

| 场景 | 要求                                                                                                                             |
| ---- | -------------------------------------------------------------------------------------------------------------------------------- |
| 开发 | Node ≥22.18（直接运行 `.ts`）；pnpm 10，版本由 `packageManager` 固定                                                             |
| 使用 | Node 版本见包表；peer dependency：`zod`（核心包）、`ai@^7`（ctx-models）、`@modelctx-ai/ctx`（ctx-sqlite、ctx-mcp、ctx-gateway） |

## 文档

[docs/index.md](docs/index.md)：架构、三个仓库的关系、决策记录。

## 许可

[Apache-2.0](LICENSE)
