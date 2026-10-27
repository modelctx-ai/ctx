# @modelctx-ai/ctx-models

按配置创建 Vercel AI SDK 的 `LanguageModel`。内置 `openai-compatible` 和 `anthropic`（和 dsh-pet 独立模式的协议名一致），可以注册更多服务商。

也按配置创建 System One 模型：`ctx-protocol` 的 `DecisionModel`（Cloudflare Clef、TypeSafe Jev）和 `ExtractionModel`（Cloudflare Clairic），见 [System One 模型](#system-one-模型)。

## 安装

```sh
pnpm add @modelctx-ai/ctx-models @modelctx-ai/ctx-protocol ai zod
```

Node ≥22。`ai`、`@modelctx-ai/ctx-protocol` 是 peer dependency。

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

// 兼容 anthropic 协议的服务：baseUrl 写服务根，请求打到 <baseUrl>/v1/messages
const deepseekAnthropic = createModel({
  provider: 'anthropic',
  baseUrl: 'https://api.deepseek.com/anthropic',
  apiKey: process.env.DEEPSEEK_API_KEY,
  model: 'deepseek-chat',
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

| 字段       | 说明                                                                                                                                                                                                                                                                                    |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `provider` | 服务商协议，缺省 `openai-compatible`                                                                                                                                                                                                                                                    |
| `model`    | 模型名，必填                                                                                                                                                                                                                                                                            |
| `baseUrl`  | 接口根地址，结尾的 `/` 会去掉。`openai-compatible` 必填，写到 `/v1` 为止。`anthropic` 写服务根（例如 `https://api.deepseek.com/anthropic`），不以 `/v1` 结尾时自动补上；不写就用官方的 `https://api.anthropic.com/v1`，不读环境变量 `ANTHROPIC_BASE_URL`。和 dsh-pet 独立模式的写法一致 |
| `apiKey`   | 密钥                                                                                                                                                                                                                                                                                    |
| `headers`  | 额外的请求头                                                                                                                                                                                                                                                                            |
| `name`     | 日志和遥测里显示的服务商名，`openai-compatible` 用                                                                                                                                                                                                                                      |

缺 `model`、服务商没注册、`openai-compatible` 缺 `baseUrl`，都会报出明确的错误。

## System One 模型

`createDecisionModel(spec, options?)`、`createExtractionModel(spec, options?)` 返回 `ctx-protocol` 的 `DecisionModel`、`ExtractionModel`。适配器只做协议和服务之间的薄映射，用全局 `fetch`（可以注入），不依赖服务商的 SDK。

```ts
import { createDecisionModel, createExtractionModel } from '@modelctx-ai/ctx-models';

// Cloudflare Workers AI：POST <baseUrl>/accounts/{accountId}/ai/run/@cf/cloudflare/<model>
const gate = createDecisionModel({
  provider: 'cloudflare',
  model: 'clef-flash', // 或 'clef'
  accountId: process.env.CF_ACCOUNT_ID,
  apiKey: process.env.CF_API_TOKEN,
});
const extractor = createExtractionModel({
  provider: 'cloudflare',
  model: 'clairic',
  accountId: process.env.CF_ACCOUNT_ID,
  apiKey: process.env.CF_API_TOKEN,
});

// TypeSafe：POST <baseUrl>/v1/systemone
const jev = createDecisionModel({ provider: 'typesafe', model: 'jev-latest', apiKey: process.env.TYPESAFE_API_KEY });

const replies = await gate.decide({
  state: '用户：以后回答都用中文。',
  questions: { keep: { type: 'noul', instructions: '值得长期记住吗？' } },
});
```

### `SystemOneSpec`

和 `ModelSpec` 一样可以直接写进配置文件。

| 字段        | 说明                                                                                                                                                        |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `provider`  | 必填，没有缺省。决策模型内置 `cloudflare`、`typesafe`；提取模型内置 `cloudflare`（TypeSafe 的公开 API 没有提取接口）                                        |
| `model`     | 必填。Cloudflare 是 `@cf/cloudflare/` 后面那段（`clef`、`clef-flash`、`clairic`），同时作为请求体里的 `model`；TypeSafe 是 `jev-latest` 这样的名字          |
| `accountId` | Cloudflare 账号 ID，`cloudflare` 必填                                                                                                                       |
| `baseUrl`   | 结尾的 `/` 会去掉。`cloudflare` 缺省 `https://api.cloudflare.com/client/v4`；`typesafe` 写服务根，缺省 `https://api.typesafe.ai`，不以 `/v1` 结尾时自动补上 |
| `apiKey`    | 有就发 `Authorization: Bearer <apiKey>`                                                                                                                     |
| `headers`   | 额外的请求头，覆盖同名的缺省头                                                                                                                              |
| `name`      | 模型的 `name`，缺省 `<provider>:<model>`                                                                                                                    |

第二个参数 `options` 不进配置文件：`fetch` 换掉全局 `fetch`（测试用）。

### 行为

- `decide` 超过 `MAX_DECISION_QUESTIONS`（64）个问题、`choice` 没有选项、`score` 少于两档时，不发请求，抛 `CtxError('invalid_request')`。只有一个选项的 `choice` 本地答（Clef 要 2 个以上选项）。
- 回答收紧到协议：概率归一到和为 1，`choice` 取概率最大的；`score` 按归一后的逐档概率重算成 `Σ pᵢ · i / (n − 1)`（服务返回的 `score` 是 0..n−1 的档位刻度）；`noul`、`confidence`、`pNull` 夹到 0..1。提取的 `value` 按字段类型收紧，收不成的当作没找到（`null`）；`datetime` 能解析但不是 ISO 8601 时转成 ISO。
- 提取：JSON 的 `state` 先序列化成字符串（Clairic 只收字符串）；空输入（null 或空白文字）不发请求，全部答 `{ value: null, pNull: 1, confidence: 1 }`；`duration` 显式要秒。
- 服务不收的问题名、字段名（Clef：`[A-Za-z0-9_.-]`，Clairic：字母或 `_` 开头、最多 64 个字符）换成别名发，回答里换回原名。
- 非 2xx（以及 Cloudflare 外壳里的 `success: false`）抛 `SystemOneError`：继承 `CtxError`，`type` 是 `api_call`，带 `statusCode`、`responseBody`（响应原文），408、429、5xx 的 `retryable` 是 `true`。响应不是 JSON、缺回答、回答类型不对抛 `CtxError('invalid_response')`。
- `signal` 传给 `fetch`；已经中止时不发请求就 reject。

注册别的服务商：

```ts
import { createDecisionModelRegistry } from '@modelctx-ai/ctx-models';

const decisions = createDecisionModelRegistry().register('mine', (spec, { fetch }) => myDecisionModel(spec, fetch));
const model = decisions.create({ provider: 'mine', model: 'x' });
```

请求、响应的形状依据 Cloudflare 的模型页和 JSON schema（`workers-ai/models/clef`、`workers-ai/models/clairic`）以及 TypeSafe 的 OpenAPI（`docs.typesafe.ai/api/system-one`），没有打过真实服务。

## 导出

| 导出                                                                                                                            | 说明                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `createModel(spec)`                                                                                                             | 用内置注册表建模型                                                                                         |
| `createModelRegistry(factories?)`                                                                                               | 新注册表：`register(provider, factory)`、`create(spec)`、`providers()`；传入的工厂可以覆盖内置的           |
| `openAICompatible`、`anthropic`                                                                                                 | 内置的工厂                                                                                                 |
| `DEFAULT_PROVIDER`                                                                                                              | `'openai-compatible'`                                                                                      |
| `ModelSpec`、`ModelFactory`、`ModelRegistry`                                                                                    | 类型                                                                                                       |
| `createDecisionModel(spec, options?)`、`createExtractionModel(spec, options?)`                                                  | 用内置注册表建 System One 模型                                                                             |
| `createDecisionModelRegistry(factories?)`、`createExtractionModelRegistry(factories?)`                                          | 新注册表：`register(provider, factory)`、`create(spec, options?)`、`providers()`；传入的工厂可以覆盖内置的 |
| `cloudflareDecision`、`typesafeDecision`、`cloudflareExtraction`                                                                | 内置的工厂                                                                                                 |
| `SystemOneError`                                                                                                                | 上游非 2xx 时抛的错误                                                                                      |
| `SystemOneSpec`、`SystemOneOptions`、`DecisionFactory`、`ExtractionFactory`、`DecisionModelRegistry`、`ExtractionModelRegistry` | 类型                                                                                                       |
