---
type: Decision Record
title: 'ADR 0006：记忆作为第八个组件，只读日志、夜里改写、System One 做判断'
description: '记忆作为第八个组件：只读日志、夜里改写、事实不 UPDATE、证据必填、System One 模型做判断、遗忘是公式、只用已有扩展点接入'
tags: [adr, memory]
status: stable
---

# ADR 0006：记忆作为第八个组件，只读日志、夜里改写、System One 做判断

- 状态：已采纳（2026-10-27 实施时按「决定记录」修订）
- 实施状态：已实施，未发布（0.4 计划）。阶段 1 协议 `3807576`（`ctx-protocol`：接口、纯函数、契约测试、剧本模型）；阶段 2 `ctx-sqlite` `68c8e2c`、`ctx-models` `990aaae`、新包 `ctx-memory` `363fce4`；`ctx-remote` `af0a889`（`/memory/*`、`createRemoteMemoryStore`）；文档同步 `591b4dc`。协议和参考实现见[记忆](../memory.md)
- 日期：2026-10-27
- 范围：`ctx-protocol`（`MemoryStore`、`DecisionModel`、`ExtractionModel`）、新包 `ctx-memory`、`ctx-sqlite`（记忆存储）、`ctx-models`（System One 工厂）、`ctx-remote`（`/memory/*`）；yoyo 作为实践
- 依据：2026 年 Agent Memory 方案的调研（Mem0、Zep / Graphiti、Letta、Hindsight、LongMemEval-V2、Redis 的混合存储实验），互补学习系统（CLS）和 ACT-R 的激活模型，Cloudflare 的 System One 模型（Clef、Clairic）

## 背景

会话日志（[ADR 0003](0003-context-model.md)）记下一个 agent 经历过的一切，投影和压缩决定模型这一次看到多少。这解决了「不忘记当前任务」。三件事它解决不了：

1. **跨会话的事实。** 主人偏好什么、当前在做哪个项目、上个月换过什么。这些散在几千条日志里，压缩会丢，全文检索找回来的是原话不是结论。
2. **事实的变化。** 「项目从 X 换到 Y」之后，既要知道现在是 Y，也要能查当时是 X。日志只有时间顺序，没有有效期。
3. **经验。** 同类失败第二次出现时，agent 应该比第一次快。日志里有失败的记录，没有从失败归纳出来的规则。

[ADR 0003](0003-context-model.md) 的「没有采用」里写过：以向量检索为主的存储不在核心包范围里，需要时写成 `ContextSource` 或工具。这条仍然成立，但只覆盖了检索，没有覆盖上面三件事里的「提炼」和「更新」。

调研的结论：没有公认的最优方案，主流路线是分层记忆 + 结构化提取 + 混合检索，知识图谱和自主反思按需加。混合方案（原始日志 + 提取层）在 LongMemEval 上比只做提取高十几个点；LongMemEval-V2 开始考察经验类记忆。真正决定效果的是三个决策：什么值得记、什么时候想起、旧记忆怎么更新和遗忘。

生物学给了一个现成的分工：海马体快速记下情节并建索引，新皮层在睡眠中慢速整合成语义知识，杏仁核给事件打「值得记」的标签，激活度随时间衰减、回忆时重新加强。ctx 的会话日志就是海马体；缺的是其余三样。

## 决定

### 1. 记忆是第八个组件，协议是 `MemoryStore`

一个独立的存储，四个集合：笔记 `Note`（门控结果，指向日志的 `seq` 区间）、事实 `Fact`（带有效期、来源、召回时间戳）、程序 `Procedure`（触发条件、动作、证据、确认次数）、画像 `core`（一段常驻文字，保留历史版本）。全部只收发 JSON，可以放到进程边界另一侧，可以和会话日志共用一个 SQLite 库。

不把记忆做成会话日志的事件：事实要按主语查、按有效期筛、按激活度排，日志的 `list` 做不到。不把记忆做成 `ContextBuilder` 的一部分：builder 每次重算、不持久，记忆要跨会话持久。

### 2. 记忆只读会话日志，从不改它

`gate` 用 `list({ after })` 读新条目，`consolidate` 按 `SourceRef` 读原文。记忆不 `append`。会话日志仍是唯一的真相；记忆是从真相里提炼、可以丢掉重建的东西。应用要在日志里留痕，自己追加事件。

### 3. 快的在白天、不改写；慢的在夜里、是唯一改写记忆的地方

| 操作              | 节律     | 改写记忆   | 谁算                                  |
| ----------------- | -------- | ---------- | ------------------------------------- |
| `gate`            | 每轮后   | 只写笔记   | 决策模型或启发式，< 300 ms，异步      |
| `recall`          | 组装前   | 只 `touch` | 代码：相似度 + 激活度                 |
| `consolidate`     | 夜里     | 是         | 提取模型 → 决策模型 → `LanguageModel` |
| 衰减归档          | 夜里     | 是         | 公式                                  |
| `close`、`forget` | 主人操作 | 是         | 应用界面                              |

即使提取模型快到可以在线做，也不在一轮里改写记忆：改写集中在一处，可重复、可回滚，白天出错不会污染记忆。

### 4. 事实不 UPDATE，证据必填

事实的文字写入后不改：变了就 `close` 旧的、`add` 新的，`supersededBy` 连起来。每条事实和程序必须有 `SourceRef` 指回日志。没有证据的事实不进存储。`archive` 退出查询但不删，`forget` 才删。

### 5. 判断交给 System One 模型，归纳留给 `LanguageModel`

记忆回路里的多数判断是分类、打分、填字段：值不值得记（是 / 否）、哪一类、哪个主题、多重要、事件里有哪些事实、新事实和旧事实是什么关系。这些交给单次前向、返回概率、只收输入 token 的模型。ctx 为它们定两个协议 `DecisionModel`、`ExtractionModel`，形状跟着 Cloudflare 的 System One API（Clef、Jev、Clairic）走，类型是 ctx 自己的 JSON。`LanguageModel` 只做两件开放生成的事：把教训写成规则、重写 `core`；再加低置信度判断的升级。

推理 token 因此从每天约 30k 降到约 12k；在线路径对一轮的延迟是零。没有 System One 服务时有启发式实现和「用 `LanguageModel` 装成决策模型」两条退路，接口不变。

### 6. 遗忘是公式，不是模型

ACT-R 的基础激活 `A = ln Σ (Δt_i + ε)^(−d) + s`：每次召回是一个 `t_i`，显著性 `s` 是偏置。注入排序和夜间归档用同一个 `A`。`activation` 是协议包里的纯函数，参数（`d`、`archiveAt`）由应用配。

### 7. 接进其余组件只用已有的扩展点

`Memory` 门面是一个 `Executor`（提供 `recall` 工具，和 MCP hub 一个思路），`memory.source()` 是一个 `ContextSource`。`AgentSpec.context.facts.sources` 按名字选用。`gate` 和 `consolidate` 什么时候跑是编排器的事。harness、会话、工具目录的协议不改。

## 包布局

| 包                 | 加什么                                                                                                                                                                                                                                                                                                                                                  |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ctx-protocol`     | `MemoryStore`、`DecisionModel`、`ExtractionModel`、门面 `Memory` 的接口和 JSON 形状；常量 `MAX_DECISION_QUESTIONS`、`MEMORY_RECALL_TOOL`、`ACTIVATION_DEFAULTS`；纯函数 `activation`、`rankFacts`、`renderCore`、`sourceRef` 和存储实现用的校验函数；`/testing` 的四个契约测试和剧本模型 `createScriptedDecisionModel`、`createScriptedExtractionModel` |
| `ctx-memory`（新） | `createMemory`、内存 `MemoryStore`（`createMemoryStore`，和核心包的会话存储同名）、启发式决策模型 `createHeuristicDecisionModel`、`decisionFromLanguageModel`、`extractionFromLanguageModel`、`textSimilarity`、`cosine`、缺省值 `MEMORY_DEFAULTS`、`DEFAULT_KINDS`、`HEURISTIC_WEIGHTS`                                                                |
| `ctx-sqlite`       | `createSqliteMemoryStore({ database \| path, prefix = 'memory_', busyTimeoutMs, id })`，可以和 `ctx_` 表共用一个库；结构版本独立（`memory_schema`）                                                                                                                                                                                                     |
| `ctx-models`       | `createDecisionModel`、`createExtractionModel` 和各自的注册表：决策模型内置 `cloudflare`（Clef）、`typesafe`（Jev），提取模型只内置 `cloudflare`（Clairic）；`SystemOneError`                                                                                                                                                                           |
| `ctx-remote`       | 服务端挂 `memory`：`/memory/notes`、`/memory/facts`、`/memory/procedures`、`/memory/core`；客户端 `createRemoteMemoryStore`                                                                                                                                                                                                                             |

`ctx-memory` 只依赖协议包，`ai` 是 peer（`generateText`）；要 `LanguageModel` 时经 `ModelRef`，名字靠 `models` 解析，和 harness 一样。`ctx-models` 因为返回协议的 `DecisionModel`、`ExtractionModel`，从此也把协议包当 peer。

## 代价

- 多一个存储、多两类模型、多一个夜间任务。单进程的最小用法（`createContext()` 三行）不受影响：不建 `Memory` 就什么都没有。
- System One 模型目前只有少数服务商（Cloudflare、TypeSafe），Clairic 还是预览版，TypeSafe 没有提取接口。协议是 ctx 自己的，适配器薄，但服务商换接口要跟；适配器按公开文档写成，没有对真实服务验证过。
- 提取和并入的质量取决于模型，输出总是合法但未必正确。靠 `confidence`、`pNull` 阈值和抽样复核兜底，不能靠协议保证。
- `core` 每夜重写一次，`LanguageModel` 的开销固定存在；没有模型就不重写，`core` 退化成手写。
- 激活度的参数要按应用调；缺省值来自个人助理的量级。

## 没有采用

- **知识图谱（Zep / Graphiti 路线）。** 个人 agent 的关系浅，`subject` + `topic` + 有效期够用；图数据库可以作为一种 `MemoryStore` 实现接进来，协议不排斥。
- **Agent 自主管理记忆（Letta / MemGPT 路线）。** 让模型直接 UPDATE 记忆需要版本和权限约束；这里模型只有 `recall`，改写走夜间任务。以后要加，是一组绑到 `Memory` 执行环境的新工具，协议不变。
- **在线提取（Mem0 路线的一次 LLM 调用）。** 把门控和提取混在一次调用里，每轮都贵，而且改写发生在在线路径。拆成白天打分、夜里提取。
- **记忆作为会话日志的事件。** 见决定 1。
- **把 System One 协议放进 AI SDK 的 `LanguageModel`。** 它们不生成文字，形状不同；并列定义，`ModelRef` 的名字机制共用。

## 决定记录

- 2026-10-27：按调研、Plate VII / VIII 的方案和 Cloudflare System One 的接口写成提案。等 yoyo 侧的应用设计（[yoyo 的记忆](https://github.com/modelctx-ai/yoyo/blob/main/docs/tech/memory.md)）过一遍协议够不够用，再定实施阶段。
- 2026-10-27：实施，状态改为已采纳。分两个阶段：阶段 1 协议包，阶段 2 `ctx-sqlite`、`ctx-models`、`ctx-memory`、`ctx-remote` 并行。上面七条决定不变；对草案的修订如下，已并入[记忆](../memory.md)：
  1. **事实的归档**：`MemoryFact.archived` 改成 `archivedAt?: number`，和 `validTo`、`settledAt` 一样记时刻。
  2. **笔记**：`NewNote = Omit<Note, 'id'>`，可以带 `settledAt`。门控没过的段落写成已 settle 的笔记，`head` 照样前进；`head` 是这个会话所有笔记（含处理过的）的最大 `upTo`。
  3. **事实的方法**：新增 `facts.cite(id, sources)`（并入时追加证据，相同的区间跳过）；`facts.search` 返回 `FactHit[]`（`{ fact, score }`，`score` 0..1），`recall` 用它当相似度；`facts.list` 按 `id` 码点序，`after`、`limit` 翻页，和 `sessions` 一样。
  4. **程序**：`procedures.add` 的 `confirmations` 从 1 起；`confirm` 时相同的证据不计数。
  5. **画像**：新增 `core.history({ last? })`。
  6. **召回**：`RecallOptions` 加 `evidence`（带回证据原文，工具调用时带）、`signal`。
  7. **纯函数和常量**：`renderCore(facts, budget, { now })` 用 `estimateTextTokens` 计预算；常量 `MAX_DECISION_QUESTIONS`（64）、`MEMORY_RECALL_TOOL`（`recall`）、`ACTIVATION_DEFAULTS`（`d` 0.5、`epsilon` 0.02、`archiveAt` 0.55）。
  8. **契约测试**：`describeMemoryContract` 的工厂签名是 `(setup: { sessions, decision, extraction, now }) => { memory, store }`；剧本模型 `createScriptedDecisionModel`、`createScriptedExtractionModel` 放在协议包的 `/testing`，不在 `ctx-memory`（包布局表已改）。
  9. **`MemoryOptions`** 比草案多 `models`、`subject`（缺省 `user`）、`recall`（`k` 5、`budgetTokens`、`minScore` 0.1、`confirmations` 2）、`consolidate`（`escalateBelow` 0.6、`maxPNull` 0.3、`maxTokens` 6000）、`gate.auto`（自动调阈值，最近 7 天笔记少于 20 条时用 `theta`）、`gate.maxTokens`（4000，超长的段落拆开各 `decide` 一次）、`decay.epsilon`、`name`、`now`；`sessions` 的类型收窄成 `Pick<SessionStore, 'list'>`。
  10. **`consolidate` 的细节**：`decisions` 也写成事实；措辞相同的事实不经 `decide` 直接合并；这一轮写入或合并的事实不在同一轮归档；读不到原文的笔记直接 settle；既没有 `extraction` 也没有 `model` 时笔记保持待处理；open 事实的集合没变时不调模型重写 `core`。
  11. **`recall` 工具**：输出是 `<memory>` 包起来的文字，不是 JSON；输入除 `query`、`since_days` 外加 `topic`、`k`。
  12. **System One**：TypeSafe 的公开 API 只有 `/v1/systemone`（决策），没有提取接口，所以 TypeSafe（Jev）只做决策模型，提取模型只内置 `cloudflare`（Clairic）。`SystemOneSpec.provider` 必填、没有缺省。两家的映射依据公开文档，没有对真实服务验证。
  13. **遗忘的量级**：缺省参数下 `s = 0.6`、从未召回的事实约 1.09 天后低于 `archiveAt`（提案写的是两三天），协议包的单元测试固定了这个数。
  14. **SQLite 的检索**：Node 22.13 自带的 SQLite 没有编进 FTS5，`search` 改用 `instr(lower(text))` 子串匹配。

  实施中发现、留给后续版本的协议待办：
  - `RecallOptions` 没有 `since`：工具的 `since_days` 只能在参考实现内部处理，走协议的调用方做不到。
  - `NoteQuery` 没有时间过滤：自动调阈值要读全部笔记再筛最近 7 天。
  - `activation` 以 `validFrom` 起算：提取出的 `since` 很早的事实，写入后的下一夜就会归档（参考实现只保证不在写入的同一轮归档）；可能需要单独的写入时间。
  - `SessionStore.list` 没有上界：按 `SourceRef` 读原文只能 `after: from - 1` 读到末尾再截。
  - `score` 回答没有 `confidence`：Clef / Jev 的响应里有，适配器丢掉了。
  - `ExtractionRequest` 传不了 Clairic 的 `reference_date`、`null_threshold`。
  - `score` 的档数协议不设上限，Clef / Jev 的文档写最多 10 档；适配器不检查。
  - `ExtractionField` 的 `list.items` 没有 `date`。
