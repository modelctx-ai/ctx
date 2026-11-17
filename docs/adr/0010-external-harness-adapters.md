---
type: Decision Record
title: 'ADR 0010：外部 harness 的适配：轨迹实时落日志、工具经 MCP 回到 ctx、会话一对一'
description: '自带循环的程序（Claude Code）作为 harness 接进 ctx：流式输出实时写进会话日志，ctx 的执行环境经 MCP 交给它，`ctx.run.started` 记它的身份和会话，失败重试退回到失败之前，映射不了的配置以 `invalid_request` 结束，它压缩自己的上下文时不写 `summary`'
tags: [adr, harness, adapter, claude-code, mcp]
status: stable
---

# ADR 0010：外部 harness 的适配：轨迹实时落日志、工具经 MCP 回到 ctx、会话一对一

- 状态：已采纳
- 实施状态：Claude Code、pydantic-ai（Python）已实施，未发布
- 日期：2026-11-17
- 范围：`ctx-protocol`（`RunStartedData.harness`、`HarnessInfo`、`isContextOverflowText`）、`ctx-mcp`（`createMcpServer` 的 `maxOutputChars`）、新包 `ctx-claude-code`、Python 的 `ctx-pydantic-ai`（`python/pydantic-ai`）
- 依据：issue #23

## 背景

唯一的 harness 是基于 AI SDK 的参考实现，协议里哪些是通用的、哪些只是这一份实现的习惯，分不出来。#23 要用真实的外部 harness 验证「trace 和 execute 各一条约定」，并让每个适配器回答七个问题：轨迹从哪拿、工具怎么接、它自己执行的工具、会话身份、生命周期、配置、上下文。

Claude Code 的无界面模式（`claude -p`）在 2.1.326 上核实过：`--output-format stream-json --include-partial-messages` 逐行给出原始的流式事件、每个内容块一行的助手消息、每个工具结果一行的用户消息和最后的 `result`；它按工作目录把会话存成自己的记录文件，`--resume` 续接、`--session-id` 指定新会话的 id、`--resume-session-at` 只取到某一条为止；`--input-format stream-json` 时 stdin 收用户消息和 `interrupt` 控制消息；MCP 服务器经 `--mcp-config` 给。

## 决定

**一、适配器就是一个 `Harness`。** `run`、`stream` 照协议，`ctx.run.started`、`ctx.run.ended`、`ctx.error` 由适配器写，过 `describeHarnessContract` 的哪几级写在包的 README 里。编排器、`ctx-remote`、`ctx-otel` 不用知道它是外部的。

**二、轨迹从程序的流式输出拿，边读边写。** 不等跑完再导入它的记录文件：日志要能被订阅、崩溃后要留得下「调用已发出」。一条助手消息收齐就写（工具执行之前），一步的工具结果到齐就写，每一步带 `meta.step`。文字和推理的增量只进 `stream` 的事件，和参考实现一样不落日志。程序自己补的用户消息（输出截断后让模型接着写、催模型调结构化输出的工具、中断说明）记成适配器自己的事件，不记成用户消息：日志里的用户消息只有用户说的话，认重试、提取记忆都靠这一点。

**三、工具：ctx 的执行环境经 MCP 交给程序，它自带的工具只进日志。** 每轮起一个只听本机、带一次性令牌的 MCP 服务器（`ctx-mcp` 的 `createMcpServer`），调用落在 ctx 的执行环境上：输入检查、结果截断、执行前 `open` 会话都在 ctx 这边做，和参考实现同一套规则。MCP 服务器的结果截断由 `createMcpServer` 的 `maxOutputChars` 做：MCP 客户端不经过 harness 的那一层。程序自带的工具（`Read`、`Bash`）由应用显式列出才交出去，缺省一个都不交；它们的调用和结果照常记进日志，工具结果条目的 `source` 是 `claude-code`，经 ctx 执行的是执行环境的名字：回看时分得清是谁执行的。

**四、会话一对一，身份进协议，位置放 `meta`。** ctx 的一个会话对着程序的一个会话。`ctx.run.started` 的 `data` 加可选的 `harness`（`HarnessInfo`：`name`、`version`、`session`），下一轮按最近一次记下的 `session` 续接：谁跑的、它自己的会话是哪个，是所有外部 harness 都有的、读日志的一方要知道的，进协议。程序记录里的位置（Claude Code 的消息 uuid）只有这个适配器用得上，放 `meta.claudeCode`：`ctx.run.started` 记这一轮从哪一条接着跑，`ctx.run.ended` 记结束时的最后一条。参考实现不写 `harness`。

**五、失败后的重试退回到失败之前。** 上一轮以 `error` 或 `aborted` 结束、这一轮带同样的输入（或同一个 `inputKey`）重试，认法和参考实现一样；这时适配器用 `--resume-session-at` 退回到失败那一轮开始的位置再跑，程序的记录文件分出一支，原来的不改。否则失败那一轮的输入会在程序的上下文里出现两次，上下文过长时越重试越长——参考实现不再记输入就是为了避免它。换了一句话就照常接着跑，失败那一轮留在上下文里，也和参考实现一样。

**六、生命周期和停止原因。** `signal` 中止时先发 `interrupt` 控制消息，让程序停下手里的模型调用和工具、照常给出结果，过了时限才结束进程。`stopReason` 按程序的结果映射：用完轮数是 `max_steps`（这一步的工具照样执行，同参考实现），中断是 `aborted`，接口错误是 `error`，`error.type` 按状态码和文字定（上下文过长用协议的 `isContextOverflowText` 认）。`isContextOverflowText` 从核心包挪进协议包：适配器只依赖协议包，拿到的是上游的原始文字，不是 AI SDK 的错误对象。

**七、配置：映射不了的以 `invalid_request` 结束。** `AgentSpec` 里能对上的映射过去（模型名、指令、步数、结构化输出、`allow` 和 `deny` 的权限、预算、执行环境、重试次数、输出长度、超时），对不上的（`window`、`context`、`auto` 以外的 `toolChoice`、`ask` 权限、其余的调用参数）在场时这一轮以 `invalid_request` 结束，不静默忽略：协议本来就要求不支持的字段要么报错、要么写进一致性等级。

**八、上下文是程序自己的，ctx 不写 `summary`。** 程序压缩自己的上下文时，适配器记一条事件（带它给的元数据），摘要文字作为程序补的消息记下，不写 ctx 的 `summary` 条目。`summary` 的意思是「投影时 `covers` 之前的条目由它代替」，那是 ctx 自己的投影的事；程序不读 ctx 的投影，写了反而让别的读日志的一方（参考实现、记忆）以为历史被压过。不跑 `context` 一级。

**九、适配包可以依赖 `ctx-mcp`。** 「实现包之间不互相依赖」（[ADR 0002](0002-packages.md)）的例外：`ctx-claude-code` 把 `ctx-mcp` 当 peer，复用 `createMcpServer`。把 MCP 服务器那一半挪进协议包会把 `node:http` 带进协议包；在适配包里再写一份，两份的结果转换会分叉。peer 而不是 dependency：应用里只有一份 `ctx-mcp`。

## 代价

- 程序看不到 ctx 日志里别处写的东西（应用的事件、别的 harness 跑的轮次）：它只读自己的会话。一个 ctx 会话只给一种 harness 跑。
- 续接依赖程序的记录文件还在：换了工作目录或配置目录、删了记录，下一轮以 `not_found` 结束。
- 依赖两个 `--help` 里没有列出的参数（`--max-turns`、`--resume-session-at`）和 stream-json 的行格式。适配器按核实过的版本写，升级程序要重跑契约测试；CI 装固定版本跑。
- `RunRequest.prompt` 对不上「临时」：只能当作这一轮的用户消息交出去，留在程序自己的会话里。
- 子代理里面的消息还不进子会话。

## 没有采用的方案

- **跑完再读它的记录文件。** 简单，但不实时：日志在一轮结束前看不到，崩溃时什么都没留下。
- **用程序的钩子拿轨迹。** 钩子是每个事件起一个命令，拿得到工具调用，拿不到模型的消息和增量。
- **每轮 `--fork-session` 换新会话。** 重试时从上一个成功的会话再分一次就不会重复输入，但每轮复制一整份记录，长对话的磁盘用量平方级增长。
- **每轮不续接，把 ctx 的投影交给它。** 程序只认自己的记录文件，没有注入历史的接口。
- **`harness` 也记进 `ctx.run.ended`。** 结束位置只有这个适配器用，放 `meta` 就够，不改 `RunEndedData`。

## 实施状态

- 协议：`RunStartedData.harness`、`HarnessInfo`；`isContextOverflowText` 从核心包挪过来，核心包的 `isContextOverflowError` 改用它。
- `ctx-mcp`：`createMcpServer` 的 `maxOutputChars`（缺省 `DEFAULT_MAX_TOOL_OUTPUT_CHARS`），`onResult` 收到截过的结果。
- `ctx-claude-code`：`createClaudeCodeHarness`，过 `trace`、`execute`、`resume`、`output` 四级，对 Claude Code 2.1.326 验证过，模型是本机的假接口；对真实的 Anthropic 接口没有验证。
- `ctx-pydantic-ai`（Python，[`python/pydantic-ai`](../../python/pydantic-ai/README.md)）：`PydanticAIHarness` 和它的线上入口 `create_app`，加上线上协议的 Python 客户端 `RemoteSessionStore`、`RemoteExecutor`。经 `ctx-conformance` 过 `trace`、`execute`、`resume`、`output` 四级；对 pydantic-ai 2.69.0 验证过，模型是按剧本回答的 `FunctionModel` 和它自带的 `test` 模型，对真实的模型服务没有验证。
- 没做：子代理的轨迹写进子会话；pydantic-ai 的 `ask` 权限、`window` 和 `context`。

## 决定记录

- 2026-11-17：采纳；Claude Code 的适配器实施。
- 2026-11-17：pydantic-ai 的适配器实施，用 Python 写：第二种形态（库，不是进程）、第二种语言，验证这份决定和线上协议不只是这一份 TypeScript 的习惯。和 Claude Code 不一样的地方，决定正文不变：
  - 决定三：工具不经 MCP。pydantic-ai 的工具本来就是进程内的函数，每个 ctx 工具包成一个 `Tool`，调用直接交给执行环境（多半是 `ctx-remote` 上的）；`deny` 的工具照样交给模型、调用时回拒绝，同参考实现。它没有自带的工具。
  - 决定四：没有另一份会话。pydantic-ai 不存对话，每一轮的历史都从 ctx 的日志投影出来，`HarnessInfo` 只写 `name`、`version`；投影照协议包 `project` 的缺省规则移植，测试对同一组日志和 TypeScript 的结果比。
  - 决定五：不用退回。历史本来就读 ctx 的日志，重试时不再写输入就够，认法和参考实现一样。
  - 决定二：pydantic-ai 让模型改了再答时补的话（`RetryFeedbackPart`）记成 `pydantic-ai.retry` 事件。
  - 决定八：上下文由 ctx 投影，但还不裁窗口、不压缩，`window`、`context` 以 `invalid_request` 结束；不跑 `context` 一级。
  - 线上协议的服务端（`POST /runs` 的心跳、NDJSON、取消、`Host` 和 `Origin` 的检查）用 Python 再写了一份，一致性模式只给 harness；`PROTOCOL_VERSION`、`ENTRY_VERSION` 和截断、配对用的常量由测试从 TypeScript 源码里读出来比。
