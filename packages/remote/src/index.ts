/**
 * `ctx-remote` 的客户端：经 HTTP 用别处的会话存储、执行环境、harness、编排器，拿到的仍是协议的接口。
 * 只用 `fetch`、`TextDecoder`、`AbortController`，不用 `node:` 模块，任何运行时都能跑。服务端在 `./server`。
 */
import {
  CtxError,
  errorOutput,
  type AppendOptions,
  type Entry,
  type ErrorInfo,
  type ExecutionContext,
  type Executor,
  type Harness,
  type ListOptions,
  type NewEntry,
  type Orchestrator,
  type OrchestratorEvent,
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
}

interface RequestInit {
  readonly query?: Readonly<Record<string, string | undefined>>;
  readonly body?: unknown;
  readonly signal?: AbortSignal;
}

interface Connection {
  readonly baseUrl: string;
  /** 2xx 以外的响应变成 `RemoteError` 抛出。 */
  request(method: string, path: string, init?: RequestInit): Promise<Response>;
  json<T>(method: string, path: string, init?: RequestInit): Promise<T>;
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
  async function request(method: string, path: string, init: RequestInit = {}): Promise<Response> {
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
    request,
    async json<T>(method: string, path: string, init?: RequestInit): Promise<T> {
      const response = await request(method, path, init);
      return parse(await response.text()) as T;
    },
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

/** 远端的会话存储。`watch` 读 `GET …/entries/stream` 的 NDJSON；`signal` 中止后迭代正常结束。 */
export function createRemoteSessionStore(options: RemoteClientOptions): SessionStore & {
  watch(session: string, options?: WatchOptions): AsyncIterable<Entry>;
} {
  const connection = connect(options);
  return {
    async append(session: string, entries: readonly NewEntry[], appendOptions?: AppendOptions): Promise<Entry[]> {
      try {
        const body = await connection.json<{ entries: Entry[] }>('POST', entriesPath(session), {
          body: { entries, ...(appendOptions?.expectSeq !== undefined ? { expectSeq: appendOptions.expectSeq } : {}) },
        });
        return body.entries;
      } catch (error) {
        // 409 + conflict：前提不满足，转成协议的 `conflict`，调用方不必认识 HTTP。
        if (isRemoteError(error) && error.status === 409 && error.type === 'conflict') {
          throw new CtxError('conflict', error.message, { retryable: true });
        }
        throw error;
      }
    },
    async list(session: string, listOptions: ListOptions = {}): Promise<Entry[]> {
      const { after, last, types, kinds } = listOptions;
      // kinds 用逗号分隔，带逗号的 kind 过不了线；与其静默拆成两个，不如直接报错。
      if (kinds?.some((kind) => kind.includes(','))) throw new Error('An entry kind cannot contain a comma.');
      const body = await connection.json<{ entries: Entry[] }>('GET', entriesPath(session), {
        query: {
          after: after !== undefined ? String(after) : undefined,
          last: last !== undefined ? String(last) : undefined,
          types: types ? types.join(',') : undefined,
          kinds: kinds ? kinds.join(',') : undefined,
        },
      });
      return body.entries;
    },
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
      const { after, signal } = watchOptions;
      if (signal?.aborted) return;
      try {
        const response = await connection.request('GET', `${entriesPath(session)}/stream`, {
          query: {
            after: after !== undefined ? String(after) : undefined,
          },
          ...(signal ? { signal } : {}),
        });
        yield* lines<Entry>(response);
      } catch (error) {
        if (isAbort(error, signal)) return;
        throw error;
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
            { retryable: error.status >= 500 },
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

  async function view(runId: string, wait: number): Promise<RunView | undefined> {
    try {
      return await connection.json<RunView>('GET', runPath(runId), {
        query: wait > 0 ? { wait: String(wait) } : {},
      });
    } catch (error) {
      if (isRemoteError(error) && error.status === 404) return undefined;
      throw error;
    }
  }

  async function waitFor(runId: string): Promise<RunResult> {
    for (;;) {
      const current = await view(runId, waitMs);
      if (!current) throw new Error(`Run "${runId}" is unknown to the remote orchestrator at ${connection.baseUrl}.`);
      if (current.result) return current.result;
      if (current.error) throw remoteError(500, current.error);
      if (TERMINAL.includes(current.status)) {
        throw new Error(`Run "${runId}" ended (${current.status}) but its result is no longer kept by the server.`);
      }
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
      const done = waitFor(submitted.runId);
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
        return (await connection.json<{ cancelled: boolean }>('DELETE', runPath(runId))).cancelled;
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
