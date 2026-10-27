# ctx

面向 agent 原生程序的上下文与运行框架，for programs as yet unthought of。

一个 agent 被拆成七个组件：会话（只追加的事件日志）、上下文（每次调用从日志算出来交给模型的东西）、工具、执行环境、harness（跑一轮的循环）、编排（什么时候跑哪个会话）、模型。每个组件一个协议，组件之间只通过协议交互：任何一个都能单独替换，也能放在任何地方托管。harness 可以是一个服务，经 HTTP 驱使别处的执行环境；执行环境可以是容器，也可以只是本机的一个进程；会话可以在内存、SQLite 或第三方存储；编排可以是本机一个循环，也可以在云端。模型经 Vercel AI SDK v7 接任何服务商。第八个组件记忆（[`ctx-memory`](packages/memory)）从会话日志里提炼跨会话的事实、经验和画像，只读日志、不改它，见[记忆](docs/memory.md)。

仓库分三层：

| 层   | 在哪                                                    | 内容                                                  |
| ---- | ------------------------------------------------------- | ----------------------------------------------------- |
| 协议 | [`@modelctx-ai/ctx-protocol`](packages/protocol)        | 九个协议的接口、JSON 形状、纯函数、契约测试。只有定义 |
| 实现 | `@modelctx-ai/ctx` 和 `ctx-*`                           | 每个协议至少一份参考实现，按依赖和托管形态分包        |
| 实践 | [modelctx-ai/yoyo](https://github.com/modelctx-ai/yoyo) | 用这些实现组合出来的程序：一个常驻的桌宠导演          |

| 包                                               | 作用                                                                                                                                                                       | 运行环境                          |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| [`@modelctx-ai/ctx-protocol`](packages/protocol) | `SessionStore`、`ContextBuilder`、`ToolRegistry`、`Executor`、`Harness`、`Orchestrator`，记忆的 `MemoryStore`、`DecisionModel`、`ExtractionModel`；`/testing` 导出契约测试 | 任何 JS 运行时                    |
| [`@modelctx-ai/ctx`](packages/core)              | 进程内参考实现：内存会话存储、投影和来源、工具注册表、函数执行环境、基于 AI SDK 的 harness、进程内编排器、`createContext()`                                                | Node ≥22；主入口不用 `node:` 模块 |
| [`@modelctx-ai/ctx-sqlite`](packages/sqlite)     | 基于 `node:sqlite` 的 `SessionStore` 和 `MemoryStore`，可以和应用共用一个库                                                                                                | Node ≥22.13                       |
| [`@modelctx-ai/ctx-models`](packages/models)     | 按配置创建 `LanguageModel`（内置 `openai-compatible`、`anthropic`）和 System One 的决策、提取模型（Cloudflare、TypeSafe），可注册更多服务商                                | Node ≥22                          |
| [`@modelctx-ai/ctx-memory`](packages/memory)     | 记忆的参考实现：`createMemory` 的门控、召回、巩固、遗忘，内存 `MemoryStore`，启发式和 `LanguageModel` 装成的决策、提取模型                                                 | Node ≥22                          |
| [`@modelctx-ai/ctx-mcp`](packages/mcp)           | MCP 服务器作为执行环境：按常见的 `mcpServers` 配置连接（stdio、Streamable HTTP、SSE），工具写进注册表                                                                      | Node ≥22                          |
| [`@modelctx-ai/ctx-exec`](packages/exec)         | 本机子进程执行环境：跑命令行、读写工作目录里的文件，环境变量白名单、超时、输出截断                                                                                         | Node ≥22                          |
| [`@modelctx-ai/ctx-remote`](packages/remote)     | 会话存储、执行环境、harness、编排器、记忆存储的 HTTP 服务端和客户端：把组件放到进程边界另一侧                                                                              | 客户端任何运行时；服务端 Node ≥22 |
| [`@modelctx-ai/ctx-gateway`](packages/gateway)   | 本机 OpenAI 兼容网关：转发 `chat/completions`，把调用方带来的历史换成 ctx 的上下文                                                                                         | Node ≥22                          |

还没有发布到 npm，现在的用法见[在其他仓库里使用](#在其他仓库里使用)。设计见[概念](docs/concepts.md)和[协议层](docs/protocol.md)。

## 快速开始

```sh
pnpm add @modelctx-ai/ctx @modelctx-ai/ctx-protocol @modelctx-ai/ctx-models zod
```

`@modelctx-ai/ctx-protocol` 是核心包的 peer dependency（类型和纯函数核心包都原样转出，应用只从 `@modelctx-ai/ctx` 导入就行），`zod` 是 `ai` 的；下面用到的 `@modelctx-ai/ctx-sqlite`、`@modelctx-ai/ctx-gateway` 按需再装。发布之前用[同级目录链接](#现在同级目录链接)代替这一步。

### 对话

```ts
import { createContext, createMemoryStore } from '@modelctx-ai/ctx';
import { createModel } from '@modelctx-ai/ctx-models';

const context = createContext({
  store: createMemoryStore(),
  session: 'demo',
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

// zod 工具转成 JSON Schema 定义，执行函数放进注册表自带的进程内执行环境
const tools = createToolRegistry().addTool(
  'weather_get',
  tool({
    description: '查城市天气',
    inputSchema: z.object({ city: z.string() }),
    execute: async ({ city }) => `${city}：晴，28°C`,
  }),
);

const context = createContext({
  store: createSqliteStore({ database: db, prefix: 'ctx_' }),
  session: 'user:42',
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
      'app.reminder': {
        fold: true,
        render: (events) => ({ role: 'user', content: `已提醒：${events.map((event) => event.text).join('、')}` }),
      },
    },
    window: { maxTokens: 32_000 },
  },
});

await context.append(eventEntry('app.reminder', { text: '15:30 喝水' }));
const { text } = await context.generate({ instructions: '你是生活助手。', input: '台北下午要带伞吗？' });
console.log(text);
```

### 网关

给只会说 OpenAI 协议、自己截断历史的客户端用：客户端把接口地址填成网关，网关把它带来的历史换成 ctx 的完整上下文，再转发给真正的上游。

```ts
import { randomBytes } from 'node:crypto';

import { createContext, createMemoryStore } from '@modelctx-ai/ctx';
import { startGateway, withContext } from '@modelctx-ai/ctx-gateway';

const context = createContext({ store: createMemoryStore(), session: 'pet:main' });
const accessToken = randomBytes(24).toString('base64url');

const gateway = await startGateway({
  upstream: { baseUrl: 'https://api.deepseek.com/v1', apiKey: process.env.DEEPSEEK_API_KEY },
  rewrite: withContext(context),
  accessToken, // 客户端带 Authorization: Bearer <accessToken>；真密钥只留在这个进程里
  // 缺省只认本机地址的 Host，带 Origin 的浏览器请求一律 403；要放行网页用 allowedOrigins
});

console.log(gateway.baseUrl); // http://127.0.0.1:<随机端口>/v1
```

### 直接用 harness 和编排器

`createContext()` 是糖。底下的几样都能单独拿来用：`createContextBuilder()` 组装上下文，`createHarness()` 跑一轮（出错不抛，`stopReason` 说明原因，日志里有 `ctx.run.started` / `ctx.run.ended`），`createOrchestrator()` 排队：同一会话串行，不同会话并行。

```ts
import {
  createContextBuilder,
  createFunctionExecutor,
  createHarness,
  createMemoryStore,
  createOrchestrator,
  createToolRegistry,
} from '@modelctx-ai/ctx';
import { createModel } from '@modelctx-ai/ctx-models';

const store = createMemoryStore();

// 进程内函数执行环境：名字 → (input, context) => ToolOutput；出错返回 { type: 'error' }，不抛
const local = createFunctionExecutor('local').register(
  { name: 'clock_now', description: '当前时间', inputSchema: { type: 'object', properties: {} } },
  () => ({ type: 'text', text: new Date().toISOString() }),
);

const harness = createHarness({
  store,
  context: createContextBuilder({ store }),
  tools: createToolRegistry({ executor: local }).add(local.definition('clock_now')!),
  // AgentSpec 里的模型只是名字，在这里造出来
  models: (name) =>
    createModel({ baseUrl: 'https://api.deepseek.com/v1', apiKey: process.env.DEEPSEEK_API_KEY, model: name }),
});

const agent = { model: 'deepseek-chat', instructions: '回答控制在一句话。' };
const result = await harness.run({ session: 'demo', agent, input: '现在几点？' });
console.log(result.stopReason, result.text); // end_turn …

const orchestrator = createOrchestrator({ harness, store });
await orchestrator.recover?.(); // 上次崩溃时断掉的运行补一条 ctx.run.ended
const handle = await orchestrator.submit({ session: 'demo', agent, input: '再说一遍？' });
console.log((await handle.done).text);
await orchestrator.close();
```

上面几段都是进程内的用法：`createContext()` 把会话存储、上下文组装、工具、执行环境和 harness 组合成一个对象。要把其中任何一个换掉或放到别处，按协议给另一份实现，见[协议层](docs/protocol.md)；投影规则、记录和压缩的细节见[架构](docs/architecture.md)。

## 在其他仓库里使用

### 现在：同级目录链接

```
<workspace>/
├── ctx/     本仓库，先 pnpm install && pnpm build
└── yoyo/    使用方
```

使用方的 `package.json` 照常写版本范围（`"@modelctx-ai/ctx": "^0.3.0"`），在 `pnpm-workspace.yaml` 里用 `overrides` 指到同级目录：

```yaml
overrides:
  '@modelctx-ai/ctx': link:../ctx/packages/core
  '@modelctx-ai/ctx-exec': link:../ctx/packages/exec
  '@modelctx-ai/ctx-gateway': link:../ctx/packages/gateway
  '@modelctx-ai/ctx-mcp': link:../ctx/packages/mcp
  '@modelctx-ai/ctx-memory': link:../ctx/packages/memory
  '@modelctx-ai/ctx-models': link:../ctx/packages/models
  '@modelctx-ai/ctx-protocol': link:../ctx/packages/protocol
  '@modelctx-ai/ctx-remote': link:../ctx/packages/remote
  '@modelctx-ai/ctx-sqlite': link:../ctx/packages/sqlite
```

使用方读的是 `dist/`，改了 ctx 的源码要在 ctx 里重新 `pnpm build`。

### 发布以后

删掉 `overrides`，重新 `pnpm install`，同样的 `^0.3.0` 从 npm 解析。

## 开发

工具链是 [Vite+](https://viteplus.dev/)（`vite-plus`，命令 `vp`），配置都在根目录和各包的 `vite.config.ts` 里。

| 命令                                | 作用                                                                                        |
| ----------------------------------- | ------------------------------------------------------------------------------------------- |
| `pnpm install`                      | 安装依赖                                                                                    |
| `pnpm typecheck`                    | `vp check --no-fmt --no-lint`：只做类型检查（tsgolint，TS 7），覆盖全部包的源码、测试和配置 |
| `pnpm lint`                         | `vp lint`：Oxlint，带类型信息的规则，同时报类型错误；有警告也算失败                         |
| `pnpm test`                         | `vp test`：Vitest 运行 `packages/*/src/**/*.test.ts`                                        |
| `pnpm build`                        | 每个包 `vp pack`（tsdown）构建 `dist/`（ESM + `.d.ts`）                                     |
| `pnpm format` / `pnpm format:check` | `vp fmt`：Oxfmt 改写 / 检查                                                                 |
| `pnpm check`                        | `vp check`（格式、lint、类型）、test、build；CI 在 Node 22 和 24 上跑同样几步               |

仓库里各包互相引用时按源码解析（`@modelctx-ai/source` 条件，见 [ADR 0002](docs/adr/0002-packages.md)），类型检查和测试不用先构建。

## 要求

| 场景 | 要求                                                                                                                            |
| ---- | ------------------------------------------------------------------------------------------------------------------------------- |
| 开发 | Node ≥22.18（直接运行 `.ts`）；pnpm 10，版本由 `packageManager` 固定                                                            |
| 使用 | Node 版本见包表；peer dependency：`@modelctx-ai/ctx-protocol`（所有实现包）、`zod`（核心包）、`ai@^7`（ctx-models、ctx-memory） |

## 文档

[docs/index.md](docs/index.md)：概念、协议层、参考实现的架构、实践、决策记录。

## 许可

[Apache-2.0](LICENSE)
