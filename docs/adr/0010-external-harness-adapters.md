---
type: Decision Record
title: 'ADR 0010：外部 harness 的适配：轨迹实时落日志、工具经 MCP 回到 ctx、会话一对一'
description: '自带循环的程序（Claude Code、pi）作为 harness 接进 ctx：流式输出实时写进会话日志，ctx 的执行环境经 MCP 交给它，`ctx.run.started` 记它的身份和会话，失败重试退回到失败之前，映射不了的配置以 `invalid_request` 结束，它压缩自己的上下文时不写 `summary`'
tags: [adr, harness, adapter, claude-code, pi, mcp]
status: stable
---

# ADR 0010：外部 harness 的适配：轨迹实时落日志、工具经 MCP 回到 ctx、会话一对一

- 状态：已采纳
- 实施状态：Claude Code、pydantic-ai（Python）、pi 已实施，未发布
- 日期：2026-11-17
- 范围：`ctx-protocol`（`RunStartedData.harness`、`HarnessInfo`、`isContextOverflowText`）、`ctx-mcp`（`createMcpServer` 的 `maxOutputChars`）、新包 `ctx-claude-code`、`ctx-pi`、Python 的 `ctx-pydantic-ai`（`python/pydantic-ai`）
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
- `ctx-claude-code`：`createClaudeCodeHarness`，过 `trace`、`execute`、`resume`、`output` 四级，对 Claude Code 2.1.326 验证过，模型是本机的假接口；对真实的 Anthropic 接口没有验证。Claude Code 起的子代理写进子会话（2026-11-18，对 2.1.326 和 2.1.327 核实过）。
- `ctx-pydantic-ai`（Python，[`python/pydantic-ai`](../../python/pydantic-ai/README.md)）：`PydanticAIHarness` 和它的线上入口 `create_app`，加上线上协议的 Python 客户端 `RemoteSessionStore`、`RemoteExecutor`。经 `ctx-conformance` 过 `trace`、`execute`、`resume`、`context`、`output` 五级（`context` 一级 2026-11-18 起）；对 pydantic-ai 2.69.0 验证过，模型是按剧本回答的 `FunctionModel` 和它自带的 `test` 模型，对真实的模型服务没有验证。`ask` 权限和外部执行环境（`external`）以 `requires_action` 结束，`window`、`context` 照参考实现的 builder 移植（都是 2026-11-18）。
- `ctx-pi`：`createPiHarness`，过 `trace`、`execute`、`resume`、`output` 四级，对 pi 1.5.2 验证过（2026-11-18），模型是本机的假 Anthropic 接口；对真实的模型服务没有验证。CI 装同一个版本跑。
- 没做：pydantic-ai 的压缩（`context.overflow` 的 `compact` 只裁）、事件规则和别的投影、事实来源；pi 的扩展加进上下文的消息（`custom_message`）和插话（`steer`、`follow_up`）不进日志。

## 决定记录

- 2026-11-17：采纳；Claude Code 的适配器实施。
- 2026-11-17：pydantic-ai 的适配器实施，用 Python 写：第二种形态（库，不是进程）、第二种语言，验证这份决定和线上协议不只是这一份 TypeScript 的习惯。和 Claude Code 不一样的地方，决定正文不变：
  - 决定三：工具不经 MCP。pydantic-ai 的工具本来就是进程内的函数，每个 ctx 工具包成一个 `Tool`，调用直接交给执行环境（多半是 `ctx-remote` 上的）；`deny` 的工具照样交给模型、调用时回拒绝，同参考实现。它没有自带的工具。
  - 决定四：没有另一份会话。pydantic-ai 不存对话，每一轮的历史都从 ctx 的日志投影出来，`HarnessInfo` 只写 `name`、`version`；投影照协议包 `project` 的缺省规则移植，测试对同一组日志和 TypeScript 的结果比。
  - 决定五：不用退回。历史本来就读 ctx 的日志，重试时不再写输入就够，认法和参考实现一样。
  - 决定二：pydantic-ai 让模型改了再答时补的话（`RetryFeedbackPart`）记成 `pydantic-ai.retry` 事件。
  - 决定八：上下文由 ctx 投影，但还不裁窗口、不压缩，`window`、`context` 以 `invalid_request` 结束；不跑 `context` 一级。
  - 线上协议的服务端（`POST /runs` 的心跳、NDJSON、取消、`Host` 和 `Origin` 的检查）用 Python 再写了一份，一致性模式只给 harness；`PROTOCOL_VERSION`、`ENTRY_VERSION` 和截断、配对用的常量由测试从 TypeScript 源码里读出来比。
- 2026-11-18：Claude Code 起的子代理（`Task` 工具）写进子会话，「代价」里最后一条不再成立。照协议的父子运行：子会话名同进程内派子 agent 的缺省（`<发起方的会话>/<工具名>/<调用 id>`），`ctx.run.started` 带 `parent`，发起方那次调用的结果是 `ChildRunResult`。和决定正文的关系：
  - 决定二：子代理在前台跑才有完整的轨迹，适配器给 Claude Code 设 `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`。缺省时子代理在后台跑，`Task` 立刻返回「已启动」，这一轮先结束，子代理的轨迹落在这一轮之外。后台命令（`Bash` 的 `run_in_background`）一起关掉：一轮到 `result` 就结束进程，它们本来就活不过这一轮。
  - 决定二：子代理最后的回答不单独转出，只在那次调用的结果里（`tool_use_result.content`），适配器补成子会话里的一条助手消息；子代理再派的子代理里面的消息 Claude Code 不转出，那一层只记输入、回答和结束。
  - 决定四：子运行的 `harness` 不带 `session`：子代理的记录挂在父会话下面，不能单独续接。
- 2026-11-18：pydantic-ai 的 `ask` 权限和外部执行环境（`external`）实施，决定七里列着的「`ask` 权限」不再以 `invalid_request` 结束。交给别处执行的工具在 pydantic-ai 里抛 `CallDeferred`（输出类型里加 `DeferredToolRequests`），pydantic-ai 走完那一步就停下，这一轮以 `requires_action` 结束，`pending` 和参考实现一样；执行方追加结果用的 `tool_result_entry`、`pending_tool_calls` 移植到 Python，测试和 TypeScript 的比。核对时发现参考实现把绑到外部执行环境、权限是 `deny` 的工具也当成等别处执行，和协议说的「`deny` 的不执行」不符，一起改成 `deny` 优先。
- 2026-11-18：pydantic-ai 的 `window`、`context` 实施，2026-11-17 那条里决定八的「还不裁窗口」不再成立。窗口、超窗兜底和继承父会话照参考实现的 builder 移植：`maxTokens` 是整次调用的预算，先扣掉指令、工具定义和不进日志的输入，按上一轮第一步的实际用量校准；token 的估算、截短和投影一起移植，测试对同一组输入和 TypeScript 的结果比。`context` 一级经 `ctx-conformance` 过了。还是不压缩：适配器没有写摘要用的模型，`compact` 和 builder 没有压缩时一样直接裁；`projection` 只认 `default`。
- 2026-11-18：pi 的适配器实施（`ctx-pi`，对 pi 1.5.2 核实过）：第二个进程级的 harness，验证决定二到决定八不只是 Claude Code 一家的形状。pi 的 RPC 模式（`pi --mode rpc`）在 stdin、stdout 上收发一行一条的 JSON 命令和事件；`-e` 加载的扩展能注册 MCP 服务器、在执行前改写或拦下工具调用、在一步结束时叫停、注册命令。和 Claude Code 不一样的地方，决定正文不变：
  - 决定三：MCP 服务器不经命令行给，由这一轮的扩展用 `registerMcpServer` 交给 pi 内置的 MCP 扩展，`--tools` 只列这一轮交出去的工具。pi 的 `mcp.json` 里有同名的服务器时它优先，调用会落到别处：适配器看模型第一次回答之前 MCP 服务器有没有收到带令牌的请求，没有就以 `error` 结束。
  - 决定三：pi 执行工具之前把参数照 schema 转一遍（数字当字符串、可选属性的 `null` 当没给），不合 schema 的输入就查不出来了。扩展在 `message_end` 记下模型给的原样，`tool_call` 时把 ctx 的工具的参数换回去，输入检查还在 ctx 的 MCP 服务器里做，日志里记的调用就是执行的那一个。`deny` 的工具照样交出去、调用时回拒绝（同参考实现），扩展和 MCP 服务器两边都拦。
  - 决定四、五：位置是 pi 会话里条目的 id（`meta.pi` 的 `resumeAt`、`last`），续接用 `--session-id`。退回不靠命令行参数：扩展注册一个名字随机的命令，`navigateTree` 到失败那一轮开始的位置，不写摘要；记录文件里分出一支，原来的不改。
  - 决定六：pi 没有步数的上限。`maxSteps` 和 `budget` 由扩展在调了工具的一步结束时（`turn_end`）叫停（`ctx.abort()`），pi 不再调模型；停止原因由适配器按步数和用量定成 `max_steps`、`max_budget`，不是 `aborted`。扩展要人回答的对话框一律回取消：整轮没有人在场。
  - 决定七：pi 没有结构化输出，`output` 的 schema 写进系统提示，最后的回答按 schema 查，不合的以 `invalid_output` 结束。`settings.maxRetries` 只认 `0`（关掉 pi 的自动重试）：重试几次是 pi 自己的设置，RPC 里改不了。
  - 决定八：pi 压缩自己的上下文时记 `pi.compacted`，摘要放在这条事件的 `text` 里：pi 不把摘要当成一条消息交出来，不另记程序补的消息。
  - `record: false`：新会话不存（`--no-session`），接着跑的在一份副本上跑（`--fork`），跑完删掉副本，pi 的会话不变。
