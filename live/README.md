# 对真实服务的冒烟测试

各包的测试用的都是剧本模型和假 `fetch`：它们查得出逻辑错，查不出「服务商的响应其实不长这样」。这个目录补这一块，分三件事：

| 文件                                   | 做什么                                                                                                          | 什么时候跑                                                                             |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| [`smoke.ts`](smoke.ts)                 | 对配了密钥的真实服务各跑几个小场景，映射不对就失败                                                              | 每晚和手动（[`live.yml`](../.github/workflows/live.yml)），不进 PR 的 CI               |
| [`replay.test.ts`](replay.test.ts)     | 重放 [`fixtures/`](fixtures/README.md) 里录下来的真实响应，同一份响应得出的结果要和录的时候一样                 | `pnpm test`，PR 的 CI                                                                  |
| [`exchange.test.ts`](exchange.test.ts) | 录制、去密钥、重放这套机制自己的测试，上游是手写的假响应                                                        | `pnpm test`，PR 的 CI                                                                  |
| [`memory-eval.ts`](memory-eval.ts)     | 记忆的评测：[`memory-eval.json`](memory-eval.json) 的每段对话门控、巩固之后，算召回率、误记率、召回问得到的比例 | 每晚和手动，和冒烟一起；`memory-eval.test.ts` 用标准答案跑一遍评测本身，进 `pnpm test` |

## 记忆评测

[`memory-eval.json`](memory-eval.json) 是中英文各六段对话：偏好、计划、搬家、被更正的说法这些该记住的；闲聊、一次性的问题、助手的猜测、网页和邮件里注入的指令这些不该记住的；每段配几个召回的问题。每段对话一份新的记忆，按缺省配置门控、巩固，然后数三个比例：

| 比例   | 怎么算                                                                  |
| ------ | ----------------------------------------------------------------------- |
| 召回率 | 该记住的里，有一条会被召回的事实含有它的全部关键词（`all`）的比例       |
| 误记率 | 不该记住的里，有一条会被召回的事实含有它的任何一个关键词（`any`）的比例 |
| 问到   | 召回的问题里，`recall` 带回的事实含有期望的全部关键词的比例             |

「会被召回」是仍然成立、没归档、置信度不低于召回的缺省门槛（0.5）：被取代的旧说法、原文里没有支撑而被降了置信度的不算。

```sh
node live/memory-eval.ts                                   # 配了密钥的每种模型各跑一遍
node live/memory-eval.ts --min-recall 0.8 --max-false 0.1  # 低于、高于门槛时退出码是 1
```

用的是 `live/smoke.ts` 同一套环境变量：OpenAI 兼容、Anthropic 的模型用 `LanguageModel` 做提取；Cloudflare 的提取模型配了决策模型时一起用。每晚的工作流只报数、不设门槛：还没有对真实模型跑出过基线。**记忆的门控阈值、激活度参数还没有用这套评测在真实模型上校准过。**`memory-eval.test.ts` 用「照标准答案回答」和「什么都记」两个剧本提取模型跑评测本身，查的是计分对不对，不是记忆好不好。

## 现在验证到哪了

- **MCP**：2026-11-15 对 DeepWiki 的公开服务器（`https://mcp.deepwiki.com/mcp`，Streamable HTTP，`@ai-sdk/mcp` 2.0.83）跑过，连接、列工具、调一个工具都通过。`list_changed`、会话过期、事件流断开没有对真实服务验证。
- **模型（`openai-compatible`、`anthropic`）、System One（Cloudflare、TypeSafe）、网关**：没有对真实服务验证。场景写好了，仓库里还没有配密钥，`fixtures/` 是空的。配上密钥跑一次 `--record` 并提交夹具之后，这一行改成验证的日期和版本。

## 场景

| 场景              | 目标                | 查什么                                                                                                                                               |
| ----------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tool-stream`     | 每个模型            | 一轮带工具调用的流式运行：工具参数是数字不是字符串、结果回得去、文字是流式来的、`stopReason` 是 `end_turn`、`Usage` 的输入输出 token 都有            |
| `gateway-rewrite` | OpenAI 兼容的模型   | `ctx-gateway` 的 `replaceHistory` 改写过的请求上游接不接受：历史里有没配对的工具调用、调用方用分段写法重发同一句话                                   |
| `decide`          | 决策模型            | `noul`、`choice`、`score` 三种问题各一个：形状对（概率在 0..1、和为 1），方向也对（明显的「是」P(是) 大于 0.5）                                      |
| `extract`         | 提取模型            | 日期、整数、列表各一个，加两个输入里没有的字段：没有的要给得出「没有」（`value` 是 null、`pNull` 高）。`list` 字段的 `pNull` 恒为 0 的问题在这里会红 |
| `mcp`             | 一台远程 MCP 服务器 | 连得上、列得出工具、每个工具有输入结构；给了工具名就调一次                                                                                           |

场景只断言确定的东西（调了哪个工具、参数、结束原因、有没有用量），不断言模型具体怎么措辞。

## 怎么跑

Node ≥22.18。在仓库根目录先 `pnpm install`、`pnpm build`，再：

```sh
node live/smoke.ts --list
```

列出每组目标要哪些环境变量（方括号里的可以不给）：

| 目标                | 必须                                                              | 可选                                                                                                          |
| ------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `openai-compatible` | `CTX_LIVE_OPENAI_BASE_URL`、`CTX_LIVE_OPENAI_MODEL`               | `CTX_LIVE_OPENAI_API_KEY`                                                                                     |
| `anthropic`         | `CTX_LIVE_ANTHROPIC_API_KEY`、`CTX_LIVE_ANTHROPIC_MODEL`          | `CTX_LIVE_ANTHROPIC_BASE_URL`                                                                                 |
| `cloudflare`        | `CTX_LIVE_CLOUDFLARE_ACCOUNT_ID`、`CTX_LIVE_CLOUDFLARE_API_TOKEN` | `CTX_LIVE_CLOUDFLARE_DECISION_MODEL`（缺省 `clef`）、`CTX_LIVE_CLOUDFLARE_EXTRACTION_MODEL`（缺省 `clairic`） |
| `typesafe`          | `CTX_LIVE_TYPESAFE_API_KEY`                                       | `CTX_LIVE_TYPESAFE_MODEL`（缺省 `jev-latest`）                                                                |
| `mcp`               | `CTX_LIVE_MCP_URL`                                                | `CTX_LIVE_MCP_TYPE`（`sse`，缺省 Streamable HTTP）、`CTX_LIVE_MCP_TOOL`、`CTX_LIVE_MCP_INPUT`（JSON）         |

```sh
CTX_LIVE_MCP_URL=https://mcp.deepwiki.com/mcp node live/smoke.ts
```

一组变量不齐就跳过那一组（`SKIP`），不算失败；有场景不通过退出码是 1。

在 GitHub 上：密钥放仓库的 secrets，模型名、地址这些不保密的放 variables，名字和上表一样。工作流每晚跑一次，也可以在 Actions 页面手动触发。

## 录夹具

```sh
CTX_LIVE_OPENAI_BASE_URL=… CTX_LIVE_OPENAI_MODEL=… CTX_LIVE_OPENAI_API_KEY=… node live/smoke.ts --record
```

通过的场景写一个 `fixtures/<目标>.<场景>.json`：目标的配置、每次 HTTP 往来的方法、地址、请求正文和响应的状态、类型、正文、当时看到的结果。

- 请求头不录；密钥和账号在地址、正文里出现的地方换成 `REDACTED`。提交之前还是看一眼文件：响应正文里服务商回显的东西录的是原样。
- MCP 的往来是长连接上的事件流，不录。
- 手动触发工作流时勾上 `record`，夹具作为产物 `live-fixtures` 上传，下载后提交。工作流自己没有写仓库的权限。

提交之后 `replay.test.ts` 每次都重放它：请求打到的地址变了、同一份响应映射出来的事件、工具调用、结束原因、用量和录的时候不一样，测试就红。服务商改了接口要重新录。

## 加场景

在 [`scenarios.ts`](scenarios.ts) 里加一个 `Scenario`（`applies` 说对哪种目标跑，`run` 返回看到的结果和问题），放进 `SCENARIOS`。结果里只放确定的值，不放 `runId` 和时间，不然重放对不上。用到全局 `fetch` 的库不用管，跑的时候全局的 `fetch` 已经换成录制的；有 `fetch` 注入口的适配器用 `run` 的第二个参数。
