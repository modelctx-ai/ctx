# ctx 文档

想知道 ctx 是什么、怎么拆，看概念；要实现或替换一个组件，看协议层；要用现成的，看参考实现。

## 设计

| 文档                  | 内容                                                                                                                                            |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| [概念](concepts.md)   | 定位、七个组件、术语、和 Anthropic 公开实践的对应、设计约束                                                                                     |
| [协议层](protocol.md) | 九个协议（含记忆的三个和门面 `Memory`）的职责、签名、JSON 形状、激活度公式、契约测试、托管矩阵、HTTP 线上形态                                   |
| [记忆](memory.md)     | 第八个组件（已实现，未发布）的设计：四层记忆和 ctx 组件的对应、五个决策各交给谁、怎么接进其余组件、预算、失败模式。签名在协议层，参考实现在架构 |

## 参考实现

| 文档                    | 内容                                                                                                                                                                                             |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [架构](architecture.md) | 进程内参考实现：条目和存储、投影、调用和记录、压缩、来源、工具和 MCP、函数执行环境、harness、编排器、记忆（`createMemory` 的门控 / 召回 / 巩固、存储、模型实例化、组装）、网关、扩展点、实现约束 |
| [实践：yoyo](repos.md)  | ctx、yoyo、dsh-pet 各管什么，契约、依赖和运行时拓扑，本地联调                                                                                                                                    |

## 决策记录

| ADR                                                                                      | 内容                                                                                                                     |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| [0001：TypeScript](adr/0001-typescript.md)                                               | 为什么 ctx 和 yoyo 用 TypeScript；工具链和编译选项                                                                       |
| [0002：包](adr/0002-packages.md)                                                         | 包怎么拆、怎么命名，源码条件，版本，发布，使用方式                                                                       |
| [0003：上下文模型](adr/0003-context-model.md)                                            | 只追加的日志加投影、摘要检查点、幂等导入、事实不进日志、延后记录                                                         |
| [0004：协议与实现](adr/0004-protocol-and-implementation.md)                              | 协议层和实现层分开，七个组件各一个协议，组件不绑定托管形态，`thread` 改 `session`                                        |
| [0005：位置、并发写入、消息格式、上下文配置](adr/0005-session-position-writes-format.md) | 位置只用 `seq`，写入前提条件 `expectSeq`，ctx 自己的带版本的 JSON 消息格式，`AgentSpec.context`，会话分页和 `kinds` 过滤 |
| [0006：记忆](adr/0006-memory.md)                                                         | 记忆作为第八个组件：只读日志、夜里改写、事实不 UPDATE、证据必填、System One 模型做判断、遗忘是公式、只用已有扩展点接入   |

## 包

| 包                          | 层   | 说明                                                |
| --------------------------- | ---- | --------------------------------------------------- |
| `@modelctx-ai/ctx-protocol` | 协议 | [packages/protocol](../packages/protocol/README.md) |
| `@modelctx-ai/ctx`          | 实现 | [packages/core](../packages/core/README.md)         |
| `@modelctx-ai/ctx-sqlite`   | 实现 | [packages/sqlite](../packages/sqlite/README.md)     |
| `@modelctx-ai/ctx-models`   | 实现 | [packages/models](../packages/models/README.md)     |
| `@modelctx-ai/ctx-memory`   | 实现 | [packages/memory](../packages/memory/README.md)     |
| `@modelctx-ai/ctx-mcp`      | 实现 | [packages/mcp](../packages/mcp/README.md)           |
| `@modelctx-ai/ctx-exec`     | 实现 | [packages/exec](../packages/exec/README.md)         |
| `@modelctx-ai/ctx-remote`   | 实现 | [packages/remote](../packages/remote/README.md)     |
| `@modelctx-ai/ctx-gateway`  | 实现 | [packages/gateway](../packages/gateway/README.md)   |

## 其他

| 文档                         | 内容               |
| ---------------------------- | ------------------ |
| [更新记录](log.md)           | 文档本身的变更     |
| [CHANGELOG](../CHANGELOG.md) | 代码的变更，按版本 |
