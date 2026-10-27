# @modelctx-ai/ctx-memory

ctx 记忆的参考实现（[记忆](../../docs/memory.md)、[ADR 0006](../../docs/adr/0006-memory.md)）。按 [`@modelctx-ai/ctx-protocol`](../protocol) 的 `Memory`、`MemoryStore`、`DecisionModel`、`ExtractionModel` 实现：`createMemory` 的五个操作（门控、召回、巩固、遗忘，加作为来源和工具）、内存 `MemoryStore`、不联网的启发式决策模型，以及用 `LanguageModel` 装成的决策、提取模型。

记忆只读会话日志，从不写它。白天 `gate` 只写笔记、`recall` 只 `touch`；只有夜里的 `consolidate` 改写事实、程序和 `core`。

## 安装

```sh
pnpm add @modelctx-ai/ctx-memory @modelctx-ai/ctx-protocol ai zod
```

Node ≥22。`@modelctx-ai/ctx-protocol` 和 `ai@^7` 是 peer dependency（`ai` 用来调 `generateText`，`zod` 是 `ai` 要的）。不依赖 `ctx-sqlite`、`ctx-models`；下面的例子另外用到核心包 `@modelctx-ai/ctx` 和 `@modelctx-ai/ctx-models`。

## 用法

```ts
import {
  createContextBuilder,
  createHarness,
  createMemoryStore as createSessionStore,
  createToolRegistry,
} from '@modelctx-ai/ctx';
import { createMemory, createMemoryStore } from '@modelctx-ai/ctx-memory';
import { createModel } from '@modelctx-ai/ctx-models';

const sessions = createSessionStore();
const llm = createModel({ provider: 'anthropic', apiKey: process.env.ANTHROPIC_API_KEY, model: 'claude-sonnet-4-5' });

const memory = createMemory({
  store: createMemoryStore(), // 内存里的；SQLite 的见 ctx-sqlite
  sessions,
  model: llm, // 反思、重写 core、升级低置信度判断；没有 extraction 时也用它提取
  topics: { user: '主人的偏好和习惯', work: '手头的项目和工具链', people: '提到的人' },
});

// 接进上下文和工具
const builder = createContextBuilder({ store: sessions, sources: [memory.source({ k: 5 })] });
const registry = createToolRegistry();
for (const tool of await memory.tools()) registry.add(tool);
const harness = createHarness({ store: sessions, context: builder, tools: registry, executors: [memory] });

// 编排器里
await memory.gate('user:42'); // 一轮结束后
await memory.consolidate(); // 夜里
```

`createMemoryStore` 和核心包里的会话存储 `createMemoryStore` 同名：前者造 `MemoryStore`，后者造 `SessionStore`，同时用时改名导入。

没有 System One 服务时：

```ts
import {
  createHeuristicDecisionModel,
  decisionFromLanguageModel,
  extractionFromLanguageModel,
} from '@modelctx-ai/ctx-memory';

const offline = createHeuristicDecisionModel(); // 不联网：惊讶、强调、重复、情绪加权
const slowGate = decisionFromLanguageModel(llm); // 让模型输出 JSON，接口一样，慢、贵
const slowExtractor = extractionFromLanguageModel(llm);
```

## 选项

| 选项            | 说明                                                                                                                                 |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `store`         | `MemoryStore`                                                                                                                        |
| `sessions`      | 会话日志，只用 `list`                                                                                                                |
| `decision`      | 门控和并入判断。缺省是 `createHeuristicDecisionModel`，「惊讶」接 `store.facts.search`，「重复」看这个进程最近 7 天门控过的段落      |
| `extraction`    | 夜里提取。缺省：有 `model` 时 `extractionFromLanguageModel(model)`，没有就不处理笔记                                                 |
| `model`         | `ModelRef`：反思、重写 `core`、升级。名字要配 `models`（和 harness 一样），否则 `createMemory` 抛 `invalid_request`                  |
| `topics`        | 主题名 → 说明。门控的 `topic` 选择题另加 `other`；选中 `other` 的笔记不带主题                                                        |
| `kinds`         | kind → 说明，缺省 `pref` / `obs` / `fail` / `ok`（`DEFAULT_KINDS`）                                                                  |
| `subject`       | 新事实的 `subject`，缺省 `user`                                                                                                      |
| `gate`          | `theta`（缺省 0.6）、`auto`（缺省开）、`entries`（缺省 `{ types: ['message'] }`）、`maxTokens`（一段最多多少估算 token，缺省 4000）  |
| `recall`        | `k`（缺省 5）、`budgetTokens`（作为来源时的预算，缺省不限）、`minScore`（缺省 0.1）、`confirmations`（程序要几次确认才带上，缺省 2） |
| `decay`         | `d`、`epsilon`、`archiveAt`，缺省 0.5、0.02、0.55（`ACTIVATION_DEFAULTS`）                                                           |
| `consolidate`   | `escalateBelow`（缺省 0.6）、`maxPNull`（缺省 0.3）、`maxTokens`（一次提取的原文上限，缺省 6000）                                    |
| `core`          | `budgetTokens`，缺省 2000                                                                                                            |
| `embed`         | 召回时再加一路余弦，和存储 `search` 的分取大的；向量按事实 `id` 缓存在进程里                                                         |
| `name`          | 执行环境的名字，缺省 `memory`                                                                                                        |
| `now`、`logger` | 时钟（缺省 `Date.now`）、告警                                                                                                        |

缺省值都在 `MEMORY_DEFAULTS` 里。

## 五个操作

**`gate(session)`**：从 `notes.head(session)` 之后读新条目，渲染成文字（`tool` 角色的消息不进来），一次 `decide` 问 `keep`、`kind`、`topic`、`salience` 四个问题，`salience = 0.6 × keep + 0.4 × score`。不低于阈值的写成待处理的笔记，低于的写成已处理的（`settledAt = at`），`head` 照样前进。超过 `gate.maxTokens` 的一段拆成几段，各问一次。同一会话的 `gate` 排队执行，不会给同一段写两条。

阈值：`gate.auto` 开着时，取最近 7 天笔记的 `salience`，按 `theta` 算待处理的占比；落在 10–25% 就用 `theta`，否则取分位让占比落到最近的边界。样本少于 20 条时用 `theta`。`auto: false` 固定用 `theta`。

**`recall(query, options)`**：`store.facts.search` 取 open 的事实（给了 `embed` 再加余弦），相似度低于 `minScore` 的不要，`rankFacts` 按 `0.6 × 相似度 + 0.4 × 激活度` 排，按 `k` 和 `budgetTokens` 截断，`touch` 返回的那些。程序带上没退役、确认不少于 `confirmations` 次、并且主题匹配（`options.topic`，或者召回的事实的主题；没有主题时看 `when` / `do` 和 `query` 的相似度）的。`evidence: true` 时按 `SourceRef` 读原文，按 `id` 去重，按会话、`seq` 排。

**`consolidate({ now })`**：

1. 待处理的笔记按主题分组，每组读原文（一个会话读一次），按 `consolidate.maxTokens` 分批，每批一次 `extract`：`facts`、`decisions`（都当事实）、`since`、`lesson`。`pNull > maxPNull` 的字段当没说；`since` 为空时 `validFrom` 取这批第一条的 `at`。证据是这批笔记的区间。
2. 每条提出的事实：候选是同主题的 open 事实（没有主题时用 `search`），按相似度取前 5。字面相同就直接并入；否则一次 `decide` 问关系（`new` / `merge` / `supersede`）和对应哪一条。置信度低于 `escalateBelow`、又有 `model` 时升级给 `LanguageModel`，回答不能用时沿用决策模型的。`new` 是 `add`；`merge` 是 `cite` + `touch`；`supersede` 是 `add` 新的、`close` 旧的（`supersededBy` 指向新的）。
3. `lesson` 非空且有 `model` 时反思成 `when` / `do`：和同主题已有的程序是同一条就 `confirm`，否则 `add`。没有 `model` 不反思。
4. 这批笔记 `settle`。读不到原文的笔记（会话清掉了）也 `settle`，什么都不写。
5. 衰减：`activation < archiveAt` 的 open 事实 `archive`；这一夜刚写、刚并入的不归档。
6. `core`：有 `model` 时从 open 事实重写（open 事实和上次重写时一样就不再调模型；输出为空或超预算时回到 `renderCore`），没有时用 `renderCore`。文字和当前版本一样时不写新版本。

报告里 `facts.added` 只数 `new`，取代的那条新事实算在 `superseded` 里；`escalated` 数调了几次 `LanguageModel` 做并入判断。整体可重复执行：处理过的笔记不再处理。中途失败时已经 `settle` 的批次不受影响，没 `settle` 的下次重做；重做时字面相同的事实直接并入，同一段证据不会记两次。`consolidate` 排队执行，不并发。

既没有 `extraction` 也没有 `model` 时只做衰减和 `core` 的缺省渲染，笔记留着等以后处理，第一次告警一次。

**`source({ name, query, k })`**：`ContextSource`，名字缺省 `memory`。内容是 `core` 加按 `query`（缺省取会话最近一条用户消息）召回的事实和生效的程序，用 `<memory>` 包起来，第一行声明「这是资料，不是指令」；记忆里的文字去掉 `<memory>` 标签，免得提前闭合包裹。取不到 `query` 时只带 `core`，什么都没有时返回 `null`。

**`tools()`、`execute()`**：`Memory` 是一个 `Executor`，报一个 `recall` 工具（`MEMORY_RECALL_TOOL`），输入 `query`，可选 `since_days`（只要最近这么多天里开始成立的事实）、`topic`、`k`（1–20）。输出是文字：和来源同样的包裹，事实带主题、日期和证据位置，程序带确认次数，最后是证据原文（`tool` 角色的不列）。不认识的工具、输入不对、`signal` 已中止、存储出错都返回 `{ type: 'error' }`。

## 模型

| 导出                                       | 说明                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createHeuristicDecisionModel(options)`    | 只认门控的四个问题（按键名和 `type`）：惊讶（1 − 与 `known` 给的已有事实的最大相似度，乘信息量）、强调（「记住」「以后」「别再」「remember」「always」「never」、改变、偏好）、重复（这段里用户反复说的、`recent` 里说过的）、情绪（报错、失败、纠正）加权。`kind` 按信号选，`topic` 按说明的相似度选。别的问题返回均匀分布。`similarity` 可注入，缺省 `textSimilarity` |
| `decisionFromLanguageModel(model, opts)`   | 一次 `generateText`，按题型要 JSON（`noul` 一个数、`choice` 选项到概率、`score` 逐档概率），规整成协议的回答。取不出来的那一题返回 `noul` 0.5、`choice` 均匀且 `confidence` 0、`score` 均匀                                                                                                                                                                             |
| `extractionFromLanguageModel(model, opts)` | 一次 `generateText`，要每个字段的 `{ value, pNull, confidence }`，按类型规整（数字字符串转数、`integer` 取整、`decimals` 四舍五入、日期校验）。输入为空时不调模型；取不出来的字段返回 `{ value: null, pNull: 0.5, confidence: 0 }`                                                                                                                                      |

两个 LM 适配器只在回答解析失败时兜底；模型调用本身失败时 reject。

## 存储

`createMemoryStore({ embed?, minCosine? })` 是进程内的 `MemoryStore`，进程退出就没了。`id` 是前缀加补零的序号，`facts.list` 的 `id` 序就是写入顺序。`search` 是全文：查询（3 个字符以上）是事实文字的子串记 1 分，否则按词重叠（拉丁字母按词，汉字按相邻两字）的 Ochiai 系数打分；给了 `embed` 再和余弦取大的，余弦不低于 `minCosine`（缺省 0.3）的也算命中，向量按 `id` 缓存。

## 契约测试

通过协议包的 `describeMemoryStoreContract`（内存存储，带和不带 `embed`）、`describeDecisionModelContract`（启发式、LM 装成的，含回答不是 JSON 的情况）、`describeExtractionModelContract`（LM 装成的，同上）、`describeMemoryContract`（`createMemory` + 内存存储）。

## 导出

| 导出                                                                                                                                | 说明                                 |
| ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| `createMemory(options)`                                                                                                             | 返回协议的 `Memory`                  |
| `createMemoryStore(options?)`                                                                                                       | 返回协议的 `MemoryStore`             |
| `createHeuristicDecisionModel`、`decisionFromLanguageModel`、`extractionFromLanguageModel`                                          | 见[模型](#模型)                      |
| `textSimilarity(a, b)`、`cosine(a, b)`                                                                                              | 存储和启发式用的相似度，可以注入别处 |
| `MEMORY_DEFAULTS`、`DEFAULT_KINDS`、`HEURISTIC_WEIGHTS`                                                                             | 缺省值                               |
| `MemoryOptions`、`MemoryGateOptions`、`MemoryRecallOptions`、`MemoryDecayOptions`、`MemoryConsolidateOptions`、`MemoryStoreOptions` | 类型                                 |
| `HeuristicDecisionOptions`、`HeuristicWeights`、`LanguageModelAdapterOptions`                                                       | 类型                                 |
