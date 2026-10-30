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

# 记录

- [文档更新记录](log.md) - 文档本身的变更，按日期倒序
- [CHANGELOG](../CHANGELOG.md) - 代码的变更，按版本倒序
