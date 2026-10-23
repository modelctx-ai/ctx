# @modelctx-ai/ctx

ctx 的核心包：只追加的上下文日志、投影成 AI SDK 消息、上下文来源、工具注册表，以及基于 `generateText` / `streamText` 的 `createContext()`。只依赖 `ai`。

## 安装

```sh
pnpm add @modelctx-ai/ctx zod
```

Node ≥22。`zod` 是 `ai` 的 peer dependency。

## 用法

```ts
import { createContext, createMemoryStore, defineSource, eventEntry, type LanguageModel } from '@modelctx-ai/ctx';

declare const model: LanguageModel; // 任何 AI SDK 模型，例如 @modelctx-ai/ctx-models 的 createModel()

const context = createContext({
  store: createMemoryStore(),
  thread: 'pet:main',
  model,
  sources: [defineSource('task', () => '当前任务：写周报')],
  projection: {
    events: {
      whisper: {
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

await context.append(eventEntry('whisper', { text: '在呢' }), eventEntry('whisper', { text: '记得喝水' }));

// 用户这句在调用模型前写进日志；失败后用同一个 inputKey 重试，不会记两遍
const reply = await context.generate({
  instructions: '你是桌宠，回答一句话。',
  input: '今天忙吗？',
  inputKey: 'turn-1',
});
console.log(reply.text);

const { result, recorded } = await context.stream({ instructions: '你是桌宠，回答一句话。', input: '那明天呢？' });
for await (const delta of result.textStream) process.stdout.write(delta);
console.log((await recorded).length); // 这次写进日志的条目：用户这句和回复

await context.compact(); // 历史够长时把较早的部分压成一条摘要
```

## 导出

| 导出                                                                                                               | 说明                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `createContext(options)`                                                                                           | 绑定存储和线程：`append`、`entries`、`view`、`facts`、`prepare`、`generate`、`stream`（返回 `{ result, recorded }`）、`compact` |
| `createMemoryStore(options?)`、`ContextStore`                                                                      | 进程内存储；存储接口                                                                                                            |
| `userEntry`、`assistantEntry`、`messageEntry`、`eventEntry`                                                        | 构造新条目                                                                                                                      |
| `project(entries, options)`、`ProjectionOptions`、`EventRule`                                                      | 条目渲染成 `ModelMessage[]`                                                                                                     |
| `defineSource`、`collectFacts`、`renderFacts`                                                                      | 上下文来源和事实                                                                                                                |
| `createToolRegistry()`                                                                                             | 工具注册表                                                                                                                      |
| `estimateTokens`、`estimateTextTokens`                                                                             | 不依赖分词器的 token 估算                                                                                                       |
| `describeError`、`redact`                                                                                          | 给日志和界面用的错误摘要；去密钥                                                                                                |
| `compareCursor`、`cursorOf`、`textOf`、`latestSummary`                                                             | 游标和消息的工具函数                                                                                                            |
| `tool`、`dynamicTool`、`jsonSchema`、`zodSchema`、`stepCountIs`，`ModelMessage`、`LanguageModel`、`ToolSet` 等类型 | 从 `ai` 转出，应用不用单独依赖 `ai`                                                                                             |
| `@modelctx-ai/ctx/testing` 的 `describeStoreContract(name, factory, { describe, test })`                           | 自定义存储的契约测试；`describe`、`test` 由调用方传入，Vitest、`node:test`、Jest、Bun 都能跑，不依赖测试框架                    |

细节见[架构](https://github.com/modelctx-ai/ctx/blob/main/docs/architecture.md)和[上下文模型](https://github.com/modelctx-ai/ctx/blob/main/docs/adr/0003-context-model.md)。
