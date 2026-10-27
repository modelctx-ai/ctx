# ADR 0006：记忆作为第八个组件，只读日志、夜里改写、System One 做判断

- 状态：提案
- 实施状态：未实施。协议和参考实现的草案见[记忆](../memory.md)
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

| 包                 | 加什么                                                                                                                        |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `ctx-protocol`     | `MemoryStore`、`DecisionModel`、`ExtractionModel` 的接口和 JSON 形状；纯函数 `activation`、`rankFacts`、`sourceRef`；契约测试 |
| `ctx-memory`（新） | `createMemory`、内存 `MemoryStore`、启发式决策模型、`decisionFromLanguageModel`、`extractionFromLanguageModel`、剧本模型      |
| `ctx-sqlite`       | `createSqliteMemoryStore({ database, prefix })`，可以和 `ctx_` 表共用一个库                                                   |
| `ctx-models`       | `createDecisionModel`、`createExtractionModel`：`cloudflare`、`typesafe` 两个 provider，可注册                                |
| `ctx-remote`       | `/memory/notes`、`/memory/facts`、`/memory/procedures`、`/memory/core`                                                        |

`ctx-memory` 只依赖协议包；要 `LanguageModel` 时经 `ModelRef`，和 harness 一样。

## 代价

- 多一个存储、多两类模型、多一个夜间任务。单进程的最小用法（`createContext()` 三行）不受影响：不建 `Memory` 就什么都没有。
- System One 模型目前只有少数服务商（Cloudflare、TypeSafe），Clairic 还是预览版。协议是 ctx 自己的，适配器薄，但服务商换接口要跟。
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
