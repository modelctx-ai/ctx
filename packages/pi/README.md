# @modelctx-ai/ctx-pi

把 [pi](https://github.com/earendil-works/pi) 接成 ctx 的 harness：一轮起一个 `pi --mode rpc` 进程，循环、上下文、自带的工具都是它自己的；它的每一步实时写进 ctx 的会话日志，ctx 的工具经 MCP 交给它、调用回到 ctx 的执行环境。为什么这样接见 [ADR 0010](../../docs/adr/0010-external-harness-adapters.md)。

## 安装

```bash
pnpm add @modelctx-ai/ctx-pi @modelctx-ai/ctx-mcp @modelctx-ai/ctx-protocol
```

Node ≥22。`@modelctx-ai/ctx-protocol` 和 `@modelctx-ai/ctx-mcp` 是 peer dependency。pi 本身另装（`npm install --global @earendil-works/pi-coding-agent`，它要 Node ≥22.19；`pi` 在 `PATH` 上，或用 `command` 指过去），模型和凭证由它自己的配置（代理目录里的 `models.json`、`auth.json`）或 `env` 给。

## 用法

```ts
import { createToolRegistry } from '@modelctx-ai/ctx';
import { createPiHarness } from '@modelctx-ai/ctx-pi';
import { createSqliteStore } from '@modelctx-ai/ctx-sqlite';

const store = createSqliteStore({ path: 'ctx.db' });
const tools = createToolRegistry(); // ctx 的工具：经 MCP 交给 pi，在 ctx 的执行环境里执行
tools.executor.register(
  { name: 'remember', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
  (input) => ({ type: 'json', value: { saved: input } }),
);
tools.add(tools.executor.definition('remember')!);

const harness = createPiHarness({
  store,
  tools,
  builtinTools: ['read', 'grep'], // pi 自带的：它自己执行，只记进日志
  cwd: '/srv/agent', // 它按目录存会话：同一个 ctx 会话的各轮用同一个
});

const result = await harness.run({
  session: 'user:42',
  agent: { model: 'anthropic/claude-sonnet-4-5', instructions: '你是代码助手。', maxSteps: 10 },
  input: '看一下 README 里怎么装，记下来',
});
console.log(result.stopReason, result.text);
```

它是一个 `Harness`：交给编排器（`createOrchestrator({ harness, store })`）、`ctx-remote` 的服务端、`ctx-otel` 都和参考实现一样。

## 怎么对上

| 问题            | 做法                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 轨迹从哪拿      | RPC 模式的事件，边读边写：一条助手消息收齐（`message_end`）就写，工具执行之前就在日志里；一步的工具结果在这一步结束（`turn_end`）时写。文字和推理的增量（`message_update`）只进 `stream` 的事件。出错、被中断的模型调用不记成助手消息（同参考实现）                                                                                                                                                                                                                  |
| 工具怎么接      | 每轮起一个只听 `127.0.0.1`、带一次性令牌的 MCP 服务器（`createMcpServer` 加 `listenMcpHttp`），由这一轮的扩展（`-e`，写在只有自己读得到的临时文件里，跑完就删）用 `registerMcpServer` 交给 pi，直接交给模型（`exposure: 'direct'`）。工具在 pi 里叫 `mcp__ctx__<名字>`，日志里换回原名；`--tools` 只列这一轮交出去的工具，别处配的 MCP 服务器的工具不交出去。输入检查、结果截断（`maxToolOutputChars`）在 MCP 服务器里做；第一次交给某个执行环境之前 `open` 这个会话 |
| 输入检查        | pi 执行之前把对不上 schema 的参数转一遍（`42` 当字符串、可选属性的 `null` 当没给……）。ctx 的工具的参数由扩展换回模型给的原样，ctx 的 MCP 服务器查，不合 `inputSchema` 的不执行、作为错误回给模型（同参考实现）；日志里记的调用就是执行的那一个。pi 自带的工具照 pi 的规则                                                                                                                                                                                            |
| 自带的工具      | `builtinTools` 列出的才交出去（`--tools`），缺省一个都不交（`--no-tools`）。调用和结果照常记进日志，工具结果条目的 `source` 是 `pi`；经 ctx 执行的是执行环境的名字                                                                                                                                                                                                                                                                                                   |
| 会话身份        | ctx 的一个会话对着 pi 的一个会话。`ctx.run.started` 的 `data.harness` 记 `{ name: 'pi', version, session }`，每一轮按最近一次记下的 `session` 用 `--session-id` 接着跑；第一轮生成一个新的 id。pi 按工作目录（或 `sessionDir`）找会话                                                                                                                                                                                                                                |
| 位置            | `meta.pi` 记 pi 会话里条目的 id：`ctx.run.started` 的 `resumeAt`（从哪一条接着跑），`ctx.run.ended` 的 `last`（结束时的最后一条，`get_entries` 的 `leafId`）。接着跑之前核对 `resumeAt` 还在：会话或那一条不在了，以 `not_found` 结束，不调模型                                                                                                                                                                                                                      |
| 失败后重试      | 上一轮以 `error` 或 `aborted` 结束、这一轮带同样的输入（或同一个 `inputKey`）重试时，先退回到失败那一轮开始的位置（扩展注册一个名字随机的命令，`navigateTree` 过去，不写摘要），失败那一轮的输入不会在 pi 的上下文里出现两次（记录文件里分出一支，不改原来的）。第一轮就失败的换一个新会话。换了一句话就照常接着跑，失败那一轮留在上下文里                                                                                                                           |
| 取消            | 排队等同一会话的前一轮时取消的，以 `aborted` 结束、什么都不写。`signal` 中止时发 RPC 的 `abort`，pi 停下手里的模型调用和工具、照常结束这一轮；`interruptTimeoutMs` 之后还没退出就 SIGTERM，再过一样久 SIGKILL                                                                                                                                                                                                                                                        |
| 步数和预算      | pi 没有步数的上限：扩展数步，调了工具的一步结束时（`turn_end`）步数到了 `maxSteps` 或整轮超了 `budget` 就叫停（`ctx.abort()`），pi 不再调模型                                                                                                                                                                                                                                                                                                                        |
| 上下文          | pi 自己管：ctx 的日志不压缩、不投影。它压缩自己的上下文时记一条 `pi.compacted`（`text` 是它写的摘要，`data` 是起因和前后的 token 数），不写 ctx 的 `summary`。上下文来源（`sources`，例如 `memory.source()`）每轮记下输入之后收一次，事实接在指令后面，同参考实现的缺省放法；不进 pi 自己的会话，也不写日志                                                                                                                                                          |
| `record: false` | 什么都不写：新开的会话不存（`--no-session`）；接着跑的在一份副本上跑（`--fork`），模型看得到上一轮，跑完副本删掉，pi 的会话不变                                                                                                                                                                                                                                                                                                                                      |
| 对话框          | 扩展要人回答的对话框（`select`、`confirm`、`input`、`editor`）一律回取消；提示（`notify`）的警告和错误交给 `logger`                                                                                                                                                                                                                                                                                                                                                  |

日志里一轮的样子（并行调了两次 ctx 的工具）：

| `seq` | 条目              | `source`  | 带着                                                                                       |
| ----- | ----------------- | --------- | ------------------------------------------------------------------------------------------ |
| 1     | `ctx.run.started` | `harness` | `data.harness`：`{ name, version, session }`；`meta.pi.resumeAt`                           |
| 2     | `user`            | `source`  | 输入                                                                                       |
| 3     | `assistant`       | `model`   | 文字和两个 `tool-call`；`meta.step`（`step`、`provider`、`modelId`、`finishReason`、用量） |
| 4     | `tool`            | `local`   | 两个结果，按调用的顺序                                                                     |
| 5     | `assistant`       | `model`   | 回答；推理的签名在 `reasoning` 部件的 `providerOptions.pi` 里                              |
| 6     | `ctx.run.ended`   | `harness` | `stopReason`、整轮的用量；`meta.pi.last`                                                   |

## `AgentSpec`

| 字段                           | 映射                                                                                                                                                                                                                              |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `model`                        | `--model`：`提供方/模型`，或给 `provider` 选项；pi 的写法都行（`:<思考等级>` 后缀、模糊匹配）。找不到时 pi 不起来，以 `error` 结束                                                                                                |
| `instructions`                 | `--append-system-prompt`（写进临时文件）：接在 pi 自己的系统提示后面                                                                                                                                                              |
| `tools`                        | 从工具目录里挑交给它的 ctx 工具                                                                                                                                                                                                   |
| `maxSteps`                     | 扩展数步，缺省有工具 5、没有 1。用完时这一步的工具照样执行，`stopReason` 是 `max_steps`                                                                                                                                           |
| `output`                       | pi 没有结构化输出：schema 写进系统提示，要它最后只回一个 JSON；最后的回答（可以包在一个代码块里）按 schema 查一遍放进 `RunResult.output`                                                                                          |
| `permissions`                  | `allow` 的交出去；`deny` 的也交出去，调用时回拒绝（同参考实现），扩展和 MCP 服务器两边都拦                                                                                                                                        |
| `budget`                       | 扩展在步骤之间查：这一步调了工具、整轮超了，就叫停，`stopReason` 是 `max_budget`                                                                                                                                                  |
| `environment`                  | 交给执行环境的 `open`                                                                                                                                                                                                             |
| `settings.maxRetries`          | 只认 `0`：`set_auto_retry` 关掉 pi 的自动重试。重试几次是 pi 自己的设置（`settings.json` 的 `retry.maxRetries`）                                                                                                                  |
| `settings.timeoutMs`           | 到点中断，以 `error` 结束，`error.type` 是 `timeout`                                                                                                                                                                              |
| `name`、`version`              | 只记进 `ctx.run.started`                                                                                                                                                                                                          |
| `context.facts`                | 有 `sources` 时每轮收一次：`sources` 按名字选用、`heading` 加标题、`false` 不收（同参考实现的 builder）。事实接在指令后面（`--append-system-prompt`），`placement: 'prompt'` 不支持：放进这一轮的用户消息就留在 pi 自己的会话里了 |
| `window`、`context` 的其余各项 | 不支持：历史是 pi 自己的                                                                                                                                                                                                          |
| `toolChoice`（`auto` 以外）    | 不支持                                                                                                                                                                                                                            |
| `permissions` 里的 `ask`       | 不支持：整轮在 pi 里跑完，没有 `requires_action`                                                                                                                                                                                  |
| `settings` 的其余各项          | 不支持：`maxOutputTokens`、`temperature` 这些 pi 从模型的配置里取                                                                                                                                                                 |

不支持的字段在场时，这一轮以 `invalid_request` 结束（`ctx.run.started`、输入照常记下，不起 pi），不静默忽略。`RunRequest.prompt` 接在输入后面一起交给 pi：不写 ctx 的日志，但会留在 pi 自己的会话里。输入里内联的图片交给 pi（`prompt` 的 `images`），文字文件内联成文字，别的文件（PDF、给的是地址的图片）pi 的提示放不下，换成一句说明。输入以 `/` 开头时照 pi 的规则展开提示模板和技能（`bare` 时不加载它们）。

## `stopReason`

| pi 的结果                                                      | `stopReason` | `error.type`                                                                                                            |
| -------------------------------------------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------- |
| 回答完了（`stop`）                                             | `end_turn`   |                                                                                                                         |
| 输出到了上限（`length`）                                       | `max_tokens` |                                                                                                                         |
| 扩展按 `maxSteps` 叫停                                         | `max_steps`  |                                                                                                                         |
| 扩展按 `budget` 叫停                                           | `max_budget` |                                                                                                                         |
| 模型调用出错（`stopReason: error`，`errorMessage`）            | `error`      | 开头是状态码的是 `api_call`，带 `statusCode`，408、409、429、5xx 可重试；上下文过长的是 `context_overflow`；别的是 `pi` |
| pi 的会话或接着跑的那一条不在了                                | `error`      | `not_found`                                                                                                             |
| pi 没连上 ctx 的 MCP 服务器（它的 `mcp.json` 里有叫 `ctx` 的） | `error`      | `pi`                                                                                                                    |
| pi 不接那句话（`prompt` 的响应不成功）                         | `error`      | `pi`                                                                                                                    |
| 被 `signal` 中断                                               | `aborted`    |                                                                                                                         |
| 到了 `settings.timeoutMs`                                      | `error`      | `timeout`                                                                                                               |
| 没跑完就退出了（找不到 `pi`、模型找不到、崩了）                | `error`      | `pi`，带 stderr 的末尾                                                                                                  |
| 给了 `output`、最后的回答不是合 schema 的 JSON                 | `error`      | `invalid_output`                                                                                                        |

## 选项

| 选项                 | 缺省                            | 说明                                                                                                                                                                                  |
| -------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `store`              | 必填                            | 会话日志                                                                                                                                                                              |
| `executors`          | 无                              | ctx 的执行环境，数组或 `{ 名字: 执行环境 }`                                                                                                                                           |
| `tools`              | 各执行环境 `tools()` 报的全部   | 工具目录；`createToolRegistry()` 建的，它自带的函数执行环境自动加进来                                                                                                                 |
| `builtinTools`       | `[]`                            | pi 自带的工具交出哪些（`read`、`bash`、`edit`、`write`、`grep`、`find`、`ls`……）                                                                                                      |
| `command`            | `pi`                            | 可执行文件                                                                                                                                                                            |
| `args`               | 无                              | 加在最后的命令行参数                                                                                                                                                                  |
| `cwd`                | 当前目录                        | pi 的工作目录；没给 `sessionDir` 时也是它存会话的依据                                                                                                                                 |
| `sessionDir`         | pi 自己的                       | 存会话的目录（`--session-dir`）                                                                                                                                                       |
| `provider`           | 不给                            | `--provider`：在哪个提供方里找 `AgentSpec.model`                                                                                                                                      |
| `env`                | `process.env`                   | 子进程的环境变量：代理目录（`PI_CODING_AGENT_DIR`）、凭证                                                                                                                             |
| `bare`               | `false`                         | 不读上下文文件（`AGENTS.md`、`CLAUDE.md`）、技能、提示模板、主题，不加载发现的扩展和内置的扩展（要 MCP 时只加载 `builtin:mcp`），不读项目里的 `.pi`；模型、凭证和 pi 自己的设置照常读 |
| `maxToolOutputChars` | `DEFAULT_MAX_TOOL_OUTPUT_CHARS` | 一次 ctx 工具结果最多多少字符                                                                                                                                                         |
| `interruptTimeoutMs` | `5_000`                         | 取消后等它自己停下多久                                                                                                                                                                |
| `source`             | 不写                            | 输入条目的 `source`                                                                                                                                                                   |
| `sources`            | 不给                            | 上下文来源，见 `AgentSpec` 的 `context.facts`                                                                                                                                         |
| `sourceTimeoutMs`    | `2_000`                         | 单个来源最多等多久，超时就当它这次没有内容                                                                                                                                            |
| `logger`             | 不记                            | pi 的警告提示、扩展的错误、压缩失败时 `warn`                                                                                                                                          |

同一个实例里同一会话的记录型运行一个接一个；跨进程时第二个以 `session_busy` 结束。

## 一致性等级

过 `describeHarnessContract` 的 `trace`、`execute`、`resume`、`output`。不跑 `context`：上下文是 pi 自己组装的。

还没做的：

- ctx 的日志里别处写的东西（应用的事件、别的 harness 跑的轮次）pi 看不到：它只读自己的会话。一个 ctx 会话只给它一个 harness 跑。
- 扩展加进上下文的消息（`custom_message`）、插话（`steer`、`follow_up`）不进 ctx 的日志；工具自己调的工具（codemode）只有外面那次调用和结果。
- pi 的 `mcp.json` 里有叫 `ctx` 的服务器时它优先：这一轮以 `error` 结束，不会把调用交给它。

## 验证

用 pi 1.5.2（`@earendil-works/pi-coding-agent`）验证过（2026-11-18）：契约测试和本包的用例起真的 `pi`，模型换成本机的假 Anthropic Messages API；RPC 的命令和事件、`--session-id` 续接、`--fork`、扩展的 `registerMcpServer`、`tool_call`、`turn_end` 里的 `ctx.abort()`、`navigateTree` 退回、`--tools` 的白名单、内置 MCP 扩展经 Streamable HTTP 都对着它核实过。对真实的模型服务没有验证。

本包的测试和 [`examples/pi.ts`](../../examples/pi.ts) 在装了 `pi` 时跑，没装就跳过；`CTX_TEST_PI=required` 时没装就失败，`CTX_PI_COMMAND` 换可执行文件。测试给子进程的环境变量只有 `PATH`、临时的 `HOME`、`TMPDIR` 和代理目录（`PI_CODING_AGENT_DIR`，里面的 `models.json` 指到假接口）、`PI_OFFLINE`、`PI_SKIP_VERSION_CHECK`、`PI_TELEMETRY=0`，不读本机的设置和凭证。

## 导出

| 导出                            | 说明                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createPiHarness(options)`      | 返回 `PiHarness`：协议的 `Harness`，`run` 和 `stream` 都有                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `PiHarness`、`PiHarnessOptions` | 类型；选项见上                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `PI_HARNESS`                    | `pi`：`HarnessInfo.name`，也是自带工具结果的 `source`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `PI_MCP_SERVER`                 | `ctx`：pi 里 MCP 服务器的名字，工具叫 `mcp__ctx__<名字>`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `PI_EVENTS`                     | 适配器写的事件的 `kind`：`compacted`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `@modelctx-ai/ctx-pi/testing`   | `createFakeAnthropicApi({ script, tool? })`：本机的假 Anthropic Messages API，返回 `{ url, requests, models, close() }`，`models` 是 pi 的 `models.json`（放进代理目录），里面的模型在 `AgentSpec.model` 里写 `FAKE_MODEL`（`fake/fake-model`）。每个请求按剧本取一步，剧本的一步（`FakeAnthropicStep`）和契约测试的 `ModelScriptStep` 同形状，另有并行调用的 `tool-calls`、`delayMs`、`text` 前面的 `reasoning`、`error` 的 `status`，`tool-call` 和 `tool-calls` 的每次调用可以用 `tool` 指定调哪个工具。类型 `FakeAnthropicApi`、`FakeAnthropicApiOptions`、`FakeAnthropicRequest`、`FakeAnthropicStep` |
