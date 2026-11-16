# @modelctx-ai/ctx-otel

ctx 的 OpenTelemetry 适配：从会话日志的条目派生 span，按 [GenAI 语义约定](https://opentelemetry.io/docs/specs/semconv/gen-ai/)填属性。会话日志是事实来源，span 只是换一种形状交给 OpenTelemetry，不另记一套；核心包不依赖它。

## 安装

```bash
pnpm add @modelctx-ai/ctx-otel @modelctx-ai/ctx-protocol @opentelemetry/api
```

Node ≥22。`@modelctx-ai/ctx-protocol` 和 `@opentelemetry/api`（`^1.9.0`）是 peer dependency；导出 span 的 SDK（`@opentelemetry/sdk-trace-base`、`sdk-node` 或别的）由应用自己配。

## 用法

```ts
import { createOrchestrator } from '@modelctx-ai/ctx';
import { traceSession } from '@modelctx-ai/ctx-otel';
import { trace } from '@opentelemetry/api';

const tracer = trace.getTracer('my-app');
const cursors = new Map<string, number>(); // 每个会话上一次发到哪里

// harness、store 照常建；每轮结束后把这个会话新结束的运行发成 span
const orchestrator = createOrchestrator({ harness, store });
void (async () => {
  for await (const event of orchestrator.events()) {
    if (event.type === 'run.queued' || event.type === 'run.running') continue;
    const { upTo } = await traceSession(store, event.session, { tracer, after: cursors.get(event.session) });
    cursors.set(event.session, upTo);
  }
})();
```

`traceSession` 只发结束了的运行（有 `ctx.run.ended` 的），返回的 `upTo` 是下一次的 `after`：同一个运行只发一次，没结束的留到下一次。也可以离线对整个库跑一遍，把历史上的运行补进追踪后端。

## span

| span                  | 来自                                                      | 属性                                                                                                                                                                                                                                    |
| --------------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `invoke_agent {name}` | `ctx.run.started` 到 `ctx.run.ended`                      | `gen_ai.operation.name`、`gen_ai.agent.name`（`AgentSpec.name`）、`gen_ai.conversation.id`（会话名）、`gen_ai.request.model`、`ctx.run.id`、`ctx.run.stop_reason`、整轮的用量；`stopReason: error` 时状态是 `ERROR`，说明取 `ctx.error` |
| `chat {model}`        | 每一步的助手消息（`meta.step`）；从它前一条条目写下时算起 | `gen_ai.operation.name`、`gen_ai.provider.name`、`gen_ai.request.model`、`gen_ai.response.model`（服务商响应里的）、`gen_ai.response.finish_reasons`、`ctx.step`、这一步的用量。`SpanKind.CLIENT`                                       |
| `execute_tool {name}` | 一次工具调用：从调用写下到结果写下                        | `gen_ai.operation.name`、`gen_ai.tool.name`、`gen_ai.tool.call.id`；结果是错误、或者到下一步都没有结果时状态是 `ERROR`                                                                                                                  |

用量的属性：`gen_ai.usage.input_tokens`、`gen_ai.usage.output_tokens`、`gen_ai.usage.cache_read.input_tokens`、`gen_ai.usage.cache_creation.input_tokens`、`gen_ai.usage.reasoning.output_tokens`，取 `Usage` 里有的项。时间是条目的 `at`：条目在每一步写下（见[协议层的 Harness 一节](https://github.com/modelctx-ai/ctx/blob/main/docs/protocol.md#harness)），所以 `chat` 是从上一次写入到模型调用结束，近似模型调用的耗时，不是精确的网络时间。消息正文、工具输入和输出不进属性：要看内容的去读日志。旧日志里没有 `meta.step` 的运行只有 `invoke_agent` 一层。属性名按 GenAI 语义约定的属性注册表（2026-11-16）对过，那份约定还在 development 状态；**没有对真实的追踪后端验证**。

## 导出

| 导出                                                        | 说明                                                                                                                        |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `traceSession(store, session, { tracer, after?, parent? })` | 读 `after` 之后的条目，把结束了的运行发成 span，返回 `TraceSessionResult`（`runs`、`upTo`）                                 |
| `deriveSpans(entries, { session?, after? })`                | 纯函数：按 `seq` 排好的条目 → `DerivedSpans`（`runs`：每个运行一棵 `SpanRecord`；`upTo`）。不碰 OpenTelemetry，可以自己检查 |
| `emitSpans(records, tracer, parent?)`                       | 把 `SpanRecord` 交给 `tracer`，开始和结束时间用条目的 `at`                                                                  |
| 类型                                                        | `SpanRecord`、`DerivedSpans`、`DeriveOptions`、`TraceSessionOptions`、`TraceSessionResult`                                  |
