# 文档更新记录

只记文档本身的变更。代码的变更在根目录的 [CHANGELOG.md](../CHANGELOG.md)。

## 2026-10-27

- **更新** [ctx-sqlite](../packages/sqlite/README.md)「多进程」一段：写明切 WAL 时 SQLite 不调 busy handler，本包自己重试（见 [CHANGELOG](../CHANGELOG.md)）。
- **更新** 记忆的文档按其他七个组件的模式拆开，只搬动、不改写：[记忆](memory.md)（591 行 → 108 行）只留设计——四层记忆和 ctx 组件、五个决策、接进其余组件、预算、失败模式，「没有采用」改成指 ADR 0006 的同名一节；协议签名（`MemoryStore`、`DecisionModel`、`ExtractionModel`、门面 `Memory`、激活度公式）进[协议层](protocol.md)的记忆一节，取代原来「只列方法」的缩写版，契约测试一段补上各契约由谁跑；参考实现（`createMemory` 的选项、门控、召回、巩固，SQLite 和内存存储，模型实例化，组装）进[架构](architecture.md)新的「记忆」一节，放在编排器和网关之间。[架构](architecture.md)的「设计约束」改名「实现约束」，和[概念](concepts.md)的「设计约束」（设计原则）区分；[索引](index.md)三行、[AGENTS.md](../AGENTS.md) 的链接跟上。
- **更新** [实践：yoyo](repos.md)只留跨仓库的事：删掉「yoyo 和 ctx 组件的对应」表、「yoyo 怎么用 ctx」「yoyo 的分层」两节（和 yoyo 仓库 `docs/tech/architecture.md` 的三节是同一份内容的两个副本，这里的已经落后），开头一句改成链接过去。顺带改正落后的事实：yoyo 依赖的是 7 个包（加 `ctx-memory`），`yoyo.db` 的契约加 `memory_` 前缀的表（结构版本 1），依赖图加 `ctx-memory`，去掉「yoyo 还没接记忆」。
- **新增** [CHANGELOG.md](../CHANGELOG.md)：代码变更按版本倒序（未发布、0.3.0、0.2.0、0.1.0）。这里原来以「实现 / 发布 / 修复 / 删除」开头的条目原文搬了过去，这里只留文档的变更；[索引](index.md)的「其他」加一行，[AGENTS.md](../AGENTS.md) 的「记录」写明两处各记什么。
- **新增** [AGENTS.md](../AGENTS.md)：给人和 coding agent 的工作约定。文档各管什么（协议层是规范、架构只写参考实现、`repos.md` 只写跨仓库契约、ADR 的状态和修订方式、包 README 要全覆盖导出）、记录（`log.md` 记什么、版本按 ADR 0002）、改代码时的契约测试和对 yoyo 的影响、格式和提交信息。根 README「文档」一节加链接。
- **更新** [记忆](memory.md)、[ADR 0006](adr/0006-memory.md) 从提案改为已实现 / 已采纳：签名按 `.d.ts` 对齐（`MemoryOptions`、`Memory`、`MemorySourceOptions`），组装示例的 `createHarness` 选项改成实际的 `store`、`context`、`tools`，托管表写实际的包和函数名（TypeSafe 只在决策模型一栏），契约测试表写实际的工厂签名和谁跑，模型实例化写明未对真实服务验证，衰减的量级改成约 1.09 天；ADR 0006 加实施状态、修订后的包布局（剧本模型在协议包 `/testing`）、「决定记录」里的实施修订和协议待办（`RecallOptions` 没有 `since`、`NoteQuery` 没有时间过滤、`activation` 以 `validFrom` 起算、`SessionStore.list` 没有上界、`score` 回答没有 `confidence`、`ExtractionRequest` 传不了 `reference_date` / `null_threshold`、`score` 档数不设上限、`list.items` 没有 `date`）。[协议层](protocol.md)改成九个协议，加记忆一节、契约测试、托管矩阵和线上形态的行；[索引](index.md)、[概念](concepts.md)、[实践：yoyo](repos.md)去掉「提案」，索引的包表加 `ctx-memory`；[ADR 0002](adr/0002-packages.md)、[架构](architecture.md)加 `ctx-memory`，改正 `ctx-models` 的 peer（现在也有协议包）；根 README、[核心包](../packages/core/README.md)跟上。
- **新增** [记忆](memory.md)（提案，未实现）：记忆作为第八个组件。四层记忆（工作、情节、语义、程序）加画像和 ctx 组件的对应（会话日志就是情节记忆，不动）；五个决策（什么值得记、什么时候想起、怎么并入、怎么忘、怎么纠错）和对应的操作；协议草案 `MemoryStore`（笔记、事实、程序、画像四个集合，事实不 UPDATE、证据必填、归档不删除）、`DecisionModel`、`ExtractionModel`（System One 模型，形状跟 Cloudflare Clef / Clairic，类型是 ctx 自己的 JSON）；参考实现 `createMemory` 的门控、召回、巩固（提取 → 决策 → 推理模型只做反思）、遗忘（ACT-R 激活度）；只用已有扩展点接入（`Memory` 是 `Executor`，`source()` 是 `ContextSource`）；托管矩阵、契约测试、模型实例化示例（Cloudflare、TypeSafe、启发式、`LanguageModel` 装成的）、预算、失败模式、没有采用。
- **新增** [ADR 0006](adr/0006-memory.md)（提案）：七条决定和依据、包布局（新包 `ctx-memory`，`ctx-sqlite`、`ctx-models`、`ctx-remote` 各加一点）、代价、没有采用（知识图谱、Agent 自主改记忆、在线提取、记忆作为日志事件、并进 `LanguageModel`）。
- **更新** [概念](concepts.md)加第八个组件一段和一行，术语表加笔记、`MemoryFact`（和来源的 `Fact` 区分）、程序、画像、激活度、决策和提取模型；[索引](index.md)加记忆和 ADR 0006；[实践：yoyo](repos.md)的对应表和职责表加记忆一行（ctx 管机制，yoyo 管主题和节律）。

- **更新** 弃用别名删掉后（见 [CHANGELOG](../CHANGELOG.md)），[核心包](../packages/core/README.md)、[ctx-sqlite](../packages/sqlite/README.md)、[架构](architecture.md)、[协议层](protocol.md)去掉对应的说法，[ADR 0004](adr/0004-protocol-and-implementation.md) 注明别名已删。
- **更新** [实践：yoyo](repos.md)跟上 ctx 0.3 和 yoyo#11：产物改成八个包、0.3.0；yoyo 依赖的是六个包（多了 `ctx-protocol`），版本范围 `^0.3.0`，契约加上共用的 `yoyo.db`（`ctx-sqlite` 结构版本 3，不支持滚动升级）；依赖图按实际画，实现包只依赖协议包；「yoyo 怎么用 ctx」的线程改成会话，加上 agent（`AgentSpec.context` 的事实位置）、经编排器提交、恢复（`record: false` 不配 `owner`）、旧摘要（启动时 `recompactLossy`）、排序（`compareEntries`）；分层表的 brain、runtime 跟上 harness、agent 配置和编排器。

## 2026-10-26

- **新增** [ADR 0005](adr/0005-session-position-writes-format.md)（已采纳，不改代码）：会话位置改用 `seq`（补写旧记录会被摘要盖掉）、写入前提条件 `expectSeq` 和围栏、`recover` 的 `owner`、ctx 自己的带版本 JSON 消息格式（读时升级，部件逐项对照 `ai@7.0.150`）、`AgentSpec.context`、会话分页和事件 `kinds` 过滤；`ctx-sqlite` 结构版本 2 → 3；对内存、sqlite、remote、gateway 的破坏面，和对照 yoyo `main` 代码核对出的 yoyo 影响。
- **更新** [ADR 0003](adr/0003-context-model.md)、[ADR 0004](adr/0004-protocol-and-implementation.md) 按 ADR 0005 修订：消息改用 `Message`，`covers` 和位置用 `seq`，日志顺序和投影顺序分开说，「没有采用：自定义消息格式」一条被推翻；[概念](concepts.md)术语表加消息和版本、`expectSeq`、围栏、`owner`、`ContextSpec`；[ADR 0002](adr/0002-packages.md) 的包数改成实际的八个；[ADR 0005](adr/0005-session-position-writes-format.md) 加实施状态和各阶段的提交。
- **更新** [协议层](protocol.md)：`ErrorInfo` 加 `statusCode`、`responseBody`（上游 HTTP 接口出错时的状态码和响应正文，纯 JSON，随 `RunResult.error` 过线）。
- **更新** [协议层](protocol.md)、[实践：yoyo](repos.md)：yoyo 的描述跟上 yoyo#9：`createYoyoOrchestrator` 实现 `Orchestrator`，碎碎念和回复是同一个 `createHarness` 跑的两份 `AgentSpec`，导演只剩舞台动作，常驻循环只管进程。

## 2026-10-25

- **更新** [协议层](protocol.md)：「线上形态」按实现定稿：编排器移到 `/orchestrator` 下，和 harness 的 `/runs` 分开；加 `DELETE /runs/:runId`（`signal` 跨边界）、`GET /orchestrator/runs/:id?wait=` 长轮询、`POST /orchestrator/recover`、`GET /executors`；编排器事件用 NDJSON 不用 SSE。「托管矩阵」写实际的 API 名，去掉「（计划）」。[概念](concepts.md)里 worker 拉取改成「之后加」。
- **更新** [架构](architecture.md)：去掉 `thread` 改名的提示，补函数执行环境、harness、编排器三节；根 README 和各包 README 跟上。
- **更新** [协议层](protocol.md)：签名按代码定稿。和草案相比：`AgentSpec.tools` 改成能序列化的 `ToolSelection`（函数筛选只留在进程内的 `ToolFilter`）；`WindowOptions` 不再带 `estimate`；`StopReason` 去掉 `hook_denied`、加 `max_tokens`，`RunResult` 加 `error`，出错也照常返回；`RunStatus` 的 `idle` 改成 `completed`；`append` 的原子性写清楚了去重时其余照写；`ToolRegistry` 加 `get`；`ToolOutput` 的内容块定成 `text` / `file`，给了和 AI SDK 互转的函数；补契约测试一节。
- **更新** [概念](concepts.md)：术语表补 `CTX_EVENTS`、`StopReason` 的取值。
- **定位**：ctx 从「给 yoyo 用的上下文管理库」改成「面向 agent 原生程序的上下文与运行框架」：协议层、实现层、实践三层。README、索引按此重写。
- **新增** [概念](concepts.md)：七个组件、术语、和 Anthropic 公开实践（Managed Agents、上下文工程、长程 harness、工具设计、Agent SDK）的对应、设计约束。
- **新增** [协议层](protocol.md)：`SessionStore`、`ContextBuilder`、`ToolRegistry`、`Executor`、`Harness`、`Orchestrator` 的签名草案、框架事件 `ctx.*`、托管矩阵、HTTP 线上形态。
- **新增** [ADR 0004](adr/0004-protocol-and-implementation.md)：协议与实现分开，包布局加 `ctx-protocol`、`ctx-exec`、`ctx-remote`，`thread` 改 `session`。
- **更新** [架构](architecture.md)：标明它写的是进程内参考实现，开头加分层图；术语跟着改 `session`。
- **更新** [实践：yoyo](repos.md)：yoyo 定位为 ctx 的实践，导演和常驻循环对应编排器。
- **更新** [ADR 0002](adr/0002-packages.md)：包表加协议包和新适配包，依赖方向加「协议 ← 实现」。

## 2026-10-23

- 建立文档：架构、三个仓库、ADR 0001–0003。
