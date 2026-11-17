---
type: Decision Record
title: 'ADR 0002：包的拆分、命名、版本和发布'
description: '包怎么拆、怎么命名，源码条件，版本，发布，使用方式'
tags: [adr, packages, release]
status: stable
---

# ADR 0002：包的拆分、命名、版本和发布

- 状态：已采纳（2026-11-15 按「决定记录」修订）
- 日期：2026-10-23
- 实施状态：拆包、命名、源码条件、版本约定已实施；发布工作流和发布前的检查 2026-11-15 加上，还没有发布过，见「实施状态」

## 拆分

先按层拆：协议一个包，实现若干包（[ADR 0004](0004-protocol-and-implementation.md)）。实现包再按依赖和运行环境拆，不按概念拆：所有应用都要的、和运行环境无关的放进核心包；带额外依赖或只能在 Node 上跑的各成一个适配包，用不到就不装。

| 包                             | 内容                                                                                            | 单独成包的原因                                                                                          |
| ------------------------------ | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `@modelctx-ai/ctx-protocol`    | 九个协议的接口、JSON 形状、纯函数、`/testing` 契约测试                                          | 实现别的存储、执行环境或 harness 时只装它，不带进任何实现和 `ai` 的运行时                               |
| `@modelctx-ai/ctx`             | 内存存储、投影和来源、工具注册表、函数执行环境、AI SDK harness、进程内编排器、`createContext()` | 进程内的参考实现，每个应用都要；只依赖协议包和 `ai`                                                     |
| `@modelctx-ai/ctx-sqlite`      | `node:sqlite` 的会话存储和记忆存储                                                              | 只能在 Node ≥22.13 上跑；自带存储的应用用不到                                                           |
| `@modelctx-ai/ctx-models`      | 按配置建模型，含 System One 的决策、提取模型                                                    | 带进服务商 SDK（`@ai-sdk/openai-compatible`、`@ai-sdk/anthropic`）；自己传 `LanguageModel` 的应用用不到 |
| `@modelctx-ai/ctx-memory`      | 记忆的参考实现 `createMemory`、内存记忆存储、启发式和 `LanguageModel` 装成的决策、提取模型      | 不用记忆的应用用不到；要 `ai` 的 `generateText`                                                         |
| `@modelctx-ai/ctx-mcp`         | MCP 服务器作为执行环境                                                                          | 带进 `@ai-sdk/mcp`，要起子进程                                                                          |
| `@modelctx-ai/ctx-exec`        | 本机子进程执行环境                                                                              | 要 `node:child_process`；不跑命令的应用用不到                                                           |
| `@modelctx-ai/ctx-remote`      | 会话存储、执行环境、harness、编排器、记忆存储的 HTTP 服务端和客户端                             | 服务端要 `node:http`；进程内用法用不到                                                                  |
| `@modelctx-ai/ctx-gateway`     | OpenAI 兼容网关                                                                                 | 本机 HTTP 服务；只有要接 OpenAI 协议客户端的应用才用                                                    |
| `@modelctx-ai/ctx-otel`        | 从会话日志派生 OpenTelemetry 的 span                                                            | 带进 `@opentelemetry/api`；不接追踪后端的应用用不到                                                     |
| `@modelctx-ai/ctx-claude-code` | 把 Claude Code 接成 harness                                                                     | 要起 `claude` 子进程和本机 HTTP；不用 Claude Code 的应用用不到                                          |

没选一个包加子路径（`@modelctx-ai/ctx/sqlite`）：适配器的依赖要么所有人都装上，要么变成可选的 peer 让使用方自己补；各部分对 Node 版本的要求也不一样。

## 命名

- npm 作用域 `@modelctx-ai`，组织已经在这里发布 `@modelctx-ai/via`。
- 核心包叫 `@modelctx-ai/ctx`，导入最常用的东西路径最短；适配包叫 `@modelctx-ai/ctx-<名字>`。
- 目录 `packages/<名字>`，核心包在 `packages/core`。
- 工厂函数叫 `createX()`，起服务的叫 `startX()`，都返回接口；类型名不加 `I` 之类的前缀。

## 依赖关系

| 包                             | `dependencies`                                   | `peerDependencies`                   |
| ------------------------------ | ------------------------------------------------ | ------------------------------------ |
| `@modelctx-ai/ctx-protocol`    | —                                                | `ai`（只用类型）                     |
| `@modelctx-ai/ctx`             | `ai`                                             | `ctx-protocol`、`zod`                |
| `@modelctx-ai/ctx-sqlite`      | —                                                | `ctx-protocol`                       |
| `@modelctx-ai/ctx-models`      | `@ai-sdk/openai-compatible`、`@ai-sdk/anthropic` | `ctx-protocol`、`ai`                 |
| `@modelctx-ai/ctx-memory`      | —                                                | `ctx-protocol`、`ai`                 |
| `@modelctx-ai/ctx-mcp`         | `@ai-sdk/mcp`                                    | `ctx-protocol`                       |
| `@modelctx-ai/ctx-exec`        | —                                                | `ctx-protocol`                       |
| `@modelctx-ai/ctx-remote`      | —                                                | `ctx-protocol`                       |
| `@modelctx-ai/ctx-gateway`     | —                                                | `ctx-protocol`                       |
| `@modelctx-ai/ctx-otel`        | —                                                | `ctx-protocol`、`@opentelemetry/api` |
| `@modelctx-ai/ctx-claude-code` | —                                                | `ctx-protocol`、`ctx-mcp`            |

依赖只朝一个方向：协议 ← 实现 ← 实践。实现包把协议包当 peer：应用里只有一份协议包，`SessionStore`、`Executor`、`Harness` 这些类型来自同一份。实现包之间不互相依赖（例外是 `ctx-claude-code` 把 `ctx-mcp` 当 peer，见 [ADR 0010](0010-external-harness-adapters.md)）；测试里需要一个会话存储时把 `@modelctx-ai/ctx` 列进 `devDependencies`。ctx-models、ctx-memory 把协议包和 `ai` 都当 peer：返回的 `LanguageModel`、`DecisionModel`、`ExtractionModel` 和应用用的是同一份 AI SDK、同一份协议包。仓库里对协议包的 peer 写成 `workspace:^`，同时列进 `devDependencies` 供测试和构建使用。

## 源码条件

每个包的 `exports` 把自定义条件放在第一位：

```json
{
  ".": {
    "@modelctx-ai/source": "./src/index.ts",
    "types": "./dist/index.d.ts",
    "default": "./dist/index.js"
  }
}
```

| 谁               | 打开条件的方式                                                                        | 解析到                      |
| ---------------- | ------------------------------------------------------------------------------------- | --------------------------- |
| 仓库里的类型检查 | `tsconfig.base.json` 的 `customConditions: ["@modelctx-ai/source"]`                   | `src/*.ts`                  |
| 仓库里的测试     | 根目录 `vite.config.ts` 的 `ssr.resolve.conditions`（Vitest 的 node 环境走 ssr 解析） | `src/*.ts`，Vitest 直接转译 |
| 使用方           | 不打开                                                                                | `dist/`                     |

- 改了核心包，依赖它的包马上能在类型检查和测试里看到，不用先构建。
- 条件名带作用域：使用方的工具链如果打开了通用的 `source` 之类的条件，不会误进我们的源码。
- 发布的包里没有 `src/`（`files: ["dist"]`），条件指向的文件不存在；只要使用方不打开这个条件就没有影响。
- Node 按对象里的顺序选第一个匹配的条件，所以它必须排在 `types`、`default` 前面。

## 版本

- 0.x 语义化版本：minor 可以有不兼容的改动（0.1 → 0.2），patch 修问题、加兼容的功能。所有包都从 0.1.0 开始。
- `workspace:^` 发布时被换成 `^<当前版本>`，例如 `^0.1.0`。0.x 下 `^0.1.0` 只覆盖 0.1.x，所以核心包升 minor 时适配包也要一起发新版本。0.x 期间所有包（现在九个）的版本号一起升。
- 以后用 changesets 管：每个 PR 带一份变更说明，发版时统一改版本号、写 CHANGELOG；所有包放进同一个 `fixed` 组。

## 发布

目标：npmjs 公开包（`publishConfig.access: public`），带 provenance（`publishConfig.provenance: true`），由 GitHub Actions 通过 OIDC trusted publishing 发布，不在仓库里放长期的 npm token。

Trusted publishing 只能给已经存在的包配置，所以第一次要先把包名占住。`@modelctx-ai/via` 就是这样：维护者手动发了一个 `0.0.0-stage`，在 npmjs.com 配好 trusted publisher，之后的正式版本都由 GitHub Actions 发布（npm 上记录的发布者是 GitHub Actions，带 provenance）。ctx 照做：

1. 给每个包名（现在九个）各发一个占位版本 `0.0.0-stage`，用维护者账号或一次性 token；之后第一次正式发布会把 `latest` 移到正式版本。`publishConfig.provenance: true` 在本机发布会失败（provenance 只能在受支持的 CI 里生成），所以占位包用一个临时目录里只有 `name`、`version`、`license`、`repository` 的最小 `package.json` 发。
2. 在 npmjs.com 每个包的设置里加 trusted publisher：GitHub Actions，`modelctx-ai/ctx`，发布工作流的文件名（例如 `release.yml`）。
3. 发布工作流（`.github/workflows/release.yml`，打 `v<版本>` 的 tag 触发）：`permissions: { contents: read, id-token: write }`；npm ≥ 11.5.1（Node 22 自带的是 npm 10，要先升级）；核对 tag 和各包版本、`pnpm install --frozen-lockfile`、`pnpm check`、打包冒烟检查，再 `pnpm -r publish --access public --no-git-checks --tag <latest 或 next>`。
4. 吊销第 1 步用过的 token。

一定用 pnpm 发布：`pnpm publish` 先自己打包（把 `workspace:^` 换成实际版本），再交给 npm CLI 上传，OIDC 换 token 和 provenance 都由 npm 完成。直接在包目录里 `npm publish` 会把 `workspace:^` 原样发出去，使用方装不上。

`pnpm pack` 打出来的包里有 `dist/`、`package.json`、`README.md`，以及从仓库根复制过来的 `LICENSE`；`workspace:^` 已经换成 `^0.1.0`。

## 使用方式

| 方式         | 什么时候用                      | 怎么做                                                                                                                                     | 读到的是                                              |
| ------------ | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| 仓库内       | 开发 ctx 本身                   | workspace + 源码条件                                                                                                                       | `src/*.ts`                                            |
| 同级目录链接 | 发布前；或者 ctx 和使用方一起改 | ctx 克隆在使用方旁边，在 ctx 里 `pnpm install && pnpm build`；使用方 `pnpm-workspace.yaml` 的 `overrides` 写 `link:../ctx/packages/<名字>` | ctx 的 `dist/`，依赖从 ctx 自己的 `node_modules` 解析 |
| npm          | 发布后                          | 删掉 `overrides`，`^0.1.0` 从 npm 解析                                                                                                     | npm 包里的 `dist/`                                    |

使用方的 `package.json` 在链接和 npm 两种方式下写同样的版本范围，切换时只动 `overrides`。

## 实施状态

已经有的（2026-11-15）：

- 十个包的 `publishConfig`（`access: public`、`provenance: true`）、`files: ["dist"]`、`workspace:^`。
- `scripts/release.mjs`：`version <版本>` 把十个包改成同一个版本，正式版本顺带把 `CHANGELOG.md` 的「未发布」落成 `## <版本> - <日期>`；`check <tag>` 核对 tag 和各包版本、正式版本在 `CHANGELOG.md` 里有一节，给出 dist-tag。
- `scripts/pack-smoke.mjs`（`pnpm smoke`）：每个包 `pnpm pack`，查包里的内容（有 `dist/`、`README.md`、`LICENSE`，没有 `src/` 和测试，没有残留的 `workspace:`，`exports` 指的文件都在），在干净目录里用 npm 一次装上十个 tarball，不打开源码条件用 `tsc`（`skipLibCheck: false`）把每个入口的类型解析一遍，再把每个入口 `import` 一遍、内存存储和 SQLite 存储各写读一次。
- CI 的 `Pack smoke` 任务：上面的检查每个 PR 都跑；`import` 那一步另在 Node 22.0.0、22.13.0 上跑，按各包自己的 `engines.node` 决定跑哪些，`engines` 写低了这里会失败。
- `.github/workflows/release.yml`：tag `v<版本>` 触发，`check`、`pnpm check`、冒烟检查都过了才 `pnpm -r publish`。正式版本的 tag 必须在 `main` 上，发到 `latest`；带 `-` 的预发布版本（`v0.4.0-next.0`）发到 `next`，给下游先试。

还没做、只能由 npm 组织的维护者做的：「发布」里的第 1、2、4 步（占位版本、每个包配 trusted publisher 指向 `release.yml`、吊销 token）。发布工作流没有对真实的 npm 验证过；第一次建议先打一个预发布 tag 走一遍。

发一版的步骤：

1. `pnpm release:version 0.4.0`（预发布写 `0.4.0-next.0`），看一眼 `CHANGELOG.md`，提交 `chore: 发布 0.4.0`，合进 `main`。
2. 在那个提交上打 tag `v0.4.0` 并推上去。
3. 工作流发完以后，yoyo 这类下游把 `overrides` 里的 `link:` 去掉。

`engines.node` 核对过（2026-11-15）：各包 `dist/` 用到的最新的运行时 API 是 `Promise.withResolvers`（Node 22.0）和不用开关的 `node:sqlite`（22.13），依赖 `ai@7`、`@ai-sdk/mcp` 自己要求 `>=22`。所以九个包保持 `>=22.0.0`，`ctx-sqlite` 保持 `>=22.13.0`；根目录的 `>=22.18.0` 是开发要求（直接运行 `.ts`、Vitest 5），不随包发布。

## 决定记录

- 2026-11-15：占位版本要给九个包名发；当初写「5 个」是 0.1 的包数。
- 2026-11-15：暂不引入 changesets。`CHANGELOG.md` 继续手写（「未发布」一节），发版时由 `scripts/release.mjs version` 统一改版本号和落版本标题。九个包、版本一起升、一个人维护，changesets 的每 PR 一份变更说明换不来什么；包多到要分组、或者有了外部贡献者再议。
- 2026-11-15：加预发布通道。带 `-` 的版本发到 npm 的 `next`，不动 `latest`，tag 不要求在 `main` 上。
- 2026-11-16：加第十个包 `@modelctx-ai/ctx-otel`（[#46](https://github.com/modelctx-ai/ctx/issues/46)）：OpenTelemetry 的适配带进 `@opentelemetry/api`，按「带额外依赖的各成一个适配包」单独成包，不进核心包。它只依赖协议包，`@opentelemetry/api` 是 peer：应用里只有一份 OpenTelemetry API，全局的 tracer provider 才对得上。正文里「现在九个」按十个读；占位版本也要给它发。
- 2026-11-17：加第十一个包 `@modelctx-ai/ctx-claude-code`（[#23](https://github.com/modelctx-ai/ctx/issues/23)）：要起子进程和本机 HTTP，按「只能在 Node 上跑的各成一个适配包」单独成包。它把 `ctx-mcp` 当 peer，是「实现包之间不互相依赖」的第一个例外：MCP 服务器那一半（`createMcpServer`）只在 `ctx-mcp` 里有一份，理由见 [ADR 0010](0010-external-harness-adapters.md)。正文里的「十个」按十一个读；占位版本也要给它发。
