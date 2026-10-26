# @modelctx-ai/ctx-exec

本机子进程执行环境（协议的 `Executor`）：在一个工作目录里跑命令行，读写这个目录里的文件。环境变量白名单、超时、输出截断、可选的命令审批。只依赖 `@modelctx-ai/ctx-protocol`。

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
  allow: (command) => !/\brm\s+-rf\b/.test(command), // 返回 false 时不跑，模型看到一条错误
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

| 工具          | 输入                            | 说明                                                                                 |
| ------------- | ------------------------------- | ------------------------------------------------------------------------------------ |
| `run_command` | `{ command, cwd?, timeoutMs? }` | 用 shell 跑一条命令；`cwd` 是工作目录里的相对路径；`timeoutMs` 不超过 `maxTimeoutMs` |
| `read_file`   | `{ path }`                      | 读文本文件，超过 `maxOutputBytes` 截断并注明                                         |
| `write_file`  | `{ path, content, append? }`    | 写文本文件，自动建父目录                                                             |
| `list_dir`    | `{ path? }`                     | 列目录，一行一个，目录以 `/` 结尾，最多 1000 项                                      |
| `commands` 里 | 自定                            | 固定命令工具                                                                         |

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

非零退出码**不是**错误：模型要看到 stdout 和 stderr 才知道下一步。下面这些才是 `{ type: 'error' }`，信息写清楚原因和下一步：

| 情况                    | 信息（节选）                                                                     | `data`                         |
| ----------------------- | -------------------------------------------------------------------------------- | ------------------------------ |
| `allow` 返回 `false`    | `Command not allowed by this executor's policy: … It did not run; …`             | —                              |
| 起不来（shell 不存在…） | `Could not start "/bin/zsh" in .: … Check that the program exists on PATH …`     | —                              |
| 超时                    | `Command timed out after 30000 ms and was killed: … pass a larger timeoutMs …`   | `{ stdout, stderr }`（已有的） |
| `signal` 中止           | `Command was cancelled and killed: …`                                            | `{ stdout, stderr }`           |
| 路径越界                | `Path "../x" is outside the working directory /srv/… Use a path relative to it…` | —                              |
| 文件不存在              | `File not found: a.txt (in /srv/…). Use list_dir to see what is there.`          | —                              |

## 选项

| 选项             | 缺省                | 说明                                                                                                                                                          |
| ---------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`           | `process`           | 执行环境的名字，工具定义的 `executor` 填它                                                                                                                    |
| `cwd`            | `process.cwd()`     | 工作目录；命令在这里跑，文件工具只能碰它里面的路径（`..` 和指出去的符号链接都拒绝）                                                                           |
| `env`            | —                   | 额外的环境变量。子进程**不继承**整份 `process.env`，只带 `INHERITED_ENV` 里的几个（`PATH`、`HOME`、`LANG`、`LC_*`、`TMPDIR`、`TZ`、`USER`、`SHELL`、`TERM`…） |
| `shell`          | `['/bin/sh', '-c']` | 跑命令的 shell 和参数，命令接在最后                                                                                                                           |
| `timeoutMs`      | 30 000              | 一条命令最多跑多久，到点连同它起的子进程（整个进程组）一起 `SIGKILL`                                                                                          |
| `maxTimeoutMs`   | 600 000             | 调用时 `timeoutMs` 输入的上限                                                                                                                                 |
| `maxOutputBytes` | 65 536              | stdout、stderr、`read_file` 各自最多给多少字节；超出的截掉，末尾注明截掉多少                                                                                  |
| `allow`          | 都放行              | `(command) => boolean \| Promise<boolean>`，执行前问一次；固定命令工具也问（参数用空格连起来）                                                                |
| `files`          | `true`              | 是否提供 `read_file`、`write_file`、`list_dir`                                                                                                                |
| `commands`       | —                   | `{ 名字: { command, description?, inputSchema?, timeoutMs?, tags? } }`；`command(input)` 返回字符串经 shell 跑，返回数组直接执行                              |

工具定义的 `source` 是 `process`，`tags` 是 `exec`、`fs`、`read`、`write`，可以用 `AgentSpec.tools` 按标签挑。`dispose()` 之后不再执行。

## 安全

**这不是沙箱。** 命令以当前用户的权限在这台机器上运行，能读写这个用户能读写的一切；`cwd` 只限制文件工具和 `run_command` 的起始目录，限制不了命令本身（`cat /etc/passwd` 照样能跑）。环境变量白名单只是不把这个进程的密钥顺手交出去。

- 给不信任的模型或输入用时，把它放进容器、虚拟机或专门的用户下面，再经 [`@modelctx-ai/ctx-remote`](../remote/README.md) 的服务端接进来：harness 在外面，执行环境在隔离的那一侧，中间只有协议。
- `allow` 是审批钩子，不是安全边界：字符串匹配挡不住有心绕过的命令。要逐条确认，用 harness 的 `beforeTool` 钩子问人。
- 超时和取消会杀掉整个进程组；用 `setsid` 之类自己脱离进程组的孙进程杀不到，杀掉后最多再等 2 秒就返回。

## 导出

| 导出                                                       | 说明                                        |
| ---------------------------------------------------------- | ------------------------------------------- |
| `createProcessExecutor(options)`                           | 返回 `ProcessExecutor`：`Executor` 加 `cwd` |
| `INHERITED_ENV`                                            | 子进程从 `process.env` 继承的变量名         |
| `ProcessExecutorOptions`、`ProcessExecutor`、`CommandTool` | 类型                                        |

通过协议包的契约测试 `describeExecutorContract`（回显工具是一个固定命令工具 `echo`）。
