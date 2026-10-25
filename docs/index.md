# ctx 文档

想知道 ctx 是什么、怎么拆，看概念；要实现或替换一个组件，看协议层；要用现成的，看参考实现。

## 设计

| 文档                  | 内容                                                        |
| --------------------- | ----------------------------------------------------------- |
| [概念](concepts.md)   | 定位、七个组件、术语、和 Anthropic 公开实践的对应、设计约束 |
| [协议层](protocol.md) | 六个协议的职责、签名、JSON 形状、托管矩阵、HTTP 线上形态    |

## 参考实现

| 文档                    | 内容                                                                               |
| ----------------------- | ---------------------------------------------------------------------------------- |
| [架构](architecture.md) | 进程内参考实现：条目和存储、投影、调用和记录、压缩、来源、工具和 MCP、网关、扩展点 |
| [实践：yoyo](repos.md)  | ctx、yoyo、dsh-pet 各管什么，契约、依赖和运行时拓扑，本地联调                      |

## 决策记录

| ADR                                                         | 内容                                                                              |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------- |
| [0001：TypeScript](adr/0001-typescript.md)                  | 为什么 ctx 和 yoyo 用 TypeScript；工具链和编译选项                                |
| [0002：包](adr/0002-packages.md)                            | 包怎么拆、怎么命名，源码条件，版本，发布，使用方式                                |
| [0003：上下文模型](adr/0003-context-model.md)               | 只追加的日志加投影、摘要检查点、幂等导入、事实不进日志、延后记录                  |
| [0004：协议与实现](adr/0004-protocol-and-implementation.md) | 协议层和实现层分开，七个组件各一个协议，组件不绑定托管形态，`thread` 改 `session` |

## 包

| 包                          | 层   | 说明                                                |
| --------------------------- | ---- | --------------------------------------------------- |
| `@modelctx-ai/ctx-protocol` | 协议 | [packages/protocol](../packages/protocol/README.md) |
| `@modelctx-ai/ctx`          | 实现 | [packages/core](../packages/core/README.md)         |
| `@modelctx-ai/ctx-sqlite`   | 实现 | [packages/sqlite](../packages/sqlite/README.md)     |
| `@modelctx-ai/ctx-models`   | 实现 | [packages/models](../packages/models/README.md)     |
| `@modelctx-ai/ctx-mcp`      | 实现 | [packages/mcp](../packages/mcp/README.md)           |
| `@modelctx-ai/ctx-exec`     | 实现 | [packages/exec](../packages/exec/README.md)         |
| `@modelctx-ai/ctx-remote`   | 实现 | [packages/remote](../packages/remote/README.md)     |
| `@modelctx-ai/ctx-gateway`  | 实现 | [packages/gateway](../packages/gateway/README.md)   |

## 其他

| 文档               | 内容           |
| ------------------ | -------------- |
| [更新记录](log.md) | 文档本身的变更 |
