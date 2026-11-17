---
type: Overview
title: '概念'
description: 'ctx 的定位、七个组件和第八个组件记忆、术语表、和 Anthropic 公开实践的对应、设计约束'
tags: [design, terminology]
status: stable
---

# 概念

ctx 是面向 agent 原生程序的上下文与运行框架。它把一个 agent 拆成七个组件，每个组件一个协议；组件之间只通过协议交互，任何一个都可以单独替换。其中会话、执行环境、harness、编排和记忆存储有线上形态，能单独托管、用别的语言实现（[托管矩阵](protocol.md#托管矩阵)）；上下文、工具目录、模型是进程内的，跟着 harness 走。本仓库给每个协议一份参考实现，[yoyo](https://github.com/modelctx-ai/yoyo) 是把它们组合成业务的实践。

## 七个组件

```mermaid
flowchart LR
  orch["编排 Orchestrator<br/>什么时候跑、跑哪个会话"]
  harness["Harness<br/>一轮：组装 → 调模型 → 分发工具 → 写回"]
  ctxb["上下文 ContextBuilder<br/>日志 + 事实 + 输入 → 指令、消息、工具名单"]
  store[("会话 SessionStore<br/>只追加的事件日志")]
  tools["工具 ToolRegistry<br/>名字、说明、Schema、绑定"]
  exec["执行环境 Executor<br/>execute(call) → output"]
  model["模型 LanguageModel"]

  orch --> harness
  harness --> ctxb
  harness --> model
  harness --> tools
  harness --> exec
  ctxb --> store
  harness --> store
  tools -. 绑定 .-> exec
```

| 组件              | 一句话                                                                                           | 像什么                                                         | 参考实现                     |
| ----------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- | ---------------------------- |
| 会话 Session      | 一个 agent 实例的全部经历，只追加的事件日志，放在模型的上下文窗口之外                            | Managed Agents 的 session，Claude Code 的会话记录              | 内存、SQLite、HTTP 远端      |
| 上下文 Context    | 这一次调用模型时交给它的东西：从日志、来源、输入里算出来，每次重算，不改日志                     | 上下文工程本身                                                 | 投影 + 来源 + 窗口 + 压缩    |
| 工具 Tools        | 模型能调用什么：名字、说明、输入结构；每个工具绑一个执行环境                                     | 函数调用、MCP 工具                                             | 注册表                       |
| 执行环境 Executor | 工具调用真正发生的地方：进程内函数、本机子进程、容器、远端服务                                   | Managed Agents 的 sandbox / 自托管 worker，Claude Code 的 Bash | 函数、子进程、MCP、HTTP 远端 |
| Harness           | 跑一轮的循环：组装上下文、调模型、把工具调用交给执行环境、把结果写回会话，直到模型停下或达到上限 | Managed Agents 的 harness，Agent SDK 的 agent loop             | 基于 AI SDK 的循环           |
| 编排 Orchestrator | 跨轮次、跨会话的调度：排队、串行、取消、定时、崩溃后从日志续跑、多 agent 分工                    | Managed Agents 的控制面，yoyo 的常驻循环和导演                 | 进程内队列                   |
| 模型 Model        | 一次模型调用                                                                                     | AI SDK `LanguageModel`                                         | `ctx-models` 按配置造        |

第八个组件是**记忆**（见[记忆](memory.md)和 [ADR 0006](adr/0006-memory.md)）：会话日志回答「发生过什么」，记忆回答「什么仍然成立、上次的教训是什么」。它是一个独立的存储 `MemoryStore`（笔记、事实、程序、画像），只读会话日志、从不改它；白天打分和召回，夜里由提取模型、决策模型和 `LanguageModel` 整理。它通过已有的扩展点接进来：`Memory` 门面是一个 `Executor`（提供 `recall` 工具），`memory.source()` 是一个 `ContextSource`，什么时候 `gate`、什么时候 `consolidate` 是编排器的事。上面的图和表不变。

| 组件        | 一句话                                                                               | 像什么                                              | 参考实现                                                                                                     |
| ----------- | ------------------------------------------------------------------------------------ | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 记忆 Memory | 从日志里提炼出来、跨会话持久、可以重建的知识：事实（带有效期）、程序（带证据）、画像 | Mem0 的事实记忆、Letta 的核心记忆、Hindsight 的反思 | `ctx-memory` 的 `createMemory`；存储在内存、SQLite、HTTP 远端；System One 模型（`ctx-models`）或启发式做判断 |

一个 agent 的**配置**（用哪个模型、什么指令、哪些工具、什么参数）是一个 JSON 值 `AgentSpec`，不是组件。同一个 harness 跑不同的配置就是不同的 agent；Managed Agents 的 Agent 资源、长程 harness 文章里「初始化 agent 和编码 agent 只差第一条提示」说的都是这件事。

## 术语

| 术语                           | 说明                                                                                                                                                                                                                                                                                                                       |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 会话 `session`                 | 日志的名字，字符串，例如 `user:42`、`pet:main`。原来叫 `thread`，见 [ADR 0004](adr/0004-protocol-and-implementation.md)                                                                                                                                                                                                    |
| 条目 `Entry`                   | 日志里的一条：`message`（ctx 自己的 JSON 消息 `Message`）、`event`（应用或框架的事件）、`summary`（压缩点）。写入后不改                                                                                                                                                                                                    |
| 位置 `seq`                     | 条目在会话里的写入序号：会话内严格递增，`list`、`watch`、`covers` 都按它；逻辑时间 `at` 只用于投影排序                                                                                                                                                                                                                     |
| 消息 `Message`、版本 `v`       | ctx 自己的 JSON 消息格式，是 AI SDK `ModelMessage` 的子集，和它互转；每个条目带写入时的格式版本 `v`，旧行读时升级（`upgradeEntry`），不改写存量                                                                                                                                                                            |
| 写入前提 `expectSeq`           | `append` 的选项：会话末尾的 `seq` 不等于它就整批不写，抛 `conflict`。没有租约，`seq` 就是围栏令牌                                                                                                                                                                                                                          |
| 围栏                           | 一轮运行写入时发现自己的 `runId` 已被别人写了 `ctx.run.ended`（被 `recover` 收走），或者自己写的条目被清掉、被擦除：以 `aborted` 停下，不再写。一个会话最多一个未结束的运行，否则新的一轮以 `session_busy` 结束                                                                                                            |
| 擦除、擦除记录 `ctx.erased`    | 只追加的例外：`truncate`（删掉 `seq ≤ upTo` 的）、`remove`（按 `id` 真删）、`redact`（按 `id` 涂改）。真的动了条目时存储追加一条 `ctx.erased`（只有位置），所以末尾一定前进、旧的 `expectSeq` 一定冲突一次、`watch` 收得到                                                                                                 |
| 涂改 `redact`、`ctx.redacted`  | 条目的内容换成占位事件 `ctx.redacted`，`id`、`seq`、`at`、`key` 留着：位置还在，摘要的 `covers` 和记忆的证据照常指得到，同一个幂等键的重试写不回来                                                                                                                                                                         |
| 保留期                         | 应用自己调的清理：`pruneSession` 删掉被摘要盖住的旧历史，按条数或时间留一部分。框架里没有定时器                                                                                                                                                                                                                            |
| 导出、导入                     | 把一个会话搬到别的存储：`exportSession` 导成 JSON Lines，`importSession` 写进目标存储并把摘要的 `covers` 这类 `seq` 引用换成目标存储的位置；`copySession` 是两步连起来。`seq` 是各个存储自己分配的，不能 `list` 再 `append`                                                                                                |
| 所有者 `owner`                 | 部署者给编排器的稳定实例名，写进 `ctx.run.started`；`recover` 只收同一个 `owner` 的断点                                                                                                                                                                                                                                    |
| 协议版本 `PROTOCOL_VERSION`    | 线上协议的版本，和包的 minor 版本一起走；客户端连上先读 `GET /protocol`（`ProtocolInfo`：版本、条目格式、挂了的组件），不同就报错                                                                                                                                                                                          |
| 一致性模式                     | 被测服务多一个 `POST /conformance/instances`，每个用例一个隔离的实例；`ctx-conformance` 对这个地址跑契约测试，别的语言的实现也这样验证                                                                                                                                                                                     |
| 一致性等级 `HarnessLevel`      | harness 的契约按能力分级：`trace`（一轮写进日志）、`execute`（工具交给 ctx 的执行环境）、`resume`（围栏、幂等、续跑），加上正交的 `context`（用 `ContextBuilder`）、`output`。进程级的 harness 的适配器跑自己做到的几级                                                                                                    |
| 外部 harness、`HarnessInfo`    | 自带循环的程序（Claude Code）经适配器当 harness 用：轨迹实时写进日志，ctx 的工具经 MCP 交给它；`ctx.run.started` 的 `harness` 记它是谁、它自己的会话是哪个（[ADR 0010](adr/0010-external-harness-adapters.md)）                                                                                                            |
| 父运行、子运行 `parent`        | 一个 agent 经工具调用派另一个 agent 在子会话上跑一轮：子会话的 `ctx.run.started` 记 `parent`，父会话的工具结果是 `ChildRunResult`，取消沿着链往下传                                                                                                                                                                        |
| 继承上下文 `inherit`           | `AgentSpec.context.inherit`：把另一个会话（一般是父会话）到某个 `seq` 的投影接在本会话的历史前面，只读不写                                                                                                                                                                                                                 |
| 权限策略 `permissions`         | `AgentSpec` 里按工具名的 `allow`、`ask`、`deny`：能序列化，过得了线；`ask` 走 `requires_action`                                                                                                                                                                                                                            |
| 预算 `budget`                  | `AgentSpec` 里整轮的 token 和墙钟上限，在步骤之间检查，超了以 `max_budget` 停下                                                                                                                                                                                                                                            |
| 结构化输出 `output`            | `AgentSpec` 里的 JSON Schema：最后的回答按它解析进 `RunResult.output`，不合是 `invalid_output`                                                                                                                                                                                                                             |
| 执行环境的会话 `open`、`close` | 执行环境为一个会话准备的资源（容器、工作目录）：harness 在一轮里第一次交给它之前 `open`，应用在会话结束时 `close`；`provision`、`dispose` 管的是整个执行环境                                                                                                                                                               |
| 环境描述 `EnvironmentSpec`     | `AgentSpec.environment`：镜像、包、出站白名单、要哪些环境变量的名字，能序列化；执行环境做不到就在 `open` 里报 `invalid_request`                                                                                                                                                                                            |
| 主体 `Principal`               | `ctx-remote` 的 `authenticate` 认出的调用方：`id`，能碰的会话前缀、记忆作用域，能不能 `recover`；超出范围的回 403                                                                                                                                                                                                          |
| 等待外部执行 `requires_action` | 一轮留下了要在别处执行的工具调用（绑定到 harness 的 `external` 执行环境）后结束；执行方把结果作为 `tool` 消息追加进日志，下一轮不带输入接着跑（[ADR 0008](adr/0008-tool-calls-through-the-log.md)）                                                                                                                        |
| 续跑 `resume`                  | 崩溃后从日志接着跑断掉的一轮：harness 每一步即时落日志、工具调用先写再执行，`recover` 给结果未知的调用补错误结果，编排器配了 `resume` 的在同一个会话上提交一轮不带输入的运行                                                                                                                                               |
| 步骤元数据 `meta.step`         | harness 写给每一步助手消息的 `StepMeta`：哪一轮的第几步、服务商实际用的模型、这一步的用量 `Usage`（含缓存读写和推理 token）；整轮合计在 `ctx.run.ended`                                                                                                                                                                    |
| 对齐点 `seq`（流）             | `RunEvent` 里 `run.started`、`model.ended`、`run.ended` 带的 `seq`：发出时日志已经写到这里，流断了从它接着读日志                                                                                                                                                                                                           |
| 上下文配置 `ContextSpec`       | `AgentSpec.context`：按名字选事实的来源、位置和投影，能序列化                                                                                                                                                                                                                                                              |
| 事实 `Fact`                    | 来源在调用那一刻取到的文字，只用于这一次，不写日志                                                                                                                                                                                                                                                                         |
| 投影 `Projection`              | 把条目渲染成这一次交给模型的消息                                                                                                                                                                                                                                                                                           |
| 窗口 `window`、截短            | 这一次投影最多带多少：`maxMessages`、`maxTokens` 从最旧的消息整组丢起；`truncate` 另外把超预算的单条消息截短（文字留头尾，工具结果截短，内联文件换成说明）。只影响这一次，什么都不写                                                                                                                                       |
| 压缩、滚动摘要、检查点         | `compact` 把较早的历史压成 `summary` 条目。历史超过摘要模型一次能收的输入（`maxInputTokens`）时分段：每段连同到目前为止的摘要压成新的摘要，带进下一段，这是滚动摘要；每段压完写下的那条摘要是检查点，中途停下也不丢。结果 `CompactResult.status` 是 `compacted`、`not_needed`、`truncated`、`empty`、`input_too_long` 之一 |
| 超窗兜底 `OverflowSpec`        | `AgentSpec.context.overflow`：整次调用的估算超过 `maxTokens` 时，harness 先压缩、再裁剪（单条超预算时截短），还放不下就不调模型。能序列化，缺省关着                                                                                                                                                                        |
| 上下文过长 `context_overflow`  | `ErrorInfo.type` 的一个值：上下文超过了模型的窗口。超窗兜底放不下时由 harness 给出，服务商拒绝调用时由 harness 认出来；这一轮的 `stopReason` 是 `error`。`isContextOverflow(error)` 认它                                                                                                                                   |
| 事件 `kind`                    | 事件的类型名，`{domain}.{action}` 写法。框架保留 `ctx.` 前缀（`ctx.run.started`、`ctx.run.ended`、`ctx.compacted`、`ctx.error`、`ctx.unreadable`、`ctx.erased`、`ctx.redacted`，常量 `CTX_EVENTS`），应用自定其余。事件缺省对模型不可见，投影规则决定怎么渲染                                                              |
| 一轮 `run`                     | harness 的一次运行：一个输入进去，若干次模型调用和工具调用，一个 `stopReason`（`end_turn`、`max_steps`、`max_tokens`、`aborted`、`error`）出来；`error` 时 `error.type` 说是哪一种（`session_busy`、`context_overflow`、`api_call`……）。`runId` 标识它                                                                     |
| 工具调用 `ToolCall`            | `{ id, name, input }`；结果 `ToolOutput` 是文字、JSON、内容块或错误，和 AI SDK 的工具结果互转                                                                                                                                                                                                                              |
| 执行上下文 `ExecutionContext`  | 一次工具调用附带的环境：会话、`runId`、取消信号                                                                                                                                                                                                                                                                            |
| 钩子 `Hooks`                   | harness 在调模型前后、执行工具前后给应用的切入点；权限确认是「执行工具前」的一个钩子                                                                                                                                                                                                                                       |
| 笔记 `Note`                    | 写入门控的结果：日志里值得夜里处理的一段（`session`、`from`、`upTo` 是 `seq` 区间）加显著性、类别、主题。不复制内容。                                                                                                                                                                                                      |
| 死信                           | 夜里处理失败次数到了上限的笔记（`Note.failedAt`）：不再算待处理、不再处理，`notes.list({ failed: true })` 列出来，修好原因后 `notes.retry` 放回去                                                                                                                                                                          |
| 幂等键 `key`                   | 事实上的一个字符串，一个作用域里不重复：`facts.add`、`supersede` 遇到已有的键返回已有的那条。几个进程处理同一批笔记不写出重复的事实                                                                                                                                                                                        |
| 记忆里的事实 `MemoryFact`      | 一句能独立成立的话，带主语、`validFrom` / `validTo`、来源 `SourceRef`、召回时刻 `recalls`。写入后不改文字：变了就 `supersede`（新的写进去、旧的关掉，一步完成）。和来源取到的事实 `Fact`（`{ source, text }`，只用于一次调用）是两回事。                                                                                   |
| 程序 `Procedure`               | 从经验归纳的规则：`when`、`do`、`evidence`、`confirmations`。确认次数够了才生效。                                                                                                                                                                                                                                          |
| 画像 `core`                    | 仍然成立的事实压成的一段话，每夜重写，常驻上下文，保留历史版本。                                                                                                                                                                                                                                                           |
| 激活度 `activation`            | `ln Σ (Δtᵢ + ε)^−d + s`：召回越近越多越高，显著性 `s` 是偏置。注入排序和夜间归档都用它。                                                                                                                                                                                                                                   |
| 决策模型、提取模型             | System One 模型：单次前向，返回概率或带类型的字段，不生成文字。`DecisionModel.decide({ state, questions })`、`ExtractionModel.extract({ state, fields })`。                                                                                                                                                                |

## 和 Anthropic 公开实践的对应

ctx 的拆法参考了 Anthropic 公开的工程和研究材料。对应关系和差别：

| 来源                                                                                              | 它说的                                                                                                                                                                                       | ctx 里的对应                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Managed Agents](https://www.anthropic.com/research/managed-agents)                               | session / harness / sandbox 三者虚拟化、互相可换；session 是上下文窗口之外的持久上下文对象；harness 和容器都是可丢弃的，崩了从日志续跑                                                       | 同样的拆法，再加上下文、工具、编排三个协议；不限定托管方和模型                                                                                                                                     |
| Managed Agents API                                                                                | `Agent`（配置）、`Environment`（在哪跑）、`Session`、`Event`（`{domain}.{action}`）；自定义工具由应用侧执行再回传 `user.custom_tool_result`；自托管沙箱是只需出站连接的 worker，从队列领工作 | `AgentSpec`、`Executor`、`SessionStore`、事件命名；应用侧执行就是一个 `Executor`；`ctx-remote` 现在是 harness 推给执行环境（执行环境是一个 HTTP 服务），执行环境拉取的 worker 接法之后加，协议不变 |
| [上下文工程](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)   | 注意力预算有限，找「最少的高价值 token」；预取和即时检索混用；长程靠压缩、结构化笔记、子代理                                                                                                 | `ContextBuilder` 是这件事的落点：来源是预取，工具是即时检索，压缩是 `compact`，笔记放执行环境的文件里，子代理由编排器开新会话                                                                      |
| [长程 harness](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents) | 状态放在上下文窗口之外（git、进度文件、功能清单）；每次会话开始先读状态、跑冒烟测试；一次只做一件事                                                                                          | 状态属于会话日志和执行环境；这些是 `AgentSpec` 的指令和编排器的策略，框架不替应用决定                                                                                                              |
| [写给 agent 的工具](https://www.anthropic.com/engineering/writing-tools-for-agents)               | 少而专的工具胜过薄封装；按服务和资源加前缀；说明写给新同事看；输出只给高信号字段，大结果分页截断；错误要能照着做                                                                             | `ToolDefinition` 的约定，MCP 工具的 `<server>__<tool>` 前缀，`ToolOutput.error` 带可读信息                                                                                                         |
| [用代码执行接 MCP](https://www.anthropic.com/engineering/code-execution-with-mcp)                 | 把工具呈现成代码 API，让模型写代码在执行环境里过滤、循环，只把结果给模型；渐进披露工具                                                                                                       | `ctx-exec` 这类执行环境的方向；工具目录支持按需挑选                                                                                                                                                |
| [构建有效的 agent](https://www.anthropic.com/engineering/building-effective-agents)               | 工作流（预定义路径）和 agent（模型自己决定）之分；链式、路由、并行、编排者-工作者、评估-优化几种模式；先简单                                                                                 | 编排器用 `Harness.run` 组合出这些模式；协议不预设哪一种                                                                                                                                            |
| [Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview)                                   | hooks、权限、子代理、会话续跑                                                                                                                                                                | `Hooks`、编排器、`SessionStore`                                                                                                                                                                    |

差别只有一个：以上都是 Anthropic 托管、只跑 Claude；ctx 的每个组件都可以放在任何地方，模型经 AI SDK 接任何服务商。Managed Agents 可以作为一种实现接进来（一个远端 `Harness` 加 `Executor`）。

## 设计约束

1. **只追加。** 会话日志只追加，压缩追加摘要，窗口只影响这一次投影。原条目一直在（[ADR 0003](adr/0003-context-model.md)），直到应用明确删掉它：`clear`、`truncate`、`remove` 真删，`redact` 涂改，都留下擦除记录（`clear` 除外），框架自己从不删（[ADR 0007](adr/0007-deletion-and-retention.md)）。
2. **协议只收发 JSON。** 除 `AbortSignal` 和进程内的 `LanguageModel`，协议方法的参数和返回都能序列化，所以每个组件都能放到进程边界另一侧（[ADR 0004](adr/0004-protocol-and-implementation.md)）。
3. **身份是字符串。** 会话、工具、执行环境、运行都用字符串 id 指代，跨边界时不用传对象。
4. **可丢弃。** harness 和执行环境可以随时崩、随时换；会话日志是唯一的真相，续跑从日志读：每一步都即时写下，工具调用在执行之前写下，`recover` 收尾或续跑。
5. **框架不替应用做决定。** 什么时候压缩、什么事件给模型看、工具给不给、什么时候跑一轮，都是应用（编排器、`AgentSpec`、投影规则）的事；框架给机制和缺省值。上下文超过模型窗口时的兜底也一样：它是 `AgentSpec.context.overflow` 里的配置，缺省关着。
6. **先简单。** 进程内的用法（`createContext()`）和三行代码的例子要一直能用；分布式是能力，不是门槛。
