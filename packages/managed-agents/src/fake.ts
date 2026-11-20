// 测试用的假 Managed Agents 接口（`@modelctx-ai/ctx-managed-agents/testing`）：`new Anthropic({ baseURL: fake.url })` 指过来，
// 会话、事件、事件流（SSE）按接口文档的形状回，模型按剧本回答。形状照 `@anthropic-ai/sdk` 1.10.0 的类型写，没有和真实服务比对过。
//
// 只做适配器用到的：建会话（`agent_with_overrides`）、取会话、改工具、发事件（用户消息、自定义工具结果、确认、中断）、
// 读事件（按类型、顺序、条数、`created_at[gte]` 筛）、事件流（`event_deltas` 要预览时带 `event_start`、`event_delta`）。
// 剧本是全局的：所有会话按顺序取下一步，和契约测试的 `ModelScript` 一样。
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { JsonObject } from '@modelctx-ai/ctx-protocol';

/**
 * 剧本的一步，和契约测试的 `ModelScriptStep` 同形状，多几种：`tool-calls` 一条消息里先说一段话再并行调几次工具，
 * `builtin` 调一次 Managed Agents 那边的内置工具（`permission: 'ask'` 时停下等确认，结果是 `result`）。共有的可选项：
 * `delayMs` 先等一会儿再回答（测取消、超时），`drop` 这一步开始后断开事件流（事件照样落库，测重连），`compact` 这一步
 * 之前先压缩一次上下文。
 */
export type FakeManagedAgentsStep = (
  | { readonly type: 'text'; readonly text: string; readonly truncated?: boolean }
  | { readonly type: 'tool-call'; readonly id: string; readonly input: JsonObject; readonly tool?: string }
  | {
      readonly type: 'tool-calls';
      readonly text?: string;
      readonly calls: readonly { readonly id: string; readonly input: JsonObject; readonly tool?: string }[];
    }
  | {
      readonly type: 'builtin';
      readonly id: string;
      readonly name: string;
      readonly input: JsonObject;
      readonly permission?: 'allow' | 'ask';
      readonly result?: string;
    }
  | { readonly type: 'error'; readonly message: string }
) & { readonly delayMs?: number; readonly drop?: boolean; readonly compact?: boolean };

export interface FakeManagedAgentsOptions {
  readonly script: readonly FakeManagedAgentsStep[];
  /** `tool-call` 调哪个自定义工具，缺省 `echo`。 */
  readonly tool?: string;
}

/** 一个假会话：建会话的请求、现在的 agent（模型、指令、工具）、落了库的事件、收到的用户事件。 */
export interface FakeManagedAgentsSession {
  readonly id: string;
  readonly request: JsonObject;
  readonly agent: { readonly model: string; readonly system: string | null; readonly tools: readonly JsonObject[] };
  readonly status: 'idle' | 'running' | 'terminated';
  readonly events: readonly JsonObject[];
  readonly received: readonly JsonObject[];
}

export interface FakeManagedAgents {
  /** 给 `new Anthropic({ baseURL })`。 */
  readonly url: string;
  /** 按建的顺序。 */
  readonly sessions: readonly FakeManagedAgentsSession[];
  /** 收到的请求：方法和路径（不带查询）。 */
  readonly requests: readonly { readonly method: string; readonly path: string }[];
  /** 让一个会话结束（`terminated`）或者删掉它（之后取它是 404）。 */
  end(session: string, how: 'terminate' | 'delete'): void;
  close(): Promise<void>;
}

interface Subscriber {
  readonly res: ServerResponse;
  readonly deltas: boolean;
}

interface State {
  readonly id: string;
  readonly request: JsonObject;
  agent: { model: string; system: string | null; tools: JsonObject[]; id: string; version: number };
  status: 'idle' | 'running' | 'terminated';
  archived: boolean;
  readonly events: JsonObject[];
  readonly received: JsonObject[];
  readonly subscribers: Set<Subscriber>;
  /** 停着等的调用（自定义工具、等确认的内置工具）。 */
  readonly blocking: Map<string, { readonly kind: 'custom' | 'confirm'; readonly result?: string }>;
  /** 每次开始或中断一轮加一：剧本放到一半被中断的，按它认出来不再往下放。 */
  generation: number;
  readonly createdAt: string;
}

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('error', reject);
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      try {
        const value = text ? (JSON.parse(text) as unknown) : {};
        resolve(typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {});
      } catch {
        resolve({});
      }
    });
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) }).end(text);
}

function apiError(res: ServerResponse, status: number, type: string, message: string): void {
  json(res, status, { type: 'error', error: { type, message } });
}

function usage(output: number): JsonObject {
  return { input_tokens: 20, output_tokens: output, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
}

function stringOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function createFakeManagedAgents(options: FakeManagedAgentsOptions): Promise<FakeManagedAgents> {
  const wanted = options.tool ?? 'echo';
  const sessions = new Map<string, State>();
  const order: State[] = [];
  const requests: { method: string; path: string }[] = [];
  let next = 0;
  let ids = 0;
  let clock = Date.now();
  const now = (): string => {
    clock = Math.max(Date.now(), clock + 1);
    return new Date(clock).toISOString();
  };
  const newId = (prefix: string): string => `${prefix}_fake_${String((ids += 1)).padStart(6, '0')}`;

  function sessionObject(state: State): JsonObject {
    return {
      id: state.id,
      type: 'session',
      status: state.status,
      archived_at: state.archived ? state.createdAt : null,
      created_at: state.createdAt,
      updated_at: now(),
      environment_id: typeof state.request['environment_id'] === 'string' ? state.request['environment_id'] : '',
      metadata: {},
      title: null,
      budget: null,
      resources: [],
      vault_ids: [],
      outcome_evaluations: [],
      stats: {},
      usage: {},
      agent: {
        id: state.agent.id,
        version: state.agent.version,
        type: 'agent',
        name: 'fake',
        description: null,
        model: { id: state.agent.model },
        system: state.agent.system,
        tools: state.agent.tools,
        mcp_servers: [],
        skills: [],
      },
    };
  }

  /** 落库并推给订阅方；预览事件（`event_start`、`event_delta`）只推给要了预览的，不落库。 */
  function emit(state: State, event: JsonObject): void {
    const preview = event['type'] === 'event_start' || event['type'] === 'event_delta';
    if (!preview) state.events.push(event);
    for (const subscriber of state.subscribers) {
      if (preview && !subscriber.deltas) continue;
      subscriber.res.write(`event: ${stringOf(event['type'])}\ndata: ${JSON.stringify(event)}\n\n`);
    }
  }

  function persisted(state: State, type: string, fields: JsonObject = {}): JsonObject {
    const event = { id: newId('sevt'), type, processed_at: now(), ...fields };
    emit(state, event);
    return event;
  }

  function idle(state: State, stopReason: JsonObject): void {
    state.status = 'idle';
    persisted(state, 'session.status_idle', { stop_reason: stopReason, stop_details: null });
  }

  function customToolName(state: State, tool = wanted): string {
    const names = state.agent.tools.flatMap((item) =>
      item['type'] === 'custom' && typeof item['name'] === 'string' ? [item['name']] : [],
    );
    return names.find((name) => name === tool) ?? tool;
  }

  /** 一段话：预览增量（两截）、缓冲的 `agent.message`。 */
  function say(state: State, text: string): void {
    const id = newId('sevt');
    emit(state, { type: 'event_start', event: { type: 'agent.message', id } });
    const half = Math.ceil(text.length / 2);
    for (const chunk of [text.slice(0, half), text.slice(half)]) {
      if (chunk) {
        emit(state, {
          type: 'event_delta',
          event_id: id,
          delta: { type: 'content_delta', index: 0, content: { type: 'text', text: chunk } },
        });
      }
    }
    emit(state, { id, type: 'agent.message', processed_at: now(), content: [{ type: 'text', text }] });
  }

  /** 开始一轮：取剧本的下一步放出来，放完停下（或者接着放下一步）。中断了的不再往下放。 */
  async function play(state: State): Promise<void> {
    const generation = (state.generation += 1);
    if (state.status !== 'running') {
      state.status = 'running';
      persisted(state, 'session.status_running');
    }
    const step: FakeManagedAgentsStep = options.script[next++] ?? {
      type: 'error',
      message: 'The fake Managed Agents script is exhausted.',
    };
    if (step.delayMs) await sleep(step.delayMs);
    if (generation !== state.generation || state.status !== 'running') return;
    if (step.compact) persisted(state, 'agent.thread_context_compacted');
    const start = persisted(state, 'span.model_request_start');
    if (step.drop) {
      // 断开事件流：之后的事件照样落库，重连的从历史里补。
      for (const subscriber of state.subscribers) subscriber.res.destroy();
      state.subscribers.clear();
    }
    const end = (output: number, isError = false): void => {
      persisted(state, 'span.model_request_end', {
        model_request_start_id: start['id'] as string,
        model_usage: usage(output),
        is_error: isError,
      });
    };
    switch (step.type) {
      case 'text':
        say(state, step.text);
        end(5);
        idle(state, { type: 'end_turn' });
        return;
      case 'error':
        persisted(state, 'session.error', {
          error: { type: 'model_request_failed_error', message: step.message, retry_status: { type: 'exhausted' } },
        });
        end(0, true);
        idle(state, { type: 'retries_exhausted' });
        return;
      case 'tool-call':
      case 'tool-calls': {
        const calls = step.type === 'tool-call' ? [step] : step.calls;
        if (step.type === 'tool-calls' && step.text) say(state, step.text);
        for (const call of calls) {
          emit(state, {
            id: call.id,
            type: 'agent.custom_tool_use',
            processed_at: now(),
            name: customToolName(state, call.tool),
            input: call.input,
          });
          state.blocking.set(call.id, { kind: 'custom' });
        }
        end(5);
        idle(state, { type: 'requires_action', event_ids: calls.map((call) => call.id) });
        return;
      }
      case 'builtin': {
        const ask = step.permission === 'ask';
        emit(state, {
          id: step.id,
          type: 'agent.tool_use',
          processed_at: now(),
          name: step.name,
          input: step.input,
          evaluated_permission: ask ? 'ask' : 'allow',
          evaluation: ask ? { type: 'always_ask' } : { type: 'always_allow' },
        });
        end(5);
        if (ask) {
          state.blocking.set(step.id, {
            kind: 'confirm',
            ...(step.result !== undefined ? { result: step.result } : {}),
          });
          idle(state, { type: 'requires_action', event_ids: [step.id] });
          return;
        }
        persisted(state, 'agent.tool_result', {
          tool_use_id: step.id,
          content: [{ type: 'text', text: step.result ?? 'ok' }],
          is_error: false,
        });
        return play(state);
      }
    }
  }

  /** 收到了结：都了结了就接着跑，还剩的再停一次（同真实服务：了结一部分时带着剩下的再发一次 idle）。 */
  function settle(state: State, id: string, outcome: { readonly allow?: boolean; readonly message?: string }): void {
    const blocked = state.blocking.get(id);
    if (!blocked) return;
    state.blocking.delete(id);
    if (blocked.kind === 'confirm') {
      persisted(state, 'agent.tool_result', {
        tool_use_id: id,
        content: [{ type: 'text', text: outcome.allow ? (blocked.result ?? 'ok') : (outcome.message ?? 'denied') }],
        is_error: !outcome.allow,
      });
    }
  }

  async function receive(state: State, events: readonly Record<string, unknown>[], res: ServerResponse): Promise<void> {
    const waiting = state.status === 'idle' && state.blocking.size > 0;
    if (state.status === 'terminated')
      return apiError(res, 400, 'invalid_request_error', 'The session has terminated.');
    for (const event of events) {
      const type = event['type'];
      if (type === 'user.message' && (waiting || state.status === 'running')) {
        return apiError(
          res,
          400,
          'invalid_request_error',
          waiting
            ? 'The session is waiting on tool calls; only user.tool_confirmation, user.tool_result, user.custom_tool_result and user.interrupt are accepted.'
            : 'fake: the session is running; this fake does not queue user messages.',
        );
      }
    }
    const echoed: JsonObject[] = [];
    let resume = false;
    for (const event of events) {
      const type = stringOf(event['type']);
      state.received.push(event as JsonObject);
      const echo = persisted(
        state,
        type,
        Object.fromEntries(Object.entries(event).filter(([key]) => key !== 'type')) as JsonObject,
      );
      echoed.push(echo);
      if (type === 'user.interrupt') {
        if (state.status === 'running') {
          state.generation += 1;
          idle(state, { type: 'end_turn' });
        }
      } else if (type === 'user.custom_tool_result') {
        settle(state, stringOf(event['custom_tool_use_id']), {});
        resume = true;
      } else if (type === 'user.tool_confirmation') {
        const message = typeof event['deny_message'] === 'string' ? event['deny_message'] : undefined;
        settle(state, stringOf(event['tool_use_id']), {
          allow: event['result'] === 'allow',
          ...(message !== undefined ? { message } : {}),
        });
        resume = true;
      } else if (type === 'user.message') {
        resume = true;
      }
    }
    json(res, 200, { data: echoed });
    if (!resume || state.status !== 'idle') return;
    if (state.blocking.size > 0) {
      idle(state, { type: 'requires_action', event_ids: [...state.blocking.keys()] });
      return;
    }
    // 先回了请求再放剧本：调用方拿到回应之后才看到这一轮的事件。
    setImmediate(() => void play(state));
  }

  function create(body: Record<string, unknown>): State {
    const agent = body['agent'];
    const overrides = typeof agent === 'object' && agent !== null ? (agent as Record<string, unknown>) : {};
    const state: State = {
      id: newId('sesn'),
      request: body as JsonObject,
      agent: {
        id: typeof agent === 'string' ? agent : typeof overrides['id'] === 'string' ? overrides['id'] : 'agent_fake',
        version: typeof overrides['version'] === 'number' ? overrides['version'] : 1,
        model: typeof overrides['model'] === 'string' ? overrides['model'] : 'claude-fake',
        system: typeof overrides['system'] === 'string' ? overrides['system'] : null,
        tools: Array.isArray(overrides['tools']) ? (overrides['tools'] as JsonObject[]) : [],
      },
      status: 'idle',
      archived: false,
      events: [],
      received: [],
      subscribers: new Set(),
      blocking: new Map(),
      generation: 0,
      createdAt: now(),
    };
    sessions.set(state.id, state);
    order.push(state);
    return state;
  }

  function list(state: State, url: URL): JsonObject[] {
    const types = url.searchParams.getAll('types[]');
    const since = url.searchParams.get('created_at[gte]');
    const limit = Number(url.searchParams.get('limit') ?? '1000');
    let events = state.events.filter(
      (event) =>
        (types.length === 0 || types.includes(stringOf(event['type']))) &&
        (since === null || stringOf(event['processed_at']) >= since),
    );
    if (url.searchParams.get('order') === 'desc') events = events.toReversed();
    return events.slice(0, limit);
  }

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://fake.local');
      const method = req.method ?? 'GET';
      requests.push({ method, path: url.pathname });
      const body = method === 'POST' ? await readJson(req) : {};
      const parts = url.pathname.split('/').filter(Boolean);
      if (parts[0] !== 'v1' || parts[1] !== 'sessions')
        return apiError(res, 404, 'not_found_error', 'fake: no such route');
      if (parts.length === 2 && method === 'POST') return json(res, 200, sessionObject(create(body)));
      const state = sessions.get(parts[2] ?? '');
      if (!state) return apiError(res, 404, 'not_found_error', `fake: no session ${parts[2] ?? ''}`);
      if (parts.length === 3 && method === 'GET') return json(res, 200, sessionObject(state));
      if (parts.length === 3 && method === 'POST') {
        if (state.status === 'running') {
          return apiError(res, 400, 'invalid_request_error', 'The session can only be updated while it is idle.');
        }
        const agent = body['agent'];
        const tools =
          typeof agent === 'object' && agent !== null ? (agent as Record<string, unknown>)['tools'] : undefined;
        if (Array.isArray(tools)) state.agent.tools = tools as JsonObject[];
        return json(res, 200, sessionObject(state));
      }
      if (parts[3] !== 'events') return apiError(res, 404, 'not_found_error', 'fake: no such route');
      if (parts.length === 4 && method === 'POST') {
        const events = Array.isArray(body['events']) ? (body['events'] as Record<string, unknown>[]) : [];
        return receive(state, events, res);
      }
      if (parts.length === 4 && method === 'GET') return json(res, 200, { data: list(state, url), next_page: null });
      if (parts.length === 5 && parts[4] === 'stream' && method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        res.flushHeaders();
        const subscriber: Subscriber = {
          res,
          deltas: url.searchParams.getAll('event_deltas[]').includes('agent.message'),
        };
        state.subscribers.add(subscriber);
        req.on('close', () => state.subscribers.delete(subscriber));
        return;
      }
      return apiError(res, 404, 'not_found_error', 'fake: no such route');
    })().catch((error: unknown) => {
      if (!res.headersSent) apiError(res, 500, 'api_error', String(error));
      else res.destroy();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    get sessions() {
      return order.map((state) => ({
        id: state.id,
        request: state.request,
        agent: { model: state.agent.model, system: state.agent.system, tools: state.agent.tools },
        status: state.status,
        events: state.events,
        received: state.received,
      }));
    },
    requests,
    end(session, how) {
      const state = sessions.get(session);
      if (!state) return;
      state.generation += 1;
      if (how === 'delete') {
        persisted(state, 'session.deleted');
        sessions.delete(session);
      } else {
        state.status = 'terminated';
        persisted(state, 'session.status_terminated');
      }
      for (const subscriber of state.subscribers) subscriber.res.end();
      state.subscribers.clear();
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const state of sessions.values()) for (const subscriber of state.subscribers) subscriber.res.destroy();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
