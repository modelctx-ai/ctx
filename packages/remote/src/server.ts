/**
 * `ctx-remote` 的服务端：把进程内的协议对象挂到 HTTP 上。基于 `node:http`，安全缺省照 `ctx-gateway`：
 * 只听本机、Host 只认监听地址、带 `Origin` 的请求一律 403（除非在白名单）、Bearer 常量时间比较、请求体有上限。
 */
import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  silentLogger,
  type Entry,
  type EntryType,
  type ErrorInfo,
  type ExecutionContext,
  type Executor,
  type Harness,
  type ListOptions,
  type Logger,
  type NewEntry,
  type Orchestrator,
  type RunEvent,
  type RunRequest,
  type RunResult,
  type RunStatus,
  type SessionStore,
  type ToolCall,
} from '@modelctx-ai/ctx-protocol';

import { parse, stringify, type WireRunRequest } from './wire.ts';

export interface RemoteHandlerOptions {
  /** 挂在 `/sessions` 下。 */
  readonly store?: SessionStore;
  /** 挂在 `/executors` 下，按名字找。 */
  readonly executors?: readonly Executor[] | Readonly<Record<string, Executor>>;
  /** 挂在 `/runs` 下。`agent.model` 只能是名字，由这个 harness 自己造模型（例如核心包 `createHarness` 的 `models`）。 */
  readonly harness?: Harness;
  /** 挂在 `/orchestrator` 下。 */
  readonly orchestrator?: Orchestrator;
  /** 要求调用方带 `Authorization: Bearer <accessToken>`。 */
  readonly accessToken?: string;
  /**
   * 只接受这些 Host 头（`host:port`，不分大小写），别的回 403，挡 DNS rebinding。`startRemote` 缺省用监听地址，
   * 监听本机时再加 `localhost`、`127.0.0.1`、`[::1]`；`createRemoteHandler` 不知道端口，不给就不查。
   */
  readonly allowedHosts?: readonly string[];
  /** 带 `Origin` 头的请求只放行这些来源，缺省一个都不放：浏览器网页发来的请求一律 403。 */
  readonly allowedOrigins?: readonly string[];
  /** 请求体上限，缺省 4 MiB。 */
  readonly maxBodyBytes?: number;
  /** 路径前缀，缺省挂在根上。 */
  readonly basePath?: string;
  /** 存储没有 `watch` 时，`entries/stream` 轮询 `list(after)` 的间隔，缺省 250 毫秒。 */
  readonly pollIntervalMs?: number;
  /** 编排器的运行结果在结束后保留多久（给客户端的 `done` 取），缺省 10 分钟。 */
  readonly retainResultsMs?: number;
  readonly logger?: Logger;
}

export type RemoteHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

export interface StartRemoteOptions extends RemoteHandlerOptions {
  /** 缺省 `127.0.0.1`。 */
  readonly host?: string;
  /** 缺省 0：随机端口。 */
  readonly port?: number;
}

export interface RemoteServer {
  /** 例如 `http://127.0.0.1:53001`。 */
  readonly origin: string;
  /** 给客户端填的地址：`origin + basePath`。 */
  readonly baseUrl: string;
  /** 停止监听并断开所有连接（包括还在读的流）。不关挂上来的组件。 */
  close(): Promise<void>;
}

// ---- HTTP 基础 ----

/** 带状态码的错误：处理函数抛出来，最外层转成 `{ error }` 正文。 */
interface HttpFailure {
  readonly status: number;
  readonly info: ErrorInfo;
}

function fail(status: number, message: string, type?: string): never {
  const failure: HttpFailure = { status, info: { message, type: type ?? typeOf(status) } };
  throw Object.assign(new Error(message), { failure });
}

function failureOf(error: unknown): HttpFailure | undefined {
  return (error as { failure?: HttpFailure } | undefined)?.failure;
}

function typeOf(status: number): string {
  switch (status) {
    case 400:
      return 'invalid_request_error';
    case 401:
      return 'authentication_error';
    case 403:
      return 'permission_error';
    case 404:
      return 'not_found_error';
    case 405:
      return 'method_not_allowed';
    case 409:
      return 'conflict_error';
    case 413:
      return 'request_too_large';
    default:
      return 'server_error';
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const body = stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function sendError(res: ServerResponse, status: number, info: ErrorInfo): void {
  sendJson(res, status, { error: info });
}

async function readBody(req: IncomingMessage, limit: number): Promise<unknown> {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) fail(413, `request body exceeds ${limit} bytes`);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) fail(413, `request body exceeds ${limit} bytes`);
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return undefined;
  try {
    return parse(text);
  } catch {
    return fail(400, 'request body is not valid JSON');
  }
}

function authorized(req: IncomingMessage, token: string | undefined): boolean {
  if (!token) return true;
  // 认证方案不分大小写（RFC 9110）。
  const given = Buffer.from(/^bearer\s+(.+)$/i.exec(req.headers.authorization ?? '')?.[1] ?? '');
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** 去掉结尾的 `/`；挂在根上时是 `''`。 */
function normalizePath(path: string): string {
  const trimmed = path.trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

function lowered(values: readonly string[]): Set<string> {
  return new Set(values.map((value) => value.trim().toLowerCase().replace(/\/+$/, '')));
}

const LOOPBACK = ['localhost', '127.0.0.1', '::1'];

/** 监听地址本身；监听本机（或所有地址）时，本机的几种写法都认。 */
function defaultHosts(host: string, port: number): string[] {
  const local = LOOPBACK.includes(host) || host.startsWith('127.') || host === '0.0.0.0' || host === '::';
  const names = local ? [host, ...LOOPBACK] : [host];
  return names.flatMap((name) => {
    const bare = name.includes(':') ? `[${name}]` : name;
    return port === 80 ? [`${bare}:80`, bare] : [`${bare}:${port}`];
  });
}

/** NDJSON：每行一个值，边产生边写；对面读得慢时等 `drain`，断开时不再等。 */
function startStream(res: ServerResponse): (value: unknown) => Promise<void> {
  res.writeHead(200, {
    'content-type': 'application/x-ndjson; charset=utf-8',
    'cache-control': 'no-store',
    'x-accel-buffering': 'no',
  });
  res.flushHeaders();
  return async (value) => {
    if (res.destroyed || res.writableEnded) return;
    if (!res.write(`${stringify(value)}\n`)) {
      await new Promise<void>((resolve) => {
        const done = (): void => {
          res.off('drain', done);
          res.off('close', done);
          resolve();
        };
        res.on('drain', done);
        res.on('close', done);
      });
    }
  };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

// ---- 输入校验 ----

function need<T>(component: T | undefined, what: string): T {
  if (component === undefined) fail(404, `this server does not serve ${what}`);
  return component;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function runRequestOf(body: unknown): WireRunRequest {
  if (!isObject(body)) fail(400, 'request body must be a RunRequest object');
  if (typeof body['session'] !== 'string' || !body['session']) fail(400, 'RunRequest.session must be a string');
  const agent = body['agent'];
  if (!isObject(agent)) fail(400, 'RunRequest.agent must be an object');
  if (typeof agent['model'] !== 'string' || !agent['model']) {
    fail(400, 'RunRequest.agent.model must be a model name string; model objects cannot cross the boundary');
  }
  if (body['runId'] !== undefined && typeof body['runId'] !== 'string') fail(400, 'RunRequest.runId must be a string');
  return body as unknown as WireRunRequest;
}

const ENTRY_TYPES: readonly EntryType[] = ['message', 'event', 'summary'];

function afterParam(query: URLSearchParams): number | undefined {
  const raw = query.get('after');
  if (raw === null) return undefined;
  const after = Number(raw);
  if (raw === '' || !Number.isFinite(after)) fail(400, 'after must be a number (a seq)');
  return after;
}

function listOptionsOf(query: URLSearchParams): ListOptions {
  const options: { after?: number; last?: number; types?: EntryType[] } = {};
  const after = afterParam(query);
  if (after !== undefined) options.after = after;
  const last = query.get('last');
  if (last !== null) options.last = Number(last);
  const types = query.get('types');
  if (types !== null) {
    const list = types.split(',').filter(Boolean);
    const unknown = list.filter((type) => !ENTRY_TYPES.includes(type as EntryType));
    if (unknown.length > 0) fail(400, `unknown entry types: ${unknown.join(', ')}; use ${ENTRY_TYPES.join(', ')}`);
    options.types = list as EntryType[];
  }
  return options;
}

function executorTable(executors: RemoteHandlerOptions['executors']): Map<string, Executor> {
  if (!executors) return new Map();
  if (Array.isArray(executors)) return new Map(executors.map((executor: Executor) => [executor.name, executor]));
  return new Map(Object.entries(executors));
}

const TERMINAL: readonly RunStatus[] = ['completed', 'failed', 'cancelled'];
/** 一次长轮询最多挂多久。 */
const MAX_WAIT_MS = 30_000;
/** 还没开始就被取消的 harness 运行，记这么久等它的请求到。 */
const PENDING_CANCEL_MS = 60_000;
const MAX_PENDING_CANCELS = 1_000;

interface SubmittedRun {
  readonly session: string;
  readonly done: Promise<void>;
  result?: RunResult;
  error?: ErrorInfo;
}

/**
 * 可以挂到已有 HTTP 服务上的处理函数。给了哪些组件就挂哪些路径，其余 404。路径见包说明和 docs/protocol.md「线上形态」。
 */
export function createRemoteHandler(options: RemoteHandlerOptions): RemoteHandler {
  const { store, harness, orchestrator } = options;
  const executors = executorTable(options.executors);
  const basePath = normalizePath(options.basePath ?? '');
  const limit = options.maxBodyBytes ?? 4 * 1024 * 1024;
  const pollIntervalMs = options.pollIntervalMs ?? 250;
  const retainMs = options.retainResultsMs ?? 10 * 60_000;
  const logger = options.logger ?? silentLogger;
  const hosts = options.allowedHosts ? lowered(options.allowedHosts) : undefined;
  const origins = lowered(options.allowedOrigins ?? []);

  /** 正在跑的 harness 运行：`DELETE /runs/:id` 和断开都会中止它。 */
  const activeRuns = new Map<string, AbortController>();
  const pendingCancels = new Map<string, ReturnType<typeof setTimeout>>();
  /** 经这个服务提交给编排器的运行，留着结果给客户端取。 */
  const submitted = new Map<string, SubmittedRun>();

  // ---- 会话 ----

  async function sessions(method: string, rest: string[], url: URL, req: IncomingMessage, res: ServerResponse) {
    const sessionStore = need(store, 'a session store');
    const [session, sub, tail, extra] = rest;
    if (session === undefined) {
      if (method !== 'GET') fail(405, 'use GET /sessions');
      sendJson(res, 200, { sessions: await sessionStore.sessions() });
      return;
    }
    if (sub === undefined) {
      if (method !== 'DELETE') fail(405, 'use DELETE /sessions/:session');
      sendJson(res, 200, { deleted: await sessionStore.clear(session) });
      return;
    }
    if (sub !== 'entries' || extra !== undefined) fail(404, `not found: ${url.pathname}`);
    if (tail === 'stream') {
      if (method !== 'GET') fail(405, 'use GET /sessions/:session/entries/stream');
      await watchEntries(sessionStore, session, afterParam(url.searchParams), res);
      return;
    }
    if (tail !== undefined) fail(404, `not found: ${url.pathname}`);
    if (method === 'GET') {
      sendJson(res, 200, { entries: await sessionStore.list(session, listOptionsOf(url.searchParams)) });
      return;
    }
    if (method !== 'POST') fail(405, 'use GET or POST /sessions/:session/entries');
    const body = await readBody(req, limit);
    const entries = isObject(body) ? body['entries'] : undefined;
    if (!Array.isArray(entries)) fail(400, 'request body must be { "entries": NewEntry[] }');
    sendJson(res, 200, { entries: await sessionStore.append(session, entries as NewEntry[]) });
  }

  async function watchEntries(
    sessionStore: SessionStore,
    session: string,
    after: number | undefined,
    res: ServerResponse,
  ): Promise<void> {
    const controller = new AbortController();
    res.on('close', () => controller.abort());
    const { signal } = controller;
    const write = startStream(res);
    try {
      if (sessionStore.watch) {
        for await (const entry of sessionStore.watch(session, { ...(after !== undefined ? { after } : {}), signal })) {
          await write(entry);
        }
      } else {
        let position = after;
        while (!signal.aborted) {
          const entries: Entry[] = await sessionStore.list(session, position !== undefined ? { after: position } : {});
          for (const entry of entries) await write(entry);
          const last = entries.at(-1);
          if (last) position = last.seq;
          await sleep(pollIntervalMs, signal);
        }
      }
    } catch (error) {
      if (!signal.aborted) await write({ error: { message: messageOf(error), type: 'server_error' } });
    }
    res.end();
  }

  // ---- 执行环境 ----

  async function executorRoutes(method: string, rest: string[], url: URL, req: IncomingMessage, res: ServerResponse) {
    if (executors.size === 0) fail(404, 'this server does not serve executors');
    const [name, action, extra] = rest;
    if (name === undefined) {
      if (method !== 'GET') fail(405, 'use GET /executors');
      sendJson(res, 200, { executors: [...executors.keys()] });
      return;
    }
    const executor = executors.get(name);
    if (!executor) fail(404, `no executor named "${name}"; available: ${[...executors.keys()].join(', ')}`);
    if (extra !== undefined) fail(404, `not found: ${url.pathname}`);
    if (action === 'tools') {
      if (method !== 'GET') fail(405, 'use GET /executors/:name/tools');
      sendJson(res, 200, { tools: executor.tools ? await executor.tools() : [] });
      return;
    }
    if (action !== 'execute') fail(404, `not found: ${url.pathname}`);
    if (method !== 'POST') fail(405, 'use POST /executors/:name/execute');
    const body = await readBody(req, limit);
    const call = isObject(body) ? body['call'] : undefined;
    const context = isObject(body) ? body['context'] : undefined;
    if (!isObject(call) || typeof call['id'] !== 'string' || typeof call['name'] !== 'string') {
      fail(400, 'request body must be { "call": { "id", "name", "input" }, "context": { "session", "runId"? } }');
    }
    if (!isObject(context) || typeof context['session'] !== 'string') fail(400, 'context.session must be a string');
    const controller = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) controller.abort(new Error('Client disconnected.'));
    });
    const execution: ExecutionContext = {
      session: context['session'],
      ...(typeof context['runId'] === 'string' ? { runId: context['runId'] } : {}),
      signal: controller.signal,
    };
    const output = await executor.execute(
      { id: call['id'], name: call['name'], input: call['input'] ?? null } as ToolCall,
      execution,
    );
    sendJson(res, 200, { output });
  }

  // ---- Harness ----

  function cancelLater(runId: string): void {
    if (pendingCancels.size >= MAX_PENDING_CANCELS) {
      const [oldest] = pendingCancels.keys();
      if (oldest !== undefined) {
        clearTimeout(pendingCancels.get(oldest));
        pendingCancels.delete(oldest);
      }
    }
    const timer = setTimeout(() => pendingCancels.delete(runId), PENDING_CANCEL_MS);
    timer.unref?.();
    pendingCancels.set(runId, timer);
  }

  function takePendingCancel(runId: string): boolean {
    const timer = pendingCancels.get(runId);
    if (timer === undefined) return false;
    clearTimeout(timer);
    pendingCancels.delete(runId);
    return true;
  }

  async function runs(method: string, rest: string[], url: URL, req: IncomingMessage, res: ServerResponse) {
    const runner = need(harness, 'a harness');
    const [runId, extra] = rest;
    if (runId !== undefined) {
      if (extra !== undefined) fail(404, `not found: ${url.pathname}`);
      if (method !== 'DELETE') fail(405, 'use DELETE /runs/:runId');
      const active = activeRuns.get(runId);
      if (active && !active.signal.aborted) {
        active.abort(new Error('Run cancelled.'));
        sendJson(res, 200, { cancelled: true });
        return;
      }
      // 请求可能还在路上：记下来，它到了就以已中止开始。
      if (!active) cancelLater(runId);
      sendJson(res, 200, { cancelled: false });
      return;
    }
    if (method !== 'POST') fail(405, 'use POST /runs');
    const { aborted, ...wire } = runRequestOf(await readBody(req, limit));
    const id = wire.runId ?? crypto.randomUUID();
    if (activeRuns.has(id)) fail(409, `run "${id}" is already running`);
    const controller = new AbortController();
    activeRuns.set(id, controller);
    res.on('close', () => {
      if (!res.writableFinished) controller.abort(new Error('Client disconnected.'));
    });
    if (aborted || takePendingCancel(id)) controller.abort(new Error('Run cancelled before it started.'));
    const request: RunRequest = { ...wire, runId: id, signal: controller.signal };
    try {
      if (url.searchParams.get('stream') === '1') await streamRun(runner, request, res);
      else sendJson(res, 200, await runner.run(request));
    } finally {
      activeRuns.delete(id);
    }
  }

  async function streamRun(runner: Harness, request: RunRequest, res: ServerResponse): Promise<void> {
    const write = startStream(res);
    try {
      if (runner.stream) {
        for await (const event of runner.stream(request)) await write(event);
      } else {
        // 没有 stream 的 harness：跑完再给出首尾两个事件。
        const runId = request.runId!;
        await write({ type: 'run.started', runId, session: request.session } satisfies RunEvent);
        const { messages: _messages, recorded: _recorded, ...result } = await runner.run(request);
        if (result.error) await write({ type: 'error', runId, message: result.error.message } satisfies RunEvent);
        await write({ type: 'run.ended', runId, result } satisfies RunEvent);
      }
    } catch (error) {
      logger.warn('remote run stream failed', { error: messageOf(error) });
      await write({ error: { message: messageOf(error), type: 'harness_error' } });
    }
    res.end();
  }

  // ---- 编排器 ----

  function remember(runId: string, session: string, done: Promise<RunResult>): void {
    const record: SubmittedRun = {
      session,
      done: done.then(
        (result) => void (record.result = result),
        (error: unknown) => void (record.error = { message: messageOf(error), type: 'harness_error' }),
      ),
    };
    const forget = (): void => {
      const timer = setTimeout(() => {
        if (submitted.get(runId) === record) submitted.delete(runId);
      }, retainMs);
      timer.unref?.();
    };
    void record.done.finally(forget);
    submitted.set(runId, record);
  }

  async function orchestratorRoutes(
    method: string,
    rest: string[],
    url: URL,
    req: IncomingMessage,
    res: ServerResponse,
  ) {
    const queue = need(orchestrator, 'an orchestrator');
    const [resource, runId, extra] = rest;
    if (resource === 'events' && runId === undefined) {
      if (method !== 'GET') fail(405, 'use GET /orchestrator/events');
      if (!queue.events) fail(404, 'this orchestrator does not publish events');
      const controller = new AbortController();
      res.on('close', () => controller.abort());
      // 先订阅再回响应头：客户端拿到响应头以后提交的运行，事件一定在这条流里。
      const iterator = queue.events({ signal: controller.signal })[Symbol.asyncIterator]();
      const first = iterator.next();
      const write = startStream(res);
      try {
        for (let next = await first; !next.done; next = await iterator.next()) await write(next.value);
      } catch (error) {
        if (!controller.signal.aborted) await write({ error: { message: messageOf(error), type: 'server_error' } });
      } finally {
        await iterator.return?.();
      }
      res.end();
      return;
    }
    if (resource === 'recover' && runId === undefined) {
      if (method !== 'POST') fail(405, 'use POST /orchestrator/recover');
      if (!queue.recover) fail(404, 'this orchestrator does not support recover');
      sendJson(res, 200, { recovered: await queue.recover() });
      return;
    }
    if (resource !== 'runs' || extra !== undefined) fail(404, `not found: ${url.pathname}`);
    if (runId === undefined) {
      if (method !== 'POST') fail(405, 'use POST /orchestrator/runs');
      const { aborted, ...wire } = runRequestOf(await readBody(req, limit));
      const handle = await queue.submit({ ...wire, ...(aborted ? { signal: AbortSignal.abort() } : {}) });
      remember(handle.runId, handle.session, handle.done);
      sendJson(res, 200, { runId: handle.runId, session: handle.session });
      return;
    }
    if (method === 'DELETE') {
      sendJson(res, 200, { cancelled: await queue.cancel(runId) });
      return;
    }
    if (method !== 'GET') fail(405, 'use GET or DELETE /orchestrator/runs/:runId');
    let status = await queue.status(runId);
    if (status === undefined) fail(404, `no run "${runId}"`, 'not_found_error');
    const record = submitted.get(runId);
    const wait = Math.min(Number(url.searchParams.get('wait') ?? 0) || 0, MAX_WAIT_MS);
    if (record && wait > 0 && !TERMINAL.includes(status)) {
      const controller = new AbortController();
      const stop = (): void => controller.abort();
      res.on('close', stop);
      await Promise.race([record.done, sleep(wait, controller.signal)]);
      controller.abort();
      res.off('close', stop);
      status = (await queue.status(runId)) ?? status;
    }
    if (record && TERMINAL.includes(status)) await record.done;
    sendJson(res, 200, {
      runId,
      status,
      ...(record ? { session: record.session } : {}),
      ...(record?.result ? { result: record.result } : {}),
      ...(record?.error ? { error: record.error } : {}),
    });
  }

  return async (req, res) => {
    if (hosts && !hosts.has(req.headers.host?.toLowerCase() ?? '')) {
      sendError(res, 403, { message: 'host not allowed', type: 'permission_error' });
      return;
    }
    const origin = req.headers.origin;
    if (origin !== undefined && !origins.has(origin.toLowerCase())) {
      sendError(res, 403, { message: 'origin not allowed', type: 'permission_error' });
      return;
    }
    const url = new URL(req.url ?? '/', 'http://remote.local');
    if (basePath && url.pathname !== basePath && !url.pathname.startsWith(`${basePath}/`)) {
      sendError(res, 404, { message: `not found: ${url.pathname}`, type: 'not_found_error' });
      return;
    }
    if (!authorized(req, options.accessToken)) {
      sendError(res, 401, {
        message: 'unauthorized: send Authorization: Bearer <token>',
        type: 'authentication_error',
      });
      return;
    }
    const method = req.method ?? 'GET';
    try {
      const segments = url.pathname
        .slice(basePath.length)
        .split('/')
        .filter((part) => part !== '')
        .map((part) => {
          try {
            return decodeURIComponent(part);
          } catch {
            return fail(400, `bad path segment: ${part}`);
          }
        });
      const [group, ...rest] = segments;
      switch (group) {
        case 'sessions':
          await sessions(method, rest, url, req, res);
          break;
        case 'executors':
          await executorRoutes(method, rest, url, req, res);
          break;
        case 'runs':
          await runs(method, rest, url, req, res);
          break;
        case 'orchestrator':
          await orchestratorRoutes(method, rest, url, req, res);
          break;
        default:
          fail(404, `not found: ${url.pathname}`);
      }
    } catch (error) {
      const failure = failureOf(error);
      if (failure) {
        sendError(res, failure.status, failure.info);
        return;
      }
      logger.warn('remote request failed', { method, path: url.pathname, error: messageOf(error) });
      sendError(res, 500, { message: messageOf(error), type: 'server_error' });
    }
  };
}

/** 起一个只听本机的服务。Host 头缺省只认监听地址（见 `allowedHosts`）。 */
export function startRemote(options: StartRemoteOptions): Promise<RemoteServer> {
  const host = options.host ?? '127.0.0.1';
  const basePath = normalizePath(options.basePath ?? '');
  // 端口要等监听上才知道，处理函数到那时再建。
  let handler: RemoteHandler | undefined;
  const server = createServer((req, res) => {
    if (handler) void handler(req, res);
    else sendError(res, 503, { message: 'server is starting', type: 'server_error', retryable: true });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, host, () => {
      server.off('error', reject);
      const { port } = server.address() as AddressInfo;
      handler = createRemoteHandler({ ...options, allowedHosts: options.allowedHosts ?? defaultHosts(host, port) });
      const origin = `http://${host.includes(':') ? `[${host}]` : host}:${port}`;
      resolve({
        origin,
        baseUrl: `${origin}${basePath}`,
        close: () =>
          new Promise<void>((done, failClose) => {
            server.close((error) => (error ? failClose(error) : done()));
            server.closeAllConnections();
          }),
      });
    });
  });
}

export { isRemoteError, type ErrorBody, type RemoteError, type WireRunRequest } from './wire.ts';
