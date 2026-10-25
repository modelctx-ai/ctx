# 文档更新记录

## 2026-10-25

- **定位**：ctx 从「给 yoyo 用的上下文管理库」改成「面向 agent 原生程序的上下文与运行框架」：协议层、实现层、实践三层。README、索引按此重写。
- **新增** [概念](concepts.md)：七个组件、术语、和 Anthropic 公开实践（Managed Agents、上下文工程、长程 harness、工具设计、Agent SDK）的对应、设计约束。
- **新增** [协议层](protocol.md)：`SessionStore`、`ContextBuilder`、`ToolRegistry`、`Executor`、`Harness`、`Orchestrator` 的签名草案、框架事件 `ctx.*`、托管矩阵、HTTP 线上形态。
- **新增** [ADR 0004](adr/0004-protocol-and-implementation.md)：协议与实现分开，包布局加 `ctx-protocol`、`ctx-exec`、`ctx-remote`，`thread` 改 `session`。
- **更新** [架构](architecture.md)：标明它写的是进程内参考实现，开头加分层图；术语跟着改 `session`。
- **更新** [实践：yoyo](repos.md)：yoyo 定位为 ctx 的实践，导演和常驻循环对应编排器。
- **更新** [ADR 0002](adr/0002-packages.md)：包表加协议包和新适配包，依赖方向加「协议 ← 实现」。

## 2026-10-23

- 建立文档：架构、三个仓库、ADR 0001–0003。
