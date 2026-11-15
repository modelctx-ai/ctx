/**
 * `ctx-remote` 的客户端：经 HTTP 用别处的会话存储、执行环境、harness、编排器、记忆存储，拿到的仍是协议的接口。
 * 只用 `fetch`、`TextDecoder`、`AbortController`，不用 `node:` 模块，任何运行时都能跑。服务端在 `./server`。
 */
import {
  CtxError,
  ENTRY_VERSION,
  errorOutput,
  unreadableEntry,
  type AppendOptions,
  type CoreVersion,
  type Entry,
  type ErrorInfo,
  type ExecutionContext,
  type Executor,
  type FactHit,
  type Harness,
  type ListOptions,
  type MemoryFact,
  type MemoryStore,
  type NewEntry,
  type Note,
  type Orchestrator,
  type OrchestratorEvent,
  type Procedure,
  type RecoveredRun,
  type RunEvent,
  type RunHandle,
  type RunRequest,
  type RunResult,
  type RunStatus,
  type SessionsOptions,
  type SessionStore,
  type ToolCall,
  type ToolDefinition,
  type ToolOutput,
  type UnreadableMode,
  type WatchOptions,
} from '@modelctx-ai/ctx-protocol';

import {
  isErrorBody,
  isRemoteError,
  parse,
  remoteError,
  segment,
  stringify,
  type RemoteError,
  type WireRunRequest,
} from './wire.ts';

export { isRemoteError, type ErrorBody, type RemoteError, type WireRunRequest } from './wire.ts';

export interface RemoteClientOptions {
  /** 服务端的地址，含路径前缀，例如 `http://127.0.0.1:53001` 或 `https://agents.example.com/ctx`。 */
  readonly baseUrl: string;
  /** 带上 `Authorization: Bearer <accessToken>`。 */
  readonly accessToken?: string;
  /** 额外的请求头。 */
  readonly headers?: Readonly<Record<string, string>>;
  /** 缺省用全局的 `fetch`。 */
  readonly fetch?: typeof fetch;
  /** 连不上、连接中途断了、服务端回 429/502/503/504 时怎么重试。只用在重试了也不会多做一遍的请求上。 */
  readonly retry?: RetryOptions;
}

/**
 * 重试的节奏：第 n 次重试前等 `minDelayMs × 2ⁿ`（带抖动），不超过 `maxDelayMs`。
 * 会重试的：所有 `GET`、会话的 `append`（发出前给每条补上 `id`，存储按 `id` 去重）、取消运行、
 * `watch` 断线后的重连、编排器的 `done`。提交运行、执行工具、记忆的写入不重试。
 */
export interface RetryOptions {
  /** 最多再试几次，缺省 4；0 是不重试。 */
  readonly retries?: number;
  /** 缺省 200 毫秒。 */
  readonly minDelayMs?: number;
  /** 缺省 5 秒。 */
  readonly maxDelayMs?: number;
}

interface RequestInit {
  readonly query?: Readonly<Record<string, string | undefined>>;
  readonly body?: unknown;
  readonly signal?: AbortSignal;
  /** 出了暂时性的错要不要重试，缺省只有 `GET` 重试。 */
  readonly retry?: boolean;
}

interface Connection {
  readonly baseUrl: string;
  readonly retries: number;
  readonly maxDelayMs: number;
  /** 第 `attempt` 次重试（从 0 数）之前等多久。 */
  delay(attempt: number): number;
  /** 2xx 以外的响应变成 `RemoteError` 抛出。重试只管到拿到响应头为止。 */
  request(method: string, path: string, init?: RequestInit): Promise<Response>;
  /** 读完正文再解析；重试时连读正文也算在内。 */
  json<T>(method: string, path: string, init?: RequestInit): Promise<T>;
}

/** 重试也许就好了的状态码：限流、网关或服务暂时不可用。 */
const TRANSIENT_STATUS: readonly number[] = [429, 502, 503, 504];

/** 暂时性的错：连不上、连接断了（`fetch` 抛的不是 `RemoteError`），或者上面那几个状态码。 */
function transient(error: unknown): boolean {
  if (isRemoteError(error)) return TRANSIENT_STATUS.includes(error.status);
  return !(error instanceof Error && error.name === 'AbortError');
}

/** 等 `ms` 毫秒，`signal` 中止时提前返回。 */
function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

/**
 * 响应头已经是 200 之后才出的错（见服务端的 `heartbeatMs`）：正文是 `{ "error", "status" }`。
 * 别的正文不会同时有对象 `error` 和数字 `status`。
 */
function lateFailure(value: unknown): RemoteError | undefined {
  if (!isErrorBody(value)) return undefined;
  const status = (value as { status?: unknown }).status;
  return typeof status === 'number' ? remoteError(status, value.error) : undefined;
}

async function errorFrom(response: Response): Promise<RemoteError> {
  const text = await response.text().catch(() => '');
  try {
    const body: unknown = parse(text);
    if (isErrorBody(body)) return remoteError(response.status, body.error);
  } catch {
    // 不是 JSON：用原文。
  }
  return remoteError(response.status, {
    message: text.trim() || `HTTP ${response.status} ${response.statusText}`.trim(),
    retryable: response.status >= 500,
  });
}

function connect(options: RemoteClientOptions): Connection {
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const fetcher = options.fetch ?? globalThis.fetch;
  const retries = Math.max(0, Math.floor(options.retry?.retries ?? 4));
  const minDelayMs = Math.max(0, options.retry?.minDelayMs ?? 200);
  const maxDelayMs = Math.max(minDelayMs, options.retry?.maxDelayMs ?? 5_000);
  const delay = (attempt: number): number =>
    Math.min(maxDelayMs, minDelayMs * 2 ** attempt) * (0.5 + Math.random() / 2);

  async function retrying<T>(method: string, init: RequestInit, attempt: () => Promise<T>): Promise<T> {
    const allowed = init.retry ?? method === 'GET';
    for (let failures = 0; ; failures += 1) {
      try {
        return await attempt();
      } catch (error) {
        if (!allowed || failures >= retries || init.signal?.aborted || !transient(error)) throw error;
        await pause(delay(failures), init.signal);
        if (init.signal?.aborted) throw error;
      }
    }
  }

  async function once(method: string, path: string, init: RequestInit = {}): Promise<Response> {
    const headers: Record<string, string> = { accept: 'application/json, application/x-ndjson', ...options.headers };
    if (options.accessToken) headers['authorization'] = `Bearer ${options.accessToken}`;
    if (init.body !== undefined) headers['content-type'] = 'application/json; charset=utf-8';
    let url = `${baseUrl}${path}`;
    const query = Object.entries(init.query ?? {}).filter((pair): pair is [string, string] => pair[1] !== undefined);
    if (query.length > 0) url += `?${new URLSearchParams(query).toString()}`;
    const response = await fetcher(url, {
      method,
      headers,
      ...(init.body !== undefined ? { body: stringify(init.body) } : {}),
      ...(init.signal ? { signal: init.signal } : {}),
    });
    if (!response.ok) throw await errorFrom(response);
    return response;
  }
  return {
    baseUrl,
    retries,
    maxDelayMs,
    delay,
    request: (method, path, init = {}) => retrying(method, init, () => once(method, path, init)),
    json: <T>(method: string, path: string, init: RequestInit = {}): Promise<T> =>
      retrying(method, init, async () => {
        const response = await once(method, path, init);
        const value: unknown = parse(await response.text());
        const late = lateFailure(value);
        if (late) throw late;
        return value as T;
      }),
  };
}

/** 读 NDJSON：每行一个值；`{ error }` 那一行变成 `RemoteError` 抛出。结束或提前退出时放掉连接。 */
async function* lines<T>(response: Response): AsyncGenerator<T> {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const decode = (line: string): T => {
    const value: unknown = parse(line);
    if (isErrorBody(value)) throw remoteError(response.status === 200 ? 500 : response.status, value.error);
    return value as T;
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      for (let index = buffer.indexOf('\n'); index >= 0; index = buffer.indexOf('\n')) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line) yield decode(line);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) yield decode(buffer.trim());
  } finally {
    await reader.cancel().catch(() => {});
  }
}

function isAbort(error: unknown, signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true || (error instanceof Error && error.name === 'AbortError');
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---- 会话 ----

function entriesPath(session: string): string {
  return `/sessions/${segment(session)}/entries`;
}

export interface RemoteSessionStoreOptions extends RemoteClientOptions {
  /**
   * 读到格式版本比这个客户端认识的高的条目（服务端先升级了）时怎么办。缺省 `throw`：抛 `unsupported_version`；
   * `placeholder`：那一条换成 `ctx.unreadable` 事件，其余照常。
   */
  readonly unreadable?: UnreadableMode;
}

/** `append` 重试后回头找自己写的条目时，至少看会话末尾这么多条。 */
const APPEND_LOOKBACK = 200;

/**
 * 远端的会话存储。`watch` 读 `GET …/entries/stream` 的 NDJSON，连接断了按最后读到的 `seq` 重连；
 * `signal` 中止后迭代正常结束。`append` 发出前给没有 `id` 的条目补上，连不上时重试不会记两遍。
 */
export function createRemoteSessionStore(options: RemoteSessionStoreOptions): SessionStore & {
  watch(session: string, options?: WatchOptions): AsyncIterable<Entry>;
} {
  const connection = connect(options);
  const mode = options.unreadable ?? 'throw';
  /** 服务端比这个客户端新时，条目的 `v` 会比这里认识的高：形状可能已经变了，不能当成当前版本用。 */
  const checked = (entry: Entry): Entry => {
    const v: unknown = entry.v;
    if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= ENTRY_VERSION) return entry;
    const error = new CtxError(
      'unsupported_version',
      `Entry format version ${JSON.stringify(v)} is newer than the version ${ENTRY_VERSION} this client supports. ` +
        'Upgrade @modelctx-ai/ctx-remote.',
    );
    if (mode === 'throw') throw error;
    return unreadableEntry(entry, error);
  };

  async function list(session: string, listOptions: ListOptions = {}): Promise<Entry[]> {
    const { last, limit, types, kinds } = listOptions;
    // kinds 用逗号分隔，带逗号的 kind 过不了线；与其静默拆成两个，不如直接报错。
    if (kinds?.some((kind) => kind.includes(','))) throw new Error('An entry kind cannot contain a comma.');
    const wanted = limit === undefined ? undefined : Number.isFinite(limit) ? Math.floor(limit) : 0;
    if (wanted !== undefined && wanted <= 0) return [];
    // 服务端一次只回一页（`more: true` 表示后面还有）：接着用 `after` 读，直到读完或够了 `limit`。
    const out: Entry[] = [];
    for (let after = listOptions.after; ;) {
      const body = await connection.json<{ entries: Entry[]; more?: boolean }>('GET', entriesPath(session), {
        query: {
          after: after !== undefined ? String(after) : undefined,
          last: last !== undefined ? String(last) : undefined,
          limit: wanted !== undefined ? String(wanted - out.length) : undefined,
          types: types ? types.join(',') : undefined,
          kinds: kinds ? kinds.join(',') : undefined,
        },
      });
      out.push(...body.entries.map(checked));
      const tail = body.entries.at(-1);
      // `last` 是从末尾数的，翻页会改变它的意思：只读服务端给的这一页。
      if (!body.more || tail === undefined || last !== undefined) return out;
      after = tail.seq;
    }
  }

  return {
    async append(session: string, entries: readonly NewEntry[], appendOptions?: AppendOptions): Promise<Entry[]> {
      // 发出前给每条补上 `id`：响应丢了再发一遍时，存储按 `id` 去重，不会记两遍。
      const batch = entries.map((entry) => (entry.id === undefined ? { ...entry, id: crypto.randomUUID() } : entry));
      const ids = new Set(batch.map((entry) => entry.id));
      const body = {
        entries: batch,
        ...(appendOptions?.expectSeq !== undefined ? { expectSeq: appendOptions.expectSeq } : {}),
      };
      /** 前面有一次没拿到响应、其实写成功了的条目：从会话末尾找回来。 */
      const written = async (): Promise<Entry[]> =>
        (await list(session, { last: Math.max(APPEND_LOOKBACK, batch.length * 2) })).filter((entry) =>
          ids.has(entry.id),
        );
      for (let failures = 0; ; failures += 1) {
        try {
          const response = await connection.json<{ entries: Entry[] }>('POST', entriesPath(session), {
            body,
            retry: false,
          });
          if (failures === 0 || response.entries.length === batch.length) return response.entries.map(checked);
          // 重试的这一次里被去重跳过的，可能是上一次写进去的：把它们也算进返回值。
          const got = new Set(response.entries.map((entry) => entry.id));
          const earlier = (await written()).filter((entry) => !got.has(entry.id));
          return [...earlier, ...response.entries.map(checked)].toSorted((a, b) => a.seq - b.seq);
        } catch (error) {
          // 409 + conflict：前提不满足，转成协议的 `conflict`，调用方不必认识 HTTP。
          if (isRemoteError(error) && error.status === 409 && error.type === 'conflict') {
            // 重试时冲突，可能是上一次已经写成功、末尾被自己推后了：条目都在就是成功。
            const earlier = failures > 0 ? await written() : [];
            if (earlier.length > 0) return earlier;
            throw new CtxError('conflict', error.message, { retryable: true });
          }
          if (failures >= connection.retries || !transient(error)) throw error;
          await pause(connection.delay(failures));
        }
      }
    },
    list,
    async clear(session: string): Promise<number> {
      return (await connection.json<{ deleted: number }>('DELETE', `/sessions/${segment(session)}`)).deleted;
    },
    async sessions(sessionsOptions: SessionsOptions = {}): Promise<string[]> {
      const { prefix, after, limit } = sessionsOptions;
      const body = await connection.json<{ sessions: string[] }>('GET', '/sessions', {
        query: {
          prefix,
          after,
          limit: limit !== undefined ? String(limit) : undefined,
        },
      });
      return body.sessions;
    },
    async *watch(session: string, watchOptions: WatchOptions = {}): AsyncGenerator<Entry> {
      const { signal } = watchOptions;
      // 记住读到哪了：连接断了就带着最后的 `seq` 重连，不重不漏。
      let after = watchOptions.after;
      for (let failures = 0; ;) {
        if (signal?.aborted) return;
        let connectedAt: number | undefined;
        try {
          const response = await connection.request('GET', `${entriesPath(session)}/stream`, {
            query: { after: after !== undefined ? String(after) : undefined },
            ...(signal ? { signal } : {}),
            retry: false,
          });
          connectedAt = Date.now();
          for await (const entry of lines<Entry>(response)) {
            failures = 0;
            const read = checked(entry);
            after = entry.seq;
            yield read;
          }
          // 服务端自己结束了这条流。
          return;
        } catch (error) {
          if (isAbort(error, signal)) return;
          // 连上以后撑了一阵才断的不算连续失败（例如中间的代理定时掐空闲连接）。
          if (connectedAt !== undefined && Date.now() - connectedAt > connection.maxDelayMs) failures = 0;
          if (failures >= connection.retries || !transient(error)) throw error;
          await pause(connection.delay(failures), signal);
          failures += 1;
        }
      }
    },
  };
}

// ---- 执行环境 ----

export interface RemoteExecutorOptions extends RemoteClientOptions {
  /** 服务端上执行环境的名字，也是这个客户端的名字：工具定义的 `executor` 填它。 */
  readonly name: string;
}

/**
 * 远端的执行环境。连不上、服务端出错都返回 `{ type: 'error', retryable: true }` 而不是抛：模型看得到，harness 接着跑。
 * `signal` 中止时断开请求，服务端随之中止它那边的执行。
 */
export function createRemoteExecutor(options: RemoteExecutorOptions): Executor & {
  tools(): Promise<ToolDefinition[]>;
} {
  const connection = connect(options);
  const { name } = options;
  const base = `/executors/${segment(name)}`;
  return {
    name,
    async tools() {
      const body = await connection.json<{ tools: ToolDefinition[] }>('GET', `${base}/tools`);
      return body.tools.map((tool) => ({ ...tool, executor: name }));
    },
    async execute(call: ToolCall, context: ExecutionContext): Promise<ToolOutput> {
      const { signal } = context;
      if (signal?.aborted) return errorOutput(`Aborted before tool "${call.name}" ran.`);
      try {
        const body = await connection.json<{ output: ToolOutput }>('POST', `${base}/execute`, {
          body: {
            call,
            context: { session: context.session, ...(context.runId !== undefined ? { runId: context.runId } : {}) },
          },
          ...(signal ? { signal } : {}),
        });
        return body.output;
      } catch (error) {
        if (isAbort(error, signal)) {
          return errorOutput(`Tool "${call.name}" was cancelled while running on remote executor "${name}".`);
        }
        if (isRemoteError(error)) {
          return errorOutput(
            `Remote executor "${name}" at ${connection.baseUrl} refused tool "${call.name}" (HTTP ${error.status}): ${error.message}`,
            { retryable: error.status >= 500 || error.status === 429 },
          );
        }
        return errorOutput(
          `Could not reach remote executor "${name}" at ${connection.baseUrl}: ${messageOf(error)}. ` +
            `Tool "${call.name}" may not have run; retry if it is safe to run twice.`,
          { retryable: true },
        );
      }
    },
  };
}

// ---- Harness ----

/** 跨边界只能传模型名：对面的 harness 按名字造模型。 */
function wireRequest(request: RunRequest, runId: string): WireRunRequest {
  if (typeof request.agent.model !== 'string') {
    throw new TypeError(
      'A remote harness needs agent.model to be a model name string; model objects cannot cross the process boundary.',
    );
  }
  const { signal, ...rest } = request;
  return { ...rest, runId, ...(signal?.aborted ? { aborted: true } : {}) };
}

/**
 * 远端的 harness。`run` 回 `RunResult`，`stream` 读 `POST /runs?stream=1` 的 NDJSON。
 * `signal` 中止时发 `DELETE /runs/:runId`，服务端中止这一轮，`run` 照常返回 `stopReason: aborted`；
 * `stream` 的调用方提前不读了就断开连接，服务端同样中止。
 */
export function createRemoteHarness(options: RemoteClientOptions): Harness & {
  stream(request: RunRequest): AsyncIterable<RunEvent>;
} {
  const connection = connect(options);

  /** 调用方中止时请服务端取消；请求发不出去就直接断开连接（服务端也会中止）。 */
  function watchAbort(request: RunRequest, runId: string, connectionAbort: AbortController): () => void {
    const { signal } = request;
    if (!signal || signal.aborted) return () => {};
    const onAbort = (): void => {
      connection.request('DELETE', `/runs/${segment(runId)}`).then(
        (response) => response.body?.cancel(),
        () => connectionAbort.abort(signal.reason),
      );
    };
    signal.addEventListener('abort', onAbort, { once: true });
    return () => signal.removeEventListener('abort', onAbort);
  }

  return {
    async run(request: RunRequest): Promise<RunResult> {
      const runId = request.runId ?? crypto.randomUUID();
      const body = wireRequest(request, runId);
      const controller = new AbortController();
      const unwatch = watchAbort(request, runId, controller);
      try {
        return await connection.json<RunResult>('POST', '/runs', { body, signal: controller.signal });
      } finally {
        unwatch();
      }
    },
    async *stream(request: RunRequest): AsyncGenerator<RunEvent> {
      const runId = request.runId ?? crypto.randomUUID();
      const body = wireRequest(request, runId);
      const controller = new AbortController();
      const unwatch = watchAbort(request, runId, controller);
      let ended = false;
      try {
        const response = await connection.request('POST', '/runs', {
          query: { stream: '1' },
          body,
          signal: controller.signal,
        });
        for await (const event of lines<RunEvent>(response)) {
          if (event.type === 'run.ended') ended = true;
          yield event;
        }
      } finally {
        unwatch();
        // 提前不读了：断开连接，服务端中止这一轮。
        if (!ended) controller.abort(new Error('Run stream closed by the consumer.'));
      }
    },
  };
}

// ---- 编排器 ----

export interface RemoteOrchestratorOptions extends RemoteClientOptions {
  /** `done` 每次长轮询 `GET /orchestrator/runs/:id?wait=` 最多等多久，缺省 25 秒。 */
  readonly waitMs?: number;
}

interface RunView {
  readonly runId: string;
  readonly status: RunStatus;
  readonly session?: string;
  readonly result?: RunResult;
  readonly error?: ErrorInfo;
}

function runPath(runId: string): string {
  return `/orchestrator/runs/${segment(runId)}`;
}

const TERMINAL: readonly RunStatus[] = ['completed', 'failed', 'cancelled'];

/**
 * 远端的编排器。`done` 用长轮询 `GET /orchestrator/runs/:id?wait=…` 实现：服务端等到这一轮结束（或等满）才回。
 * `close` 只关这个客户端：不再提交，结束它开着的事件流，等它提交的运行结束；服务端的编排器不受影响。
 * 请求的 `signal` 中止时发 `DELETE /orchestrator/runs/:id`。
 */
export function createRemoteOrchestrator(options: RemoteOrchestratorOptions): Orchestrator & {
  recover(): Promise<RecoveredRun[]>;
  events(options?: { readonly signal?: AbortSignal }): AsyncIterable<OrchestratorEvent>;
} {
  const connection = connect(options);
  const waitMs = options.waitMs ?? 25_000;
  const pending = new Set<Promise<unknown>>();
  /** 正在建立的事件流：提交前等它们连上，保证这个客户端先开的事件流看得到后提交的运行。 */
  const connecting = new Set<Promise<unknown>>();
  const streams = new Set<AbortController>();
  let closed = false;

  async function view(runId: string, wait: number, session?: string): Promise<RunView | undefined> {
    try {
      return await connection.json<RunView>('GET', runPath(runId), {
        query: { wait: wait > 0 ? String(wait) : undefined, session },
      });
    } catch (error) {
      if (isRemoteError(error) && error.status === 404) return undefined;
      throw error;
    }
  }

  /**
   * 长轮询到这一轮结束。连不上时 `view` 自己按 `retry` 重试；带上会话名，服务端内存里没有结果时（重启过、
   * 过了保留期）从会话日志还原。服务端没等就回了「还没结束」的话隔一会儿再问，不空转。
   */
  async function waitFor(runId: string, session: string): Promise<RunResult> {
    for (let early = 0; ;) {
      const asked = Date.now();
      const current = await view(runId, waitMs, session);
      if (!current) throw new Error(`Run "${runId}" is unknown to the remote orchestrator at ${connection.baseUrl}.`);
      if (current.result) return current.result;
      if (current.error) throw remoteError(500, current.error);
      if (TERMINAL.includes(current.status)) {
        throw new Error(
          `Run "${runId}" ended (${current.status}) but the server no longer keeps its result ` +
            'and has no session store to restore it from.',
        );
      }
      if (Date.now() - asked >= Math.min(waitMs, 1_000)) early = 0;
      else await pause(connection.delay(early++));
    }
  }

  const orchestrator = {
    async submit(request: RunRequest): Promise<RunHandle> {
      if (closed) throw new Error('Remote orchestrator client is closed.');
      const runId = request.runId ?? crypto.randomUUID();
      const body = wireRequest(request, runId);
      await Promise.allSettled(connecting);
      const submitted = await connection.json<{ runId: string; session: string }>('POST', '/orchestrator/runs', {
        body,
      });
      const { signal } = request;
      if (signal && !signal.aborted) {
        signal.addEventListener('abort', () => void orchestrator.cancel(submitted.runId).catch(() => false), {
          once: true,
        });
      }
      const done = waitFor(submitted.runId, submitted.session);
      // 没人等 done 时出错也不能变成未处理的 rejection。
      done.catch(() => {});
      pending.add(done);
      void done.finally(() => pending.delete(done)).catch(() => {});
      return { runId: submitted.runId, session: submitted.session, done };
    },
    async status(runId: string): Promise<RunStatus | undefined> {
      return (await view(runId, 0))?.status;
    },
    async cancel(runId: string): Promise<boolean> {
      try {
        return (await connection.json<{ cancelled: boolean }>('DELETE', runPath(runId), { retry: true })).cancelled;
      } catch (error) {
        if (isRemoteError(error) && error.status === 404) return false;
        throw error;
      }
    },
    async recover(): Promise<RecoveredRun[]> {
      return (await connection.json<{ recovered: RecoveredRun[] }>('POST', '/orchestrator/recover')).recovered;
    },
    async *events(eventOptions: { readonly signal?: AbortSignal } = {}): AsyncGenerator<OrchestratorEvent> {
      const { signal } = eventOptions;
      if (closed || signal?.aborted) return;
      const controller = new AbortController();
      const stop = (): void => controller.abort();
      signal?.addEventListener('abort', stop, { once: true });
      streams.add(controller);
      try {
        const opening = connection.request('GET', '/orchestrator/events', { signal: controller.signal });
        connecting.add(opening);
        let response: Response;
        try {
          response = await opening;
        } finally {
          connecting.delete(opening);
        }
        yield* lines<OrchestratorEvent>(response);
      } catch (error) {
        if (isAbort(error, controller.signal)) return;
        throw error;
      } finally {
        streams.delete(controller);
        signal?.removeEventListener('abort', stop);
        controller.abort();
      }
    },
    async close(): Promise<void> {
      closed = true;
      await Promise.allSettled(pending);
      for (const controller of streams) controller.abort();
    },
  };
  return orchestrator;
}

// ---- 记忆 ----

/** 服务端原样转发的协议错误：转回 `CtxError`。 */
const CTX_ERROR_TYPES: readonly string[] = ['invalid_request', 'not_found', 'conflict'];

function flag(value: boolean | undefined): string | undefined {
  return value === undefined ? undefined : String(value);
}

function count(value: number | undefined): string | undefined {
  return value === undefined ? undefined : String(value);
}

/**
 * 远端的记忆存储。服务端存储抛的 `CtxError`（`invalid_request`、`not_found`、`conflict`）转回同 `type` 的 `CtxError`，
 * 调用方不必认识 HTTP；连不上、服务端没挂记忆（404 `not_found_error`）等仍是 `RemoteError` 或 `fetch` 的错误。
 */
export function createRemoteMemoryStore(options: RemoteClientOptions): MemoryStore {
  const connection = connect(options);
  async function call<T>(method: string, path: string, init?: RequestInit): Promise<T> {
    try {
      return await connection.json<T>(method, `/memory${path}`, init);
    } catch (error) {
      if (isRemoteError(error) && error.type !== undefined && CTX_ERROR_TYPES.includes(error.type)) {
        throw new CtxError(
          error.type,
          error.message,
          error.retryable !== undefined ? { retryable: error.retryable } : {},
        );
      }
      throw error;
    }
  }
  return {
    notes: {
      async add(notes) {
        return (await call<{ notes: Note[] }>('POST', '/notes', { body: { notes } })).notes;
      },
      async list(query = {}) {
        const { session, pending, limit } = query;
        return (
          await call<{ notes: Note[] }>('GET', '/notes', {
            query: { session, pending: flag(pending), limit: count(limit) },
          })
        ).notes;
      },
      async settle(ids, at) {
        return (await call<{ settled: number }>('POST', '/notes/settle', { body: { ids, at } })).settled;
      },
      async head(session) {
        return (await call<{ head: number }>('GET', '/notes/head', { query: { session } })).head;
      },
    },
    facts: {
      async add(fact) {
        return (await call<{ fact: MemoryFact }>('POST', '/facts', { body: { fact } })).fact;
      },
      async close(id, at, closeOptions) {
        const supersededBy = closeOptions?.supersededBy;
        await call('POST', `/facts/${segment(id)}/close`, {
          body: { at, ...(supersededBy !== undefined ? { supersededBy } : {}) },
        });
      },
      async cite(id, sources) {
        return (await call<{ fact: MemoryFact }>('POST', `/facts/${segment(id)}/cite`, { body: { sources } })).fact;
      },
      async touch(ids, at) {
        await call('POST', '/facts/touch', { body: { ids, at } });
      },
      async archive(ids, at) {
        return (await call<{ archived: number }>('POST', '/facts/archive', { body: { ids, at } })).archived;
      },
      async forget(ids) {
        return (await call<{ forgotten: number }>('POST', '/facts/forget', { body: { ids } })).forgotten;
      },
      async list(query = {}) {
        const { subject, topic, open, after, limit } = query;
        return (
          await call<{ facts: MemoryFact[] }>('GET', '/facts', {
            query: { subject, topic, open: flag(open), after, limit: count(limit) },
          })
        ).facts;
      },
      async search(query) {
        return (await call<{ hits: FactHit[] }>('POST', '/facts/search', { body: query })).hits;
      },
    },
    procedures: {
      async add(procedure) {
        return (await call<{ procedure: Procedure }>('POST', '/procedures', { body: { procedure } })).procedure;
      },
      async confirm(id, evidence) {
        return (
          await call<{ procedure: Procedure }>('POST', `/procedures/${segment(id)}/confirm`, { body: { evidence } })
        ).procedure;
      },
      async retire(id, at) {
        await call('POST', `/procedures/${segment(id)}/retire`, { body: { at } });
      },
      async list(query = {}) {
        const { topic, active } = query;
        return (
          await call<{ procedures: Procedure[] }>('GET', '/procedures', {
            query: { topic, active: flag(active) },
          })
        ).procedures;
      },
    },
    core: {
      async get() {
        return (await call<{ core: CoreVersion | null }>('GET', '/core')).core;
      },
      async set(text, at) {
        await call('PUT', '/core', { body: { text, at } });
      },
      async history(historyOptions = {}) {
        return (
          await call<{ versions: CoreVersion[] }>('GET', '/core/history', {
            query: { last: count(historyOptions.last) },
          })
        ).versions;
      },
    },
  };
}
