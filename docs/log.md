# 文档更新记录

只记文档本身的变更。代码的变更在根目录的 [CHANGELOG.md](../CHANGELOG.md)。

## 2026-11-16

- **新增** 英文译本（[#50](https://github.com/modelctx-ai/ctx/issues/50)）：[`docs/en/protocol.md`](en/protocol.md)（协议层全文，含线上形态）、[`README.en.md`](../README.en.md)，[docs/en/index.md](en/index.md) 和[文档入口](index.md)的「英文」一组。中文为准，译本的 frontmatter 记 `translation_of`、`synced`；`packages/protocol/src/translation.test.ts` 查两边的行内代码和章节层级，规范改了没跟进译本就失败。[README](../README.md) 开头加英文版的链接；[AGENTS.md](../AGENTS.md) 写了同步的规矩。架构和 ADR 先不译。
- **新增** [ADR 0009](adr/0009-hosted-prerequisites.md)：云托管的前提（[#25](https://github.com/modelctx-ai/ctx/issues/25)）。每会话的执行环境另起 `open`、`close`，不改 `provision`；环境的描述放在 `AgentSpec.environment`；凭证不进执行环境、只给约定；`ctx-remote` 的鉴权扩展点和主体。
- **更新** [协议层](protocol.md)（#25）：执行环境一节加 `open`、`close`、`ExecutorSessionOptions`、`EnvironmentSpec`，新写「每会话的执行环境」「凭证不进执行环境」两条；`AgentSpec` 加 `environment`；线上形态的路径表加两条执行环境会话的路径，跨路径的规则加「主体」；记忆作用域那条写明配了主体时按 `memoryScopes` 查；契约测试表跟上。
- **更新** [架构](architecture.md)：函数执行环境一节写 `open`、`close`，新写「每会话的执行环境」（harness 怎么 `open`、`closeExecutorSessions`、`ctx-exec` 的 `sessionCwd`、remote 的两条路径）。[概念](concepts.md)的术语表加「执行环境的会话」「环境描述 `EnvironmentSpec`」「主体 `Principal`」。
- **更新** [ctx-remote](../packages/remote/README.md)：选项加 `authenticate`，新写「主体」一节（哪些入口按什么查、租户隔离靠会话名前缀）；路径表加 `open`、`close`。[ctx-exec](../packages/exec/README.md)：选项加 `sessionCwd`，`env` 写明模型生成的代码读得到；导出加 `sessionCwd(session)`。[ctx](../packages/core/README.md)：导出加 `closeExecutorSessions`，函数执行环境的 `open`、`close`。[ctx-protocol](../packages/protocol/README.md)：`Executor` 一行和契约测试表跟上。
- **更新** [live/README](../live/README.md)（[#49](https://github.com/modelctx-ai/ctx/issues/49)）：新增「记忆评测」一节：评测集里有什么、三个比例怎么算、「会被召回」的定义、怎么跑，以及门控阈值和激活度参数还没有在真实模型上校准过；文件表加 `memory-eval.ts`。
- **更新** [架构](architecture.md)的巩固一节、[ctx-memory](../packages/memory/README.md) 的 `consolidate` 步骤和选项（[#42](https://github.com/modelctx-ai/ctx/issues/42)）：证据要在原文里有支撑，怎么算、有支撑时收窄到哪几条、没有时降置信度，以及这只是启发式；[协议层](protocol.md)的 `ConsolidateReport` 加 `ungrounded`。
- **更新** [协议层](protocol.md)（[#22](https://github.com/modelctx-ai/ctx/issues/22)）：总则加「版本」「语言无关」两行；线上形态写版本和能力发现（`GET /protocol`）、JSON Schema 和 OpenAPI（`GET /protocol/schema`、`GET /protocol/openapi`，副本在仓库根 `schema/`，一致靠测试），以及对一个地址跑的一致性测试（`POST /conformance/instances`、`ctx-conformance`）；托管矩阵照实写哪些组件是线上协议、哪些留在进程内。[README](../README.md)、[概念](concepts.md)的「任何一个都能单独托管」改成同样的说法，术语表加「协议版本」「一致性模式」；[ADR 0004](adr/0004-protocol-and-implementation.md) 的决定记录加一条。[ctx-remote](../packages/remote/README.md) 写握手、`checkProtocol`、三个发现入口，新增「对一个地址跑一致性测试」一节（`ConformanceSetup` 的字段和剧本语义、命令、`describeConformance`、`createConformanceHandler`）；[ctx-protocol](../packages/protocol/README.md) 的导出表加两行。
- **更新** [协议层](protocol.md)（[#48](https://github.com/modelctx-ai/ctx/issues/48)）：`RunRequest` 加 `owner`、`parent` 和 `RunParent`，`ContextSpec` 加 `inherit`，Harness 一节新写「父子运行」一条（两边各记一半、用量怎么往上加、取消怎么传、`recover`、子 agent 的上下文、进程级 harness 的适配器怎么写、不做编排模式），编排器一节写 `cancel` 连带取消；[架构](architecture.md)加「子 agent」一节，编排器的 `cancel`、`resume` 补上 `parent`；[概念](concepts.md)术语表加「父运行、子运行」「继承上下文」；[`@modelctx-ai/ctx`](../packages/core/README.md) 加「子 agent」一节和 `createSubagentTool` 的导出；[ctx-protocol](../packages/protocol/README.md) 的纯函数表和契约表各加一条。
- **更新** [协议层](protocol.md)的 Harness 一节（[#47](https://github.com/modelctx-ai/ctx/issues/47)）：`AgentSpec` 加 `version`、`output`、`toolChoice`、`permissions`、`budget` 和它们的类型，新写一条说明每一项的语义、`invalid_output` 和 `max_budget`，以及不支持的 harness 不能静默忽略；[架构](architecture.md)写参考实现怎么交给 AI SDK；[概念](concepts.md)术语表加「权限策略」「预算」「结构化输出」；[ctx-protocol](../packages/protocol/README.md) 的纯函数表加 `toolPermission`、契约表加一条；[`@modelctx-ai/ctx`](../packages/core/README.md) 加「Agent 配置」一节；[ADR 0008](adr/0008-tool-calls-through-the-log.md) 的实施状态记下 `ask` 复用经日志往返做人工确认。
- **新增** [ADR 0008](adr/0008-tool-calls-through-the-log.md)：工具调用经日志往返（#21）。等待态是 `StopReason` 的 `requires_action`，结果是带幂等键的 `tool` 消息，走这条路的工具由 harness 的 `external` 名单决定（为什么不按「没有实例」、不在 `ToolDefinition` 上标注），三个待定问题的答案，代价，还没做的两件。[ADR 索引](adr/index.md)跟上。
- **更新** [协议层](protocol.md)的 Harness 一节加「工具调用经日志往返」，`StopReason`、`RunResult.pending` 跟上；[架构](architecture.md)写 `external`、`runPendingTools` 怎么做；[概念](concepts.md)术语表加「等待外部执行 `requires_action`」。[ctx](../packages/core/README.md) 加「工具在别处执行」一节和导出，[ctx-protocol](../packages/protocol/README.md) 的纯函数表加三项，[ctx-remote](../packages/remote/README.md) 的「长请求和断线」写明长任务走编排器、内网的执行环境怎么接。
- **新增** [ctx-otel](../packages/otel/README.md)：安装、用法（编排器的事件驱动 `traceSession`）、span 和属性表、导出。[架构](architecture.md)加「追踪」一节，写 span 怎么从条目派生。
- **更新** [ADR 0002](adr/0002-packages.md)：拆分和依赖关系两张表加 `ctx-otel`，「实施状态」的包数改成十个，「决定记录」记下为什么单独成包、`@opentelemetry/api` 为什么是 peer。[文档索引](index.md)的「包」、根目录 README 的包表和 `overrides`、[实践：yoyo](repos.md)的产物表跟上；`AGENTS.md` 的包数跟上。
- **更新** [协议层](protocol.md)的 Harness 一节（[#46](https://github.com/modelctx-ai/ctx/issues/46)）：`Usage` 加缓存读写和推理三项，新写 `StepMeta` 和「用量」一条；`RunEvent` 加 `reasoning.delta` 和三个对齐点的 `seq`。[架构](architecture.md)写每一步的 `meta.step` 取哪些字段、`model.ended` 等写完再发。[概念](concepts.md)术语表加「步骤元数据 `meta.step`」「对齐点 `seq`（流）」。[ctx-protocol](../packages/protocol/README.md) 的纯函数表加 `stepMetaOf`。
- **更新** [协议层](protocol.md)的 Harness 一节（[#20](https://github.com/modelctx-ai/ctx/issues/20)）：新写「每一步即时落日志」，一个会话一个运行的约定加第 5 条「续跑」；编排器的 `recover` 签名改成 `RecoveredRun[]`，`RecoveredRun` 加 `resumed`；契约测试表跟上。以前写的是整轮结束时一批记产出。
- **更新** [架构](architecture.md)的 Harness 和编排器两节：每一步怎么用 AI SDK 的 `onLanguageModelCallEnd`、`onStepEnd` 落日志，半路结束时怎么给悬空的调用补结果；`recover` 补结果、`resume` 续跑。
- **更新** [概念](concepts.md)：术语表加「续跑 `resume`」；「可丢弃」一条写明续跑靠什么。
- **更新** [ctx](../packages/core/README.md)：新写「崩溃后续跑」一节，一个带工具、两个进程共用 SQLite 库的例子；`createOrchestrator` 的选项加 `resume`。[ctx-protocol](../packages/protocol/README.md) 的契约测试表跟上。
- **更新** [协议层](protocol.md)的记忆一节（[#43](https://github.com/modelctx-ai/ctx/issues/43)、[#36](https://github.com/modelctx-ai/ctx/issues/36)）：`Note` 加 `attempts`、`error`、`failedAt`，`NoteQuery` 加 `failed`、`since`；`MemoryStore` 加 `notes.fail`、`retry`、`forget`，`facts.supersede`、`reopen`，`procedures.forget`，`core.clear`，`MemoryFact.key`；新写「每个方法单独是原子的」「几个进程写同一份存储不重复」「失败和死信」「删除是真删除」四条；决策和提取模型写明拿不到可用的回答时 reject `invalid_response`；门面加 `forget`、`ForgetRequest`、`ForgetReport`，`ConsolidateReport` 加 `failed`、`dead`；远端的路径一句话列全；契约测试表跟上。原因：解析失败时记忆悄悄丢了，一批失败卡住整夜，取代不原子，多进程写重复，删了事实画像里还在。
- **更新** [架构](architecture.md)的记忆一节：`createMemory` 的选项加 `consolidate.maxAttempts`、`onDeadLetter`；门控失败退回启发式；巩固的提取按条给日期、取代用 `supersede`、将来才成立的不取代、幂等键、按批隔离和死信；新节「删除 `forget`」；SQLite 结构版本 4；LM 适配器的结构化输出；System One 的超时。[记忆](memory.md)的失败模式表加三行，纠错的操作换成 `reopen`、`forget`。[概念](concepts.md)的术语表加「死信」「幂等键」，「记忆里的事实」改成 `supersede`。[ADR 0006](adr/0006-memory.md) 的「决定记录」补 2026-11-16 一条，[ADR 0007](adr/0007-deletion-and-retention.md) 的实施状态写明记忆一半已做。
- **更新** [ctx-memory](../packages/memory/README.md)：选项加 `consolidate.maxAttempts`、`onDeadLetter`，`gate`、`consolidate` 的说明跟上，新写 `forget` 和一起删日志的写法，LM 适配器改成结构化输出、取不出 JSON 时 reject。[ctx-sqlite](../packages/sqlite/README.md)：记忆的表加新列和唯一索引、结构版本 4 和升级。[ctx-remote](../packages/remote/README.md)：记忆的路径表加七条。[ctx-models](../packages/models/README.md)：`SystemOneSpec.timeoutMs`、`SYSTEM_ONE_TIMEOUT_MS`。[协议包](../packages/protocol/README.md)：`MemoryStore`、`Memory` 的说明跟上。

## 2026-11-15

- **更新** [协议层](protocol.md)的记忆一节：`SearchQuery.archived`、`facts.restore`、`RecallOptions.minConfidence`；`search` 的底线（切词、最多 256 个词、不因查询长报错）；`recalls` 只留最近 32 个；「激活度」一节改成 `activation`、`retrievability`（上界、未来的时刻、排序公式），纯函数的列表加 `searchTerms`、`termOverlap`、`inSearchScope`；契约测试表跟上。原因：检索和遗忘的规则改了（[#44](https://github.com/modelctx-ai/ctx/issues/44)）。
- **更新** [记忆](memory.md)：新节「想起和忘记的规则」（召回怎么排、什么时候记一次召回、什么时候归档、归档之后怎么找回来、`confidence` 的门槛），失败模式表跟上。[架构](architecture.md)：`createMemory` 的选项、召回的步骤、夜里的衰减；「SQLite 和内存存储」重写（结构版本 3、倒排索引、为什么不用 FTS5、升级）。[ADR 0006](adr/0006-memory.md) 的「决定记录」补一条：七处修订各自的理由，以及还没做的。
- **更新** [ctx-memory](../packages/memory/README.md)：`recall` 的选项加 `minConfidence`、`archivedWeight`、`spacingMs`，`decay` 加 `minChances`；`recall`、`consolidate`、`source` 的说明跟上；新节「遗忘」，带一张和以前不一样的地方的表；内存存储的 `search` 改写。[ctx-sqlite](../packages/sqlite/README.md)：记忆的表加 `fact_docs`、`fact_terms`，检索一段重写（以前写的子串匹配已经不是实际行为），结构版本 3 和升级。[协议包](../packages/protocol/README.md)导出表加检索和激活度的新名字。[ctx-remote](../packages/remote/README.md)：记忆的路径表加 `restore`，`search` 的请求体加 `archived`。
- **更新** [协议层](protocol.md)（[#33](https://github.com/modelctx-ai/ctx/issues/33)）：`ContextBuilder` 一节加 `compactDetailed`、`CompactResult`、`CompactOptions.maxInputTokens`、`WindowOptions.truncate`、`PreparedCall.tokens`、`ProjectedMessage.at`，写明压缩分段、检查点、`at` 在未来的条目不算「最近的」；`Harness` 一节加 `OverflowSpec` 和三段语义（超窗兜底、上下文过长的错误、失败的重试不让历史变长）；总则的错误表加 `context_overflow`；契约测试表加 `describeContextBuilderContract`，去掉「`ContextBuilder` 的契约还没写」。原因：上下文超过模型窗口时规范里没有任何兜底，压缩自己也会被同一段历史撑爆。服务商的错误形状写明没有对真实服务验证。
- **更新** [架构](architecture.md)：「压缩」一节按分段滚动摘要重写（切点、分段、检查点、截断和超时、摘要模型报过长时减半）；投影加第七步「截短」；harness 的步骤加超窗检查和重试去重，`error.type` 一段写明 `context_overflow` 怎么认；`createContextBuilder` 的签名、扩展点表跟上。
- **更新** [概念](concepts.md)：术语表加「窗口、截短」「压缩、滚动摘要、检查点」「超窗兜底」「上下文过长」四条，「一轮」补上 `error.type`；设计约束 5 写明超窗兜底是应用的配置、缺省关着。
- **更新** [ADR 0003](adr/0003-context-model.md)：加「决定记录」四条（压缩分段并落检查点、`at` 在未来的条目不算「最近的」、不带 `inputKey` 的失败重试不再记输入、harness 可以按配置在超窗时压缩），决定正文不动。[ADR 0005](adr/0005-session-position-writes-format.md)「决定记录」补一条：`ContextSpec` 加 `overflow`，仍然只有 JSON、`RunRequest` 不加字段。
- **更新** [核心包](../packages/core/README.md)：例子加 `compactDetailed`；harness 一节加 `context.overflow` 的用法、`context_overflow`、失败重试和窗口的 `truncate`；导出表加 `DEFAULT_COMPACT_INPUT_TOKENS`、`isContextOverflowError`、`createContextBuilder` 的 `now`、`createContext` 的 `overflow`。[协议包](../packages/protocol/README.md)：导出表加 `truncateText`、`truncateMessage`、`CONTEXT_OVERFLOW`、`isContextOverflow`、`OverflowSpec`、`CompactResult`、`CompactStatus`，契约测试表加 `describeContextBuilderContract`。
- **新增** [`live/`](../live/README.md) 的说明：对真实服务的冒烟场景（模型的带工具流式运行、网关改写、决策、提取、MCP）、要哪些环境变量、怎么录夹具和重放、现在验证到哪了（只有 MCP 的连接、列工具、调用对一台公开服务器验证过，别的还没有密钥）。[AGENTS.md](../AGENTS.md) 的命令表加 `pnpm live`，「没有对真实服务验证」那条约定写明验证过之后换成日期和版本。[ctx-mcp](../packages/mcp/README.md) 的限制一条写上验证过的部分和日期，没验证的照旧留着。
- **更新** [协议层](protocol.md)的会话一节：加两条规则——会话名不能是空串、`.`、`..`（为什么、谁来拒绝、`checkSessionName`），存进去和读出来的都是拷贝；契约测试表跟上。[协议包](../packages/protocol/README.md)导出表加 `checkSessionName`；[核心包](../packages/core/README.md)和[架构](architecture.md)写明内存存储写入、读出各拷一份；[ctx-remote](../packages/remote/README.md)写明这三种会话名客户端直接拒绝。
- **更新** [协议层](protocol.md)：会话一节加「导出、导入、复制」小节——JSON Lines 的格式（头、条目、结束行）、`exportSession`、`importSession`、`copySession` 的签名，导入时哪些 `seq` 引用跟着换、`id` 的三种处理、不是原子的、哪些情况抛什么；契约测试表跟上。以前没有写会话怎么搬到别的存储，「`list` 再 `append`」会让 `covers` 指错位置。[概念](concepts.md)术语表加「导出、导入」。[协议包](../packages/protocol/README.md)导出表加这三个函数和格式的常量、类型。
- **新增** 例子 [`move-session.ts`](../examples/move-session.ts)：一个压缩过的会话从内存存储导成文件、导进 SQLite、再复制到远端存储，三边的上下文一样；[例子说明](../examples/README.md)的表加一行。
- **新增** [ADR 0007](adr/0007-deletion-and-retention.md)（已采纳，会话这一半已实现）：只追加的例外。`truncate`、`remove`、`redact` 三个方法和擦除记录 `ctx.erased`（为什么要留记录：末尾一定前进、`expectSeq` 一定冲突、`watch` 收得到），运行中的 harness 在自己写的条目被擦除时停下，摘要不跟着改，SQLite 用连接级的 `secure_delete` 加 `vacuum()`（附实测：只在删除时打开擦不干净），保留期是应用调的函数；破坏面、代价、没有采用的方案。[ADR 索引](adr/index.md)加一行；[ADR 0003](adr/0003-context-model.md) 头部加修订行指过来，正文不动。
- **更新** [协议层](protocol.md)：`SessionStore` 的签名加三个方法；新的「擦除」小节写每个方法做什么，和 `seq`、`expectSeq`、`watch`、摘要的 `covers`、投影、生命周期事件的关系，以及 `clear` 为什么不在其中；框架事件表加 `ctx.erased`、`ctx.redacted`；harness 的写入规则加第三种围栏（自己写的条目被擦除）；契约测试表和线上形态（三条 `POST` 路径、重试的说法）跟上。
- **更新** [概念](concepts.md)：术语表加擦除和擦除记录、涂改、保留期，围栏一条和事件 `kind` 一条跟上；设计约束 1「只追加」写明例外只在应用明确删除时发生。
- **更新** [架构](architecture.md)：存储表加三个方法；新的「删除和保留期」小节写内存存储、`ctx-sqlite`、`ctx-remote` 各怎么做，`pruneSession` 的选项和两条保守的规则，以及擦除和记忆的证据的关系；harness 的围栏、自定义存储的用例表、实现约束里「只追加」一行跟上。
- **更新** [ctx-sqlite](../packages/sqlite/README.md)：选项 `secureDelete`；新的「删除和文件大小」一节回答四个问题（删掉的内容还在不在、`-wal` 呢、文件什么时候变小、什么时候要 `vacuum()`）和 `secure_delete` 的三个注意（连接级、写入时也要开着、只管库文件里的字节）；导出表加 `vacuum()`。
- **更新** [协议包](../packages/protocol/README.md)、[核心包](../packages/core/README.md)、[ctx-remote](../packages/remote/README.md)：协议表和导出表加擦除的方法、纯函数和事件，核心包加 `pruneSession`，远端的线上形态加三条路径、写明不自动重试。[实践：yoyo](repos.md) 的 `yoyo.db` 契约加一句：yoyo 传进来的连接上会打开 `secure_delete`。
- **新增** [`examples/`](../examples/README.md)：四个能直接跑的最小例子（单进程、拆开部署、两个进程共用一个库、记忆接进上下文），缺省用剧本模型，CI 里跑。[README](../README.md) 的「安装」后面指过去；[AGENTS.md](../AGENTS.md) 的命令表加 `pnpm examples`，「改代码时」写明例子要跟着公开 API 改。
- **更新** [AGENTS.md](../AGENTS.md)：改公开 API 的约定里写上 CI 的 `Downstream (yoyo)` 作业（用 PR 的构建产物跑 yoyo 的检查和测试，不拦合并）和它红了该怎么办。
- **更新** [ctx-gateway](../packages/gateway/README.md) 和[架构](architecture.md)的网关一节：`replaceHistory` 怎么判断「同一句话」、没配对的工具调用怎么处理、没有用户话时的预填；请求处理表里 400、500、502 的条件和正文。[ADR 0004](adr/0004-protocol-and-implementation.md) 加「决定记录」：协议的数目几处说法对上（七个组件、协议包里六个加记忆的三个共九个）。
- **更新** [协议层](protocol.md)的记忆存储一节：作用域（`scope(name)`、隔离的范围、名字的规则、不是鉴权）；线上形态的 `?scope=`。[记忆](memory.md)的失败模式表加两行（多用户串、事件里的指令）。[ADR 0006](adr/0006-memory.md) 的「决定记录」补两条：为什么是视图而不是每个方法多一个参数、为什么不复用 `subject`；提取和证据用门控的筛选。
- **更新** [ctx-memory](../packages/memory/README.md)：选项 `scope`、`ownsSession`，新节「几个用户共用一份存储」。[ctx-remote](../packages/remote/README.md)：记忆的作用域和 `RemoteMemoryStoreOptions`。[协议包](../packages/protocol/README.md)导出表加作用域的三个名字。[ctx-sqlite](../packages/sqlite/README.md)：记忆的表加 `scope` 列、索引和结构版本 2 的升级。
- **更新** [ADR 0002](adr/0002-packages.md)：加「实施状态」（发布工作流、`scripts/release.mjs`、打包冒烟检查、发一版的步骤、`engines` 核对的结论、还要维护者在 npm 上做的三步）和「决定记录」（占位版本是九个包、暂不引入 changesets、预发布发到 `next`）；「发布」里的包数和工作流步骤改对。[AGENTS.md](../AGENTS.md) 的命令表加 `pnpm smoke`、`pnpm release:version`。
- **更新** [协议层](protocol.md)：`ListOptions.limit` 和翻页的写法；读不了的条目（`ctx.unreadable`、`readEntry`、宽松模式）和滚动升级的顺序（读的一方先升，没有降级路径）——以前只写了「更高的版本抛错」，没说新旧版本共用一个库时怎么办；投影的输出保证（工具调用和结果成对、开头合法）；窗口的两处配置谁盖谁、`build` 的 `maxTokens` 管整次调用；token 估算的口径；工具边界上输入校验归 harness、输出截断归执行环境加 harness 兜底；`agentSpecToJson` 给请求头打码；线上形态加心跳、`more`、`{ error, status }`、429、500 不回原文、哪些请求可以重试。
- **更新** [架构](architecture.md)：投影从五步改成六步（加配对），窗口裁剪和 token 估算跟上；「调用」写明请求的 `window` 和 `build` 的预算口径；harness 的工具步骤加输入检查和结果截断；MCP 一节加上限、调用时限、断开和重连、`list_changed`；存储表加 `limit`。
- **更新** [ctx-remote](../packages/remote/README.md)：选项表补上 `allowedModels`、`allowedSettings`、`maxListEntries`、`heartbeatMs`、`maxRuns`、`maxExecutions`、`maxStreams`；新增「长请求和断线」一节，写明 Node `fetch` 的 300 秒缺省超时、心跳怎么绕开它、关掉心跳时怎么换 `fetch`，以及重试的范围；线上形态和安全缺省跟上。原来写的「客户端读到更高的版本时抛 `unsupported_version`」以前没有实现，现在实现了。
- **更新** [ctx-sqlite](../packages/sqlite/README.md)：选项 `unreadable`；「结构版本和迁移」加几个进程共用一个库时的升级顺序。
- **更新** [ctx-exec](../packages/exec/README.md)：`allowFile`、`runCommand`、`FileAccess`，文件工具挡住哪些绕过、挡不住什么。
- **更新** [ctx-mcp](../packages/mcp/README.md)：上限、调用时限、断开和重连、`refresh`、自己写连接器时的两个钩子；写明远程传输的断开检测靠 SDK 内部实现、没有对真实服务验证。
- **更新** [协议包](../packages/protocol/README.md)和[核心包](../packages/core/README.md)的导出表：`estimateFileTokens`、`REDACTED_HEADER`、`readEntry` 一组、`checkJsonSchema`、`limitToolOutput`、`DEFAULT_MAX_TOOL_OUTPUT_CHARS`；核心包的 harness 一节加窗口和工具边界两段。
- **更新** [ctx-gateway](../packages/gateway/README.md)、[架构](architecture.md)的网关一节：请求处理表加 `routes`（缺省只转发聊天补全和模型列表），写明空的 `accessToken` 抛错、对外监听没有令牌拒绝启动（`allowUnauthenticated`）。对应的代码变更见 [CHANGELOG](../CHANGELOG.md)。
- **更新** [ctx-remote](../packages/remote/README.md)：同样的鉴权规则；服务端示例补上 `allowedHosts`（原来照着示例写，客户端会得到 `403 host not allowed`）。
- **更新** [ctx-models](../packages/models/README.md)：`apiKey` 一行写明 `anthropic` 换了 `baseUrl` 必须显式给密钥。
- **更新** [协议层](protocol.md)的 harness 写入规则和[架构](architecture.md)的编排器一节：运行中途会话被 `clear` 也算被围栏；编排器的 `retainEnded`。[核心包](../packages/core/README.md)的导出表跟上。

## 2026-10-30

- **更新** 文档按 [Open Knowledge Format](https://github.com/GoogleCloudPlatform/open-knowledge-format/blob/main/SPEC.md) v0.2 组织：[概念](concepts.md)、[协议层](protocol.md)、[记忆](memory.md)、[架构](architecture.md)、[实践：yoyo](repos.md) 和六篇 ADR 加 frontmatter（`type`、`title`、`description`、`tags`、`status`），正文不动；[索引](index.md)从表格改成 OKF 的条目列表，描述和各篇的 `description` 一致，根上声明 `okf_version`；决策记录拆到新的 [adr/index.md](adr/index.md)，根索引只留一条。文件不搬家，外部链接（yoyo、各包 README）不受影响。[AGENTS.md](../AGENTS.md) 加「文档怎么组织」，ADR 和包的链接跟上。
- **更新** 根 [README](../README.md) 只做项目级展示：加「架构」一节，两张 Mermaid 图（八个组件和它们之间的协议调用、一轮的顺序）；三层表和包表合成一张、每个包一句话，运行环境和 peer dependency 留在各包 README 的「安装」；快速开始只留一个对话的例子，持久化、工具、harness、编排器、网关的例子删掉（各包 README 里都有）；同级目录链接压成一段，`overrides` 收进折叠块，细节指 [ADR 0002](adr/0002-packages.md#使用方式)；「开发」只留两条命令。命令表、工具链、开发用的 Node 和 pnpm 版本、源码条件挪进 [AGENTS.md](../AGENTS.md) 新的「工具链和命令」一节，开头的链接跟上。

## 2026-10-29

- **更新** [实践：yoyo](repos.md)的右键对话这条路：网关的 `fetch` 换成 yoyo 自己，请求不再转发到上游，由 yoyo 经编排器和 harness 跑回复的 agent；绑定时等待设成 60 秒；哪种 `llm.provider` 都接。契约里「yoyo → LLM」一行跟上。
- **更新** [实践：yoyo](repos.md)跟上 yoyo 改用 npm 上的 dsh-pet：职责表写明不改 dsh-pet 的仓库（fork 只跟上游），yoyo 带一份右键菜单补丁；产物表写明 dsh-pet 发到 npm、yoyo 安装时打补丁；契约加 `YOYO_PET_MENU`；本地联调不再克隆 dsh-pet，桌宠用 yoyo 的 `pnpm pet` 开。

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
