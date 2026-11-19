---
type: Decision Record
title: 'ADR 0008：工具调用经日志往返'
description: '一轮可以停在「等外部执行」：`StopReason` 的 `requires_action`，结果作为 `tool` 消息追加进日志，执行方只需读写会话存储，下一轮不带输入续跑'
tags: [adr, harness, tools, protocol]
status: stable
---

# ADR 0008：工具调用经日志往返

- 状态：已采纳
- 实施状态：已实施，未发布。人工确认也走这条路；`ctx-remote` 按执行环境名字领工作的路由还没做，见文末
- 日期：2026-11-16
- 范围：`ctx-protocol`（`StopReason`、`RunResult.pending`、`pendingToolCalls`、`toolResultEntry`）、`@modelctx-ai/ctx`（harness 的 `external`、`runPendingTools`）
- 依据：issue #21；依赖每一步即时落日志（#20）

## 背景

harness 和执行环境之间只有同步的请求、响应：`Executor.execute(call)` 等到 `ToolOutput` 才返回。三种场景因此做不到：

1. 一轮停下来等外部，例如应用侧执行的工具、要人确认的操作。进程重启后还要能接上，而 `beforeTool` 是进程内函数，等不过重启。
2. 执行环境在内网，只能出站连接。`ctx-remote` 只有 harness 推给执行环境这一个方向。
3. 进程级的 harness（Claude Code、dsh 这类）要把工具交给别处执行，没有约定可依。

三件其实是同一件事：工具调用先落日志，执行方把结果追加回来，harness 从日志继续。#20 之后，工具调用在执行之前已经写进日志，缺的只是「这一轮停在这里」的状态，和追加结果的约定。

## 决定

**一、等待态是一种 `StopReason`。** 新增 `requires_action`：这一轮在日志里留下没有结果的工具调用，然后照常写 `ctx.run.ended` 结束，不占会话。`RunResult.pending` 列出这些调用。不另设「挂起的运行」：一轮结束就是结束，续跑是新的一轮，不带输入，从日志接着走。这和 #20 的 `recover` 续跑是同一个模型，会话里同时最多一个未结束的运行这条约定也不用改。

**二、结果是普通的 `tool` 消息条目。** 执行方追加 `toolResultEntry(call, output)`，带幂等键 `ctx.tool-result:<id>`：同一次调用的结果只记先到的一条，两个执行方都执行了也不会写重。不设新的事件种类：投影、压缩、记忆、导出本来就认 `tool` 消息。

**三、走这条路的是绑定到「外部执行环境」的工具，名单在 harness 上。** `createHarness({ external: ['worker'] })`：绑定到这些执行环境的工具照常交给模型，但在 harness 这一侧不执行。issue 里给了两种写法：

- 执行环境在 harness 这一侧没有实例，就落日志等待。
- 在 `ToolDefinition` 上标注。

两种都没选，选的是 harness 上的名单。没有实例现在的意思是配置错误：模型看到错误，开发者收到告警。把它改成静默等待，配错的工具会让每一轮都停下。`ToolDefinition` 是工具目录里的 JSON，同一个工具在一个部署里由 worker 执行，在另一个部署里可能就在进程内；执行在哪里是部署的事，不是工具的事。

**四、执行方只读写会话存储。** `runPendingTools(store, session, { executor })`：读最后一轮起的条目，用 `pendingToolCalls` 找到等待中的调用，归这个执行环境的逐个执行，追加结果。在内网的 worker 用 `ctx-remote` 的远端会话存储，只要出站连接，不必是一个能被访问的 HTTP 服务。

**五、同步的 `execute` 保留**，作为进程内的快路径；不在 `external` 名单里的工具照旧。

## 三个待定的问题

- **结果齐了没有。** `pendingToolCalls(entries)` 是纯函数：以 `requires_action` 结束的那一轮留下的调用，去掉后面已经有结果的。之后又有运行以别的原因结束，之前等着的就作废，不再算等待中。所以等待期间别人往会话里写了应用事件，不影响判断。结果没齐就开下一轮也可以，投影给缺结果的调用补「没有记录到结果」。
- **结果一直不来。** 超时由应用管，框架不替应用做决定（[概念](../concepts.md)的约束 5）。应用不等了，就照常提交下一轮，等待中的调用随之作废。
- **一轮里多个并行的调用，部分已有结果。** 本地的照常执行，只有外部的留在 `pending` 里；结果可以一个一个追加，`pendingToolCalls` 列出还缺的。

## 代价

- 两个执行方同时领到同一个调用，日志里只记一条结果，但工具执行了两次。有副作用的工具要自己幂等，或者一个执行环境只跑一个执行方。真正的「领取」要存储层支持租约或者比较交换，这里不做。
- `requires_action` 之后由应用决定什么时候续跑。框架不会在结果齐了时自动提交下一轮：什么时候跑一轮是应用（编排器）的事。
- 编排器的状态里，`requires_action` 算 `completed`：这一轮正常结束了。

## 实施状态

- 协议：`StopReason` 加 `requires_action`；`RunResult.pending`；纯函数 `pendingToolCalls`、`toolResultEntry`、常量 `TOOL_RESULT_KEY_PREFIX`、类型 `PendingToolCall`。
- 核心包：`createHarness({ external })`，`toToolSet` 的 `external` 选项（这些工具不带 `execute`，AI SDK 遇到它们的调用就停下这一轮）；`runPendingTools`。
- 人工确认（#21）：`ask` 权限的调用，和 `beforeTool` 按输入回了 `{ ask: true, reason? }` 的调用，确认请求（`tool-approval-request`）写在调用的助手消息里，`RunResult.approvals` 列出；应用追加 `toolApprovalEntry`（`tool-approval-response`，幂等键 `ctx.tool-approval:<approvalId>`），下一轮开头 harness 先执行确认了的、给拒绝的写上 `approvalDeniedOutput`，绑到外部执行环境的确认了留给执行方。协议包另有 `readPendingToolCalls`、`withoutApprovals`（投影去掉确认部件）、`PendingToolCall.approval`；契约测试的等级 `approval`。参考实现用 AI SDK 的 `toolApproval` 停下这一轮；`ctx-pydantic-ai` 没有钩子，只做 `ask` 的那一半，也过这一级。
- 还没做：
  - **`ctx-remote` 按执行环境名字领工作的路由。** 现在 worker 要知道去哪些会话找：`sessions()`、`watch`，或者应用告诉它。

## 决定记录

- 2026-11-16：采纳并实施。
- 2026-11-16：`AgentSpec.permissions` 的 `ask` 复用这条路做静态的人工确认（#47）。
- 2026-11-19：人工确认改成经确认请求和决定往返（#21）。以前 `ask` 的调用只是等着，执行方（`runPendingTools`）不分确没确认都执行，应用不确认就自己追加错误结果；现在决定是日志里的一条 `tool-approval-response`，执行方只执行确认了的，拒绝由下一轮的 harness 写上。不兼容：靠 `runPendingTools` 执行 `ask` 的调用的，要先追加 `toolApprovalEntry`。
