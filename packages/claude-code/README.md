# @modelctx-ai/ctx-claude-code

把 Claude Code 接成 ctx 的 harness：一轮起一个 `claude -p` 进程，循环、上下文、自带的工具都是它自己的；它的每一步实时写进 ctx 的会话日志，ctx 的工具经 MCP 交给它、调用回到 ctx 的执行环境。为什么这样接见 [ADR 0010](../../docs/adr/0010-external-harness-adapters.md)。

## 安装

```bash
pnpm add @modelctx-ai/ctx-claude-code @modelctx-ai/ctx-mcp @modelctx-ai/ctx-protocol
```

Node ≥22。`@modelctx-ai/ctx-protocol` 和 `@modelctx-ai/ctx-mcp` 是 peer dependency。Claude Code 本身另装（`claude` 在 `PATH` 上，或用 `command` 指过去），凭证由它自己的配置或 `env` 给。

## 用法

```ts
import { createToolRegistry } from '@modelctx-ai/ctx';
import { createClaudeCodeHarness } from '@modelctx-ai/ctx-claude-code';
import { createSqliteStore } from '@modelctx-ai/ctx-sqlite';

const store = createSqliteStore({ path: 'ctx.db' });
const tools = createToolRegistry(); // ctx 的工具：经 MCP 交给 Claude Code，在 ctx 的执行环境里执行
tools.executor.register(
  { name: 'remember', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
  (input) => ({ type: 'json', value: { saved: input } }),
);
tools.add(tools.executor.definition('remember')!);

const harness = createClaudeCodeHarness({
  store,
  tools,
  builtinTools: ['Read', 'Grep'], // Claude Code 自带的：它自己执行，只记进日志
  cwd: '/srv/agent', // 它按目录存会话：同一个 ctx 会话的各轮用同一个
});

const result = await harness.run({
  session: 'user:42',
  agent: { model: 'sonnet', instructions: '你是代码助手。', maxSteps: 10 },
  input: '看一下 README 里怎么装，记下来',
});
console.log(result.stopReason, result.text);
```

它是一个 `Harness`：交给编排器（`createOrchestrator({ harness, store })`）、`ctx-remote` 的服务端、`ctx-otel` 都和参考实现一样。

## 怎么对上

| 问题           | 做法                                                                                                                                                                                                                                                                                                                                                                 |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 轨迹从哪拿     | `--output-format stream-json --include-partial-messages` 的输出，边读边写：一条助手消息收齐（`message_stop`）就写，工具执行之前就在日志里；一步的工具结果到齐就写。文字和推理的增量只进 `stream` 的事件                                                                                                                                                              |
| 工具怎么接     | 每轮起一个只听 `127.0.0.1`、带一次性令牌的 MCP 服务器（`createMcpServer`），配置写进只有自己读得到的临时文件交给 `--mcp-config`（加 `--strict-mcp-config`，不读别处配的 MCP 服务器）。工具在 Claude Code 里叫 `mcp__ctx__<名字>`，日志里换回原名；输入检查、结果截断（`maxToolOutputChars`）在 MCP 服务器里做；第一次交给某个执行环境之前 `open` 这个会话            |
| 自带的工具     | `builtinTools` 列出的才交出去（`--tools`），缺省一个都不交。调用和结果照常记进日志，工具结果条目的 `source` 是 `claude-code`；经 ctx 执行的是执行环境的名字                                                                                                                                                                                                          |
| 会话身份       | ctx 的一个会话对着 Claude Code 的一个会话。`ctx.run.started` 的 `data.harness` 记 `{ name: 'claude-code', version, session }`，下一轮按最近一次记下的 `session` `--resume`；第一轮 `--session-id` 开新的                                                                                                                                                             |
| 位置           | `meta.claudeCode` 记 Claude Code 记录里的位置：`ctx.run.started` 的 `resumeAt`（从哪一条接着跑），`ctx.run.ended` 的 `last`（结束时的最后一条），每一步的条目的 `uuid`                                                                                                                                                                                               |
| 失败后重试     | 上一轮以 `error` 或 `aborted` 结束、这一轮带同样的输入（或同一个 `inputKey`）重试时，`--resume-session-at` 退回到失败那一轮开始的位置，失败那一轮的输入不会在 Claude Code 的上下文里出现两次（记录文件里分出一支，不改原来的）。换了一句话就照常接着跑，失败那一轮留在上下文里                                                                                       |
| 取消           | `signal` 中止时先发 `interrupt` 控制消息，Claude Code 停下手里的模型调用和工具、照常给出结果；`interruptTimeoutMs` 之后还没退出就 SIGTERM，再过一样久 SIGKILL。工具执行到一半被取消时，结果是 Claude Code 给的拒绝                                                                                                                                                   |
| 上下文         | Claude Code 自己管：ctx 的日志不压缩、不投影。它压缩自己的上下文时记一条 `claude-code.compacted`（`data` 是它给的 `compact_metadata`），不写 ctx 的 `summary`；摘要文字随后作为 `claude-code.synthetic` 记下。上下文来源（`sources`，例如 `memory.source()`）每轮记下输入之后收一次，事实接在指令后面，同参考实现的缺省放法；不进 Claude Code 自己的会话，也不写日志 |
| 它补的用户消息 | 输出被截断后让模型接着写、催模型调结构化输出的工具、中断时的说明：记成 `claude-code.synthetic` 事件（`text` 是那段话），不记成用户消息                                                                                                                                                                                                                               |
| 子代理         | `builtinTools` 里有 `Task`（发给模型时叫 `Agent`）才有，`bare` 时没有。子代理在这一轮里跑完（适配器给子进程设 `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`），轨迹写进子会话 `<会话>/<工具名>/<调用 id>`，和进程内派子 agent 的缺省一样；父会话里那次调用的结果是 `ChildRunResult`，`childRunsOf` 找得到。用量各算各的                                                   |

日志里一轮的样子（并行调了两次 ctx 的工具）：

| `seq` | 条目              | `source`  | 带着                                                                           |
| ----- | ----------------- | --------- | ------------------------------------------------------------------------------ |
| 1     | `ctx.run.started` | `harness` | `data.harness`：`{ name, version, session }`；`meta.claudeCode.resumeAt`       |
| 2     | `user`            | `source`  | 输入                                                                           |
| 3     | `assistant`       | `model`   | 文字和两个 `tool-call`；`meta.step`（`step`、`modelId`、`finishReason`、用量） |
| 4     | `tool`            | `local`   | 两个结果，按调用的顺序                                                         |
| 5     | `assistant`       | `model`   | 回答                                                                           |
| 6     | `ctx.run.ended`   | `harness` | `stopReason`、整轮的用量；`meta.claudeCode.last`                               |

子代理在子会话里的一轮：

| `seq` | 条目              | `source`      | 带着                                                                                                                                                                                     |
| ----- | ----------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | `ctx.run.started` | `harness`     | `data.parent`：父会话、父 `runId`、那次调用的 id；`data.agent`：子代理的类型（`name`）和父运行的模型；`data.harness` 没有 `session`（子代理没有能续接的会话）；`meta.claudeCode.agentId` |
| 2     | `user`            | `claude-code` | 父代理交给它的话                                                                                                                                                                         |
| 3     | `assistant`       | `model`       | 每一步；`meta.step` 的 `runId` 是子运行的                                                                                                                                                |
| 4     | `tool`            | 执行方        | 工具结果，ctx 的工具照样经 MCP 交给执行环境                                                                                                                                              |
| 5     | `assistant`       | `model`       | 最后的回答：Claude Code 只在那次调用的结果里给，适配器补成一条                                                                                                                           |
| 6     | `ctx.run.ended`   | `harness`     | 完成是 `end_turn`；失败是 `error`，前面有一条 `ctx.error`；被中断是 `aborted`                                                                                                            |

子代理再派的子代理挂在子会话下面（`<子会话>/<工具名>/<调用 id>`）。Claude Code 不转出它里面的消息，那个会话只有输入、回答和结束。父运行结束时还没结束的子代理以 `aborted` 结束，父会话里那次调用的结果是 `aborted` 的 `ChildRunResult`。

## `AgentSpec`

| 字段                           | 映射                                                                                                                                                                                                                                       |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `model`                        | `--model`，只收名字（Claude Code 的别名也行）                                                                                                                                                                                              |
| `instructions`                 | `--append-system-prompt`：接在 Claude Code 自己的系统提示后面                                                                                                                                                                              |
| `tools`                        | 从工具目录里挑交给它的 ctx 工具                                                                                                                                                                                                            |
| `maxSteps`                     | `--max-turns`，缺省有工具 5、没有 1。用完时这一步的工具照样执行，`stopReason` 是 `max_steps`                                                                                                                                               |
| `output`                       | `--json-schema`：Claude Code 加一个 `StructuredOutput` 工具，交上来的对象再按 schema 查一遍放进 `RunResult.output`                                                                                                                         |
| `permissions`                  | `allow` 的交出去并 `--allowedTools`；`deny` 的不交出去（参考实现交给模型、调用时回拒绝）                                                                                                                                                   |
| `budget`                       | 在步骤之间查：这一步调了工具、整轮超了，就中断，`stopReason` 是 `max_budget`                                                                                                                                                               |
| `environment`                  | 交给执行环境的 `open`                                                                                                                                                                                                                      |
| `settings.maxRetries`          | 环境变量 `CLAUDE_CODE_MAX_RETRIES`                                                                                                                                                                                                         |
| `settings.maxOutputTokens`     | 环境变量 `CLAUDE_CODE_MAX_OUTPUT_TOKENS`                                                                                                                                                                                                   |
| `settings.timeoutMs`           | 到点中断，以 `error` 结束，`error.type` 是 `timeout`                                                                                                                                                                                       |
| `name`、`version`              | 只记进 `ctx.run.started`                                                                                                                                                                                                                   |
| `context.facts`                | 有 `sources` 时每轮收一次：`sources` 按名字选用、`heading` 加标题、`false` 不收（同参考实现的 builder）。事实接在指令后面（`--append-system-prompt`），`placement: 'prompt'` 不支持：放进这一轮的用户消息就留在 Claude Code 自己的会话里了 |
| `window`、`context` 的其余各项 | 不支持：历史是 Claude Code 自己的                                                                                                                                                                                                          |
| `toolChoice`（`auto` 以外）    | 不支持                                                                                                                                                                                                                                     |
| `permissions` 里的 `ask`       | 不支持：整轮在 Claude Code 里跑完，没有 `requires_action`                                                                                                                                                                                  |
| `settings` 的其余各项          | 不支持                                                                                                                                                                                                                                     |

不支持的字段在场时，这一轮以 `invalid_request` 结束（`ctx.run.started`、输入照常记下，不起 Claude Code），不静默忽略。`RunRequest.prompt` 接在输入后面一起交给 Claude Code：不写 ctx 的日志，但会留在 Claude Code 自己的会话里。

## `stopReason`

| Claude Code 的结果                                                                | `stopReason` | `error.type`                                                                                                      |
| --------------------------------------------------------------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------- |
| `success`                                                                         | `end_turn`   |                                                                                                                   |
| `success`、`stop_reason: max_tokens`                                              | `max_tokens` |                                                                                                                   |
| `error_max_turns`                                                                 | `max_steps`  |                                                                                                                   |
| `error_max_budget_usd`（`args` 里给了 `--max-budget-usd`）                        | `max_budget` |                                                                                                                   |
| 接口错误（`is_error`、`api_error_status`）                                        | `error`      | 上下文过长的是 `context_overflow`（`isContextOverflowText`），别的是 `api_call`，带 `statusCode`；429、5xx 可重试 |
| 续接的会话不在了（`No conversation found`）                                       | `error`      | `not_found`                                                                                                       |
| 被 `signal` 中断                                                                  | `aborted`    |                                                                                                                   |
| 没给出结果就退出了（找不到 `claude`、崩了）                                       | `error`      | `claude_code`，带 stderr 的末尾                                                                                   |
| 给了 `output`、没交上合 schema 的对象（含 `error_max_structured_output_retries`） | `error`      | `invalid_output`                                                                                                  |

## 选项

| 选项                 | 缺省                            | 说明                                                                                                 |
| -------------------- | ------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `store`              | 必填                            | 会话日志                                                                                             |
| `executors`          | 无                              | ctx 的执行环境，数组或 `{ 名字: 执行环境 }`                                                          |
| `tools`              | 各执行环境 `tools()` 报的全部   | 工具目录；`createToolRegistry()` 建的，它自带的函数执行环境自动加进来                                |
| `builtinTools`       | `[]`                            | Claude Code 自带的工具交出哪些；子代理是 `Task`                                                      |
| `command`            | `claude`                        | 可执行文件                                                                                           |
| `args`               | 无                              | 加在最后的命令行参数                                                                                 |
| `cwd`                | 当前目录                        | Claude Code 的工作目录，也是它存会话的依据                                                           |
| `env`                | `process.env`                   | 子进程的环境变量。适配器另加 `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`：后台的活不过这一轮            |
| `bare`               | `false`                         | 加 `--bare`：不读用户和项目的设置、`CLAUDE.md`、钩子、插件，鉴权只认 `ANTHROPIC_API_KEY`；没有子代理 |
| `maxToolOutputChars` | `DEFAULT_MAX_TOOL_OUTPUT_CHARS` | 一次 ctx 工具结果最多多少字符。Claude Code 自己也限 MCP 结果的长度（`MAX_MCP_OUTPUT_TOKENS`）        |
| `interruptTimeoutMs` | `5_000`                         | 取消后等它自己停下多久                                                                               |
| `source`             | 不写                            | 输入条目的 `source`                                                                                  |
| `sources`            | 不给                            | 上下文来源，见 `AgentSpec` 的 `context.facts`                                                        |
| `sourceTimeoutMs`    | `2_000`                         | 单个来源最多等多久，超时就当它这次没有内容                                                           |
| `logger`             | 不记                            | 连不上 MCP 服务器、会话 id 对不上时 `warn`                                                           |

同一个实例里同一会话的记录型运行一个接一个；跨进程时第二个以 `session_busy` 结束。

## 一致性等级

过 `describeHarnessContract` 的 `trace`、`execute`、`resume`、`output`。不跑 `context`：上下文是 Claude Code 自己组装的。

还没做的：

- ctx 的日志里别处写的东西（应用的事件、别的 harness 跑的轮次）Claude Code 看不到：它只读自己的会话。一个 ctx 会话只给它一个 harness 跑。
- 换了 `cwd` 或 `CLAUDE_CONFIG_DIR`、删了它的记录，下一轮以 `not_found` 结束。

## 验证

用 Claude Code 2.1.326 验证过（2026-11-17）：契约测试和本包的用例起真的 `claude`，模型换成本机的假 Anthropic Messages API；stream-json 的各种行、`--resume`、`--resume-session-at`、`--no-session-persistence`、中断、`--max-turns`、`--json-schema`、MCP 经 Streamable HTTP 都对着它核实过。`--max-turns` 和 `--resume-session-at` 是它不在 `--help` 里列出的参数。子代理（`task_started`、`task_updated`、`task_notification`、带 `parent_tool_use_id` 的行、结果里的 `tool_use_result`）对 2.1.326 和 2.1.327 核实过（2026-11-18）：完成、失败、被中断、再派一层都跑过。对真实的 Anthropic 接口没有验证。

本包的测试和 [`examples/claude-code.ts`](../../examples/claude-code.ts) 在装了 `claude` 时跑，没装就跳过；`CTX_TEST_CLAUDE_CODE=required` 时没装就失败，`CTX_CLAUDE_CODE_COMMAND` 换可执行文件。测试给子进程的环境变量只有 `PATH`、临时的 `HOME`、`CLAUDE_CONFIG_DIR` 和 `TMPDIR`、假接口的地址和一个假的 `ANTHROPIC_API_KEY`，不读本机的设置和凭证；子代理的用例不加 `--bare`，读到的也只有这些临时目录。

## 导出

| 导出                                            | 说明                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createClaudeCodeHarness(options)`              | 返回 `ClaudeCodeHarness`：协议的 `Harness`，`run` 和 `stream` 都有                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `ClaudeCodeHarness`、`ClaudeCodeHarnessOptions` | 类型；选项见上                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `CLAUDE_CODE_HARNESS`                           | `claude-code`：`HarnessInfo.name`，也是自带工具结果的 `source`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `CLAUDE_CODE_MCP_SERVER`                        | `ctx`：Claude Code 里 MCP 服务器的名字，工具叫 `mcp__ctx__<名字>`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `CLAUDE_CODE_EVENTS`                            | 适配器写的事件的 `kind`：`synthetic`、`compacted`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `@modelctx-ai/ctx-claude-code/testing`          | `createFakeAnthropicApi({ script, tool? })`：本机的假 Anthropic Messages API，返回 `{ url, requests, close() }`，`url` 给 Claude Code 的 `ANTHROPIC_BASE_URL`。带工具的请求（主循环）按剧本一步一步回答，剧本的一步（`FakeAnthropicStep`）和契约测试的 `ModelScriptStep` 同形状，另有并行调用的 `tool-calls`、`delayMs`、`error` 的 `status`，`tool-call` 和 `tool-calls` 的每次调用可以用 `tool` 指定调哪个工具；要了结构化输出时 `text` 里的 JSON 交给 `StructuredOutput` 工具。`requests` 是收到的主循环请求。类型 `FakeAnthropicApi`、`FakeAnthropicApiOptions`、`FakeAnthropicRequest`、`FakeAnthropicStep` |
