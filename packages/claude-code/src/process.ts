// Claude Code 子进程：起进程、按行读 stream-json、写用户消息和中断、收尾。
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';

import { parseLine, type ClaudeLine } from './stream-json.ts';

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

export class ClaudeProcess {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #exited: Promise<Exit>;
  #stderr = '';
  #interrupted = false;
  #timers: NodeJS.Timeout[] = [];
  #done = false;

  constructor(options: SpawnOptions) {
    const env = Object.fromEntries(
      Object.entries(options.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
    );
    this.#child = spawn(options.command, [...options.args], {
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
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
      return exit as Exit;
    });
  }

  /** stdout 的每一行，认不出的跳过；进程结束时结束。 */
  async *lines(): AsyncGenerator<ClaudeLine> {
    const reader = createInterface({ input: this.#child.stdout, crlfDelay: Infinity });
    for await (const raw of reader) {
      const line = parseLine(raw);
      if (line) yield line;
    }
  }

  send(message: object): void {
    if (this.#done || this.#child.stdin.destroyed || this.#child.stdin.writableEnded) return;
    this.#child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  /** 关 stdin：Claude Code 答完手里的消息就退出。 */
  endInput(): void {
    if (!this.#child.stdin.writableEnded) this.#child.stdin.end();
  }

  /**
   * 中断这一轮：先发 `interrupt` 控制消息，Claude Code 停下手里的模型调用和工具、照常给出 `result`；`graceMs` 之后还没退出就
   * SIGTERM，再过 `graceMs` 就 SIGKILL。重复调用只算第一次。
   */
  interrupt(graceMs: number): void {
    if (this.#interrupted || this.#done) return;
    this.#interrupted = true;
    this.send({
      type: 'control_request',
      request_id: `ctx-interrupt-${Date.now()}`,
      request: { subtype: 'interrupt' },
    });
    this.#timers.push(
      setTimeout(() => {
        this.endInput();
        this.#child.kill('SIGTERM');
        this.#timers.push(setTimeout(() => this.#child.kill('SIGKILL'), graceMs).unref());
      }, graceMs).unref(),
    );
  }

  get interrupted(): boolean {
    return this.#interrupted;
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

/** `claude --version` 的版本号（`2.1.326 (Claude Code)` 里的 `2.1.326`）；跑不了时 `undefined`。 */
export async function probeVersion(options: Omit<SpawnOptions, 'args'>): Promise<string | undefined> {
  return new Promise((resolve) => {
    let out = '';
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(options.command, ['--version'], {
        ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
        env: Object.fromEntries(
          Object.entries(options.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
        ),
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
