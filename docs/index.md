---
okf_version: '0.2'
---

# 设计

- [概念](concepts.md) - ctx 的定位、七个组件和第八个组件记忆、术语表、和 Anthropic 公开实践的对应、设计约束
- [协议层](protocol.md) - 九个协议的职责、签名、JSON 形状、激活度公式、契约测试、托管矩阵和 HTTP 线上形态；`packages/protocol` 以它为准
- [记忆](memory.md) - 第八个组件的设计：四层记忆和 ctx 组件的对应、五个决策各交给谁、怎么接进其余组件、预算、失败模式

# 参考实现

- [架构：进程内参考实现](architecture.md) - `@modelctx-ai/ctx` 和各实现包怎么做：条目和存储、投影、调用和记录、压缩、来源、工具和 MCP、harness、编排器、记忆、网关、扩展点、实现约束
- [实践：yoyo 和三个仓库](repos.md) - ctx、yoyo、dsh-pet 各管什么，契约、依赖、运行时拓扑和本地联调

# 英文

- [English](en/index.md) - 规范部分的英文译本：协议层（含线上形态）；中文为准，译本记着同步日期，行内代码和章节由测试对齐

# 决策记录

- [ADR](adr/index.md) - 改变设计决策时的背景、决定、代价和没有采用的方案，编号递增

# 包

- [`@modelctx-ai/ctx-protocol`](../packages/protocol/README.md) - 协议：九个协议的接口、JSON 形状、纯函数、契约测试
- [`@modelctx-ai/ctx`](../packages/core/README.md) - 实现：进程内参考实现，门面 `createContext()`
- [`@modelctx-ai/ctx-sqlite`](../packages/sqlite/README.md) - 实现：`node:sqlite` 的会话存储和记忆存储
- [`@modelctx-ai/ctx-models`](../packages/models/README.md) - 实现：按配置造 `LanguageModel` 和决策、提取模型
- [`@modelctx-ai/ctx-memory`](../packages/memory/README.md) - 实现：记忆的门控、召回、巩固、遗忘
- [`@modelctx-ai/ctx-mcp`](../packages/mcp/README.md) - 实现：MCP 服务器作为执行环境
- [`@modelctx-ai/ctx-exec`](../packages/exec/README.md) - 实现：本机子进程执行环境
- [`@modelctx-ai/ctx-remote`](../packages/remote/README.md) - 实现：会话、执行环境、harness、编排、记忆的 HTTP 服务端和客户端
- [`@modelctx-ai/ctx-gateway`](../packages/gateway/README.md) - 实现：本机 OpenAI 兼容网关
- [`@modelctx-ai/ctx-otel`](../packages/otel/README.md) - 实现：从会话日志派生 OpenTelemetry 的 span
- [`@modelctx-ai/ctx-claude-code`](../packages/claude-code/README.md) - 实现：把 Claude Code 接成 harness，轨迹实时写进日志，工具经 MCP 回到 ctx 的执行环境
- [`@modelctx-ai/ctx-pi`](../packages/pi/README.md) - 实现：把 pi 接成 harness，轨迹实时写进日志，工具经 MCP 回到 ctx 的执行环境
- [`@modelctx-ai/ctx-managed-agents`](../packages/managed-agents/README.md) - 实现：把 Claude Managed Agents 接成 harness，事件流实时写进日志，ctx 的工具作为自定义工具回到 ctx 的执行环境
- [`ctx-pydantic-ai`（Python）](../python/pydantic-ai/README.md) - 实现：把 pydantic-ai 的 `Agent` 接成 harness，经线上协议对外，日志和工具在 `ctx-remote` 里

# 记录

- [文档更新记录](log.md) - 文档本身的变更，按日期倒序
- [CHANGELOG](../CHANGELOG.md) - 代码的变更，按版本倒序
