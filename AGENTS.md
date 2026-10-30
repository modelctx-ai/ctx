# AGENTS.md

给在这个仓库里写代码的人和 coding agent 的工作约定。项目介绍见 [README](README.md)；文档入口是 [docs/index.md](docs/index.md)。

## 工具链和命令

开发要 Node ≥22.18（直接运行 `.ts`）和 pnpm 10（版本由 `packageManager` 固定）。工具链是 [Vite+](https://viteplus.dev/)（`vite-plus`，命令 `vp`），配置都在根目录和各包的 `vite.config.ts` 里。

| 命令                                | 作用                                                                                        |
| ----------------------------------- | ------------------------------------------------------------------------------------------- |
| `pnpm install`                      | 安装依赖                                                                                    |
| `pnpm typecheck`                    | `vp check --no-fmt --no-lint`：只做类型检查（tsgolint，TS 7），覆盖全部包的源码、测试和配置 |
| `pnpm lint`                         | `vp lint`：Oxlint，带类型信息的规则，同时报类型错误；有警告也算失败                         |
| `pnpm test`                         | `vp test`：Vitest 运行 `packages/*/src/**/*.test.ts`                                        |
| `pnpm build`                        | 每个包 `vp pack`（tsdown）构建 `dist/`（ESM + `.d.ts`）                                     |
| `pnpm format` / `pnpm format:check` | `vp fmt`：Oxfmt 改写 / 检查                                                                 |
| `pnpm check`                        | `vp check`（格式、lint、类型）、test、build；CI 在 Node 22 和 24 上跑同样几步               |

仓库里各包互相引用时按源码解析（`@modelctx-ai/source` 条件，见 [ADR 0002](docs/adr/0002-packages.md)），类型检查和测试不用先构建。使用方的 Node 版本和 peer dependency 写在各包 README 的「安装」里。

## 文档怎么组织

`docs/` 按 [Open Knowledge Format](https://github.com/GoogleCloudPlatform/open-knowledge-format/blob/main/SPEC.md)（OKF）v0.2 组织，人和 agent 读同一份：

- 除 `index.md`、`log.md` 以外，每篇开头是 YAML frontmatter：`type`（必填，例如 `Specification`、`Architecture`、`Decision Record`）、`title`（和一级标题一致）、`description`（一句话）、`tags`、`status`（`draft` / `stable` / `deprecated`，对应 ADR 的提案 / 已采纳 / 被取代）。
- 每个目录一个 `index.md`，只有分组标题和 `- [title](路径) - description` 条目，`title`、`description` 和被链接文档的 frontmatter 一字不差；根目录的 `index.md` 只带 `okf_version` 这一个 frontmatter 键。加、删文档或改 `title`、`description`，同时改所在目录的 `index.md`。
- 链接用相对路径。OKF 推荐的 `/` 开头写法在 GitHub 上会解析到仓库根，不用。
- `log.md` 按 `## YYYY-MM-DD` 倒序，条目格式见下面「记录」。

## 文档各管什么

- [概念](docs/concepts.md)：定位、组件、术语表。代码里的类型名、事件名、错误类型和术语表一致；新术语先进术语表。
- [协议层](docs/protocol.md)是规范：接口签名、JSON 形状、线上路径都以它为准，和 `packages/protocol` 导出的类型逐项对应。改协议包的公开类型，同一个 PR 改 `protocol.md` 和 `packages/protocol/src/testing` 里的契约测试；两边不一致时要么改代码，要么在同一个 PR 里改规范并说明理由。
- [架构](docs/architecture.md)只写进程内参考实现（`@modelctx-ai/ctx` 和各实现包）怎么做，不重复协议签名；每个组件一节，新组件照这个粒度加。
- [实践：yoyo](docs/repos.md)只写跨仓库的契约：ctx、yoyo、dsh-pet 各管什么、产物、依赖、运行时拓扑、本地联调。yoyo 内部的分层和用法写在 yoyo 仓库，这里链接过去，不另抄一份。
- [ADR](docs/adr/index.md)：改变已有设计决策（不只是补细节）时新增一篇，编号递增，头部是「状态 / 日期 / 范围」三行；被取代的旧 ADR 改状态（frontmatter 的 `status` 改成 `deprecated`）并指向新篇。实施后在 ADR 里补「实施状态」和「决定记录」里的修订，不改写当初的决定正文。规范和架构里只写「是什么」，链接 ADR 说「为什么」。
- `packages/*/README.md`：安装、用法、选项、导出。每个公开导出都要在包 README 里出现；新包要进 [docs/index.md](docs/index.md) 的「包」一节和 [ADR 0002](docs/adr/0002-packages.md) 的包布局。

## 记录

- [CHANGELOG.md](CHANGELOG.md) 记代码变更：按版本倒序，没发布的放「未发布」，条目以「新增 / 实现 / 修复 / 删除 / 发布」开头，写公开 API 的名字、不兼容的地方和迁移方法。改了 `packages/` 里的行为就记一笔。
- [docs/log.md](docs/log.md) 只记文档变更：按日期倒序，条目以「新增 / 更新 / 删除」开头，链接到改的文档，写改了什么、为什么。改了 `docs/` 或任何 README 就记一笔。一个 PR 既改代码又改文档，两处各记。
- 版本和发布按 [ADR 0002](docs/adr/0002-packages.md)：1.0 之前不兼容改动升 minor，所有包同一个版本一起升，包间依赖是 `workspace:^`。不保留弃用别名；不兼容改动在提交标题的类型后加 `!`。

## 改代码时

- 实现一个协议就跑它的 `describeXContract`，新加的协议要在 `packages/protocol/src/testing` 里给契约测试，内存实现和 sqlite、remote 都要过。
- 依赖方向和放置规则（核心包只依赖 `ai`，实现包只依赖协议包，Node 专属模块只进适配包）见[架构](docs/architecture.md#实现约束)，新代码不打破。
- yoyo 经 `link:../ctx/packages/*` 读这里的 `dist/`，它的 CI 检出 ctx `main` 的最新提交。改公开 API 之前先在 `../yoyo` 里 grep 用法：会让 yoyo 编不过的改动，合并前要有对应的 yoyo PR 在等。
- 对真实服务（模型提供商、MCP 服务器）的映射没有在线验证时，在文档里写明「没有对真实服务验证」，不要删掉这句。

## 格式和提交

- `docs/` 和所有 README 归 Oxfmt 管（`pnpm format`），表格会被重排对齐；改完 Markdown 跑一次，CI 的 `vp check` 会查。
- 正文中文，中文标点；标识符、文件名、命令用反引号。
- 提交信息按 Conventional Commits，标题中文，scope 用包目录名（`core`、`protocol`、`sqlite`、`memory`……）或 `docs`、`repos`。
