---
type: Decision Record
title: 'ADR 0009：云托管的前提：每会话的执行环境、凭证、主体'
description: '每会话的执行环境进协议（`Executor.open`、`close` 和 `EnvironmentSpec`），凭证不进执行环境只给约定，`ctx-remote` 加鉴权扩展点把请求映射到主体、按主体限制会话前缀和记忆作用域'
tags: [adr, executor, remote, security, hosting]
status: stable
---

# ADR 0009：云托管的前提：每会话的执行环境、凭证、主体

- 状态：已采纳
- 实施状态：已实施，未发布
- 日期：2026-11-16
- 范围：`ctx-protocol`（`Executor.open`、`close`，`EnvironmentSpec`，`AgentSpec.environment`）、`@modelctx-ai/ctx`（harness 在执行前 `open`、`closeExecutorSessions`）、`ctx-remote`（`authenticate`、两条执行环境的会话路径）、`ctx-exec`（按会话的工作目录）
- 依据：issue #25

## 背景

「可以走云托管」只对单租户、可信网络成立。和 Managed Agents 比缺三样：

- 执行环境没有会话的概念：`provision`、`dispose` 管的是整个执行环境，表达不了「每个会话一个容器」，也没有描述环境的形状。
- 凭证会进执行环境：工具要用的密钥经 `ctx-exec` 的 `env` 进子进程，模型生成的代码读得到。
- `ctx-remote` 整个服务一个 Bearer token：没有主体，没有按会话的授权，隔离只靠会话名。

## 决定

**一、每会话的生命周期进协议，另起两个可选方法，不改 `provision`。** `Executor.open?(session, { environment?, signal? })` 为一个会话准备好（起容器、建工作目录），可以重复调，已经准备好就什么都不做；`Executor.close?(session)` 释放，可以重复调。`provision`、`dispose` 照旧管整个执行环境。加参数会让「整个执行环境」和「一个会话」两种语义挤在一个方法里，不认识参数的旧实现还会静默地把每个会话当成整个执行环境。

**二、环境的描述是 JSON，放在 `AgentSpec.environment`。** `EnvironmentSpec` 只有几项通用的：`name`、`image`、`packages`（按包管理器）、`network.allow`（出站白名单）、`env`（要哪些变量的名字，值由部署方给），加一个 `meta` 给实现自己的东西。执行环境满足不了（没有那个镜像、不支持白名单）时 `open` 抛 `invalid_request`，不静默降级。放在 `AgentSpec` 上是因为它跟着 agent 的配置走、记进 `ctx.run.started`，过得了 remote；会话中途换了环境由执行环境决定接受还是报错。

**三、谁调。** harness 在一轮里第一次把调用交给某个执行环境之前调一次它的 `open(session, { environment })`；`open` 抛错时这一轮的工具调用都得到错误结果，模型看得到原因。会话什么时候算结束是应用的事（一次对话、一个工单、一天），框架不猜：应用调 `closeExecutorSessions(executors, session)`，或者自己调各个执行环境的 `close`。闲置回收（一段时间没有调用就关）也是执行环境自己的策略。

**四、凭证不进执行环境，只给约定，不做一套保管库。**

- 凭证不出现在 `ToolCall`、`ExecutionContext`、`AgentSpec` 里，日志里也就没有。
- 需要凭证的工具放在 harness 这一侧执行：函数执行环境、MCP 服务器，凭证在那个进程里，模型生成的代码碰不到。
- 一定要在沙箱里用凭证的，由部署方在出口替换：沙箱里只有占位符，出站代理换成真的。代理不归 ctx 管。
- `ctx-exec` 的子进程本来就不继承 `process.env`。给了 `env` 就是交给子进程，文档写明「模型生成的代码读得到」。

**五、`ctx-remote` 的鉴权扩展点：请求映射到主体，主体限定能碰的会话和记忆作用域。** `authenticate(request) → Principal | undefined`，和 `accessToken` 二选一。`Principal` 是 JSON：

- `id`
- `sessionPrefixes?`：能碰的会话名前缀，不给是全部。
- `memoryScopes?`：能碰的记忆作用域，不给是全部。
- `admin?`：能不能做跨会话的事。

每个带会话的入口都按 `sessionPrefixes` 查，超出范围的回 403。这些入口是：会话的路径、`execute` 的 `context.session`、`runs` 和编排器提交时的 `session`、按 `runId` 取消和查状态时那一轮的会话。

不带会话的入口：

- `GET /sessions` 只列范围里的。
- 编排器的事件流只发范围里的。
- `recover` 横跨所有会话，只有 `admin` 能调。

身份怎么来（JWT、mTLS、网关传来的头）是部署方的事，ctx 不做身份系统。

## 代价

- 租户隔离靠会话名前缀：部署方要按租户给会话名加前缀（`tenant-a/…`）。前缀之外的东西（同一个执行环境实例、同一个模型密钥）不隔离，要隔离就每个租户一套服务。
- 执行环境的 `open` 是同步等待：起容器慢时，这一轮的第一次工具调用要等。预热由应用提前调 `open`。
- harness 每轮都调一次 `open`，执行环境要让「已经准备好」的路径够快。

## 实施状态

- 协议：
  - `Executor.open`、`close`。
  - `ExecutorSessionOptions`、`EnvironmentSpec`、`AgentSpec.environment`。
  - `describeExecutorContract` 加一条：`open`、`close` 可重复，`close` 之后还能再 `open`。
- 核心包：harness 在一轮里第一次交给某个执行环境之前 `open`；`closeExecutorSessions`。函数执行环境的 `open`、`close` 只记会话，不做别的。
- `ctx-exec`：`sessionCwd: true` 时每个会话一个工作目录（`cwd` 下按会话名的哈希建目录），`close` 时删掉。
- `ctx-remote`：
  - 两条路径：`POST /executors/:name/sessions/:session/open`、`DELETE /executors/:name/sessions/:session`。
  - `authenticate` 和 `Principal`；拒绝时 403 `permission_error`，`authenticate` 抛错按认不出算（401）。限定了会话的主体按 `runId` 只碰得到经这个服务提交的运行。

## 决定记录

- 2026-11-16：采纳并实施。
