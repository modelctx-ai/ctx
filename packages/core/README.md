# @modelctx-ai/ctx

ctx 的进程内参考实现。按 [`@modelctx-ai/ctx-protocol`](../protocol) 的协议实现：内存会话存储、投影和来源组成的上下文、工具注册表、函数执行环境、基于 AI SDK `generateText` / `streamText` 的 harness、进程内编排器，以及把它们组合在一个会话上的门面 `createContext()`。

协议包的全部导出（类型、纯函数、`CTX_EVENTS`）这里原样再导出一遍，应用只从 `@modelctx-ai/ctx` 导入就行。

## 安装

```sh
pnpm add @modelctx-ai/ctx @modelctx-ai/ctx-protocol zod
```

Node ≥22。`@modelctx-ai/ctx-protocol` 和 `zod` 是 peer dependency（`zod` 是 `ai` 要的）。

## 用法

### 门面：`createContext()`

```ts
import { createContext, createMemoryStore, defineSource, eventEntry, type LanguageModel } from '@modelctx-ai/ctx';

declare const model: LanguageModel; // 任何 AI SDK 模型，例如 @modelctx-ai/ctx-models 的 createModel()

const context = createContext({
  store: createMemoryStore(),
  session: 'pet:main',
  model,
  sources: [defineSource('task', () => '当前任务：写周报')],
  projection: {
    events: {
      'pet.whisper': {
        fold: true,
        render: (events) => ({
          role: 'assistant',
          content: `碎碎念：\n${events.map((event) => event.text).join('\n')}`,
        }),
      },
    },
    window: { maxTokens: 16_000 },
  },
});

await context.append(eventEntry('pet.whisper', { text: '在呢' }), eventEntry('pet.whisper', { text: '记得喝水' }));

// 用户这句在调用模型前写进日志；失败后带同样的输入重试，不会记两遍（inputKey 让这一点跨进程也成立）
const reply = await context.generate({
  instructions: '你是桌宠，回答一句话。',
  input: '今天忙吗？',
  inputKey: 'turn-1',
});
console.log(reply.runId, reply.stopReason, reply.text);

const { result, recorded } = await context.stream({ instructions: '你是桌宠，回答一句话。', input: '那明天呢？' });
for await (const delta of result.textStream) process.stdout.write(delta);
console.log((await recorded).length); // 这次写进日志的条目：ctx.run.started、用户这句、回复、ctx.run.ended

await context.compact(); // 历史够长时把较早的部分压成摘要；太长就分段，一段一段滚动摘要

// 要知道为什么没压成，用 compactDetailed
const outcome = await context.compactDetailed({ maxInputTokens: 24_000 });
if (outcome.status === 'truncated') console.warn('摘要被 maxOutputTokens 截断，调大再试');
if (outcome.status === 'input_too_long') console.warn('一段也放不进摘要模型，调大 maxInputTokens 或换模型');
```

`context.builder`、`context.executor`、`context.harness` 是门面内部的 `ContextBuilder`、函数执行环境和 harness，可以直接用。

**`generate` 和 `harness.run` 的差别**：模型出错或被取消时，`context.generate()` 为了和 0.1 兼容抛出原来的错误；`context.harness.run()`（协议的 `Harness.run`）不抛，返回 `stopReason: 'error' | 'aborted'` 和 `error`，日志里照样写 `ctx.run.ended`。两者都只在写日志失败时 reject。

### 函数执行环境

```ts
import { createFunctionExecutor } from '@modelctx-ai/ctx';

const local = createFunctionExecutor('local').register(
  { name: 'clock_now', description: '当前时间，ISO 8601', inputSchema: { type: 'object', properties: {} } },
  () => ({ type: 'text', text: new Date().toISOString() }),
);

await local.execute({ id: 'c1', name: 'clock_now', input: {} }, { session: 'demo' }); // { type: 'text', … }
await local.execute({ id: 'c2', name: 'missing', input: {} }, { session: 'demo' }); // { type: 'error', message: 'Unknown tool …' }
```

不认识的工具、`signal` 已中止、函数抛错都返回 `{ type: 'error' }`，不抛。

### 工具注册表

```ts
import { createToolRegistry, tool } from '@modelctx-ai/ctx';
import { z } from 'zod';

const tools = createToolRegistry().addTool(
  'weather_get',
  tool({
    description: '查城市天气',
    inputSchema: z.object({ city: z.string() }),
    execute: async ({ city }) => `${city}晴`,
  }),
  { tags: ['read'] },
);

tools.get('weather_get'); // { name, description, inputSchema: JSON Schema, executor: 'local', source: 'local', tags: ['read'] }
tools.select({ tags: ['read'] }); // ToolDefinition[]
tools.toolSet({ tags: ['read'] }); // AI SDK ToolSet：execute 转给绑定的执行环境
```

`addTool` 把 zod 工具转成 JSON Schema 定义（`asSchema(...).jsonSchema`），执行函数放进注册表自带的函数执行环境 `tools.executor`；执行时先按原来的 zod 校验输入。`add(definition)` 加别的执行环境的工具（例如 MCP）。

### Harness

```ts
import { createContextBuilder, createHarness, createMemoryStore } from '@modelctx-ai/ctx';

const store = createMemoryStore();
const harness = createHarness({
  store,
  context: createContextBuilder({ store, factsPlacement: 'prompt' }),
  tools, // 上面的注册表；它自带的函数执行环境自动加进 executors
  executors: [], // 其余执行环境，例如 ctx-mcp 的 hub；工具绑定的执行环境不在这里，开跑前 logger.warn 一次，调用时模型收到错误
  models: (name) => createMyModel(name), // AgentSpec.model 是名字时怎么造
  hooks: {
    beforeTool: (call) => (call.name === 'weather_get' ? undefined : { allow: false, reason: '只能查天气' }),
  },
});

const result = await harness.run({
  session: 'user:42',
  agent: { model: 'deepseek-chat', instructions: '你是生活助手。', tools: { tags: ['read'] } },
  input: '台北下午要带伞吗？',
});

for await (const event of harness.stream({
  session: 'user:42',
  agent: { model: 'deepseek-chat' },
  input: '明天呢？',
})) {
  if (event.type === 'text.delta') process.stdout.write(event.text);
}
```

流程：`ctx.run.started` → 记输入（`inputKey` 幂等）→ `build` → `beforeModel` → 调模型（每个工具调用经 `beforeTool` → 执行环境 → `afterTool`）→ 记产出 → `ctx.run.ended`。`record: false` 一条都不写。

`AgentSpec.context` 按一轮选事实和投影（只按名字选，所以能序列化）：builder 里注册，agent 里引用。

```ts
const builder = createContextBuilder({
  store,
  sources: [clock, weather], // ContextSource，按 name 选
  projection: {}, // default
  projections: { brief: { window: { maxMessages: 6 } } },
});
// 只用 weather 的事实，放进最后一条临时用户消息；用 brief 投影
const agent = {
  model: 'deepseek-chat',
  context: { facts: { sources: ['weather'], placement: 'prompt' }, projection: 'brief' },
};
```

`facts: false` 不收事实；不认识的投影名这一轮以 `not_found` 结束，不回退到缺省。

`context.overflow` 是上下文超过模型窗口时的兜底，缺省关着：

```ts
const agent = {
  model: 'deepseek-chat',
  context: {
    // 整次调用（指令、事实、工具定义、历史、输入）的估算超过 100k token 时：
    // 先压缩（最近 8 条原样保留），还超就裁剪，单条消息超预算时截短它
    overflow: { maxTokens: 100_000, compact: { keep: 8 } },
  },
};
const result = await harness.run({ session: 'user:42', agent, input: '接着说' });
if (result.error?.type === 'context_overflow') {
  // 压缩、裁剪都做了还放不下（多半是指令或工具定义本身太长），或者服务商说上下文过长
}
```

- `strategy`：`compact`（缺省）先压缩再裁剪；`trim` 只裁剪，什么都不写；`error` 超了就不调模型。压缩用 builder 配的 `model`，builder 没配就用这一轮的模型；`record: false` 的运行不压缩，直接裁剪。
- `maxTokens` 是估算（不分词），留些余量；要准就在投影配置的 `window.estimate` 里接分词器，检查用的是同一个估算。
- 服务商拒绝调用、说上下文过长时，这一轮以 `stopReason: 'error'`、`error.type: 'context_overflow'` 结束（`isContextOverflow(result.error)`）。认法是 HTTP 413 加各家常见的错误码和消息（`isContextOverflowError`），**没有对真实服务验证**；认不出来的照旧是 `api_call`。
- 失败的一轮留下的输入不会因为重试越积越多：上一轮以 `error` 或 `aborted` 结束，这一轮带同样的 `input` 来，就不再记一遍。`inputKey` 仍然有用：它在进程重启、别的 harness 实例上也成立。

窗口有两处：builder 的投影配置里的 `window`（可以带 `estimate` 函数接分词器），和请求里的 `window`（`AgentSpec.window`、`view(session, { window })`）。请求给了就整个换掉 builder 配的上限，`{}` 是不裁剪；`estimate` 始终用 builder 的。`build` 时 `maxTokens` 管整次调用：指令、事实、工具定义、这一轮的输入先扣掉，剩下的才是历史的预算。裁剪出来的总是模型接口收得下的序列：工具调用和结果成对，开头不是孤立的工具结果或助手消息。窗口缺省只会整组地丢，最后一组哪怕自己就超预算也原样留着；`window: { maxTokens, truncate: true }` 另外把超预算的单条消息截短（文字留头尾，工具结果截短，内联文件换成一句说明），日志里的原文不动。

工具边界：harness 在执行前按工具的 `inputSchema` 查模型给的输入（协议包的 `checkJsonSchema`，只查认识的关键字），不合就不执行，把问题作为错误结果回给模型，它通常下一步就改对了。`addTool` 加的工具不在这一层查：它们照旧在函数执行环境里按原来的 zod 校验，比转出来的 JSON Schema 准。工具结果过了 `afterTool` 之后超过 `maxToolOutputChars`（缺省 20 万字符）时截断并注明省略了多少。这是兜底：该截断、分页的是执行环境，它知道怎么截才有用。

### 编排器

```ts
import { createOrchestrator } from '@modelctx-ai/ctx';

const orchestrator = createOrchestrator({ harness, store, owner: 'pet' });
// 用缺省 record（写日志）的应用：启动时先 recover 再 submit，否则崩溃留下的运行会让该会话一直 session_busy
await orchestrator.recover?.(); // 给崩溃时断掉的运行补上悬空工具调用的结果和 ctx.run.ended（error）
const handle = await orchestrator.submit({ session: 'user:42', agent: { model: 'deepseek-chat' }, input: '在吗' });
await orchestrator.status(handle.runId); // queued / running / completed / failed / cancelled
await handle.done;
await orchestrator.close();
```

同一会话串行，不同会话并行；`cancel` 取消排队中或运行中的一轮；`events()` 给出状态变化。

### 工具在别处执行

执行环境在内网、只能出站连接，或者工具要由应用自己执行时，把它的名字列进 `external`。模型调用它时，这一轮写下调用后以 `requires_action` 结束，不占会话；执行方读写同一个会话存储，把结果追加回来，应用再不带输入跑一轮：

```ts
import { createHarness, createToolRegistry, runPendingTools } from '@modelctx-ai/ctx';

const tools = createToolRegistry().add({
  name: 'order_lookup',
  description: '查订单',
  inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
  executor: 'intranet', // 绑在内网的执行环境上
});
const harness = createHarness({ store, context, tools, external: ['intranet'] });

const result = await harness.run({ session: 'user:42', agent, input: '订单 42 到哪了？' });
if (result.stopReason === 'requires_action') {
  // 内网的 worker：store 可以是 ctx-remote 的远端存储，只要出站连接
  await runPendingTools(store, 'user:42', { executor: intranetExecutor });
  await harness.run({ session: 'user:42', agent }); // 不带输入，模型从日志接着走
}
```

`runPendingTools` 只执行归这个执行环境的调用（`executor.tools()` 报的名字，或者 `tools`），结果带幂等键，两个 worker 都执行了也只记一条；有副作用的工具自己幂等。结果一直不来时，应用照常提交下一轮就行，等着的调用随之作废。

### Agent 配置：结构化输出、工具选择、权限、预算

`AgentSpec` 里这几项都是 JSON，换 harness、过 `ctx-remote` 都还在：

```ts
const agent: AgentSpec = {
  model,
  version: 'support@3', // 记进 ctx.run.started
  output: { schema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] } },
  toolChoice: 'auto', // 'none'、'required'、{ tool: 'order_lookup' }
  permissions: { default: 'allow', tools: { refund: 'ask', delete_account: 'deny' } },
  budget: { maxTotalTokens: 200_000, maxDurationMs: 120_000 },
};
const result = await harness.run({ session: 'user:42', agent, input: '订单 42 能退吗？' });
result.output; // 按 schema 解析过的回答；不合是 stopReason 'error'、error.type 'invalid_output'
```

- `deny` 的工具不执行，模型看到拒绝；`ask` 的写下调用后以 `requires_action` 停下，和外部执行的工具一样：应用确认了就 `runPendingTools(store, session, { executor })`，不确认就追加 `toolResultEntry(call, errorOutput('用户拒绝了'))`，再不带输入跑一轮。
- `budget` 只在步骤之间检查，超了 `stopReason` 是 `max_budget`；正在进行的模型调用和工具不会被打断，硬上限用 `settings.timeoutMs`。

### 子 agent

一个 agent 把活交给另一个 agent：`createSubagentTool` 做一个工具，模型调用它就在子会话上跑一轮。子会话的 `ctx.run.started` 记下 `parent`，父会话的工具结果指向子会话：

```ts
import { childRunsOf, createSubagentTool } from '@modelctx-ai/ctx';

const research = createSubagentTool({
  name: 'research',
  description: '把一个需要查资料的问题交给研究员',
  runner: harness, // 或者编排器
  agent: { model: 'deepseek-chat', instructions: '你是研究员。' },
  context: 'inherit', // 带上父会话到这次调用之前的内容；缺省 'fresh'
  store,
});
tools.executor.register(research.definition, research.execute);
tools.add(tools.executor.definition('research')!);

await harness.run({ session: 'user:42', agent, input: '帮我查查这个' });
for (const run of childRunsOf(await store.list('user:42'))) console.log(run.child.session, run.stopReason, run.usage);
```

- 父运行取消时子运行跟着取消；经编排器派的，`cancel(父 runId)` 一并取消子运行。
- 用量不自动往上加：`addUsage(result.usage, ...childRunsOf(entries).map((run) => run.usage))`。
- 编排模式（路由、群聊、层级）不在这里，应用自己组合。

### 崩溃后续跑

harness 每一步都即时写日志：工具调用在执行之前写下，结果在这一步结束时写下。进程在工具执行时被杀掉，日志里有已经做完的步骤和「调用已发出、结果未知」的那一次。下一个进程启动时 `recover()` 给结果未知的调用补一条错误结果，配了 `resume` 的再从日志接着跑：

```ts
import { createContextBuilder, createHarness, createOrchestrator, createToolRegistry, tool } from '@modelctx-ai/ctx';
import { createModel } from '@modelctx-ai/ctx-models';
import { createSqliteStore } from '@modelctx-ai/ctx-sqlite';
import { z } from 'zod';

const store = createSqliteStore({ path: 'ctx.db' }); // 前后两个进程共用这个库
const tools = createToolRegistry().addTool(
  'send_mail',
  tool({
    description: '发一封邮件',
    inputSchema: z.object({ to: z.string(), text: z.string() }),
    // 有副作用的工具自己幂等（例如按收件人和正文去重）：结果未知的那次，模型可能会再调一遍。
    execute: async ({ to, text }) => sendOnce(to, text),
  }),
);
const harness = createHarness({
  store,
  context: createContextBuilder({ store }),
  tools,
  models: (name) => createModel({ provider: 'openai-compatible', baseUrl: 'https://api.deepseek.com/v1', model: name }),
});
const agents = { mailer: { name: 'mailer', model: 'deepseek-chat', tools: { names: ['send_mail'] } } };
const orchestrator = createOrchestrator({
  harness,
  store,
  owner: 'mailer',
  // 日志里记下的 agent 模型只剩名字、请求头打了码：按名字给出完整的 AgentSpec，不认识的只结束不续跑。
  resume: (run) => (run.agent['name'] === 'mailer' ? agents.mailer : undefined),
});

for (const run of await orchestrator.recover()) {
  if (run.resumed) console.log(`会话 ${run.session} 的 ${run.runId} 断在半路，接着跑：${run.resumed}`);
}
await orchestrator.submit({ session: 'user:42', agent: agents.mailer, input: '给小王和小李各发一封周报' });
```

第一封发完、第二封发到一半时进程没了：日志是 `ctx.run.started`、输入、调用一、结果一、调用二。重启后 `recover()` 写下调用二的错误结果（`The run ended before this tool call returned; its result is unknown.`）和 `ctx.run.ended`，再提交一轮不带输入的运行；模型看到第一封已经发了、第二封结果未知，第一封不会再发。不给 `resume` 时只补结果和 `ctx.run.ended`，下一句用户输入来了再接着聊。

## 导出

| 导出                                                                                                                                                                       | 说明                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 协议包的全部导出                                                                                                                                                           | `SessionStore`、`ContextBuilder`、`ToolRegistry`、`Executor`、`Harness`、`Orchestrator` 等类型，条目构造、`project`、`collectFacts`、`selectTools`、`toolOutputToAiSdk` 等纯函数，`CTX_EVENTS`                                                                                                                                                                                                                                                                          |
| `createMemoryStore({ now?, id? })`                                                                                                                                         | 内存 `SessionStore`，带 `watch`；写入时拷一份（按 JSON 的形状，不能 JSON 化的当场抛）、读出时再拷一份，改草稿和改读出来的条目都不影响日志；`truncate`、`remove`、`redact` 改条目和追加 `ctx.erased` 在同一个同步段里                                                                                                                                                                                                                                                    |
| `createFunctionExecutor(name = 'local')`                                                                                                                                   | 进程内函数执行环境：`register(definition, fn, { replace? })`、`unregister`、`has`、`definition`、`tools`、`execute`；`open`、`close` 只记会话，`openSessions()` 列出开着的                                                                                                                                                                                                                                                                                              |
| `createToolRegistry({ executor? })`                                                                                                                                        | `ToolRegistry` 加 `addTool(name, tool, meta?)`、`addAll`、`toolSet(filter?, { executors? })`、`executor`、`validatesInput(name)`（是不是 `addTool` 加的、自己校验输入的工具）；`add(name, tool, meta)` 是弃用的写法                                                                                                                                                                                                                                                     |
| `toToolSet(definitions, executors, { session?, runId?, dispatch?, validateInput?, maxOutputChars?, external? })`、`dispatchTo(executors)`、`DEFAULT_MAX_TOOL_OUTPUT_CHARS` | 定义包成 AI SDK `ToolSet`，`execute` 转给绑定的执行环境。执行前按 `inputSchema` 查输入，不合就不执行、把问题回给模型（`validateInput: false` 关掉，也可以给按定义决定的函数）；结果超过 `maxOutputChars`（缺省 `DEFAULT_MAX_TOOL_OUTPUT_CHARS`，20 万字符）截断并注明                                                                                                                                                                                                   |
| `createContextBuilder({ store, projection?, projections?, sources?, sourceTimeoutMs?, logger?, factsPlacement?, model?, models?, now? })`、`DEFAULT_COMPACT_INPUT_TOKENS`  | `ContextBuilder`：`build`、`view`、`compact`、`compactDetailed`，另加 `facts(session, signal?, { sources? })`、`recompact`。`compact` 按 `maxInputTokens`（缺省 `DEFAULT_COMPACT_INPUT_TOKENS`，24000 个估算 token）分段滚动摘要，每段落一个检查点；`now` 是压缩用的钟（认 `at` 在未来的条目、算 `timeoutMs`），缺省 `Date.now`                                                                                                                                         |
| `createHarness({ store, context, tools?, executors?, external?, models?, hooks?, logger?, source?, validateToolInput?, maxToolOutputChars? })`                             | `Harness`：`run`、`stream`。后两个选项就是 `toToolSet` 的 `validateInput`、`maxOutputChars`；`external` 是在别处执行的执行环境的名字，绑定到它们的工具被调用时这一轮以 `requires_action` 结束                                                                                                                                                                                                                                                                           |
| `createOrchestrator({ harness, store?, owner?, resume?, retainEnded?, logger? })`                                                                                          | `Orchestrator`：`submit`、`status`、`cancel`、`events`、`close`；给了 `store` 才有 `recover`，它给悬空的工具调用补错误结果、补 `ctx.run.ended`；`resume(run)` 返回 `AgentSpec` 时接着跑（`InterruptedRun`：`session`、`runId`、记下的 `agent`、`interrupted`、子运行的 `parent`）；`cancel` 连带取消以它为 `parent` 的运行。结束的运行只留状态，最多 `retainEnded` 个（缺省 1000）                                                                                      |
| `createContext(options)`                                                                                                                                                   | 门面：`append`、`entries`、`view`、`facts`、`prepare`、`generate`、`stream`、`compact`、`compactDetailed`，以及 `builder`、`executor`、`harness`                                                                                                                                                                                                                                                                                                                        |
| `describeError`、`redact`、`errorInfo`、`isContextOverflowError`                                                                                                           | 给日志和界面用的错误摘要；去密钥；`RunResult.error` 的形状（上下文过长时 `type` 是 `context_overflow`）；判断一个错误是不是服务商说的「上下文过长」（按 HTTP 413 和常见的错误码、消息，没有对真实服务验证）                                                                                                                                                                                                                                                             |
| `toModelMessages`、`fromModelMessages`（单条是 `toModelMessage`、`fromModelMessage`）、`toUserContent`、`fromUserContent`                                                  | ctx 的 `Message` 和 AI SDK 的 `ModelMessage`、`UserContent` 互转；遇到子集之外的部件抛 `unsupported_part`，harness 把这一轮以 `error` 结束。`createContext()` 仍收 AI SDK 的 `UserContent`，在边界上转                                                                                                                                                                                                                                                                  |
| `runPendingTools(store, session, { executor, tools?, source?, maxOutputChars?, signal? })`、`RunPendingToolsOptions`、`PendingToolsResult`                                 | 执行方的一步（[ADR 0008](https://github.com/modelctx-ai/ctx/blob/main/docs/adr/0008-tool-calls-through-the-log.md)）：最后一轮以 `requires_action` 结束时，把归这个执行环境的等待中的调用逐个执行，结果作为 `toolResultEntry` 追加进会话；返回 `executed` 和 `remaining`                                                                                                                                                                                                |
| `createSubagentTool({ name, runner, agent, session?, input?, context?, store?, inputSchema?, description? })`、`SubagentTool`、`SubagentToolOptions`、`SubagentContext`    | 派子 agent 的工具，返回 `{ definition, execute }`，注册进函数执行环境。子运行带 `parent`，结果是 `childRunOutput`；`runner` 是 `Harness` 时父的 `signal` 传下去，是 `Orchestrator` 时中止就 `cancel`；`context: 'inherit'` 设 `AgentSpec.context.inherit`，要给 `store`                                                                                                                                                                                                 |
| `closeExecutorSessions(executors, session)`                                                                                                                                | 会话结束时调各个执行环境的 `close`（没有的跳过，一个失败不挡别的），返回 `{ closed, failed }`；harness 只 `open` 不 `close`，会话什么时候算结束由应用决定                                                                                                                                                                                                                                                                                                               |
| `pruneSession(store, session, { keep?, maxAgeMs?, now?, pageSize? })`、`PruneOptions`                                                                                      | 保留期：删掉被生效的摘要盖住的历史（走 `truncate`），返回删掉的条数。`keep` 留最后写入的 N 条，`maxAgeMs` 留 `at` 在这段时间之内的，都不给就全删；有未结束的运行时不删到它。没有定时器，应用自己决定什么时候调（见[架构](https://github.com/modelctx-ai/ctx/blob/main/docs/architecture.md#删除和保留期)）                                                                                                                                                              |
| `findLossySummaries(store, { session? })`、`recompactLossy(builder, finding, options)`                                                                                     | 升级后修复：列出 0.2 写的、有条目被新规则盖住的摘要，再用模型重新压缩一次（见[协议层](https://github.com/modelctx-ai/ctx/blob/main/docs/protocol.md#消息格式和版本)）                                                                                                                                                                                                                                                                                                   |
| `tool`、`dynamicTool`、`jsonSchema`、`zodSchema`、`asSchema`、`stepCountIs`，`ModelMessage`、`LanguageModel`、`ToolSet` 等类型                                             | 从 `ai` 转出，应用不用单独依赖 `ai`                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `@modelctx-ai/ctx/testing`                                                                                                                                                 | 原样转出协议包的 `/testing`：契约测试（`describeSessionStoreContract`、`describeContextBuilderContract` 等，含记忆的 `describeMemoryStoreContract`、`describeDecisionModelContract`、`describeExtractionModelContract`、`describeMemoryContract`）和剧本式的 `createScriptedDecisionModel`、`createScriptedExtractionModel`；另加 `createScriptedModel(script, { tool? })`：按剧本回答的假 `LanguageModel`（`text` 那一步带 `truncated` 时 `finishReason` 是 `length`） |

`createContext` 的选项：`store`、`session`、`projection`、`sources`、`sourceTimeoutMs`、`factsPlacement`、`tools`、`executors`、`hooks`、`model`、`source`、`logger`、`overflow`（`generate`、`stream` 的超窗兜底，每次调用也可以单独给 `overflow`）。

契约测试：核心包的内存存储、函数执行环境、注册表、harness、编排器、上下文分别跑 `describeSessionStoreContract`、`describeExecutorContract`、`describeToolRegistryContract`、`describeHarnessContract`、`describeOrchestratorContract`、`describeContextBuilderContract`。

细节见[架构](https://github.com/modelctx-ai/ctx/blob/main/docs/architecture.md)和[协议层](https://github.com/modelctx-ai/ctx/blob/main/docs/protocol.md)。
