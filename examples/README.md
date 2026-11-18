# 例子

每个例子对应一种部署或一件值得示范的事，都是一个能直接跑的文件。不设环境变量时模型按剧本回答（协议包的剧本模型），不用联网、不用密钥；CI 里跑的就是这一种（`examples.test.ts`，以及构建之后的 `pnpm examples`）。

| 文件                                     | 部署                                            | 看什么                                                                                                                                |
| ---------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| [`single-process.ts`](single-process.ts) | 单进程：SQLite 加一个模型，带工具               | `createSqliteStore`、`createToolRegistry().addTool`、`createHarness`、`createOrchestrator`                                            |
| [`remote-split.ts`](remote-split.ts)     | 拆开：存储一个进程，执行环境一个进程，经 HTTP   | `startRemote`、`createRemoteSessionStore`、`createRemoteExecutor`；harness 一侧只认协议                                               |
| [`two-processes.ts`](two-processes.ts)   | 记录开着，两个进程共用一个库                    | 一个会话最多一个未结束的运行（`session_busy`）、`owner`、`recover` 收走自己断掉的运行                                                 |
| [`memory.ts`](memory.ts)                 | 记忆接进上下文                                  | `createMemory` 的 `gate`、`consolidate`、`source()`、`recall` 工具，按用户的作用域（`scope`）                                         |
| [`move-session.ts`](move-session.ts)     | 搬会话：内存 → 文件 → SQLite → 远端             | `exportSession`、`importSession`、`copySession`：`seq` 重新分配之后摘要的 `covers` 仍然指对，三边的上下文一样                         |
| [`claude-code.ts`](claude-code.ts)       | 外部 harness：Claude Code 跑循环                | `createClaudeCodeHarness`：ctx 的工具经 MCP 回到 ctx 的执行环境，轨迹实时进日志，第二轮续接它自己的会话（`HarnessInfo.session`）      |
| [`pi.ts`](pi.ts)                         | 外部 harness：pi 跑循环                         | `createPiHarness`：ctx 的工具经 MCP 回到 ctx 的执行环境，轨迹实时进日志，第二轮续接它自己的会话（`HarnessInfo.session`）              |
| [`memory-pi.ts`](memory-pi.ts)           | 记忆接进自己管上下文的 harness：pi              | pi 跑的会话照样进 `gate`、`consolidate`；`memory.source()` 给适配器的 `sources`，事实接在 pi 的系统提示后面；`recall` 经 MCP 回到记忆 |
| [`pydantic-ai.ts`](pydantic-ai.ts)       | 外部 harness，另一种语言：pydantic-ai（Python） | `ctx-pydantic-ai serve` 经线上协议跑，`createRemoteHarness` 连它；日志和工具在 `ctx-remote` 里，第二轮的历史从日志投影                |

## 怎么跑

Node ≥22.18（直接运行 `.ts`）。在仓库根目录：

```sh
pnpm install
pnpm build
node examples/single-process.ts
```

用真的模型：任何 OpenAI 兼容的地址都行。

```sh
CTX_EXAMPLE_BASE_URL=https://api.deepseek.com/v1 CTX_EXAMPLE_API_KEY=… CTX_EXAMPLE_MODEL=deepseek-chat node examples/single-process.ts
```

真的模型怎么回答、调不调工具由它自己定，输出和剧本的不一样是正常的。没有对真实服务验证：CI 只跑剧本模型。

`claude-code.ts` 要装 Claude Code（`claude` 在 `PATH` 上，或 `CTX_CLAUDE_CODE_COMMAND` 指过去），没装就跳过。缺省模型是本机的假 Anthropic 接口（`@modelctx-ai/ctx-claude-code/testing`），Claude Code 的设置和会话放在临时目录，不读本机的设置和凭证；CI 的 Claude Code 作业装固定版本跑它。用真的模型，走本机 Claude Code 自己的登录和设置（没有对真实服务验证）：

```sh
CTX_EXAMPLE_CLAUDE_MODEL=sonnet node examples/claude-code.ts
```

`pi.ts` 要装 pi（`npm install --global @earendil-works/pi-coding-agent`，`pi` 在 `PATH` 上，或 `CTX_PI_COMMAND` 指过去），没装就跳过。缺省模型是本机的假 Anthropic 接口（`@modelctx-ai/ctx-pi/testing`），pi 的代理目录、家目录和会话放在临时目录，不读本机的设置和凭证；CI 的 pi 作业装固定版本跑它。用真的模型，走本机 pi 自己的配置和登录（没有对真实服务验证）：

```sh
CTX_EXAMPLE_PI_MODEL=anthropic/claude-sonnet-4-5 node examples/pi.ts
```

`memory-pi.ts` 同样要装 pi，没装就跳过；只用假接口和剧本里的提取结果，不联网。

`pydantic-ai.ts` 要装 uv（`uv` 在 `PATH` 上），没装就跳过；它按 `python/pydantic-ai/uv.lock` 装好依赖再起 `ctx-pydantic-ai serve`，子进程只拿到 `PATH`、`HOME`、uv 自己的和代理、证书的环境变量。模型是 pydantic-ai 自带的 `test` 模型（把给它的工具各调一次，再用 JSON 文字报结果），不联网、不要密钥；CI 的 pydantic-ai 作业跑它。换真的模型照 [`python/pydantic-ai`](../python/pydantic-ai/README.md) 起服务（没有对真实服务验证）。

`remote-split.ts` 可以真的拆成三个进程：

```sh
node examples/remote-split.ts store     # 打印地址和 CTX_TOKEN
CTX_TOKEN=… node examples/remote-split.ts sandbox
CTX_STORE_URL=… CTX_SANDBOX_URL=… CTX_TOKEN=… node examples/remote-split.ts agent
```

## 改例子

例子是仓库的一个工作区包（`ctx-examples`，不发布），类型检查和测试跟各包一起跑（`pnpm check`）。改了公开 API，例子编不过或者测试红了，就在同一个 PR 里改例子。每个例子导出 `main(log?)`，返回值给测试断言用；文件末尾的 `if (isMain(import.meta.url))` 让它也能被 `node` 直接跑。
