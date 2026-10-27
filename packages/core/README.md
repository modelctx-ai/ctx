# @modelctx-ai/ctx

ctx 的进程内参考实现。按 [`@modelctx-ai/ctx-protocol`](../protocol) 的协议实现：内存会话存储、投影和来源组成的上下文、工具注册表、函数执行环境、基于 AI SDK `generateText` / `streamText` 的 harness、进程内编排器，以及把它们组合在一个会话上的门面 `createContext()`。

协议包的全部导出（类型、纯函数、`CTX_EVENTS`）这里原样再导出一遍，应用只从 `@modelctx-ai/ctx` 导入就行。

## 安装

```sh
pnpm add @modelctx-ai/ctx @modelctx-ai/ctx-protocol zod
```

Node ≥22。`@modelctx-ai/ctx-protocol` 和 `zod` 是 peer dependency（`zod` 是 `ai` 要的）。

## 用法

### 门面：`createContext()`

```ts
import { createContext, createMemoryStore, defineSource, eventEntry, type LanguageModel } from '@modelctx-ai/ctx';

declare const model: LanguageModel; // 任何 AI SDK 模型，例如 @modelctx-ai/ctx-models 的 createModel()

const context = createContext({
  store: createMemoryStore(),
  session: 'pet:main',
  model,
  sources: [defineSource('task', () => '当前任务：写周报')],
  projection: {
    events: {
      'pet.whisper': {
        fold: true,
        render: (events) => ({
          role: 'assistant',
          content: `碎碎念：\n${events.map((event) => event.text).join('\n')}`,
        }),
      },
    },
    window: { maxTokens: 16_000 },
  },
});

await context.append(eventEntry('pet.whisper', { text: '在呢' }), eventEntry('pet.whisper', { text: '记得喝水' }));

// 用户这句在调用模型前写进日志；失败后用同一个 inputKey 重试，不会记两遍
const reply = await context.generate({
  instructions: '你是桌宠，回答一句话。',
  input: '今天忙吗？',
  inputKey: 'turn-1',
});
console.log(reply.runId, reply.stopReason, reply.text);

const { result, recorded } = await context.stream({ instructions: '你是桌宠，回答一句话。', input: '那明天呢？' });
for await (const delta of result.textStream) process.stdout.write(delta);
console.log((await recorded).length); // 这次写进日志的条目：ctx.run.started、用户这句、回复、ctx.run.ended

await context.compact(); // 历史够长时把较早的部分压成一条摘要
```

`context.builder`、`context.executor`、`context.harness` 是门面内部的 `ContextBuilder`、函数执行环境和 harness，可以直接用。

**`generate` 和 `harness.run` 的差别**：模型出错或被取消时，`context.generate()` 为了和 0.1 兼容抛出原来的错误；`context.harness.run()`（协议的 `Harness.run`）不抛，返回 `stopReason: 'error' | 'aborted'` 和 `error`，日志里照样写 `ctx.run.ended`。两者都只在写日志失败时 reject。

### 函数执行环境

```ts
import { createFunctionExecutor } from '@modelctx-ai/ctx';

const local = createFunctionExecutor('local').register(
  { name: 'clock_now', description: '当前时间，ISO 8601', inputSchema: { type: 'object', properties: {} } },
  () => ({ type: 'text', text: new Date().toISOString() }),
);

await local.execute({ id: 'c1', name: 'clock_now', input: {} }, { session: 'demo' }); // { type: 'text', … }
await local.execute({ id: 'c2', name: 'missing', input: {} }, { session: 'demo' }); // { type: 'error', message: 'Unknown tool …' }
```

不认识的工具、`signal` 已中止、函数抛错都返回 `{ type: 'error' }`，不抛。

### 工具注册表

```ts
import { createToolRegistry, tool } from '@modelctx-ai/ctx';
import { z } from 'zod';

const tools = createToolRegistry().addTool(
  'weather_get',
  tool({
    description: '查城市天气',
    inputSchema: z.object({ city: z.string() }),
    execute: async ({ city }) => `${city}晴`,
  }),
  { tags: ['read'] },
);

tools.get('weather_get'); // { name, description, inputSchema: JSON Schema, executor: 'local', source: 'local', tags: ['read'] }
tools.select({ tags: ['read'] }); // ToolDefinition[]
tools.toolSet({ tags: ['read'] }); // AI SDK ToolSet：execute 转给绑定的执行环境
```

`addTool` 把 zod 工具转成 JSON Schema 定义（`asSchema(...).jsonSchema`），执行函数放进注册表自带的函数执行环境 `tools.executor`；执行时先按原来的 zod 校验输入。`add(definition)` 加别的执行环境的工具（例如 MCP）。

### Harness

```ts
import { createContextBuilder, createHarness, createMemoryStore } from '@modelctx-ai/ctx';

const store = createMemoryStore();
const harness = createHarness({
  store,
  context: createContextBuilder({ store, factsPlacement: 'prompt' }),
  tools, // 上面的注册表；它自带的函数执行环境自动加进 executors
  executors: [], // 其余执行环境，例如 ctx-mcp 的 hub；工具绑定的执行环境不在这里，开跑前 logger.warn 一次，调用时模型收到错误
  models: (name) => createMyModel(name), // AgentSpec.model 是名字时怎么造
  hooks: {
    beforeTool: (call) => (call.name === 'weather_get' ? undefined : { allow: false, reason: '只能查天气' }),
  },
});

const result = await harness.run({
  session: 'user:42',
  agent: { model: 'deepseek-chat', instructions: '你是生活助手。', tools: { tags: ['read'] } },
  input: '台北下午要带伞吗？',
});

for await (const event of harness.stream({
  session: 'user:42',
  agent: { model: 'deepseek-chat' },
  input: '明天呢？',
})) {
  if (event.type === 'text.delta') process.stdout.write(event.text);
}
```

流程：`ctx.run.started` → 记输入（`inputKey` 幂等）→ `build` → `beforeModel` → 调模型（每个工具调用经 `beforeTool` → 执行环境 → `afterTool`）→ 记产出 → `ctx.run.ended`。`record: false` 一条都不写。

`AgentSpec.context` 按一轮选事实和投影（只按名字选，所以能序列化）：builder 里注册，agent 里引用。

```ts
const builder = createContextBuilder({
  store,
  sources: [clock, weather], // ContextSource，按 name 选
  projection: {}, // default
  projections: { brief: { window: { maxMessages: 6 } } },
});
// 只用 weather 的事实，放进最后一条临时用户消息；用 brief 投影
const agent = {
  model: 'deepseek-chat',
  context: { facts: { sources: ['weather'], placement: 'prompt' }, projection: 'brief' },
};
```

`facts: false` 不收事实；不认识的投影名这一轮以 `not_found` 结束，不回退到缺省。

### 编排器

```ts
import { createOrchestrator } from '@modelctx-ai/ctx';

const orchestrator = createOrchestrator({ harness, store, owner: 'pet' });
// 用缺省 record（写日志）的应用：启动时先 recover 再 submit，否则崩溃留下的运行会让该会话一直 session_busy
await orchestrator.recover?.(); // 给崩溃时断掉的运行补 ctx.run.ended（error）
const handle = await orchestrator.submit({ session: 'user:42', agent: { model: 'deepseek-chat' }, input: '在吗' });
await orchestrator.status(handle.runId); // queued / running / completed / failed / cancelled
await handle.done;
await orchestrator.close();
```

同一会话串行，不同会话并行；`cancel` 取消排队中或运行中的一轮；`events()` 给出状态变化。

## 导出

| 导出                                                                                                                                | 说明                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 协议包的全部导出                                                                                                                    | `SessionStore`、`ContextBuilder`、`ToolRegistry`、`Executor`、`Harness`、`Orchestrator` 等类型，条目构造、`project`、`collectFacts`、`selectTools`、`toolOutputToAiSdk` 等纯函数，`CTX_EVENTS`                                                                                                                                                                           |
| `createMemoryStore({ now?, id? })`                                                                                                  | 内存 `SessionStore`，带 `watch`                                                                                                                                                                                                                                                                                                                                          |
| `createFunctionExecutor(name = 'local')`                                                                                            | 进程内函数执行环境：`register(definition, fn, { replace? })`、`unregister`、`has`、`definition`、`tools`、`execute`                                                                                                                                                                                                                                                      |
| `createToolRegistry({ executor? })`                                                                                                 | `ToolRegistry` 加 `addTool(name, tool, meta?)`、`addAll`、`toolSet(filter?, { executors? })`、`executor`；`add(name, tool, meta)` 是弃用的写法                                                                                                                                                                                                                           |
| `toToolSet(definitions, executors, { session?, runId?, dispatch? })`、`dispatchTo(executors)`                                       | 定义包成 AI SDK `ToolSet`，`execute` 转给绑定的执行环境                                                                                                                                                                                                                                                                                                                  |
| `createContextBuilder({ store, projection?, projections?, sources?, sourceTimeoutMs?, logger?, factsPlacement?, model?, models? })` | `ContextBuilder`：`build`、`view`、`compact`，另加 `facts(session, signal?, { sources? })`、`recompact`                                                                                                                                                                                                                                                                  |
| `createHarness({ store, context, tools?, executors?, models?, hooks?, logger?, source? })`                                          | `Harness`：`run`、`stream`                                                                                                                                                                                                                                                                                                                                               |
| `createOrchestrator({ harness, store?, owner?, logger? })`                                                                          | `Orchestrator`：`submit`、`status`、`cancel`、`events`、`close`；给了 `store` 才有 `recover`                                                                                                                                                                                                                                                                             |
| `createContext(options)`                                                                                                            | 门面：`append`、`entries`、`view`、`facts`、`prepare`、`generate`、`stream`、`compact`，以及 `builder`、`executor`、`harness`                                                                                                                                                                                                                                            |
| `describeError`、`redact`、`errorInfo`                                                                                              | 给日志和界面用的错误摘要；去密钥；`RunResult.error` 的形状                                                                                                                                                                                                                                                                                                               |
| `toModelMessages`、`fromModelMessages`（单条是 `toModelMessage`、`fromModelMessage`）、`toUserContent`、`fromUserContent`           | ctx 的 `Message` 和 AI SDK 的 `ModelMessage`、`UserContent` 互转；遇到子集之外的部件抛 `unsupported_part`，harness 把这一轮以 `error` 结束。`createContext()` 仍收 AI SDK 的 `UserContent`，在边界上转                                                                                                                                                                   |
| `findLossySummaries(store, { session? })`、`recompactLossy(builder, finding, options)`                                              | 升级后修复：列出 0.2 写的、有条目被新规则盖住的摘要，再用模型重新压缩一次（见[协议层](https://github.com/modelctx-ai/ctx/blob/main/docs/protocol.md#消息格式和版本)）                                                                                                                                                                                                    |
| `tool`、`dynamicTool`、`jsonSchema`、`zodSchema`、`asSchema`、`stepCountIs`，`ModelMessage`、`LanguageModel`、`ToolSet` 等类型      | 从 `ai` 转出，应用不用单独依赖 `ai`                                                                                                                                                                                                                                                                                                                                      |
| `@modelctx-ai/ctx/testing`                                                                                                          | 原样转出协议包的 `/testing`：契约测试（`describeSessionStoreContract` 等，含记忆的 `describeMemoryStoreContract`、`describeDecisionModelContract`、`describeExtractionModelContract`、`describeMemoryContract`）和剧本式的 `createScriptedDecisionModel`、`createScriptedExtractionModel`；另加 `createScriptedModel(script, { tool? })`：按剧本回答的假 `LanguageModel` |

`createContext` 的选项：`store`、`session`、`projection`、`sources`、`sourceTimeoutMs`、`factsPlacement`、`tools`、`executors`、`hooks`、`model`、`source`、`logger`。

契约测试：核心包的内存存储、函数执行环境、注册表、harness、编排器分别跑 `describeSessionStoreContract`、`describeExecutorContract`、`describeToolRegistryContract`、`describeHarnessContract`、`describeOrchestratorContract`。

细节见[架构](https://github.com/modelctx-ai/ctx/blob/main/docs/architecture.md)和[协议层](https://github.com/modelctx-ai/ctx/blob/main/docs/protocol.md)。
