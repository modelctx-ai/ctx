# 文档更新记录

## 2026-10-26

- **新增** [ADR 0005](adr/0005-session-position-writes-format.md)（已采纳，不改代码）：会话位置改用 `seq`（补写旧记录会被摘要盖掉）、写入前提条件 `expectSeq` 和围栏、`recover` 的 `owner`、ctx 自己的带版本 JSON 消息格式（读时升级，部件逐项对照 `ai@7.0.150`）、`AgentSpec.context`、会话分页和事件 `kinds` 过滤；`ctx-sqlite` 结构版本 2 → 3；对内存、sqlite、remote、gateway 的破坏面，和对照 yoyo `main` 代码核对出的 yoyo 影响。
- **实现** `ctx-sqlite`：结构版本升到 2，`<prefix>meta.schema` 真正被检查。0.1 的库（`thread` 列）和 0.2 的库（`session` 列，版本同为 1）打开时在写锁里迁移，不用应用自己 `RENAME COLUMN`；比自己新的版本拒绝打开。自己开库时设 `busy_timeout`（`busyTimeoutMs`，缺省 5000），传进来的 `database` 缺省不改。写入从 `INSERT OR IGNORE` 改成 `ON CONFLICT DO NOTHING`，NOT NULL 违例不再被静默吞掉。
- **更新** [协议层](protocol.md)：`ErrorInfo` 加 `statusCode`、`responseBody`（上游 HTTP 接口出错时的状态码和响应正文，纯 JSON，随 `RunResult.error` 过线）。
- **更新** [协议层](protocol.md)、[实践：yoyo](repos.md)：yoyo 的描述跟上 yoyo#9：`createYoyoOrchestrator` 实现 `Orchestrator`，碎碎念和回复是同一个 `createHarness` 跑的两份 `AgentSpec`，导演只剩舞台动作，常驻循环只管进程。
- **实现**：harness 在一轮开始前对「工具绑定的执行环境没交给 harness」告警一次，调用时错误信息列出可用的执行环境；`createOrchestrator` 的 `submit` 在每轮结束后摘掉 `request.signal` 上的 abort 监听。

## 2026-10-25

- **新增** `packages/exec`（`@modelctx-ai/ctx-exec` 0.2.0）：本机子进程 `Executor`。`run_command` 在工作目录里用 shell 跑命令，`read_file`、`write_file`、`list_dir` 只碰工作目录里面（拒绝 `..` 和指出去的符号链接）；环境变量白名单、超时和取消时杀整个进程组、输出截断并注明截掉多少、`allow` 审批；`commands` 把固定命令包成专门的工具。结果是带 `<exit_code>`、`<stdout>`、`<stderr>` 的文字，非零退出码不算错误。
- **新增** `packages/remote`（`@modelctx-ai/ctx-remote` 0.2.0）：协议的 HTTP 形态。服务端 `/server` 的 `startRemote`、`createRemoteHandler` 挂会话存储、执行环境、harness、编排器，安全缺省照网关；客户端只用 `fetch`：`createRemoteSessionStore`（含 `watch`）、`createRemoteExecutor`、`createRemoteHarness`（含 `stream`）、`createRemoteOrchestrator`。四个协议的契约测试都在远程客户端上跑过，另有三服务端到端一例。
- **更新** [协议层](protocol.md)：「线上形态」按实现定稿：编排器移到 `/orchestrator` 下，和 harness 的 `/runs` 分开；加 `DELETE /runs/:runId`（`signal` 跨边界）、`GET /orchestrator/runs/:id?wait=` 长轮询、`POST /orchestrator/recover`、`GET /executors`；编排器事件用 NDJSON 不用 SSE。「托管矩阵」写实际的 API 名，去掉「（计划）」。[概念](concepts.md)里 worker 拉取改成「之后加」。

- **实现**：`@modelctx-ai/ctx` 改成协议的进程内参考实现，五个实现包升到 0.2.0。核心包把协议包当 peer，删掉重复的条目、存储接口、投影、来源、token 估算、工具类型，改为从协议包导入并原样再导出；新增 `createFunctionExecutor`、`createContextBuilder`（`factsPlacement: 'prompt'` 给提示缓存留不变的 system 前缀）、`createHarness`、`createOrchestrator`；`createToolRegistry` 实现协议的 `ToolRegistry`，加 `addTool`、`toolSet`、`toToolSet`；`createContext` 改成组合门面，`generate` 走 harness，结果加 `runId`、`stopReason`，日志里多了 `ctx.run.*`；`compact` 另记 `ctx.compacted`。`thread` → `session`、`ContextStore` → `SessionStore`、`threads()` → `sessions()`，旧名留作弃用别名。
- **实现**：ctx-sqlite、ctx-mcp、ctx-gateway 只依赖协议包。sqlite 的列改名 `session`，加轮询的 `watch`；mcp 的 hub 本身是一个 `Executor`（名字缺省 `mcp`），`registerInto` 写 `ToolDefinition`；gateway 的 `withContext` 也收 `(builder, session)`。
- **新增** 协议包的 `describeHarnessContract`、`describeOrchestratorContract`（工厂收一份模型剧本），核心包的 `/testing` 加 `createScriptedModel`。
- **更新** [架构](architecture.md)：去掉 `thread` 改名的提示，补函数执行环境、harness、编排器三节；根 README 和各包 README 跟上。

- **新增** `packages/protocol`（`@modelctx-ai/ctx-protocol` 0.2.0）：六个协议的接口、JSON 形状、纯函数和 `/testing` 契约测试（`describeSessionStoreContract`、`describeExecutorContract`、`describeToolRegistryContract`）。
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
