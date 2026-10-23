# @modelctx-ai/ctx-models

按配置创建 Vercel AI SDK 的 `LanguageModel`。内置 `openai-compatible` 和 `anthropic`（和 dsh-pet 独立模式的协议名一致），可以注册更多服务商。

## 安装

```sh
pnpm add @modelctx-ai/ctx-models ai zod
```

Node ≥22。`ai` 是 peer dependency。

## 用法

```ts
import { createModel } from '@modelctx-ai/ctx-models';

// 缺省 openai-compatible：baseUrl 写到 /v1 为止
const deepseek = createModel({
  baseUrl: 'https://api.deepseek.com/v1',
  apiKey: process.env.DEEPSEEK_API_KEY,
  model: 'deepseek-chat',
});

// anthropic：不写 baseUrl 就用官方地址
const claude = createModel({
  provider: 'anthropic',
  apiKey: process.env.ANTHROPIC_API_KEY,
  model: 'claude-sonnet-4-5',
});
```

注册别的服务商：

```ts
import { createOpenAI } from '@ai-sdk/openai';
import { createModelRegistry } from '@modelctx-ai/ctx-models';

const models = createModelRegistry().register('openai', (spec) =>
  createOpenAI({ apiKey: spec.apiKey, baseURL: spec.baseUrl })(spec.model),
);

const model = models.create({ provider: 'openai', model: 'gpt-5-mini', apiKey: process.env.OPENAI_API_KEY });
```

## `ModelSpec`

一份可以直接写进配置文件的模型描述。

| 字段       | 说明                                                                                       |
| ---------- | ------------------------------------------------------------------------------------------ |
| `provider` | 服务商协议，缺省 `openai-compatible`                                                       |
| `model`    | 模型名，必填                                                                               |
| `baseUrl`  | 接口根地址。`openai-compatible` 必填，写到 `/v1` 为止，结尾的 `/` 会去掉；`anthropic` 可选 |
| `apiKey`   | 密钥                                                                                       |
| `headers`  | 额外的请求头                                                                               |
| `name`     | 日志和遥测里显示的服务商名，`openai-compatible` 用                                         |

缺 `model`、服务商没注册、`openai-compatible` 缺 `baseUrl`，都会报出明确的错误。

## 导出

| 导出                                         | 说明                                                                                             |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `createModel(spec)`                          | 用内置注册表建模型                                                                               |
| `createModelRegistry(factories?)`            | 新注册表：`register(provider, factory)`、`create(spec)`、`providers()`；传入的工厂可以覆盖内置的 |
| `openAICompatible`、`anthropic`              | 内置的工厂                                                                                       |
| `DEFAULT_PROVIDER`                           | `'openai-compatible'`                                                                            |
| `ModelSpec`、`ModelFactory`、`ModelRegistry` | 类型                                                                                             |
