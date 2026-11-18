// pi 子进程（`pi --mode rpc`）：起进程，stdout 按 LF 分行读响应和事件，命令带 id、响应按 id 回给发命令的一方，中断、收尾。
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

import { isObject, parseRecord, type PiRecord, type PiResponse } from './rpc.ts';

export interface SpawnOptions {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}

export interface Exit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  /** 起不来（找不到可执行文件这类）时的错误。 */
  readonly error?: Error;
}

/** stderr 只留最后这么多字符，给错误信息用。 */
const STDERR_TAIL = 4_000;

/** 扩展要用户回答的对话框：没有人回答，一律当取消。别的（`notify`、`setStatus`……）不用回。 */
const DIALOGS: ReadonlySet<string> = new Set(['select', 'confirm', 'input', 'editor']);

function cleanEnv(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

export class PiProcess {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #exited: Promise<Exit>;
  readonly #pending = new Map<string, (response: PiResponse | undefined) => void>();
  readonly #queue: PiRecord[] = [];
  #wake: (() => void) | undefined;
  #buffer = '';
  #stderr = '';
  #closed = false;
  #done = false;
  #aborted = false;
  #next = 0;
  #timers: NodeJS.Timeout[] = [];

  constructor(options: SpawnOptions) {
    this.#child = spawn(options.command, [...options.args], {
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      env: cleanEnv(options.env),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.#child.stdout.setEncoding('utf8');
    this.#child.stdout.on('data', (chunk: string) => this.#feed(chunk));
    this.#child.stdout.on('end', () => this.#close());
    this.#child.stderr.setEncoding('utf8');
    this.#child.stderr.on('data', (chunk: string) => {
      this.#stderr = (this.#stderr + chunk).slice(-STDERR_TAIL);
    });
    // 进程先退出时写 stdin 会报 EPIPE：吞掉，退出码和 stderr 说明了原因。
    this.#child.stdin.on('error', () => {});
    this.#exited = new Promise((resolve) => {
      let error: Error | undefined;
      this.#child.once('error', (cause) => {
        error = cause;
        // 起不来时没有 `exit`，只有 `error` 和 `close`。
        if (this.#child.pid === undefined) resolve({ code: null, signal: null, error });
      });
      this.#child.once('close', (code, signal) => resolve({ code, signal, ...(error ? { error } : {}) }));
    }).then((exit) => {
      this.#done = true;
      for (const timer of this.#timers) clearTimeout(timer);
      this.#close();
      return exit as Exit;
    });
  }

  #feed(chunk: string): void {
    this.#buffer += chunk;
    let start = 0;
    for (let at = this.#buffer.indexOf('\n'); at >= 0; at = this.#buffer.indexOf('\n', start)) {
      const record = parseRecord(this.#buffer.slice(start, at));
      start = at + 1;
      if (record) this.#dispatch(record);
    }
    this.#buffer = this.#buffer.slice(start);
  }

  #dispatch(record: PiRecord): void {
    if (record.type === 'response' && typeof record['id'] === 'string') {
      const resolve = this.#pending.get(record['id']);
      if (resolve) {
        this.#pending.delete(record['id']);
        resolve(record as PiResponse);
        return;
      }
    }
    if (record.type === 'extension_ui_request' && typeof record['id'] === 'string') {
      const method = record['method'];
      if (typeof method === 'string' && DIALOGS.has(method)) {
        this.send({ type: 'extension_ui_response', id: record['id'], cancelled: true });
      }
    }
    this.#queue.push(record);
    this.#wake?.();
  }

  #close(): void {
    if (this.#closed) return;
    this.#closed = true;
    const rest = parseRecord(this.#buffer);
    this.#buffer = '';
    if (rest) this.#dispatch(rest);
    for (const resolve of this.#pending.values()) resolve(undefined);
    this.#pending.clear();
    this.#wake?.();
  }

  /** stdout 的事件和没人等的响应，按到的顺序；进程结束、读完了就结束。 */
  async *records(): AsyncGenerator<PiRecord> {
    for (;;) {
      const record = this.#queue.shift();
      if (record) {
        yield record;
        continue;
      }
      if (this.#closed) return;
      await new Promise<void>((resolve) => (this.#wake = resolve));
      this.#wake = undefined;
    }
  }

  /** 发一个命令，等它的响应；进程在响应之前结束了就是 `undefined`。 */
  request(command: Readonly<Record<string, unknown>>): Promise<PiResponse | undefined> {
    if (this.#closed || this.#done) return Promise.resolve(undefined);
    const id = `ctx-${(this.#next += 1)}`;
    return new Promise((resolve) => {
      this.#pending.set(id, resolve);
      this.send({ ...command, id });
    });
  }

  send(command: Readonly<Record<string, unknown>>): void {
    if (this.#done || this.#child.stdin.destroyed || this.#child.stdin.writableEnded) return;
    this.#child.stdin.write(`${JSON.stringify(command)}\n`);
  }

  /** 关 stdin：pi 读到结尾就退出。 */
  endInput(): void {
    if (!this.#child.stdin.writableEnded) this.#child.stdin.end();
  }

  /**
   * 中断这一轮：发 `abort`，pi 停下手里的模型调用和工具、照常发出 `agent_settled`；`graceMs` 之后还没退出就 SIGTERM，再过
   * `graceMs` 就 SIGKILL。重复调用只算第一次。
   */
  abort(graceMs: number): void {
    if (this.#aborted || this.#done) return;
    this.#aborted = true;
    this.send({ type: 'abort' });
    this.#timers.push(
      setTimeout(() => {
        this.endInput();
        this.#child.kill('SIGTERM');
        this.#timers.push(setTimeout(() => this.#child.kill('SIGKILL'), graceMs).unref());
      }, graceMs).unref(),
    );
  }

  /** 关 stdin 等它退出；`graceMs` 之后还在就结束它。 */
  async finish(graceMs: number): Promise<Exit> {
    this.endInput();
    if (!this.#done) {
      this.#timers.push(
        setTimeout(() => {
          this.#child.kill('SIGTERM');
          this.#timers.push(setTimeout(() => this.#child.kill('SIGKILL'), graceMs).unref());
        }, graceMs).unref(),
      );
    }
    return this.#exited;
  }

  get exited(): Promise<Exit> {
    return this.#exited;
  }

  get stderr(): string {
    return this.#stderr.trim();
  }
}

/** 响应的 `data` 里的一个字段。 */
export function dataOf(response: PiResponse | undefined, key: string): unknown {
  return isObject(response?.data) ? response.data[key] : undefined;
}

/** `pi --version` 的版本号（`1.5.2`）；跑不了时 `undefined`。 */
export async function probeVersion(options: Omit<SpawnOptions, 'args'>): Promise<string | undefined> {
  return new Promise((resolve) => {
    let out = '';
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(options.command, ['--version'], {
        ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
        env: cleanEnv(options.env),
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      resolve(undefined);
      return;
    }
    const timer = setTimeout(() => child.kill('SIGKILL'), 15_000).unref();
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => (out += chunk));
    child.once('error', () => {
      clearTimeout(timer);
      resolve(undefined);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? /\d+\.\d+\.\d+[\w.-]*/.exec(out)?.[0] : undefined);
    });
  });
}
