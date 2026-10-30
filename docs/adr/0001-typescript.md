---
type: Decision Record
title: 'ADR 0001：用 TypeScript 写 ctx 和 yoyo'
description: '为什么 ctx 和 yoyo 用 TypeScript；工具链和编译选项'
tags: [adr, toolchain]
status: stable
---

# ADR 0001：用 TypeScript 写 ctx 和 yoyo

- 状态：已采纳
- 日期：2026-10-23
- 范围：ctx、yoyo

## 背景

ctx 是给 LLM 应用用的上下文管理库；yoyo 是用它的桌宠导演，通过 HTTP 驱动 dsh-pet。yoyo 原来是 `src/*.js` 平铺的约 3100 行 JavaScript，没有类型。两边要做的事：

- 调多家模型：工具调用、多步循环、流式输出；
- 接 MCP 服务器（stdio、HTTP）；
- 本机 HTTP 服务（网关）和客户端（dsh-pet 接口）；
- SQLite 存储；
- 起子进程（whisper.cpp、ffmpeg、播放器）。

都是 I/O，性能不是区分点。

## 候选

| 方面            | TypeScript（Node）                                                                                        | Python                                                                | Go / Rust                                                     |
| --------------- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------- |
| 模型调用        | Vercel AI SDK 以 TypeScript 为主：统一的 `LanguageModel`、工具、多步、流式；`ModelMessage` 可以原样存下来 | 生态最全（各家官方 SDK、LiteLLM、LangChain），但和 dsh-pet 是两套类型 | 官方 SDK 少，没有 AI SDK 这样的统一抽象，要自己写             |
| MCP             | 参考实现 `@modelcontextprotocol/sdk` 是 TypeScript；`@ai-sdk/mcp` 直接产出 AI SDK 的工具                  | 有官方 SDK                                                            | 有 SDK，起步晚                                                |
| 和 dsh-pet 对接 | 同一种语言；`openapi.yaml` 直接写成 TypeScript 类型，对照它的源码确认行为不用跨语言                       | 另写一套模型                                                          | 另写一套结构体                                                |
| 运行和分发      | Node ≥22.18 直接运行 `.ts`，应用不用构建；库构建成 JS + `.d.ts` 发 npm                                    | 虚拟环境；常驻桌面进程打包麻烦                                        | 单个二进制最省事，但每次改都要编译，JSON 和 HTTP 的胶水代码多 |
| 本机能力        | `node:sqlite`、`fetch`、`node:http`、`child_process`、`node:test` 都内置                                  | `sqlite3` 内置                                                        | SQLite 要 cgo 或绑定库                                        |

## 决定

ctx 和 yoyo 都用 TypeScript，运行在 Node 上。

## 理由

1. dsh-pet 是 TypeScript（宿主、Electron、React）。yoyo 的 `@yoyo/dsh-pet` 按它的 `openapi.yaml` 写类型；要确认某个接口的真实行为，直接读它的源码。
2. AI SDK 和 MCP 的参考 SDK 都以 TypeScript 为主。ctx 直接建在 AI SDK 上：服务商、工具循环、流式都用现成的，ctx 只管上下文这一层。
3. Node 22.18 起默认去掉类型注解直接运行 `.ts`。yoyo 不构建、不打包，`node src/main.ts` 跑的就是源码。只有要发 npm 的 ctx 构建 `dist/`。
4. 三个仓库一套类型系统。yoyo 类型检查时用的就是 ctx 发布的 `.d.ts`，ctx 改了接口，yoyo 在编译期就报错。
5. 需要的本机能力 Node 都内置，ctx 和 yoyo 没有原生依赖。

## 代价

- 类型只在编译期有效。配置文件、HTTP 响应、数据库里读出来的行要在运行时校验（yoyo 的配置用 zod）。
- 直接运行 `.ts` 只支持能擦掉的语法：不能用 `enum`、`namespace`、构造函数参数属性、`import x = require()`。
- 绑定 Node：开发要 Node ≥22.18；使用时 ctx-sqlite 要 Node ≥22.13（`node:sqlite`），其余包要 Node ≥22（AI SDK 7 的要求）。核心包的主入口不用 `node:` 模块，给别的运行时留着余地。
- `node:sqlite` 在 Node 22 上仍是实验特性，会打印 ExperimentalWarning。存储藏在 `ContextStore` 接口后面，可以换。
- TypeScript 7 的原生编译器还没有稳定的编译器 API，Vite+（内含 tsdown、tsgolint）也较新，升级时要一起验证。库开着 `isolatedDeclarations`，声明文件不依赖编译器 API 生成（见下）。
- yoyo 要求本机装了 Node。它是个人工具，dsh-pet 的独立模式本来也跑在 Node 上。

## 工具链

工具链统一用 [Vite+](https://viteplus.dev/)（npm 包 `vite-plus`，命令 `vp`）。它把下面几样打包成一个开发依赖，配置写在 `vite.config.ts`：根目录放 test、lint、fmt，各包放自己的 `pack`。

| 工具                                      | 用途                                                                                                                                                                     |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| TypeScript 7                              | 只做类型检查（`noEmit`）。由 `vp check` 经 tsgolint（TS 7 原生编译器）完成，读各文件所属的 tsconfig；`pnpm typecheck` 一次检查全部包的源码、测试和配置。`tsc` 仍可单独跑 |
| `vp pack`（tsdown）                       | 构建库：ESM + `.d.ts`，每个包的 `vite.config.ts` 里一个 `pack` 块。开了 `isolatedDeclarations` 时用 Oxc 逐文件生成 `.d.ts`                                               |
| `vp test`（Vitest）、`node:assert/strict` | 测试直接跑 `.ts` 源码；测试 API 从 `vite-plus/test` 引，断言仍用 `node:assert/strict`                                                                                    |
| `vp lint`（Oxlint）                       | correctness 报错、suspicious 警告，开着带类型信息的规则；CI 里警告也算失败                                                                                               |
| `vp fmt`（Oxfmt）                         | 与 prettier 兼容的格式化：单引号、行宽 120、尾逗号                                                                                                                       |
| pnpm                                      | workspace、锁文件、`workspace:` 协议，发布时改写版本范围；版本由 `packageManager` 固定                                                                                   |

Vite+ 里面向 Web 应用的部分（`vp dev`、`vp build`、`vp preview`）这里用不上：ctx 只有库，没有页面。

## 编译选项

`tsconfig.base.json`：

| 选项                                                                                       | 作用                                                                                 |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| `strict`                                                                                   | 基线                                                                                 |
| `erasableSyntaxOnly`                                                                       | 只允许 Node 能直接擦掉的语法                                                         |
| `verbatimModuleSyntax`                                                                     | 纯类型导入必须写 `import type`，擦掉以后不留下多余的导入                             |
| `isolatedDeclarations`                                                                     | 库才开：导出的 API 写明类型，`.d.ts` 不需要类型推断就能逐文件生成。yoyo 是应用，不开 |
| `noUncheckedIndexedAccess`                                                                 | 下标访问得到 `T \| undefined`                                                        |
| `allowImportingTsExtensions`、`rewriteRelativeImportExtensions`                            | 相对导入写 `.ts`（Node 直接运行需要），构建时改成 `.js`                              |
| `customConditions: ["@modelctx-ai/source"]`                                                | 仓库里按源码解析各包，见 [ADR 0002](0002-packages.md)                                |
| `module`、`moduleResolution: nodenext`，`target: es2024`                                   | 按 Node 的 ESM 规则解析                                                              |
| `noUnusedLocals`、`noUnusedParameters`、`noImplicitOverride`、`noFallthroughCasesInSwitch` | 基本卫生                                                                             |
