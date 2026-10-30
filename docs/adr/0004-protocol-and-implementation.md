---
type: Decision Record
title: 'ADR 0004：协议层与实现层分开，组件不绑定托管形态'
description: '协议层和实现层分开，七个组件各一个协议，组件不绑定托管形态，`thread` 改 `session`'
tags: [adr, protocol]
status: stable
---

# ADR 0004：协议层与实现层分开，组件不绑定托管形态

- 状态：已采纳
- 日期：2026-10-25
- 修订：2026-10-26，按 [ADR 0005](0005-session-position-writes-format.md)：「没有采用」里的自定义消息格式一条被推翻，会话协议加 `expectSeq`、位置用 `seq`
- 范围：ctx 全部包；yoyo 作为实践

## 背景

ctx 最初是给 yoyo 用的上下文管理库：一份只追加的日志、投影、来源、工具、网关（[ADR 0003](0003-context-model.md)）。它要变成一个通用框架，面向 agent 原生的程序，包括还没有被想到的程序。

同一时期 Anthropic 发布了 Managed Agents，把一个 agent 拆成 session（只追加的事件日志）、harness（调模型、分发工具调用的循环）、sandbox（跑代码的地方），三者各自虚拟化、互相可以替换，并把 session 当作上下文窗口之外的持久上下文对象。这个拆法和 ADR 0003 的思路一致，但它是 Anthropic 托管的服务，只跑 Claude。

我们要的是同样的拆法，但不限定谁来托管、放在哪里、用什么模型：

- harness 可以是本机进程里的一个函数，也可以是一个服务，经 HTTP 或 WebSocket 驱使别处的执行环境；
- 执行环境可以是沙箱、容器，也可以只是本机的一个进程；
- 会话可以存在内存、SQLite，也可以托管在第三方的存储；
- 编排可以是最轻量的本机循环，也可以是云端的一套服务；
- 任何一个组件换掉，其他组件不用改。

## 决定

### 1. 两层：协议和实现

```
协议（抽象）      @modelctx-ai/ctx-protocol     只有接口、JSON 形状、纯函数、契约测试
实现（具体）      @modelctx-ai/ctx 和 ctx-*     每个协议至少一份参考实现
实践（应用）      modelctx-ai/yoyo 等           把实现组合成业务
```

- 协议包只定义，不实现。接口、随接口走的 JSON 形状、只依赖这些形状的纯函数（条目构造和顺序比较、工具名校验、事实渲染），以及每个协议的契约测试。它不能依赖任何实现包。
- 实现包实现协议。`@modelctx-ai/ctx` 是进程内的参考实现，其余 `ctx-*` 各管一种依赖或一种托管形态。实现包之间只通过协议交互：`ctx-sqlite` 实现 `SessionStore`，只依赖协议包；`ctx-remote` 把协议搬到 HTTP 上，两头都只认协议。
- 应用只依赖协议和它选用的实现，在组装根里挑。

这和下面这段代码表达的是同一件事：基类只规定做什么，子类决定怎么做；基类里可以有不必重写的普通方法。

```python
class Animal(ABC):
    @abstractmethod
    def speak(self): ...
    def describe(self):            # 普通方法：协议包里的纯函数
        return f"I am {self.__class__.__name__}"

class Dog(Animal):                 # 实现包
    def speak(self):
        return "Woof!"
```

TypeScript 里用接口和工厂函数表达，不用类继承：协议是 `interface`，实现是 `createX(): X`；协议包的「普通方法」是导出的纯函数。

### 2. 七个组件，各有一个协议

| 组件              | 协议                             | 职责                                                                                      | 不负责         |
| ----------------- | -------------------------------- | ----------------------------------------------------------------------------------------- | -------------- |
| 会话 Session      | `SessionStore`                   | 只追加的事件日志：追加（可带 `expectSeq` 前提）、按 `seq` 读、清空、列出会话              | 决定什么进模型 |
| 上下文 Context    | `ContextBuilder`                 | 把会话日志、来源取到的事实、这一轮的输入，组装成一次调用的指令、消息和工具名单            | 调模型、存东西 |
| 工具 Tools        | `ToolRegistry`、`ToolDefinition` | 工具目录：名字、说明、JSON Schema 输入、来源、标签；每个工具绑一个执行环境                | 执行           |
| 执行环境 Executor | `Executor`                       | 执行一次工具调用：`execute(call) → output`；可选的准备和释放                              | 决定什么时候调 |
| Harness           | `Harness`                        | 一轮运行的循环：组装上下文 → 调模型 → 把工具调用分发给执行环境 → 写回会话，直到停下       | 跨轮次的调度   |
| 编排 Orchestrator | `Orchestrator`                   | 什么时候、在哪个会话上、用哪个 harness 跑一轮；同一会话串行、排队、取消、崩溃后从日志续跑 | 一轮内部的事   |
| 模型 Model        | AI SDK `LanguageModel`           | 一次模型调用                                                                              | 其余一切       |

模型直接用 AI SDK 的 `LanguageModel`：它已经是跨服务商的抽象，`ctx-models` 按配置造它。其他六个由协议包定义，详见[协议层](../protocol.md)。

随协议走的值：

- `AgentSpec`：一个 agent 的配置（模型、指令、工具筛选、步数、调用参数），JSON，像 Managed Agents 的 Agent 资源。同一个 harness 跑不同的 `AgentSpec` 就是不同的 agent。
- `Hooks`：harness 在调模型前、执行工具前后给应用的切入点。权限确认、输入改写、输出截断都是钩子，不进协议本体。
- 框架事件：harness 和编排器往会话里写 `ctx.run.started`、`ctx.run.ended`、`ctx.compacted`、`ctx.error`，`{domain}.{action}` 写法，缺省对模型不可见。崩溃恢复靠它们。

这些取材自 Anthropic 公开的 Managed Agents、Agent SDK 和工程文章，对应关系见[概念](../concepts.md)。

### 3. 每个协议都能放在进程边界的另一侧

- 协议方法只收发 JSON 可序列化的值。例外只有两个进程内对象：`AbortSignal`（取消）和 `LanguageModel`（跨边界时换成模型的名字字符串）。
- 流式的结果用事件序列表达，跨边界时是 NDJSON 或 SSE。
- 工具的输入结构在协议层是 JSON Schema。AI SDK 的 zod 工具在进入注册表时转成 JSON Schema，执行函数绑到一个进程内执行环境。
- 身份靠字符串：会话用 `session`（字符串 id），工具用名字，执行环境用名字，运行用 `runId`。
- 因此每个组件都有三种形态：进程内对象、本机另一个进程（经 `ctx-remote` 的 HTTP 服务）、远端服务（同一套 HTTP 协议，或别人按协议实现的服务）。[协议层](../protocol.md)里有托管矩阵。

### 4. 命名

- 日志的名字从 `thread` 改成 `session`，`ContextStore` 改成 `SessionStore`，`threads()` 改成 `sessions()`。协议包里不保留旧名；`@modelctx-ai/ctx` 保留 `ContextStore`、`thread` 作为弃用别名到下一个 minor，给 yoyo 迁移的时间（0.3 里已删掉）。
- 执行环境的英文是 `Executor`，不叫 sandbox：它不一定隔离，可以只是本机的一个子进程。
- 协议包叫 `@modelctx-ai/ctx-protocol`；实现包沿用 [ADR 0002](0002-packages.md) 的 `ctx-<名字>`。
- `createContext()` 保留，含义变成「在一个会话上把会话存储、上下文组装、工具、执行环境和 harness 组合成一个进程内对象」。它是糖，不是协议。

### 5. 包

| 包                          | 层   | 内容                                                                                                                                                              | 依赖                                  |
| --------------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| `@modelctx-ai/ctx-protocol` | 协议 | 六个协议、JSON 形状、纯函数、`/testing` 契约测试                                                                                                                  | `ai`（只用类型，peer）                |
| `@modelctx-ai/ctx`          | 实现 | 内存 `SessionStore`、投影和来源组成的 `ContextBuilder`、`ToolRegistry`、进程内函数 `Executor`、基于 AI SDK 的 `Harness`、进程内 `Orchestrator`、`createContext()` | `ctx-protocol`、`ai`                  |
| `@modelctx-ai/ctx-sqlite`   | 实现 | `node:sqlite` 的 `SessionStore`                                                                                                                                   | `ctx-protocol`                        |
| `@modelctx-ai/ctx-models`   | 实现 | 按配置造 `LanguageModel`                                                                                                                                          | `ai`、服务商 SDK                      |
| `@modelctx-ai/ctx-mcp`      | 实现 | MCP 服务器作为 `Executor`，工具写进 `ToolRegistry`                                                                                                                | `ctx-protocol`、`@ai-sdk/mcp`         |
| `@modelctx-ai/ctx-exec`     | 实现 | 本机子进程 `Executor`：跑命令行、读写工作目录里的文件，环境变量白名单、超时、输出截断                                                                             | `ctx-protocol`、`node:child_process`  |
| `@modelctx-ai/ctx-remote`   | 实现 | `SessionStore`、`Executor`、`Harness`、`Orchestrator` 的 HTTP 服务端和客户端                                                                                      | `ctx-protocol`、`node:http`（服务端） |
| `@modelctx-ai/ctx-gateway`  | 实现 | OpenAI 兼容网关：把调用方的历史换成会话的上下文                                                                                                                   | `ctx-protocol`                        |

依赖只朝一个方向：协议 ← 实现 ← 实践。实现包之间不互相依赖；测试里需要一个会话存储时用 `@modelctx-ai/ctx` 的内存存储（devDependency）。

## 实施

| 阶段                  | 内容                                                                                                                 | 状态               |
| --------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------ |
| 文档                  | 本 ADR、[概念](../concepts.md)、[协议层](../protocol.md)，README 和索引改定位                                        | 本次               |
| 协议                  | 建 `ctx-protocol`：接口、形状、纯函数、契约测试                                                                      | 本次               |
| 参考实现              | `@modelctx-ai/ctx` 按协议重排，补执行环境、harness、编排器；sqlite、mcp、gateway 改依赖协议包，`thread` 改 `session` | 本次               |
| 执行环境与远程        | `ctx-exec`、`ctx-remote`                                                                                             | 本次               |
| 实践                  | yoyo 换到新接口，把导演和常驻循环写成一个 `Orchestrator`                                                             | 之后，在 yoyo 仓库 |
| WebSocket、第三方存储 | `ctx-remote` 加 WebSocket 传输；给一个托管存储写 `SessionStore` 示范                                                 | 之后               |

## 代价

- 多一个包、多一层间接：定义一个新能力要先在协议包里写接口，再在实现包里写实现。换来的是任何一侧可以单独替换、单独托管。
- 协议层的 JSON 约束让进程内的用法也要经过序列化友好的形状。工具执行函数留在进程内执行环境里，不进协议。
- 改名 `thread` → `session` 是不兼容改动，按 [ADR 0002](0002-packages.md) 升 minor（0.1 → 0.2），yoyo 要跟着改一次。
- 远程形态引入网络故障和一致性问题：harness 崩溃后从日志续跑依赖会话存储的追加是原子的，这一点写进契约测试。

## 没有采用

- 只在 `@modelctx-ai/ctx` 里加 `/protocol` 子路径：实现别人的存储或 harness 时仍要装上参考实现和 `ai` 的运行时，层次也不清楚。
- 自定义消息格式代替 AI SDK 的 `ModelMessage`：当时的理由是 `ModelMessage` 已经是 JSON，实际不是（二进制和 URL 要另外编码，两处各写了一份），所以这一条已被 [ADR 0005](0005-session-position-writes-format.md) 决定 3 推翻：协议包定义自己的 JSON `Message`，AI SDK 的互转放在 `@modelctx-ai/ctx`。
- 用类继承表达协议：TypeScript 里接口加工厂函数更轻，也和现有代码一致。
- 直接用 Managed Agents：它只跑 Claude、只在 Anthropic 托管，上下文策略在它的 harness 里。它可以作为我们协议的一种实现接进来（一个远端 `Harness` 加 `Executor`），不是替代。
