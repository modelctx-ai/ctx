import { spawn } from 'node:child_process';
import { constants, type Stats } from 'node:fs';
import { lstat, mkdir, open, readdir, readlink, realpath, stat, type FileHandle } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import {
  errorOutput,
  isValidToolName,
  type Awaitable,
  type ExecutionContext,
  type Executor,
  type JsonObject,
  type JsonValue,
  type ToolCall,
  type ToolDefinition,
  type ToolOutput,
} from '@modelctx-ai/ctx-protocol';

/** 一个固定命令的工具：把输入变成命令。返回字符串时交给 shell，返回数组时不经 shell 直接执行（不用转义）。 */
export interface CommandTool {
  readonly description?: string;
  /** 缺省 `{ type: 'object' }`。 */
  readonly inputSchema?: JsonObject;
  readonly command: (input: JsonValue) => string | readonly string[];
  readonly timeoutMs?: number;
  readonly tags?: readonly string[];
}

/** 文件工具的一次访问，交给 `allowFile` 判断。 */
export interface FileAccess {
  readonly tool: 'read_file' | 'write_file' | 'list_dir';
  /**
   * 相对工作目录的路径，已经解析过：没有 `..`，符号链接换成了它指向的真实位置，分隔符是平台的；工作目录本身是 `.`。
   * 越界的路径到不了这里，先被拒绝了。
   */
  readonly path: string;
  /** `read_file`、`list_dir` 是 `read`，`write_file` 是 `write`。 */
  readonly mode: 'read' | 'write';
}

export interface ProcessExecutorOptions {
  /** 执行环境的名字，工具定义的 `executor` 填它。缺省 `process`。 */
  readonly name?: string;
  /** 工作目录，命令在这里跑，文件工具也只能碰它里面的东西。缺省 `process.cwd()`。 */
  readonly cwd?: string;
  /**
   * 额外的环境变量。子进程不继承整份 `process.env`，只带 `PATH`、`HOME`、`LANG`、`TMPDIR` 这类基础变量
   * （见 `INHERITED_ENV`），再叠上这里给的。
   */
  readonly env?: Readonly<Record<string, string>>;
  /** 跑命令的 shell 和它的参数，命令接在最后。缺省 `['/bin/sh', '-c']`。 */
  readonly shell?: readonly [string, ...string[]];
  /** 一条命令最多跑多久，缺省 30 秒。到点连同它起的子进程一起杀掉。 */
  readonly timeoutMs?: number;
  /** 调用时 `timeoutMs` 输入的上限，缺省 10 分钟。 */
  readonly maxTimeoutMs?: number;
  /** stdout、stderr、读文件各自最多给模型多少字节，缺省 64 KiB；超出的截掉并注明截掉了多少。 */
  readonly maxOutputBytes?: number;
  /**
   * 给了就在跑命令前问一次，返回 `false` 时不跑，模型收到一条错误。缺省都放行。
   * 只管 `run_command` 和固定命令工具，管不到文件工具（那边用 `allowFile`）。
   */
  readonly allow?: (command: string) => Awaitable<boolean>;
  /** 是否提供 `run_command`，缺省提供。`false` 时只剩文件工具和 `commands` 里的固定命令工具。 */
  readonly runCommand?: boolean;
  /** 是否提供 `read_file`、`write_file`、`list_dir`，缺省提供。 */
  readonly files?: boolean;
  /** 给了就在文件工具动手前问一次（路径已经确认在工作目录里），返回 `false` 时不读不写，模型收到一条错误。缺省都放行。 */
  readonly allowFile?: (access: FileAccess) => Awaitable<boolean>;
  /** 额外的固定命令工具：名字 → 命令。 */
  readonly commands?: Readonly<Record<string, CommandTool>>;
}

/** 本机子进程执行环境。`tools()` 总是有。 */
export interface ProcessExecutor extends Executor {
  readonly cwd: string;
  tools(): Promise<ToolDefinition[]>;
}

/** 子进程从 `process.env` 继承的变量；其余不带。 */
export const INHERITED_ENV: readonly string[] =
  process.platform === 'win32'
    ? [
        'APPDATA',
        'HOMEDRIVE',
        'HOMEPATH',
        'LOCALAPPDATA',
        'PATH',
        'PATHEXT',
        'PROCESSOR_ARCHITECTURE',
        'SYSTEMDRIVE',
        'SYSTEMROOT',
        'TEMP',
        'TMP',
        'USERNAME',
        'USERPROFILE',
      ]
    : ['HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'LOGNAME', 'PATH', 'SHELL', 'TERM', 'TMPDIR', 'TZ', 'USER'];

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_TIMEOUT_MS = 600_000;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_LIST_ENTRIES = 1_000;
/** 杀掉以后最多再等这么久让管道关上：逃出进程组的孙进程不该把调用挂住。 */
const KILL_GRACE_MS = 2_000;
/** 进程自己退出以后最多再等这么久让管道关上：它留下的后台进程还占着 stdout、stderr 时不等它们。 */
const EXIT_GRACE_MS = 100;
/** `read_file` 一次读多少字节；两次之间看一眼 `signal`。 */
const READ_CHUNK_BYTES = 64 * 1024;

// Windows 上没有这两个标志，按 0 处理。
/** 最后一段是符号链接时打开失败，不跟过去。 */
const O_NOFOLLOW = (constants.O_NOFOLLOW as number | undefined) ?? 0;
/** 打开 FIFO 不等另一头；对普通文件没有影响。 */
const O_NONBLOCK = (constants.O_NONBLOCK as number | undefined) ?? 0;

const RUN_COMMAND = 'run_command';
const READ_FILE = 'read_file';
const WRITE_FILE = 'write_file';
const LIST_DIR = 'list_dir';

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isObject(value: JsonValue): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function baseEnv(extra: Readonly<Record<string, string>> | undefined): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of INHERITED_ENV) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return { ...env, ...extra };
}

// ---- 输出 ----

/** 只留前 `limit` 字节，记下截掉多少。 */
interface Capture {
  readonly chunks: Buffer[];
  kept: number;
  dropped: number;
}

function capture(): Capture {
  return { chunks: [], kept: 0, dropped: 0 };
}

function take(target: Capture, chunk: Buffer, limit: number): void {
  const room = limit - target.kept;
  if (room > 0) {
    const piece = chunk.length > room ? chunk.subarray(0, room) : chunk;
    target.chunks.push(piece);
    target.kept += piece.length;
  }
  target.dropped += Math.max(0, chunk.length - Math.max(room, 0));
}

function truncatedNote(dropped: number, hint: string): string {
  return `[… truncated ${dropped} more bytes; ${hint}]`;
}

const COMMAND_HINT = 'pipe through head, tail or grep, or redirect to a file and read it in parts';

function textOf(target: Capture): string {
  // 截断可能落在多字节字符中间，解码时那几个字节变成替换字符，不报错。
  const text = new TextDecoder().decode(Buffer.concat(target.chunks));
  return target.dropped > 0 ? `${text}\n${truncatedNote(target.dropped, COMMAND_HINT)}` : text;
}

function section(tag: string, text: string): string {
  return `<${tag}>\n${text.endsWith('\n') ? text : `${text}\n`}</${tag}>`;
}

// ---- 子进程 ----

interface Launch {
  readonly file: string;
  readonly args: readonly string[];
  /** 给人和 `allow` 看的命令行。 */
  readonly display: string;
}

type Outcome =
  | { readonly type: 'exited'; readonly code: number | null; readonly signal: string | null }
  | { readonly type: 'timeout' }
  | { readonly type: 'aborted' }
  | { readonly type: 'failed'; readonly error: unknown };

interface Finished {
  readonly outcome: Outcome;
  readonly stdout: Capture;
  readonly stderr: Capture;
}

interface SpawnOptions {
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly signal: AbortSignal | undefined;
}

function launch(command: Launch, options: SpawnOptions): Promise<Finished> {
  const stdout = capture();
  const stderr = capture();
  return new Promise((done) => {
    let settled = false;
    let reason: 'timeout' | 'aborted' | undefined;
    let exited = false;
    let grace: ReturnType<typeof setTimeout> | undefined;
    const posix = process.platform !== 'win32';
    const child = spawn(command.file, [...command.args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      // 自成一个进程组，超时或取消时连同它起的子进程一起杀。
      detached: posix,
      windowsHide: true,
    });

    const finish = (outcome: Outcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      options.signal?.removeEventListener('abort', onAbort);
      done({ outcome, stdout, stderr });
    };
    const kill = (why: 'timeout' | 'aborted'): void => {
      if (reason || settled || exited) return;
      reason = why;
      try {
        if (posix && child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
      grace = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        finish({ type: why });
      }, KILL_GRACE_MS);
    };
    const onAbort = (): void => kill('aborted');
    const timer = setTimeout(() => kill('timeout'), options.timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => take(stdout, chunk, options.maxOutputBytes));
    child.stderr.on('data', (chunk: Buffer) => take(stderr, chunk, options.maxOutputBytes));
    child.on('error', (error) => finish({ type: 'failed', error }));
    // 管道要等所有拿着它的进程都关了才 `close`：`sleep 20 & echo started` 的 shell 早退出了，后台的 sleep 还占着。
    // 进程自己退出就不再算超时、不再杀进程组；给管道一个短宽限收尾，到点按正常退出返回已有的输出。
    child.on('exit', (exitCode, signal) => {
      if (reason || settled) return;
      exited = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      grace = setTimeout(() => {
        // 再让出一轮事件循环，把已经到了的输出读完。
        setImmediate(() => {
          child.stdout.destroy();
          child.stderr.destroy();
          finish({ type: 'exited', code: exitCode, signal });
        });
      }, EXIT_GRACE_MS);
    });
    child.on('close', (exitCode, signal) =>
      finish(reason ? { type: reason } : { type: 'exited', code: exitCode, signal }),
    );
    options.signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** 正常退出（不管退出码）的结果：模型要看到 stdout、stderr 才能接着做。 */
function exitedOutput(exitCode: number | null, signal: string | null, stdout: Capture, stderr: Capture): ToolOutput {
  const parts = [exitCode !== null ? `<exit_code>${exitCode}</exit_code>` : `<signal>${signal ?? 'unknown'}</signal>`];
  const out = textOf(stdout);
  const err = textOf(stderr);
  if (out) parts.push(section('stdout', out));
  if (err) parts.push(section('stderr', err));
  if (!out && !err) parts.push('(no output)');
  return { type: 'text', text: parts.join('\n') };
}

function partial(stdout: Capture, stderr: Capture): JsonObject {
  return { stdout: textOf(stdout), stderr: textOf(stderr) };
}

// ---- 路径 ----

function seconds(ms: number): string {
  return `${Math.round(ms / 100) / 10} s`;
}

function inside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

interface Resolved {
  /** 工作目录的真实路径。 */
  readonly realRoot: string;
  /** 照输入拼出来的路径，给人看。 */
  readonly path: string;
  /** 已存在的部分解析掉符号链接以后的路径，实际操作用它。 */
  readonly real: string;
}

async function isSymlink(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isSymbolicLink();
  } catch {
    return false;
  }
}

function outsideError(input: string, realRoot: string): ToolOutput {
  return errorOutput(
    `Path "${input}" is outside the working directory ${realRoot}. Use a path relative to it, without "..".`,
  );
}

/** 检查过以后路径又变了（符号链接被换掉）。 */
function movedError(input: string, realRoot: string): ToolOutput {
  return errorOutput(
    `Path "${input}" changed while it was being opened and may now point outside the working directory ${realRoot}. ` +
      `The operation was refused; check the path with list_dir and try again.`,
  );
}

/**
 * 解析到工作目录里；`..` 逃出、符号链接指出去、符号链接解析不了（悬空、成环）都拒绝，返回给模型看的错误。
 * 指向工作目录里面的符号链接可以，`real` 是它指向的位置。
 */
async function resolveInside(root: string, input: string): Promise<Resolved | { error: ToolOutput }> {
  const realRoot = await realpath(root).catch(() => root);
  const target = resolve(realRoot, input);
  if (!inside(realRoot, target)) return { error: outsideError(input, realRoot) };
  // 从路径本身往上找最深的、解析得出来的一段：它要在里面，剩下的（还不存在的）接在它后面。
  let probe = target;
  for (;;) {
    let real: string;
    try {
      real = await realpath(probe);
    } catch {
      // 解析不了又确实是符号链接：目标不存在或者成环。当成「还不存在的文件」的话，之后写入会跟着链接写到外面。
      if (await isSymlink(probe)) {
        return {
          error: errorOutput(
            `Path "${input}" goes through a symbolic link that cannot be resolved (${shown(realRoot, probe)}: its target ` +
              `does not exist, or it loops), so it may lead outside the working directory ${realRoot}. ` +
              `Use a path without that link.`,
          ),
        };
      }
      const parent = dirname(probe);
      if (parent === probe) return { realRoot, path: target, real: target };
      probe = parent;
      continue;
    }
    if (!inside(realRoot, real)) return { error: outsideError(input, realRoot) };
    return { realRoot, path: target, real: join(real, relative(probe, target)) };
  }
}

/** 描述符实际指向的路径；只有 Linux 的 `/proc` 能问，问不到返回 `undefined`。 */
async function pathOfDescriptor(fd: number): Promise<string | undefined> {
  if (process.platform !== 'linux') return undefined;
  try {
    const path = await readlink(`/proc/self/fd/${fd}`);
    return isAbsolute(path) ? path : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 打开解析过的路径，最后一段不跟符号链接（`O_NOFOLLOW`），不等 FIFO 的另一头（`O_NONBLOCK`）。
 * 拿到描述符以后复核：父目录这时解析出来还在工作目录里；Linux 上再看描述符实际指向哪里。
 * 复核不过就关掉、返回错误；过了的话读写都经这个描述符，路径之后再怎么变也不相干。
 */
async function openInside(
  resolved: Resolved,
  input: string,
  flags: number,
): Promise<{ handle: FileHandle; info: Stats } | { error: ToolOutput }> {
  let handle: FileHandle;
  try {
    handle = await open(resolved.real, flags | O_NOFOLLOW | O_NONBLOCK);
  } catch (error) {
    // 最后一段在检查之后被换成了符号链接（Linux 报 ELOOP，BSD 报 EMLINK）。
    if (errorCode(error) === 'ELOOP' || errorCode(error) === 'EMLINK') {
      return { error: movedError(input, resolved.realRoot) };
    }
    throw error;
  }
  try {
    const info = await handle.stat();
    const parent = await realpath(dirname(resolved.real));
    const actual = await pathOfDescriptor(handle.fd);
    if (!inside(resolved.realRoot, parent) || (actual !== undefined && !inside(resolved.realRoot, actual))) {
      await handle.close();
      return { error: movedError(input, resolved.realRoot) };
    }
    return { handle, info };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

function kindOf(info: Stats): string {
  if (info.isFIFO()) return 'a FIFO (named pipe)';
  if (info.isSocket()) return 'a socket';
  if (info.isCharacterDevice() || info.isBlockDevice()) return 'a device';
  return 'a special file';
}

/** `signal` 中止时不等 `work`，直接给 `aborted()`；`work` 自己收尾。 */
async function orAborted<T>(work: Promise<T>, signal: AbortSignal | undefined, aborted: () => T): Promise<T> {
  if (!signal) return work;
  const stopped = Promise.withResolvers<T>();
  const onAbort = (): void => stopped.resolve(aborted());
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    return await Promise.race([work, stopped.promise]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

function shown(root: string, path: string): string {
  return relative(root, path) || '.';
}

function errorCode(error: unknown): string | undefined {
  return (error as { code?: unknown } | undefined)?.code as string | undefined;
}

// ---- 工厂 ----

function stringField(input: JsonValue, key: string): string | undefined {
  if (!isObject(input)) return undefined;
  const value = input[key];
  return typeof value === 'string' ? value : undefined;
}

function numberField(input: JsonValue, key: string): number | undefined {
  if (!isObject(input)) return undefined;
  const value = input[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * 本机子进程执行环境：`run_command` 在工作目录里用 shell 跑一条命令（`runCommand: false` 时不提供），`read_file`、
 * `write_file`、`list_dir` 只碰工作目录里面的文件。非零退出码照常返回（模型要看到输出）；起不来进程、被 `allow`
 * 或 `allowFile` 拒绝、超时、取消、越界才是 `{ type: 'error' }`。这不是沙箱：命令以当前用户的权限运行。
 */
export function createProcessExecutor(options: ProcessExecutorOptions = {}): ProcessExecutor {
  const name = options.name ?? 'process';
  const root = resolve(options.cwd ?? process.cwd());
  const env = baseEnv(options.env);
  const shell = options.shell ?? ['/bin/sh', '-c'];
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxTimeoutMs = Math.max(options.maxTimeoutMs ?? DEFAULT_MAX_TIMEOUT_MS, timeoutMs);
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const shellTool = options.runCommand !== false;
  const files = options.files !== false;
  const commands = options.commands ?? {};
  let disposed = false;

  for (const tool of Object.keys(commands)) {
    if (!isValidToolName(tool)) throw new Error(`Invalid tool name "${tool}": use [a-zA-Z0-9_-], at most 64 chars.`);
    if ([RUN_COMMAND, ...(files ? [READ_FILE, WRITE_FILE, LIST_DIR] : [])].includes(tool)) {
      throw new Error(`Tool name "${tool}" is taken by a built-in tool of the process executor.`);
    }
  }

  const kib = `${Math.round(maxOutputBytes / 1024)} KiB`;

  const definitions: ToolDefinition[] = [];

  if (shellTool) {
    definitions.push({
      name: RUN_COMMAND,
      description:
        `Run one shell command (${shell.join(' ')} "<command>") on this machine and return its exit code, stdout and stderr. ` +
        `It runs in ${root} unless you pass cwd (a path inside that directory), with a minimal environment ` +
        `(PATH, HOME, LANG and a few more; no secrets), no stdin and no TTY, so interactive programs will hang until the timeout. ` +
        `Each of stdout and stderr is cut at ${kib}; the cut is marked with how many bytes were dropped, so filter large output ` +
        `with head, tail or grep. Default timeout ${seconds(timeoutMs)} (max ${seconds(maxTimeoutMs)} via timeoutMs); on timeout the ` +
        `command and its children are killed and you get an error with the partial output. A command that leaves background ` +
        `jobs (cmd &) returns as soon as the shell exits and the jobs keep running: redirect their output to a file, it is not ` +
        `captured after that. A non-zero exit code is not an error: read stderr. Errors (command rejected by policy, could not start, timeout, cancelled) come back as tool errors with the reason.`,
      inputSchema: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: 'The command line, e.g. "ls -la src" or "npm test 2>&1 | tail -50".',
          },
          cwd: { type: 'string', description: `Working directory relative to ${root}. Defaults to it.` },
          timeoutMs: {
            type: 'number',
            description: `Timeout in milliseconds, at most ${maxTimeoutMs}. Defaults to ${timeoutMs}.`,
          },
        },
        required: ['command'],
        additionalProperties: false,
      },
      executor: name,
      source: 'process',
      tags: ['exec'],
    });
  }

  // 没有 `run_command` 时不让模型去找它。
  const readRest = shellTool
    ? 'read the rest with run_command (sed -n, tail)'
    : 'this executor has no tool that reads the rest';

  if (files) {
    definitions.push(
      {
        name: READ_FILE,
        description:
          `Read a UTF-8 text file inside ${root} (path relative to it). Returns the content; files over ${kib} are cut and the ` +
          `cut is marked` +
          (shellTool ? `, so read large files in parts with run_command (sed -n, head, tail). ` : `. `) +
          `Only regular files: directories, FIFOs and devices are refused, and so are paths outside the directory.`,
        inputSchema: {
          type: 'object',
          properties: { path: { type: 'string', description: 'File path relative to the working directory.' } },
          required: ['path'],
          additionalProperties: false,
        },
        executor: name,
        source: 'process',
        tags: ['fs', 'read'],
      },
      {
        name: WRITE_FILE,
        description:
          `Write a UTF-8 text file inside ${root} (path relative to it), creating parent directories. Replaces the file ` +
          `unless append is true. Returns how many bytes were written. Paths outside the directory are refused.`,
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path relative to the working directory.' },
            content: { type: 'string', description: 'The full text to write.' },
            append: { type: 'boolean', description: 'Append instead of replacing. Defaults to false.' },
          },
          required: ['path', 'content'],
          additionalProperties: false,
        },
        executor: name,
        source: 'process',
        tags: ['fs', 'write'],
      },
      {
        name: LIST_DIR,
        description:
          `List a directory inside ${root} (path relative to it, default "."): one entry per line, directories end with "/". ` +
          `At most ${MAX_LIST_ENTRIES} entries` +
          (shellTool ? `; use run_command with find for deep trees.` : `.`),
        inputSchema: {
          type: 'object',
          properties: { path: { type: 'string', description: 'Directory relative to the working directory.' } },
          additionalProperties: false,
        },
        executor: name,
        source: 'process',
        tags: ['fs', 'read'],
      },
    );
  }

  for (const [tool, spec] of Object.entries(commands)) {
    definitions.push({
      name: tool,
      ...(spec.description !== undefined ? { description: spec.description } : {}),
      inputSchema: spec.inputSchema ?? { type: 'object' },
      executor: name,
      source: 'process',
      tags: spec.tags ?? ['exec'],
    });
  }

  async function runLaunch(command: Launch, cwd: string, limitMs: number, context: ExecutionContext) {
    if (options.allow && !(await options.allow(command.display))) {
      return errorOutput(
        `Command not allowed by this executor's policy: ${command.display}. It did not run; try a different command or ask the user.`,
      );
    }
    if (context.signal?.aborted) return errorOutput(`Aborted before the command ran: ${command.display}`);
    const { outcome, stdout, stderr } = await launch(command, {
      cwd,
      env,
      timeoutMs: limitMs,
      maxOutputBytes,
      signal: context.signal,
    });
    switch (outcome.type) {
      case 'exited':
        return exitedOutput(outcome.code, outcome.signal, stdout, stderr);
      case 'timeout':
        return errorOutput(
          `Command timed out after ${limitMs} ms and was killed: ${command.display}. Partial output is in data. ` +
            `Make it faster (smaller input, run in the background with output to a file) or pass a larger timeoutMs (max ${maxTimeoutMs}).`,
          { retryable: false, data: partial(stdout, stderr) },
        );
      case 'aborted':
        return errorOutput(`Command was cancelled and killed: ${command.display}.`, { data: partial(stdout, stderr) });
      default: {
        const reason = messageOf(outcome.error);
        const missing = errorCode(outcome.error) === 'ENOENT';
        return errorOutput(
          missing
            ? `Could not start "${command.file}" in ${shown(root, cwd)}: ${reason}. Check that the program exists on PATH and the directory exists.`
            : `Could not start the command ${command.display}: ${reason}.`,
        );
      }
    }
  }

  async function runCommand(input: JsonValue, context: ExecutionContext): Promise<ToolOutput> {
    const command = stringField(input, 'command');
    if (!command?.trim()) return errorOutput('run_command needs a non-empty "command" string, e.g. {"command": "ls"}.');
    let cwd = root;
    const requested = stringField(input, 'cwd');
    if (requested !== undefined) {
      const resolved = await resolveInside(root, requested);
      if ('error' in resolved) return resolved.error;
      cwd = resolved.real;
    }
    const requestedTimeout = numberField(input, 'timeoutMs');
    const limitMs = requestedTimeout && requestedTimeout > 0 ? Math.min(requestedTimeout, maxTimeoutMs) : timeoutMs;
    const [file, ...args] = shell;
    return runLaunch({ file, args: [...args, command], display: command }, cwd, limitMs, context);
  }

  async function runFixed(spec: CommandTool, tool: string, input: JsonValue, context: ExecutionContext) {
    let command: string | readonly string[];
    try {
      command = spec.command(input);
    } catch (error) {
      return errorOutput(`Invalid input for ${tool}: ${messageOf(error)}`);
    }
    const limitMs = spec.timeoutMs ?? timeoutMs;
    if (typeof command === 'string') {
      const [file, ...args] = shell;
      return runLaunch({ file, args: [...args, command], display: command }, root, limitMs, context);
    }
    const [file, ...args] = command;
    if (!file) return errorOutput(`Tool ${tool} produced an empty command.`);
    return runLaunch({ file, args, display: command.join(' ') }, root, limitMs, context);
  }

  /** 过 `allowFile`；被拒绝时返回给模型看的错误。 */
  async function fileDenied(
    tool: FileAccess['tool'],
    mode: FileAccess['mode'],
    input: string,
    resolved: Resolved,
  ): Promise<ToolOutput | undefined> {
    if (!options.allowFile) return undefined;
    if (await options.allowFile({ tool, path: shown(resolved.realRoot, resolved.real), mode })) return undefined;
    return errorOutput(
      `File access not allowed by this executor's policy: ${tool} ${input}. It did not run; try a different path or ask the user.`,
    );
  }

  /** 只读前 `maxOutputBytes` 字节（多读一个字节看有没有截断），不整读；每块之间认 `signal`。 */
  async function readInside(
    resolved: Resolved,
    path: string,
    signal: AbortSignal | undefined,
    cancelled: () => ToolOutput,
  ): Promise<ToolOutput> {
    const opened = await openInside(resolved, path, constants.O_RDONLY);
    if ('error' in opened) return opened.error;
    const { handle, info } = opened;
    try {
      if (info.isDirectory()) return errorOutput(`${path} is a directory; use list_dir.`);
      if (!info.isFile()) {
        return errorOutput(`${path} is ${kindOf(info)}, not a regular file; read_file only reads regular files.`);
      }
      const kept = capture();
      let position = 0;
      while (position <= maxOutputBytes) {
        if (signal?.aborted) return cancelled();
        const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, maxOutputBytes + 1 - position));
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
        if (bytesRead === 0) break;
        take(kept, chunk.subarray(0, bytesRead), maxOutputBytes);
        position += bytesRead;
      }
      if (signal?.aborted) return cancelled();
      const text = new TextDecoder().decode(Buffer.concat(kept.chunks));
      // 没读到底：截掉多少按文件大小算。
      const dropped = position > maxOutputBytes ? Math.max(info.size, position) - maxOutputBytes : 0;
      return { type: 'text', text: dropped > 0 ? `${text}\n${truncatedNote(dropped, readRest)}` : text };
    } finally {
      await handle.close();
    }
  }

  async function readText(input: JsonValue, context: ExecutionContext): Promise<ToolOutput> {
    const path = stringField(input, 'path');
    if (!path) return errorOutput('read_file needs a "path" string relative to the working directory.');
    const resolved = await resolveInside(root, path);
    if ('error' in resolved) return resolved.error;
    const denied = await fileDenied(READ_FILE, 'read', path, resolved);
    if (denied) return denied;
    const cancelled = (): ToolOutput => errorOutput(`read_file was cancelled before it finished: ${path}.`);
    if (context.signal?.aborted) return cancelled();
    try {
      return await orAborted(readInside(resolved, path, context.signal, cancelled), context.signal, cancelled);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') {
        return errorOutput(`File not found: ${path} (in ${root}). Use list_dir to see what is there.`);
      }
      if (errorCode(error) === 'EISDIR') return errorOutput(`${path} is a directory; use list_dir.`);
      return errorOutput(`Could not read ${path}: ${messageOf(error)}`);
    }
  }

  async function writeText(input: JsonValue): Promise<ToolOutput> {
    const path = stringField(input, 'path');
    const content = stringField(input, 'content');
    if (!path || content === undefined) {
      return errorOutput('write_file needs "path" (relative to the working directory) and "content" strings.');
    }
    const resolved = await resolveInside(root, path);
    if ('error' in resolved) return resolved.error;
    const denied = await fileDenied(WRITE_FILE, 'write', path, resolved);
    if (denied) return denied;
    const append = isObject(input) && input['append'] === true;
    try {
      await mkdir(dirname(resolved.real), { recursive: true });
      // 不带 O_TRUNC：复核过了再清空，别在确认之前动文件。
      const flags = constants.O_WRONLY | constants.O_CREAT | (append ? constants.O_APPEND : 0);
      const opened = await openInside(resolved, path, flags);
      if ('error' in opened) return opened.error;
      const { handle, info } = opened;
      try {
        if (!info.isFile()) {
          return errorOutput(`${path} is ${kindOf(info)}, not a regular file; write_file only writes regular files.`);
        }
        if (!append) await handle.truncate(0);
        await handle.writeFile(content, 'utf8');
      } finally {
        await handle.close();
      }
      const bytes = Buffer.byteLength(content, 'utf8');
      return {
        type: 'text',
        text: `${append ? 'Appended' : 'Wrote'} ${bytes} bytes to ${shown(resolved.realRoot, resolved.path)}.`,
      };
    } catch (error) {
      if (errorCode(error) === 'EISDIR') return errorOutput(`${path} is a directory; give a file path.`);
      // 没有读者的 FIFO：O_NONBLOCK 打开只写的一头报 ENXIO。
      if (errorCode(error) === 'ENXIO') {
        return errorOutput(`${path} is not a regular file; write_file only writes regular files.`);
      }
      return errorOutput(`Could not write ${path}: ${messageOf(error)}`);
    }
  }

  async function listDir(input: JsonValue): Promise<ToolOutput> {
    const path = stringField(input, 'path') ?? '.';
    const resolved = await resolveInside(root, path);
    if ('error' in resolved) return resolved.error;
    const denied = await fileDenied(LIST_DIR, 'read', path, resolved);
    if (denied) return denied;
    try {
      const info = await stat(resolved.real);
      if (!info.isDirectory()) return errorOutput(`${path} is a file, not a directory; use read_file.`);
      const entries = (await readdir(resolved.real, { withFileTypes: true }))
        .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
        .toSorted();
      // 目录没有「不跟符号链接地打开」可用，读完再复核一次：路径被换成指出去的链接时不把列到的东西交出去。
      if (!inside(resolved.realRoot, await realpath(resolved.real))) return movedError(path, resolved.realRoot);
      const shownEntries = entries.slice(0, MAX_LIST_ENTRIES);
      const more = entries.length - shownEntries.length;
      const lines = shownEntries.length > 0 ? shownEntries : ['(empty directory)'];
      if (more > 0) {
        lines.push(
          shellTool
            ? `[… ${more} more entries; use run_command with find or ls and a pattern]`
            : `[… ${more} more entries; list a subdirectory instead]`,
        );
      }
      return { type: 'text', text: lines.join('\n') };
    } catch (error) {
      if (errorCode(error) === 'ENOENT') {
        return errorOutput(`Directory not found: ${path} (in ${root}). List "." to see what is there.`);
      }
      return errorOutput(`Could not list ${path}: ${messageOf(error)}`);
    }
  }

  return {
    name,
    cwd: root,
    async tools() {
      return definitions.map((definition) => ({ ...definition }));
    },
    async execute(call: ToolCall, context: ExecutionContext): Promise<ToolOutput> {
      if (disposed) return errorOutput(`Executor "${name}" has been disposed; tool "${call.name}" did not run.`);
      if (context.signal?.aborted) return errorOutput(`Aborted before tool "${call.name}" ran.`);
      try {
        if (call.name === RUN_COMMAND && shellTool) return await runCommand(call.input, context);
        const fixed = commands[call.name];
        if (fixed && Object.hasOwn(commands, call.name)) return await runFixed(fixed, call.name, call.input, context);
        if (files) {
          if (call.name === READ_FILE) return await readText(call.input, context);
          if (call.name === WRITE_FILE) return await writeText(call.input);
          if (call.name === LIST_DIR) return await listDir(call.input);
        }
      } catch (error) {
        return errorOutput(`Tool "${call.name}" failed: ${messageOf(error)}`);
      }
      const available = definitions.map((definition) => definition.name).join(', ') || '(none)';
      if (call.name === RUN_COMMAND) {
        return errorOutput(
          `run_command is turned off on executor "${name}": it does not run arbitrary shell commands, so nothing ran. ` +
            `Available tools: ${available}.`,
        );
      }
      return errorOutput(`Unknown tool "${call.name}". Available tools: ${available}.`);
    },
    async provision() {},
    async dispose() {
      disposed = true;
    },
  };
}
