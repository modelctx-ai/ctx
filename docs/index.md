# ctx 文档

| 文档                                              | 内容                                                                                       |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| [架构](architecture.md)                           | 概念、数据流、条目和存储、投影、调用和记录、压缩、来源、工具和 MCP、网关、扩展点、设计约束 |
| [三个仓库](repos.md)                              | ctx、yoyo、dsh-pet 各管什么，产物、契约、依赖和运行时拓扑，本地联调                        |
| [ADR 0001：TypeScript](adr/0001-typescript.md)    | 为什么 ctx 和 yoyo 用 TypeScript；工具链和编译选项                                         |
| [ADR 0002：包](adr/0002-packages.md)              | 包怎么拆、怎么命名，源码条件，版本，发布，使用方式                                         |
| [ADR 0003：上下文模型](adr/0003-context-model.md) | 只追加的日志加投影、摘要检查点、幂等导入、事实不进日志、延后记录                           |

各包的用法：

| 包                         | 说明                                              |
| -------------------------- | ------------------------------------------------- |
| `@modelctx-ai/ctx`         | [packages/core](../packages/core/README.md)       |
| `@modelctx-ai/ctx-sqlite`  | [packages/sqlite](../packages/sqlite/README.md)   |
| `@modelctx-ai/ctx-models`  | [packages/models](../packages/models/README.md)   |
| `@modelctx-ai/ctx-mcp`     | [packages/mcp](../packages/mcp/README.md)         |
| `@modelctx-ai/ctx-gateway` | [packages/gateway](../packages/gateway/README.md) |
