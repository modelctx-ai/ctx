# @modelctx-ai/ctx-managed-agents

把 [Claude Managed Agents](https://platform.claude.com/docs/en/managed-agents/overview) 接成 ctx 的 harness：循环、上下文、容器里的工具都在 Anthropic 那边；它的事件流实时写进 ctx 的会话日志，ctx 的工具作为自定义工具交给它、调用回到 ctx 的执行环境。为什么这样接见 [ADR 0010](../../docs/adr/0010-external-harness-adapters.md)。

没有对真实服务验证：照 Managed Agents 的接口文档和 `@anthropic-ai/sdk` 1.10.0 的类型写，测试对着本包的假服务端跑（见「验证」）。

## 安装

```bash
pnpm add @modelctx-ai/ctx-managed-agents @modelctx-ai/ctx-protocol @anthropic-ai/sdk
```

Node ≥22。`@modelctx-ai/ctx-protocol` 和 `@anthropic-ai/sdk`（≥1.10.0）是 peer dependency。agent 和执行环境事先建好一次（`client.beta.agents.create`、`client.beta.environments.create`，或用 `ant` 命令行），把 id 存起来；不要每轮建。

## 用法

```ts
import Anthropic from '@anthropic-ai/sdk';
import { createToolRegistry } from '@modelctx-ai/ctx';
import { createManagedAgentsHarness } from '@modelctx-ai/ctx-managed-agents';
import { createSqliteStore } from '@modelctx-ai/ctx-sqlite';

const store = createSqliteStore({ path: 'ctx.db' });
const tools = createToolRegistry(); // ctx 的工具：作为自定义工具交给 Managed Agents，在 ctx 的执行环境里执行
tools.executor.register(
  { name: 'remember', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
  (input) => ({ type: 'json', value: { saved: input } }),
);
tools.add(tools.executor.definition('remember')!);

const harness = createManagedAgentsHarness({
  store,
  client: new Anthropic(), // 密钥取 ANTHROPIC_API_KEY
  agent: process.env.AGENT_ID!, // 事先建好的 agent
  environmentId: process.env.ENVIRONMENT_ID!, // 事先建好的执行环境
  tools,
  // 容器里的内置工具：Managed Agents 执行，只记进日志；`auto` 下它拿不准的停下等确认
  builtinTools: [
    {
      type: 'agent_toolset_20260401',
      default_config: { enabled: true, permission_policy: { type: 'auto' } },
      configs: [
        { name: 'web_fetch', enabled: false },
        { name: 'web_search', enabled: false },
      ],
    },
  ],
});

const result = await harness.run({
  session: 'user:42',
  agent: { model: process.env.MODEL!, instructions: '你是代码助手。', maxSteps: 10 }, // Managed Agents 支持的模型
  input: '看一下仓库里怎么装，记下来',
});
console.log(result.stopReason, result.text);
```

它是一个 `Harness`：交给编排器（`createOrchestrator({ harness, store })`）、`ctx-remote` 的服务端、`ctx-otel` 都和参考实现一样。

## 怎么对上

| 问题                 | 做法                                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 会话身份             | ctx 的一个会话对着 Managed Agents 的一个会话。第一轮建会话（`agent_with_overrides`：模型、工具按 `AgentSpec` 覆盖，给了 `instructions` 的系统提示也覆盖），`ctx.run.started` 的 `data.harness` 记 `{ name: 'managed-agents', version, session }`；之后各轮按最近一次记下的 `session` 接着发。`record: false` 的每轮建一个新会话，用完留着不删                                                        |
| 模型和指令           | 会话建好就定了：`ctx.run.started` 的 `meta.managedAgents.config` 记它们的摘要，续接时 `AgentSpec.model` 或 `instructions` 变了的以 `invalid_request` 结束，换一个 ctx 会话。工具可以变：和上一轮结束时（`ctx.run.ended` 的 `meta.managedAgents.tools`）不一样就先更新会话的工具                                                                                                                      |
| 轨迹从哪拿           | 先连上事件流（`GET /v1/sessions/:id/events/stream`，要了 `agent.message` 的预览）再发话，边读边写：一次模型请求结束（`span.model_request_end`）就写这一步的助手消息，工具执行之前就在日志里；一步的工具结果到齐就写。文字增量只进 `stream` 的 `text.delta`，连起来就是这段话（预览丢了的部分在缓冲的 `agent.message` 到了时补上）                                                                    |
| 断线                 | 事件流不重放：断了就重连（连着最多 5 次，退避），每次连上都从最后读到的事件的时刻起和事件历史（`GET /v1/sessions/:id/events`）对一遍，按事件 `id` 去重                                                                                                                                                                                                                                               |
| ctx 的工具           | 每轮按 `AgentSpec.tools` 挑出来作为自定义工具交给会话（`deny` 的不交）。调用（`agent.custom_tool_use`）在这里执行：按 `inputSchema` 查输入，第一次交给某个执行环境之前 `open` 这个会话，结果截断（`maxToolOutputChars`），一步的结果一次交回去（`user.custom_tool_result`）。工具结果条目的 `source` 是执行环境的名字                                                                                |
| 内置工具和 MCP       | `builtinTools` 列出的才交出去，缺省一个都不交（交给会话的工具整个替换 agent 的，agent 的 MCP 服务器要用就在这里放一个 `mcp_toolset`）。调用和结果照常记进日志，结果条目的 `source` 是 `managed-agents`；MCP 工具的调用记成 `mcp__<服务器>__<名字>`                                                                                                                                                   |
| 停下等的             | `ask` 权限的 ctx 工具、绑到 `external` 执行环境的工具、Managed Agents 要确认的内置工具（`evaluated_permission: ask`）：调用写进日志（`ask` 和要确认的带 `tool-approval-request`），这一轮以 `requires_action` 结束，会话停着等。下一轮先按日志了结：有结果的交回去，确认了的执行（内置工具让它执行），拒绝的写上拒绝；没决定的、别处执行还没结果的按「没有记录到结果」交回去（不写日志），同参考实现 |
| 停着等时又说了话     | 先了结，等它把上一轮做完（停下）再发这一轮的话；中间又停下等的，这一轮以 `requires_action` 结束，话留到下一轮                                                                                                                                                                                                                                                                                        |
| 记下了没发出去的输入 | 取消、出错、映射不了的 `AgentSpec` 让这一轮没把输入发出去的，`ctx.run.ended` 的 `meta.managedAgents.unsent` 记下那些条目，下一轮和它自己的话一起发：每句话在日志里一次，Managed Agents 也只收到一次                                                                                                                                                                                                  |
| 失败后重试           | 上一轮以 `error` 结束、这一轮带同样的输入（或同一个 `inputKey`）重试时，输入不再记；上一轮已经发出去的再发一遍——Managed Agents 的会话退不回去，它的上下文里会有两遍                                                                                                                                                                                                                                  |
| 取消                 | 排队等同一会话的前一轮时取消的，以 `aborted` 结束、什么都不写。`signal` 中止、`settings.timeoutMs` 到了、步数或预算用完时发 `user.interrupt`，等它停下（`interruptTimeoutMs`），之后的模型请求不记                                                                                                                                                                                                   |
| 续接之前             | 会话还在跑（上一轮断在半路）就先中断、等它停下；停不下来以 `session_busy` 结束。会话不在了、结束了、归档了的以 `not_found` 结束                                                                                                                                                                                                                                                                      |
| 上下文               | Managed Agents 自己管：ctx 的日志不压缩、不投影。它压缩自己的上下文时记一条 `managed-agents.compacted`，不写 ctx 的 `summary`                                                                                                                                                                                                                                                                        |
| 子线程               | 不支持多 agent：子线程转到主线程上来的调用不记，回一句不支持（自定义工具回错误，要确认的拒绝），`logger` 记一条                                                                                                                                                                                                                                                                                      |

日志里一轮的样子（并行调了两次 ctx 的工具）：

| `seq` | 条目              | `source`  | 带着                                                                                                                          |
| ----- | ----------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------- |
| 1     | `ctx.run.started` | `harness` | `data.harness`：`{ name, version, session }`；`meta.managedAgents.config`                                                     |
| 2     | `user`            | `source`  | 输入                                                                                                                          |
| 3     | `assistant`       | `model`   | 文字和两个 `tool-call`；`meta.step`（`step`、`modelId`、`finishReason`、用量），`meta.managedAgents.event`（那个事件的 `id`） |
| 4     | `tool`            | `local`   | 两个结果，按调用的顺序                                                                                                        |
| 5     | `assistant`       | `model`   | 回答                                                                                                                          |
| 6     | `ctx.run.ended`   | `harness` | `stopReason`、整轮的用量；`meta.managedAgents` 的 `tools`、`last`（读到的最后一个事件），没发出去的输入有 `unsent`            |

## `AgentSpec`

| 字段                           | 映射                                                                                                                                                                                       |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `model`                        | 建会话时覆盖 agent 的模型，只收名字                                                                                                                                                        |
| `instructions`                 | 建会话时覆盖 agent 的系统提示；不给就用 agent 自己的                                                                                                                                       |
| `tools`                        | 从工具目录里挑交给会话的 ctx 工具                                                                                                                                                          |
| `permissions`                  | `deny` 的不交出去；`ask` 的交出去，调用停下等确认（`requires_action`，见上）                                                                                                               |
| `maxSteps`                     | 一次模型请求算一步，缺省有工具 5、没有 1。到了步数、还要接着调模型时中断，`stopReason` 是 `max_steps`                                                                                      |
| `output`                       | Managed Agents 没有结构化输出：schema 写进这一轮的用户消息，最后的回答（可以包在一个代码块里）按 JSON 解析、按 schema 查，放进 `RunResult.output`；不合的以 `error` 结束，`invalid_output` |
| `budget`                       | 在步骤之间查：这一步调了工具、整轮超了，就中断，`stopReason` 是 `max_budget`。Managed Agents 自己的预算（`budget_reached`）也是 `max_budget`                                               |
| `environment`                  | 交给 ctx 执行环境的 `open`；Managed Agents 的容器用 `environmentId`                                                                                                                        |
| `settings.maxRetries`          | 每次调接口的重试次数（SDK 的 `maxRetries`）                                                                                                                                                |
| `settings.headers`             | 每次调接口都带上                                                                                                                                                                           |
| `settings.timeoutMs`           | 到点中断，以 `error` 结束，`error.type` 是 `timeout`                                                                                                                                       |
| `name`、`version`              | 只记进 `ctx.run.started`                                                                                                                                                                   |
| `context.facts: false`         | 照常跑                                                                                                                                                                                     |
| `window`、`context` 的其余各项 | 不支持：历史是 Managed Agents 自己的；事实也不行，系统提示整个会话不变，放进这一轮的话又会一直留在它的会话里                                                                               |
| `toolChoice`（`auto` 以外）    | 不支持                                                                                                                                                                                     |
| `settings` 的其余各项          | 不支持                                                                                                                                                                                     |

不支持的字段在场时，这一轮以 `invalid_request` 结束（`ctx.run.started`、输入照常记下，不建会话、不调模型），不静默忽略。`RunRequest.prompt` 接在输入后面一起发：不写 ctx 的日志，但会留在 Managed Agents 自己的会话里。

## `stopReason`

| Managed Agents 停下的原因（`session.status_idle` 的 `stop_reason`） | `stopReason`      | `error.type`                                                                                                                  |
| ------------------------------------------------------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `end_turn`                                                          | `end_turn`        |                                                                                                                               |
| `refusal`                                                           | `end_turn`        | （`logger` 记一条，带 `category`）                                                                                            |
| `requires_action`，等的是这一轮停下来等的调用                       | `requires_action` |                                                                                                                               |
| `budget_reached`                                                    | `max_budget`      |                                                                                                                               |
| `retries_exhausted`                                                 | `error`           | 前面的 `session.error`：上下文过长的是 `context_overflow`，别的是 `managed_agents`，消息带它的 `error.type`；过载、限流可重试 |
| 会话在这一轮里结束、被删                                            | `error`           | `managed_agents`                                                                                                              |
| 调接口出错                                                          | `error`           | 404 是 `not_found`，别的是 `api_call`，带 `statusCode` 和 `responseBody`；408、409、429、5xx、连不上可重试                    |
| 被 `signal` 中断                                                    | `aborted`         |                                                                                                                               |

## 选项

| 选项                 | 缺省                            | 说明                                                                      |
| -------------------- | ------------------------------- | ------------------------------------------------------------------------- |
| `store`              | 必填                            | 会话日志                                                                  |
| `agent`              | 必填                            | 事先建好的 agent：id（用最新版本），或 `{ id, version }`                  |
| `environmentId`      | 必填                            | 事先建好的执行环境的 id                                                   |
| `client`             | `new Anthropic()`               | Managed Agents 的客户端                                                   |
| `executors`          | 无                              | ctx 的执行环境，数组或 `{ 名字: 执行环境 }`                               |
| `tools`              | 各执行环境 `tools()` 报的全部   | 工具目录；`createToolRegistry()` 建的，它自带的函数执行环境自动加进来     |
| `external`           | `[]`                            | 在别处执行的执行环境的名字（ADR 0008），绑到它们的调用停下等结果          |
| `builtinTools`       | `[]`                            | Managed Agents 那边执行的工具：`agent_toolset_20260401`、`mcp_toolset`    |
| `sessionParams`      | 无                              | 建会话时一起给的 `vault_ids`、`resources`、`metadata`、`title`            |
| `maxToolOutputChars` | `DEFAULT_MAX_TOOL_OUTPUT_CHARS` | 一次 ctx 工具结果最多多少字符                                             |
| `interruptTimeoutMs` | `5_000`                         | 中断以后等它停下多久                                                      |
| `source`             | 不写                            | 输入条目的 `source`                                                       |
| `logger`             | 不记                            | 事件流重连、它在重试、拒绝回答、子线程、等着的调用在日志里找不到时 `warn` |

同一个实例里同一会话的记录型运行一个接一个；跨进程时第二个以 `session_busy` 结束。

## 一致性等级

过 `describeHarnessContract` 的 `trace`、`execute`、`resume`、`output`、`approval`。不跑 `context`：上下文是 Managed Agents 自己组装的。

还没做的：

- ctx 的日志里别处写的东西（应用的事件、别的 harness 跑的轮次）Managed Agents 看不到：它只读自己的会话。一个 ctx 会话只给它一个 harness 跑。
- 多 agent（子线程）、`user.define_outcome`、`system.message` 不用。
- `RunRequest.input` 里交不过去的文件（图片、PDF 以外、服务商的文件引用）换成一句说明。

## 验证

没有对真实服务验证。接口的形状（会话、事件、事件流、`agent_with_overrides`、预览的 `event_start` 和 `event_delta`、`requires_action` 只收了结的事件）照 Managed Agents 的接口文档和 `@anthropic-ai/sdk` 1.10.0（beta `managed-agents-2026-04-01`）的类型写；契约测试和本包的用例对着 `@modelctx-ai/ctx-managed-agents/testing` 的假服务端跑，客户端用假密钥、只连本机。

## 导出

| 导出                                                  | 说明                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createManagedAgentsHarness(options)`                 | 返回 `ManagedAgentsHarness`：协议的 `Harness`，`run` 和 `stream` 都有                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `ManagedAgentsHarness`、`ManagedAgentsHarnessOptions` | 类型；选项见上                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `BuiltinTool`                                         | `builtinTools` 的一项：SDK 的 `agent_toolset_20260401` 或 `mcp_toolset` 参数                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `MANAGED_AGENTS_HARNESS`                              | `managed-agents`：`HarnessInfo.name`，也是 Managed Agents 那边执行的工具结果的 `source`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `MANAGED_AGENTS_BETA`                                 | `managed-agents-2026-04-01`：照着写的接口版本，记进 `HarnessInfo.version`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `MANAGED_AGENTS_EVENTS`                               | 适配器写的事件的 `kind`：`compacted`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `@modelctx-ai/ctx-managed-agents/testing`             | `createFakeManagedAgents({ script, tool? })`：本机的假 Managed Agents 接口，返回 `{ url, sessions, requests, end(session, how), close() }`，`url` 给 `new Anthropic({ baseURL })`。所有会话按顺序取剧本的下一步，剧本的一步（`FakeManagedAgentsStep`）和契约测试的 `ModelScriptStep` 同形状，另有并行调用的 `tool-calls`、内置工具的 `builtin`（`permission: 'ask'` 时停下等确认），共有的 `delayMs`、`drop`（断开事件流）、`compact`（先压缩一次）。`sessions` 是建过的会话（建会话的请求、现在的 agent、事件、收到的用户事件），`end` 让一个会话结束或删掉它。类型 `FakeManagedAgents`、`FakeManagedAgentsOptions`、`FakeManagedAgentsSession`、`FakeManagedAgentsStep` |
