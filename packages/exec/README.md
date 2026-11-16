# @modelctx-ai/ctx-exec

本机子进程执行环境（协议的 `Executor`）：在一个工作目录里跑命令行，读写这个目录里的文件。环境变量白名单、超时、输出截断、可选的命令审批和文件访问审批。只依赖 `@modelctx-ai/ctx-protocol`。

## 安装

```sh
pnpm add @modelctx-ai/ctx-exec @modelctx-ai/ctx-protocol
```

Node ≥22，POSIX 系统（缺省的 shell 是 `/bin/sh`；Windows 上要自己给 `shell`）。下面的例子另外用到核心包 `@modelctx-ai/ctx`。

## 用法

```ts
import { createContextBuilder, createHarness, createMemoryStore, createToolRegistry } from '@modelctx-ai/ctx';
import { createProcessExecutor } from '@modelctx-ai/ctx-exec';
import { createModel } from '@modelctx-ai/ctx-models';

const sandbox = createProcessExecutor({
  name: 'sandbox',
  cwd: '/srv/agent-workdir',
  env: { NODE_ENV: 'development' }, // 叠在 PATH、HOME、LANG、TMPDIR 这些基础变量上
  timeoutMs: 60_000,
  allow: (command) => !/\brm\s+-rf\b/.test(command), // 返回 false 时不跑，模型看到一条错误；只管命令
  allowFile: ({ path, mode }) => mode === 'read' || !path.startsWith('.git'), // 文件工具另有一道
});

// 工具定义由执行环境自己报，绑定到它的名字
const tools = createToolRegistry();
for (const definition of await sandbox.tools()) tools.add(definition);

const store = createMemoryStore();
const harness = createHarness({
  store,
  context: createContextBuilder({ store }),
  tools,
  executors: [sandbox],
  models: (name) =>
    createModel({ baseUrl: 'https://api.deepseek.com/v1', apiKey: process.env.DEEPSEEK_API_KEY, model: name }),
});
await harness.run({ session: 'dev', agent: { model: 'deepseek-chat' }, input: '跑一下测试，告诉我哪里挂了' });
```

把固定的命令包成专门的工具（少而专的工具比一个万能的 shell 更好用、更好审）。返回数组时不经 shell 直接执行，不用转义：

```ts
const git = createProcessExecutor({
  name: 'git',
  cwd: repo,
  runCommand: false, // 不给万能的 shell，只留下面这个固定命令
  files: false,
  commands: {
    git_log: {
      description: 'Show the last N commits of the repository, one line each.',
      inputSchema: { type: 'object', properties: { count: { type: 'number' } } },
      command: (input) => ['git', 'log', '--oneline', `-n${Number((input as { count?: number }).count ?? 10)}`],
    },
  },
});
```

## 工具

| 工具          | 输入                            | 说明                                                                                                             |
| ------------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `run_command` | `{ command, cwd?, timeoutMs? }` | 用 shell 跑一条命令；`cwd` 是工作目录里的相对路径；`timeoutMs` 不超过 `maxTimeoutMs`；`runCommand: false` 时没有 |
| `read_file`   | `{ path }`                      | 读文本文件，只读开头的 `maxOutputBytes` 字节，超过的截断并注明；只读普通文件，目录、FIFO、设备都拒绝             |
| `write_file`  | `{ path, content, append? }`    | 写文本文件，自动建父目录；只写普通文件                                                                           |
| `list_dir`    | `{ path? }`                     | 列目录，一行一个，目录以 `/` 结尾，最多 1000 项                                                                  |
| `commands` 里 | 自定                            | 固定命令工具                                                                                                     |

工具说明按「写给 agent 的工具」写：在哪跑、输出怎么截断、超时多少、出错长什么样都写在 `description` 里，模型照着用。

### 结果

成功（包括非零退出码）是一段文字，`{ type: 'text' }`：

```
<exit_code>1</exit_code>
<stdout>
…
</stdout>
<stderr>
npm ERR! Missing script: "tset"
[… truncated 2048 more bytes; pipe through head, tail or grep, or redirect to a file and read it in parts]
</stderr>
```

选文字而不是 `{ exitCode, stdout, stderr }` 的 JSON：命令输出本来就是多行文字，放进 JSON 以后换行全变成 `\n`，模型读起来费劲、token 也多；标签把三段分清楚，空的一段不出现，都空时是 `(no output)`。被信号杀掉时没有 `<exit_code>`，是 `<signal>SIGKILL</signal>`。

shell 自己退出就返回，不等它留下的后台进程：`sleep 20 & echo started` 马上返回 `started`，后台进程接着跑，不会被当成超时杀掉。后台进程要是还占着 stdout、stderr，shell 退出 100 毫秒后管道就关了，之后的输出收不到（它再往里写会收到 `SIGPIPE`），所以后台任务的输出要重定向到文件。

非零退出码**不是**错误：模型要看到 stdout 和 stderr 才知道下一步。下面这些才是 `{ type: 'error' }`，信息写清楚原因和下一步：

| 情况                                   | 信息（节选）                                                                                          | `data`                         |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------ |
| `allow` 返回 `false`                   | `Command not allowed by this executor's policy: … It did not run; …`                                  | —                              |
| `allowFile` 返回 `false`               | `File access not allowed by this executor's policy: write_file a.txt. It did not run; …`              | —                              |
| `runCommand: false` 时调 `run_command` | `run_command is turned off on executor "…": … Available tools: …`                                     | —                              |
| 起不来（shell 不存在…）                | `Could not start "/bin/zsh" in .: … Check that the program exists on PATH …`                          | —                              |
| 超时                                   | `Command timed out after 30000 ms and was killed: … pass a larger timeoutMs …`                        | `{ stdout, stderr }`（已有的） |
| `signal` 中止                          | `Command was cancelled and killed: …`                                                                 | `{ stdout, stderr }`           |
| 路径越界                               | `Path "../x" is outside the working directory /srv/… Use a path relative to it…`                      | —                              |
| 符号链接解析不了（悬空、成环）         | `Path "x" goes through a symbolic link that cannot be resolved (…), so it may lead outside …`         | —                              |
| 检查之后路径被换掉                     | `Path "x" changed while it was being opened and may now point outside … The operation was refused; …` | —                              |
| 文件不存在                             | `File not found: a.txt (in /srv/…). Use list_dir to see what is there.`                               | —                              |
| 不是普通文件（FIFO、设备…）            | `pipe is a FIFO (named pipe), not a regular file; read_file only reads regular files.`                | —                              |
| `read_file` 时 `signal` 中止           | `read_file was cancelled before it finished: a.txt.`                                                  | —                              |

## 选项

| 选项             | 缺省                | 说明                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`           | `process`           | 执行环境的名字，工具定义的 `executor` 填它                                                                                                                                                                                                                                                                                                                                              |
| `cwd`            | `process.cwd()`     | 工作目录；命令在这里跑，文件工具只能碰它里面的路径（`..`、指出去的符号链接、解析不了的符号链接都拒绝；指向里面的符号链接可以）                                                                                                                                                                                                                                                          |
| `sessionCwd`     | `false`             | 每个会话一个工作目录：`cwd` 下按会话名的哈希建一个子目录，这个会话的命令和文件工具只在里面，碰不到别的会话的。`open(session)` 或第一次调用时建，`close(session)` 时连同内容删掉。给了它才有 `open`、`close`；`open` 收到做不到的 `EnvironmentSpec`（`image`、`packages`、`network.allow`，或者 `env` 里要的变量这里没配）时抛 `invalid_request`                                         |
| `env`            | —                   | 额外的环境变量。子进程**不继承**整份 `process.env`，只带 `INHERITED_ENV` 里的几个（`PATH`、`HOME`、`LANG`、`LC_*`、`TMPDIR`、`TZ`、`USER`、`SHELL`、`TERM`…）。给了的变量**模型生成的代码读得到**（`echo $KEY`）：凭证不要放这里，需要凭证的工具放在 harness 这一侧执行（见 [ADR 0009](https://github.com/modelctx-ai/ctx/blob/main/docs/adr/0009-hosted-prerequisites.md)）            |
| `shell`          | `['/bin/sh', '-c']` | 跑命令的 shell 和参数，命令接在最后                                                                                                                                                                                                                                                                                                                                                     |
| `timeoutMs`      | 30 000              | 一条命令最多跑多久，到点连同它起的子进程（整个进程组）一起 `SIGKILL`                                                                                                                                                                                                                                                                                                                    |
| `maxTimeoutMs`   | 600 000             | 调用时 `timeoutMs` 输入的上限                                                                                                                                                                                                                                                                                                                                                           |
| `maxOutputBytes` | 65 536              | stdout、stderr、`read_file` 各自最多给多少字节；超出的截掉，末尾注明截掉多少                                                                                                                                                                                                                                                                                                            |
| `allow`          | 都放行              | `(command) => boolean \| Promise<boolean>`，跑命令前问一次；固定命令工具也问（参数用空格连起来）。**只管 `run_command` 和固定命令工具**，管不到文件工具：`allow: () => false` 时 `write_file` 照样能写，要管用 `allowFile`，要关用 `files: false`                                                                                                                                       |
| `runCommand`     | `true`              | 是否提供 `run_command`。`false` 时 `tools()` 不列它，调它返回错误；文件工具和固定命令工具照旧。`run_command` 这个名字始终留给内置工具                                                                                                                                                                                                                                                   |
| `files`          | `true`              | 是否提供 `read_file`、`write_file`、`list_dir`                                                                                                                                                                                                                                                                                                                                          |
| `allowFile`      | 都放行              | `(access: FileAccess) => boolean \| Promise<boolean>`，文件工具动手前问一次，返回 `false` 时不读不写。`access` 是 `{ tool, path, mode }`：`tool` 是 `read_file` / `write_file` / `list_dir`，`mode` 是 `read`（读、列）或 `write`，`path` 相对工作目录、已经解析过（没有 `..`，符号链接换成了真实位置，工作目录本身是 `.`）。越界的路径在这之前就拒绝了，不会来问；`run_command` 不问它 |
| `commands`       | —                   | `{ 名字: { command, description?, inputSchema?, timeoutMs?, tags? } }`；`command(input)` 返回字符串经 shell 跑，返回数组直接执行                                                                                                                                                                                                                                                        |

工具定义的 `source` 是 `process`，`tags` 是 `exec`、`fs`、`read`、`write`，可以用 `AgentSpec.tools` 按标签挑。`dispose()` 之后不再执行。

## 安全

**这不是沙箱。** 命令以当前用户的权限在这台机器上运行，能读写这个用户能读写的一切；`cwd` 只限制文件工具和 `run_command` 的起始目录，限制不了命令本身（`cat /etc/passwd` 照样能跑）。环境变量白名单只是不把这个进程的密钥顺手交出去。

- 给不信任的模型或输入用时，把它放进容器、虚拟机或专门的用户下面，再经 [`@modelctx-ai/ctx-remote`](../remote/README.md) 的服务端接进来：harness 在外面，执行环境在隔离的那一侧，中间只有协议。
- `allow` 是审批钩子，不是安全边界：字符串匹配挡不住有心绕过的命令。要逐条确认，用 harness 的 `beforeTool` 钩子问人。
- `allow` 和 `allowFile` 各管各的：只给 `allow` 时文件工具不受限，只给 `allowFile` 时 `run_command` 不受限（一句 `cat`、`echo >` 就绕过去了）。要让文件访问策略真的管用，同时 `runCommand: false`，只留审过的固定命令工具。
- 文件工具的目录限制防的是模型给错路径和工作目录里现成的符号链接，做法是：先把路径解析成真实路径、确认在工作目录里（悬空或成环的符号链接直接拒绝，不当成「还不存在的文件」）；再用 `O_NOFOLLOW` 打开，最后一段在检查之后被换成符号链接也不会跟过去；拿到文件描述符后复核父目录仍在工作目录里（Linux 上另外经 `/proc/self/fd` 核对描述符实际指向的路径），读写都经这个描述符，`write_file` 复核过了才清空、写入。
- 它的限度：别的进程（包括 `run_command` 起的）在检查的同时不停地把**中间目录**换成指出去的符号链接时，只能尽力而为。Linux 上（`/proc` 可用时）读不到、也改不了外面已有文件的内容，但 `write_file` 仍可能在外面留下空文件或新建的父目录，`list_dir` 的复核和读目录之间也还有一个很小的窗口；macOS 等没有 `/proc` 的系统上，父目录的复核和打开之间同样有窗口；Windows 没有 `O_NOFOLLOW`，只有打开前后的两次路径检查。硬链接不在检查范围内。要真正的隔离，还是上面说的容器或专门的用户。
- 超时和取消会杀掉整个进程组；用 `setsid` 之类自己脱离进程组的孙进程杀不到，杀掉后最多再等 2 秒就返回。

## 导出

| 导出                                                                     | 说明                                                                                                           |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `createProcessExecutor(options)`                                         | 返回 `ProcessExecutor`：`Executor` 加 `cwd`、`sessionCwd(session)`（这个会话的工作目录，不按会话时就是 `cwd`） |
| `INHERITED_ENV`                                                          | 子进程从 `process.env` 继承的变量名                                                                            |
| `ProcessExecutorOptions`、`ProcessExecutor`、`CommandTool`、`FileAccess` | 类型（`FileAccess` 是 `allowFile` 收到的 `{ tool, path, mode }`）                                              |

通过协议包的契约测试 `describeExecutorContract`（回显工具是一个固定命令工具 `echo`）。
