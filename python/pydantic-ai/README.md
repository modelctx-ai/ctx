# ctx-pydantic-ai

把 pydantic-ai 的 `Agent` 接成 ctx 的 harness，Python 写的：循环是 pydantic-ai 的（`Agent.iter`），日志、工具、历史是 ctx 的。每一步实时写进 ctx 的会话日志，工具调用落在 ctx 的执行环境上，对外是 ctx 的线上协议（`POST /runs`），TypeScript 那边用 `ctx-remote` 的 `createRemoteHarness` 连它，和连参考实现一样。为什么这样接见 [ADR 0010](../../docs/adr/0010-external-harness-adapters.md)。

## 安装

不在 PyPI 上，从仓库装：

```bash
pip install "ctx-pydantic-ai @ git+https://github.com/modelctx-ai/ctx#subdirectory=python/pydantic-ai"
```

Python ≥3.11，依赖 `pydantic-ai-slim` 2.69 以上、3 以下。模型服务商的依赖照 pydantic-ai 的写法另装（例如 `pydantic-ai-slim[openai]`），凭证照它自己的环境变量（`OPENAI_API_KEY` 这类）。

## 用法

一种部署：会话存储和执行环境在 TypeScript 的 `ctx-remote` 里，这个包起一个只管跑模型的服务，编排器经线上协议连它。

```bash
ctx-pydantic-ai serve --remote http://127.0.0.1:8080 --model openai:gpt-5 --port 8090
```

```ts
import { createRemoteHarness } from '@modelctx-ai/ctx-remote';

const harness = createRemoteHarness({ baseUrl: 'http://127.0.0.1:8090' });
const result = await harness.run({
  session: 'user:42',
  agent: { model: 'openai:gpt-5', instructions: '简短回答。' },
  input: '把 README 里的安装步骤整理一下',
});
console.log(result.stopReason, result.text);
```

它和别的 harness 一样交给编排器：`createOrchestrator({ harness, store })`，`store` 是连同一个 `ctx-remote` 的 `createRemoteSessionStore`。

在 Python 里直接用：

```python
import asyncio

from ctx_pydantic_ai import FunctionExecutor, PydanticAIHarness, RemoteExecutor, RemoteSessionStore

add = FunctionExecutor('py').register(
    {
        'name': 'add',
        'inputSchema': {'type': 'object', 'properties': {'a': {'type': 'number'}, 'b': {'type': 'number'}}},
    },
    lambda value, context: {'type': 'json', 'value': value['a'] + value['b']},
)


async def main() -> None:
    harness = PydanticAIHarness(
        store=RemoteSessionStore('http://127.0.0.1:8080'),
        executors=[add, RemoteExecutor('http://127.0.0.1:8080', 'local')],
    )
    result = await harness.run({'session': 'user:42', 'agent': {'model': 'openai:gpt-5'}, 'input': '1 加 2 是多少'})
    print(result['stopReason'], result['text'])


asyncio.run(main())
```

`create_app(harness)` 把它挂成 ASGI 应用（Starlette），交给任何 ASGI 服务器；`ctx-pydantic-ai serve` 就是这样起的（uvicorn）。

### 等确认、等别处执行

`permissions` 里 `ask` 的工具，和绑到 `external` 里执行环境的工具，照样交给模型，但不在这里执行。模型调用了它们，这一轮写下调用后以 `requires_action` 结束，`pending` 列出这些调用；应用确认了就交给执行环境、把结果追加进日志，不确认就追加一条错误结果，再不带输入跑一轮：

```python
from ctx_pydantic_ai import tool_result_entry


async def ask_first(harness, store, executor) -> dict:
    agent = {'model': 'openai:gpt-5', 'permissions': {'tools': {'add': 'ask'}}}
    result = await harness.run({'session': 'user:42', 'agent': agent, 'input': '1 加 2 是多少'})
    while result['stopReason'] == 'requires_action':
        for call in result['pending']:
            # 确认了：交给执行环境。不确认就追加 {'type': 'error', 'message': '用户拒绝了'}。
            output = await executor.execute(call, {'session': 'user:42', 'runId': result['runId']})
            await store.append('user:42', [tool_result_entry(call, output, source=executor.name)])
        result = await harness.run({'session': 'user:42', 'agent': agent})
    return result
```

经 `serve` 时一样：TypeScript 一侧拿到 `RunResult.pending`，用 `runPendingTools(store, session, { executor })` 交给 `ctx-remote` 上的执行环境，再不带输入跑一轮。

## 怎么对上

| 问题       | 做法                                                                                                                                                                                                                                                                                                                                         |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 轨迹从哪拿 | `Agent.iter` 一个节点一个节点地走：模型请求的节点流式读（文字、推理的增量只进 `stream` 的事件），到了工具节点就写这一步的助手消息，工具执行之前就在日志里；这一步的工具结果到齐就写，按调用的顺序、按执行方分组                                                                                                                              |
| 工具怎么接 | 挑出的每个 ctx 工具做成一个 pydantic-ai 的 `Tool`（`Tool.from_schema`，`inputSchema` 原样给模型）。调用时先看权限、按 `inputSchema` 查输入，再交给它的执行环境，结果按 `max_tool_output_chars` 截断。拦下的、执行出错的，模型看到的是失败的工具结果（`ToolFailed`，不占 pydantic-ai 的重试次数）。第一次交给某个执行环境之前 `open` 这个会话 |
| 等别处执行 | `ask` 的和绑到 `external` 里执行环境的工具（`deny` 优先）交给模型、不在这里执行：调用时不查输入，工具函数抛 `CallDeferred`，同一步里别的工具照常执行。这一步走完就以 `requires_action` 结束，`pending` 是这些调用，不补「结果未知」                                                                                                          |
| 自带的工具 | 没有交出去：工具都是 ctx 的。pydantic-ai 的服务商内置工具（`builtin_tools`）没有接                                                                                                                                                                                                                                                           |
| 会话身份   | 没有另一份：pydantic-ai 不存对话，每一轮的历史都从 ctx 的日志投影出来交给它（`message_history`）。`ctx.run.started` 的 `data.harness` 记 `{ name: 'pydantic-ai', version }`                                                                                                                                                                  |
| 失败后重试 | 同参考实现：上一轮以 `error` 或 `aborted` 结束、这一轮的输入就是日志里留下的那句（或同一个 `inputKey`），不再写一遍                                                                                                                                                                                                                          |
| 取消       | `signal`（线上是 `DELETE /runs/:runId` 或断开）交给 pydantic-ai 的 `CancellationToken`，手里的模型调用和工具停下；没等到结果的工具调用补一条错误结果（`source` 是 `harness`），`stopReason` 是 `aborted`                                                                                                                                     |
| 上下文     | 投影照协议包 `project` 的缺省规则：最新的摘要代替它盖住的条目，工具调用和结果按组配对，事件不进上下文。不裁窗口、不压缩，不写 `summary`；别处写的 `summary` 照用                                                                                                                                                                             |
| 它补的话   | pydantic-ai 让模型改了再答时补的那段话（该交结构化输出时给了文字这类，`RetryFeedbackPart`）记成 `pydantic-ai.retry` 事件，不记成用户消息；对某次工具调用的（调了不存在的工具）是那次调用的错误结果                                                                                                                                           |

日志里一轮的样子（并行调了两个执行环境的工具）：

| `seq` | 条目              | `source`  | 带着                                                                           |
| ----- | ----------------- | --------- | ------------------------------------------------------------------------------ |
| 1     | `ctx.run.started` | `harness` | `data.harness`：`{ name: 'pydantic-ai', version }`                             |
| 2     | `user`            | `source`  | 输入                                                                           |
| 3     | `assistant`       | `model`   | 文字和两个 `tool-call`；`meta.step`（`step`、`modelId`、`finishReason`、用量） |
| 4     | `tool`            | `local`   | `local` 执行的结果                                                             |
| 5     | `tool`            | `sandbox` | `sandbox` 执行的结果                                                           |
| 6     | `assistant`       | `model`   | 回答                                                                           |
| 7     | `ctx.run.ended`   | `harness` | `stopReason`、整轮的用量                                                       |

## `AgentSpec`

| 字段                       | 映射                                                                                                                                                                                                                            |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `model`                    | 只收名字。给了 `models` 按它找，找不到是 `not_found`；没给按 pydantic-ai 的写法推（`openai:gpt-5` 这类），推不出来是 `invalid_request`                                                                                          |
| `instructions`             | `Agent(instructions=…)`                                                                                                                                                                                                         |
| `tools`                    | 从工具目录里挑                                                                                                                                                                                                                  |
| `maxSteps`                 | 模型调用的次数，缺省有工具 5、没有 1；pydantic-ai 让模型改了再答的那一次也算。用完时这一步的工具照样执行，`stopReason` 是 `max_steps`；最后一个回答是没交对的结构化输出时是 `invalid_output`                                    |
| `output`                   | `ToolOutput(StructuredDict(schema), name='final_result')`：模型经输出工具交对象，日志里记成它交的 JSON 文字。pydantic-ai 不按 JSON Schema 查 `StructuredDict`，适配器按 schema 再查一遍，放进 `RunResult.output`                |
| `toolChoice`               | `none`、`required`、`{ tool }` → `ModelSettings` 的 `tool_choice`；`{ tool }` 点名的工具没交出去是 `invalid_request`                                                                                                            |
| `permissions`              | `deny` 的照样交给模型，调用时回拒绝；`ask` 的写下调用后以 `requires_action` 停下（同参考实现）                                                                                                                                  |
| `budget`                   | 在步骤之间查，用到上限就停，`stopReason` 是 `max_budget`                                                                                                                                                                        |
| `environment`              | 交给执行环境的 `open`                                                                                                                                                                                                           |
| `settings`                 | `ModelSettings`：`temperature`、`maxOutputTokens` → `max_tokens`、`topP` → `top_p`、`topK` → `top_k`、`presencePenalty`、`frequencyPenalty`、`seed`、`stopSequences`、`maxRetries` → `max_retries`、`headers` → `extra_headers` |
| `settings.timeoutMs`       | `Agent.iter(timeout=…)`：整轮的，到点以 `error` 结束，`error.type` 是 `timeout`                                                                                                                                                 |
| `name`、`version`          | `name` 交给 `Agent(name=…)`；都记进 `ctx.run.started`                                                                                                                                                                           |
| `window`、`context`        | 不支持：整段投影交出去                                                                                                                                                                                                          |
| `settings.providerOptions` | 不支持                                                                                                                                                                                                                          |

不支持的字段在场时，这一轮以 `invalid_request` 结束（`ctx.run.started`、输入照常记下，不调模型），不静默忽略。`RunRequest.prompt` 接在历史最后交给模型，不写日志。

## `stopReason`

| pydantic-ai 那边                              | `stopReason`              | `error.type`                                                                                                                                                                   |
| --------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 走到 `End`                                    | `end_turn`                |
| 有交给别处执行的调用（`CallDeferred`）        | `requires_action`         |                                                                                                                                                                                |
| 最后一步的 `finish_reason` 是 `length`        | `max_tokens`              |                                                                                                                                                                                |
| 到了 `maxSteps`、`budget`                     | `max_steps`、`max_budget` |                                                                                                                                                                                |
| `ModelHTTPError`、`ModelAPIError`             | `error`                   | 上下文过长的是 `context_overflow`（`ModelContextWindowExceededError`，或报错文字按 `isContextOverflowText` 认），别的是 `api_call`，带 `statusCode`；408、409、429、5xx 可重试 |
| `RunTimedOut`                                 | `error`                   | `timeout`                                                                                                                                                                      |
| `RunCancelled`                                | `aborted`                 |                                                                                                                                                                                |
| 给了 `output`、最后的回答不合 schema          | `error`                   | `invalid_output`                                                                                                                                                               |
| `UnexpectedModelBehavior`（重试次数用完这类） | `error`                   | 给了 `output` 时是 `invalid_output`，否则是 `pydantic_ai`                                                                                                                      |
| `UserError`                                   | `error`                   | `invalid_request`                                                                                                                                                              |

## 选项

`PydanticAIHarness(...)`：

| 选项                    | 缺省                            | 说明                                                                                                                                        |
| ----------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `store`                 | 必填                            | 会话日志：`RemoteSessionStore`、`MemorySessionStore`，或有 `append`、`list` 的对象                                                          |
| `executors`             | 无                              | ctx 的执行环境，列表或 `{名字: 执行环境}`：`RemoteExecutor`、`FunctionExecutor`，或有 `name`、`tools()`、`execute()`（可选 `open()`）的对象 |
| `tools`                 | 各执行环境 `tools()` 报的全部   | 工具目录（`ToolDefinition` 的列表）                                                                                                         |
| `models`                | 按 pydantic-ai 的写法推         | 模型名 → pydantic-ai 的 `Model` 或模型字符串：函数，或映射（映射之外的名字是 `not_found`）                                                  |
| `max_tool_output_chars` | `DEFAULT_MAX_TOOL_OUTPUT_CHARS` | 一次工具结果最多多少字符，按 UTF-16 码元算，和 TypeScript 一样                                                                              |
| `source`                | 不写                            | 输入条目的 `source`                                                                                                                         |
| `external`              | 无                              | 在别处执行的执行环境的名字：绑定到它们的工具交给模型、不在这里执行，调用了就以 `requires_action` 结束。它们的工具定义要在 `tools` 里        |

同一个实例里同一会话的记录型运行一个接一个；跨进程时第二个以 `session_busy` 结束。

`create_app(harness, ...)`：

| 选项                | 缺省                       | 说明                                                                                      |
| ------------------- | -------------------------- | ----------------------------------------------------------------------------------------- |
| `access_token`      | 不查                       | 要求 `Authorization: Bearer <令牌>`；空串直接报错                                         |
| `allowed_models`    | 不限                       | 只收这些模型名，别的回 400                                                                |
| `allowed_settings`  | `DEFAULT_ALLOWED_SETTINGS` | 同 `ctx-remote`：采样参数、`maxRetries`、`timeoutMs`，不含 `headers` 和 `providerOptions` |
| `allowed_hosts`     | 不查                       | 只认这些 `Host` 头（`host:port`），挡 DNS rebinding                                       |
| `allowed_origins`   | 一个都不放                 | 带 `Origin` 头的请求只放行这些来源：浏览器网页发来的请求缺省一律 403                      |
| `heartbeat_seconds` | `15`                       | 等结果时隔多久写一个换行（`POST /runs`）或空行（`?stream=1`）                             |
| `max_runs`          | `32`                       | 同时跑的上限，满了回 429                                                                  |
| `max_body_bytes`    | 4 MiB                      | 请求体上限                                                                                |

命令行：

| 命令                                                                                                    | 作用                                                                                                                       |
| ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `ctx-pydantic-ai serve --remote <地址> [--remote-token] [--executor 名字 …] [--model 名字 …] [--token]` | 日志写进那个 `ctx-remote` 的会话存储，工具交给它的执行环境（不给 `--executor` 就是它列出的全部）；`--model` 是只收的模型名 |
| `ctx-pydantic-ai conformance [--token]`                                                                 | 一致性模式（`POST /conformance/instances`），给 `ctx-conformance --components harness` 测                                  |

两个都有 `--host`（缺省 `127.0.0.1`）、`--port`（缺省 `8090`，`0` 是系统挑），起来后打印一行 `ctx-pydantic-ai listening on http://<host>:<port>`。`Host` 头只认监听地址；`--host` 不是本机地址时必须给 `--token`。令牌也可以放在 `CTX_ACCESS_TOKEN`（这个服务的）和 `CTX_REMOTE_TOKEN`（`ctx-remote` 的）里。

## 一致性等级

过 `describeHarnessContract` 的 `trace`、`execute`、`resume`、`output`，经线上协议（`ctx-conformance` 对着 `ctx-pydantic-ai conformance`）。不跑 `context`：不做 `window` 和 `context`。

一致性模式的实例上另挂了 `/sessions` 的追加和读，给 harness 契约读写日志，不是完整的会话存储：只给 `sessions` 组件的实例请求回 400。

还没做的：

- `window`、`context`：裁剪、压缩、事件规则。
- 服务商内置工具，和模型产出的文件这类 pydantic-ai 自己的部分：记成 `custom` 部分（`kind` 是 `pydantic-ai.<part_kind>`），下一轮不交回给模型。
- 不在 PyPI 上；版本跟着仓库走（`pnpm release:version` 的正式版本一起改）。

## 验证

用 pydantic-ai 2.69.0 验证过（2026-11-17，延后的调用 2026-11-18）：`Agent.iter` 的节点和事件、`Tool.from_schema` 的 `args_validator`、`ToolFailed`、`StructuredDict`、`CancellationToken`、`RunTimedOut`、`RetryFeedbackPart`、`ModelSettings` 的各项、`CallDeferred` 和 `DeferredToolRequests`（同一步里有别的工具、有结构化输出时也一样停下）都对着它核实过，模型是按剧本回答的 `FunctionModel`（`ScriptedModel`）和 pydantic-ai 自带的 `test` 模型。对真实的模型服务没有验证。

测试（`uv run pytest`）有三种：

- 进程内的 harness 和 HTTP 层。
- 协议函数（截断、投影、上下文过长的认法、筛选、`ListOptions`、等着的调用、`tool_result_entry`）对同一组输入和 TypeScript 的协议包比结果；常量和 `PROTOCOL_VERSION` 从 TypeScript 源码里读出来比。
- 线上：`RemoteSessionStore`、`RemoteExecutor` 对着真的 `ctx-remote`；TypeScript 的 `createRemoteHarness` 经 `ctx-pydantic-ai serve` 跑一轮、日志写进 `ctx-remote`，`ask` 停下后用 TypeScript 的 `runPendingTools` 执行、再接着跑完；`ctx-conformance` 跑一致性测试。

后两种要 node 22.18 以上和仓库根的 `pnpm install`（读各包的 `src/`，不用构建），没有就跳过；`CTX_TEST_PYDANTIC_AI=required` 时不跳、直接失败，CI 这样跑。

## 导出

| 导出                                                                                                                  | 说明                                                                                                                                                                                                                                        |
| --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PydanticAIHarness`                                                                                                   | 协议的 `Harness`：`await run(request, *, signal=None)` 返回 `RunResult`，`stream(request, *, signal=None)` 是 `RunEvent` 的异步迭代器（消费方提前不读了就取消这一轮）；都是线上形状的 `dict`                                                |
| `AbortSignal`                                                                                                         | `RunRequest.signal`：`abort()`、`aborted`、`add_listener(fn)`                                                                                                                                                                               |
| `SessionStore`、`RemoteSessionStore`、`MemorySessionStore`                                                            | 会话存储的接口；连 `ctx-remote` 的 `/sessions`（`aclose()` 关连接）；进程内的                                                                                                                                                               |
| `Executor`、`RemoteExecutor`、`FunctionExecutor`                                                                      | 执行环境的接口；连 `ctx-remote` 的 `/executors/:name`；进程内的函数（`register(definition, fn)`，`fn(input, context)` 返回 `ToolOutput`，可以是协程）                                                                                       |
| `create_app`、`create_conformance_app`、`CONFORMANCE_PATH`                                                            | ASGI 应用：harness 的线上入口（选项见上）；一致性模式和它的路径                                                                                                                                                                             |
| `spec_problem(spec)`                                                                                                  | `AgentSpec` 里映射不了的字段，没有是 `None`                                                                                                                                                                                                 |
| `tool_result_entry(call, output, *, source=None, meta=None)`、`pending_tool_calls(entries)`、`TOOL_RESULT_KEY_PREFIX` | 执行方追加结果的 `tool` 消息，带幂等键 `ctx.tool-result:<id>`；会话里等着别处执行的调用（`{ call, runId, seq }`）。和协议包的 `toolResultEntry`、`pendingToolCalls` 一样，测试对同一组输入比                                                |
| `CtxError`                                                                                                            | 协议认得的错误：`type`、`message`、`retryable`、`status_code`，`info()` 是 `ErrorInfo`                                                                                                                                                      |
| `HARNESS_NAME`、`RETRY_EVENT`、`OUTPUT_TOOL`、`INTERRUPTED`                                                           | `pydantic-ai`；`pydantic-ai.retry`；`final_result`；没等到结果的工具调用补的错误结果                                                                                                                                                        |
| `PROTOCOL_VERSION`、`ENTRY_VERSION`、`DEFAULT_MAX_TOOL_OUTPUT_CHARS`                                                  | 和协议包的同名常量相同，测试从 TypeScript 源码里读出来比                                                                                                                                                                                    |
| `ctx_pydantic_ai.testing`                                                                                             | `ScriptedModel(script, *, tool='echo', delay_ms=0)`：按剧本回答的 pydantic-ai 模型，剧本的一步和契约测试的 `ModelScriptStep` 同形状，另有并行调用的 `tool-calls`，`requests` 是每次收到的消息；`echo_executor(name)`、`ECHO_TOOL`：回显工具 |
