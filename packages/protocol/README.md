# @modelctx-ai/ctx-protocol

ctx 的协议层：九个协议的接口、随接口走的 JSON 形状、只依赖这些形状的纯函数，以及契约测试。**不含实现**——内存存储、harness 这些在 `@modelctx-ai/ctx` 和各 `ctx-*` 包里。实现别的存储、执行环境或 harness 时只装它。

运行时没有依赖；`ai` 只用类型 `LanguageModel`（`ModelRef` 里的进程内模型），是 peer dependency。消息是协议包自己定义的 JSON 格式 `Message`，和 AI SDK 互转在 `@modelctx-ai/ctx`。

## 安装

```sh
pnpm add @modelctx-ai/ctx-protocol ai
```

Node ≥22。

## 九个协议

| 协议              | 方法                                                            | 一句话                                                                                                                                                    |
| ----------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SessionStore`    | `append`、`list`、`clear`、`sessions`、`watch?`                 | 只追加的事件日志，按 `seq`（写入顺序）排序；`append` 可带 `expectSeq` 前提，不满足抛 `conflict`；`sessions` 名字升序，可分页，`list` 可按事件 `kind` 过滤 |
| `ContextBuilder`  | `build`、`view`、`compact?`                                     | 日志 + 事实 + 输入 → 一次调用的指令、消息、工具名单                                                                                                       |
| `ToolRegistry`    | `add`、`remove`、`removeSource`、`has`、`get`、`list`、`select` | 工具目录：JSON Schema 定义，每个绑一个执行环境的名字                                                                                                      |
| `Executor`        | `execute`、`tools?`、`provision?`、`dispose?`                   | 工具调用真正发生的地方；出错返回 `{ type: 'error' }` 而不是抛                                                                                             |
| `Harness`         | `run`、`stream?`                                                | 一轮：组装 → 调模型 → 分发工具 → 写回，直到停下                                                                                                           |
| `Orchestrator`    | `submit`、`status`、`cancel`、`close`、`recover?`、`events?`    | 跨轮次、跨会话的调度：同一会话串行，不同会话并行                                                                                                          |
| `MemoryStore`     | `notes`、`facts`、`procedures`、`core` 四个集合                 | 记忆的存储：笔记指向日志的 `seq` 区间，事实带有效期和证据、不改写只 `close` + `add`，程序带确认次数，`core` 保留历史版本                                  |
| `DecisionModel`   | `decide`                                                        | 单次前向的判断（是 / 否、选一个、量表），返回概率，不产出文字                                                                                             |
| `ExtractionModel` | `extract`                                                       | 从输入里填字段（文字、数、日期、时长、列表），带 `pNull`、`confidence`                                                                                    |

生成文字的模型用 AI SDK 的 `LanguageModel`，不另定义；`DecisionModel`、`ExtractionModel` 不生成文字，是协议包自己的 JSON 形状。记忆的门面 `Memory`（`gate`、`recall`、`consolidate`、`source`、`tools`，本身是 `Executor`）也定义在这里，参考实现在 `@modelctx-ai/ctx-memory`。随协议走的值：`AgentSpec`（一个 agent 的配置）、`Hooks`（harness 的切入点）、框架事件 `CTX_EVENTS`（`ctx.run.started`、`ctx.run.ended`、`ctx.compacted`、`ctx.error`）。

签名和语义见[协议层](https://github.com/modelctx-ai/ctx/blob/main/docs/protocol.md)，类型以包里的 `.d.ts` 为准。

## 纯函数

| 导出                                                                                     | 说明                                                                                                     |
| ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `userEntry`、`assistantEntry`、`messageEntry`、`eventEntry`、`summaryEntry`              | 构造新条目                                                                                               |
| `runStartedEntry`、`runEndedEntry`、`compactedEntry`、`ctxErrorEntry`、`isFrameworkKind` | 框架事件                                                                                                 |
| `compareEntries`、`filterEntries`、`filterSessions`、`textOf`                            | 投影顺序、`ListOptions`、`SessionsOptions` 的语义、消息文字                                              |
| `headSeq`、`isConflict`、`checkExpectSeq`、`conflictError`                               | `expectSeq` 前提：读末尾、认 `conflict`、存储实现里检查并抛错                                            |
| `ENTRY_VERSION`、`upgradeEntry`                                                          | 条目格式版本；存储读每一行时调 `upgradeEntry(raw)`，旧版本升到当前形状，更高版本抛 `unsupported_version` |
| `project`、`latestSummary`、`defaultSummaryMessage`                                      | 条目渲染成 `Message[]`：摘要、事件规则、窗口                                                             |
| `defineSource`、`collectFacts`、`renderFacts`                                            | 上下文来源和事实（`collectFacts` 并行、单个来源有超时）                                                  |
| `estimateTokens`、`estimateTextTokens`                                                   | 不依赖分词器的 token 估算                                                                                |
| `isValidToolName`、`matchesTool`、`selectTools`、`errorOutput`                           | 工具名校验、工具筛选、错误结果                                                                           |
| `toolOutputToAiSdk`、`toolOutputFromAiSdk`                                               | `ToolOutput` 和 AI SDK 工具结果 `output` 互转                                                            |
| `modelName`、`agentSpecToJson`                                                           | 模型名的字符串写法；`AgentSpec` 的可序列化部分                                                           |
| `activation`、`rankFacts`、`renderCore`、`ACTIVATION_DEFAULTS`                           | 记忆的 ACT-R 激活度、召回排序（`0.6 × 相似度 + 0.4 × 激活度`）、`core` 的缺省写法（按 token 预算截断）   |
| `sourceRef`、`checkSourceRef`、`checkEvidence`、`sameSourceRef`、`inSourceRef`           | 证据区间：从条目算、存储写入前校验（抛 `invalid_request`）、去重、判断条目在不在区间里                   |
| `isOpenFact`、`filterFacts`                                                              | `FactQuery` 的语义（`open`、按 `id` 码点序翻页）                                                         |

## 实现一个协议

协议是 `interface`，实现是返回它的工厂函数，不用类继承：

```ts
import type { Executor } from '@modelctx-ai/ctx-protocol';
import { errorOutput } from '@modelctx-ai/ctx-protocol';

export function createEchoExecutor(): Executor {
  return {
    name: 'echo',
    async tools() {
      return [{ name: 'echo', inputSchema: { type: 'object' }, executor: 'echo' }];
    },
    async execute(call, context) {
      if (context.signal?.aborted) return errorOutput('已取消，没有执行。');
      if (call.name !== 'echo') return errorOutput(`没有工具 "${call.name}"，可用的有：echo。`);
      return { type: 'json', value: call.input };
    },
  };
}
```

再用 `@modelctx-ai/ctx-protocol/testing` 的契约测试验证行为。`describe`、`test` 由调用方传入，Vitest、`node:test`、Jest、Bun 都能跑，断言用 `node:assert/strict`：

```ts
// echo.test.ts
import { describe, test } from 'vitest'; // 或 'node:test'

import {
  describeExecutorContract,
  describeSessionStoreContract,
  describeToolRegistryContract,
} from '@modelctx-ai/ctx-protocol/testing';

describeExecutorContract('echo', () => ({ executor: createEchoExecutor(), echo: 'echo' }), { describe, test });
describeSessionStoreContract('pg', ({ now }) => createPgStore({ url: 'postgres://localhost/ctx_test', now }), {
  describe,
  test,
});
describeToolRegistryContract('mine', () => createMyRegistry(), { describe, test });
```

| 契约测试                          | 工厂                                                             | 覆盖                                                                                                                                                                                                         |
| --------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `describeSessionStoreContract`    | `({ now }) => SessionStore`，每例一个                            | 排序、同一时刻、去重、一批里有重复时其余照写、并发两批不交错、查询组合（含 `kinds`）、`last`、往返、二进制和 URL、像标记的数据、`clear`、`sessions` 的升序和翻页、`watch?`                                   |
| `describeExecutorContract`        | `() => { executor, echo }`                                       | 有名字、`tools?()` 列出回显工具、`execute` 回显且结果能序列化、未知工具和已中止的 `signal` 返回 `{ type: 'error' }` 不抛、`provision?` 可重复                                                                |
| `describeToolRegistryContract`    | `() => ToolRegistry`，每例一个空的                               | 增查、按加入顺序、名字校验、同名和 `replace`、`remove`/`removeSource`、`select` 与 `selectTools` 一致                                                                                                        |
| `describeHarnessContract`         | `({ script }) => { harness, store, agent }`                      | 一轮的日志顺序和 `recorded`、`runId`、工具调用经执行环境、模型出错照常返回 `error` 并写 `ctx.run.ended`、`inputKey` 重试、`record: false`、已中止的 `signal`、`stream?` 的事件顺序和出错                     |
| `describeOrchestratorContract`    | `({ script }) => { orchestrator, store, agent }`                 | `submit`/`status`、同一会话串行、取消排队中的、`events?`、`recover?` 补 `ctx.run.ended`、`close` 后不收                                                                                                      |
| `describeMemoryStoreContract`     | `({ now }) => MemoryStore`，每例一个空的                         | 笔记的 `head`、`pending`、`settle`；事实不改写、`close` 和 `supersededBy`、`cite` 去重、`touch` 追加、`archive` 退出 `open`、`forget` 真删、`list` 翻页；`search` 全文命中；程序 `confirm` 计数；`core` 历史 |
| `describeDecisionModelContract`   | `() => DecisionModel`                                            | 三种问题的形状、概率和为 1、`choice` 是概率最大的、`score` 是期望档位、一次 64 个问题、`signal` 中止                                                                                                         |
| `describeExtractionModelContract` | `() => ExtractionModel`                                          | 每种字段的 `value` 形状、找不到时 `value: null` 且 `pNull` 高、`signal` 中止                                                                                                                                 |
| `describeMemoryContract`          | `({ sessions, decision, extraction, now }) => { memory, store }` | `gate` 不改日志、笔记指向正确的 `seq` 区间、`head` 前进；`consolidate` 幂等、取代不覆盖、证据指回日志；`recall` 后 `recalls` 多一个；`source`、`tools` 的形状                                                |

harness 和编排器的契约要一个按剧本回答的模型：工厂收到 `script`（`ModelScriptStep[]`：`text`、调用回显工具的 `tool-call`、`error`），自己造模型和回显工具。`@modelctx-ai/ctx/testing` 的 `createScriptedModel(script, { tool })` 就是这样一个模型（基于 `ai/test`）。记忆的契约要剧本式的决策、提取模型：`createScriptedDecisionModel(script)`、`createScriptedExtractionModel(script)` 在 `/testing` 里，`describeMemoryContract` 自己造好它们和一个内存会话日志交给工厂。`ContextBuilder` 的契约还没写：它的行为大半在投影规则这些进程内配置里，协议方法能比的只剩 `build` 的形状。
