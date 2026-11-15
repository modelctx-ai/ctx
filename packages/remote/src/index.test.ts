import { request as httpRequest } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createContextBuilder,
  createFunctionExecutor,
  createHarness,
  createMemoryStore,
  createOrchestrator,
  createToolRegistry,
  type LanguageModel,
} from '@modelctx-ai/ctx';
import { createScriptedModel } from '@modelctx-ai/ctx/testing';
import { createProcessExecutor } from '@modelctx-ai/ctx-exec';
import { createMemoryStore as createInMemoryMemoryStore } from '@modelctx-ai/ctx-memory';
import {
  CTX_EVENTS,
  CtxError,
  eventEntry,
  userEntry,
  type Entry,
  type Harness,
  type Orchestrator,
  type RunResult,
  type SessionStore,
} from '@modelctx-ai/ctx-protocol';
import {
  type ModelScriptStep,
  describeExecutorContract,
  describeHarnessContract,
  describeMemoryStoreContract,
  describeOrchestratorContract,
  describeSessionStoreContract,
} from '@modelctx-ai/ctx-protocol/testing';
import { afterAll, describe, expect, test } from 'vite-plus/test';

import {
  createRemoteExecutor,
  createRemoteHarness,
  createRemoteMemoryStore,
  createRemoteOrchestrator,
  createRemoteSessionStore,
  isRemoteError,
} from './index.ts';
import {
  createRemoteHandler,
  DEFAULT_ALLOWED_SETTINGS,
  startRemote,
  type RemoteServer,
  type StartRemoteOptions,
} from './server.ts';

const api = { describe, test };
const accessToken = 'test-token-0123456789';

const servers: RemoteServer[] = [];
afterAll(async () => {
  await Promise.all(servers.map((server) => server.close()));
});

async function serve(options: StartRemoteOptions): Promise<RemoteServer> {
  const server = await startRemote({ accessToken, ...options });
  servers.push(server);
  return server;
}

function urlOf(input: string | URL | Request): string {
  return input instanceof Request ? input.url : input.toString();
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function refuse(run: Promise<unknown>): Promise<unknown> {
  return run.catch((error: unknown) => error);
}

/** 第一次 `POST` 照常发到服务端，但把响应丢掉，装成连接在回程断了。 */
function losingFirstPost(): typeof fetch {
  let lost = false;
  return async (input, init) => {
    const response = await fetch(input, init);
    if (init?.method === 'POST' && !lost) {
      lost = true;
      await response.body?.cancel();
      throw new TypeError('fetch failed');
    }
    return response;
  };
}

function client(server: RemoteServer) {
  return { baseUrl: server.baseUrl, accessToken };
}

function waitForAbort(signal: AbortSignal | undefined, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/** 每次调用前先等一会儿，让「排队中」「运行中」在网络往返之后仍然成立。 */
function slow(model: ReturnType<typeof createScriptedModel>, ms: number): LanguageModel {
  const generate = model.doGenerate.bind(model);
  const stream = model.doStream.bind(model);
  model.doGenerate = async (options) => {
    await waitForAbort(options.abortSignal, ms);
    return generate(options);
  };
  model.doStream = async (options) => {
    await waitForAbort(options.abortSignal, ms);
    return stream(options);
  };
  return model;
}

/**
 * 服务端那一侧：核心包的内存存储 + 回显工具 + 按剧本回答的模型（名字 `scripted`）。
 * 回显工具的输入带 `wait: true` 时一直等到被取消（最多 5 秒），用来测中途断开。
 */
function localHarness(script: readonly ModelScriptStep[], delayMs = 0) {
  const store = createMemoryStore();
  const tools = createToolRegistry();
  tools.executor.register(
    { name: 'echo', description: '原样返回输入', inputSchema: { type: 'object' } },
    async (input, context) => {
      if ((input as { wait?: unknown } | null)?.wait === true) await waitForAbort(context.signal, 5_000);
      return { type: 'json', value: input };
    },
  );
  tools.add(tools.executor.definition('echo')!);
  const scripted = createScriptedModel(script);
  const model = delayMs > 0 ? slow(scripted, delayMs) : scripted;
  const harness = createHarness({ store, context: createContextBuilder({ store }), tools, models: () => model });
  return { store, harness };
}

const agent = { model: 'scripted' };

// ---- 契约测试：客户端一侧跑协议的契约 ----

describeSessionStoreContract(
  'remote（服务端：内存存储）',
  async ({ now }) => createRemoteSessionStore(client(await serve({ store: createMemoryStore({ now }) }))),
  api,
);

describeSessionStoreContract(
  'remote（服务端：没有 watch 的存储，轮询 list）',
  async ({ now }) => {
    const memory = createMemoryStore({ now });
    // 去掉 watch：服务端退回轮询 list(after)。
    const store: SessionStore = {
      append: (session, entries, options) => memory.append(session, entries, options),
      list: (session, options) => memory.list(session, options),
      clear: (session) => memory.clear(session),
      sessions: (options) => memory.sessions(options),
    };
    return createRemoteSessionStore(client(await serve({ store, pollIntervalMs: 20 })));
  },
  api,
);

describeExecutorContract(
  'remote（服务端：函数执行环境）',
  async () => {
    const local = createFunctionExecutor('fn').register(
      { name: 'echo', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
      (input) => ({ type: 'json', value: input }),
    );
    const server = await serve({ executors: [local] });
    return { executor: createRemoteExecutor({ ...client(server), name: 'fn' }), echo: 'echo' };
  },
  api,
);

describeExecutorContract(
  'remote（服务端：ctx-exec 子进程）',
  async () => {
    const local = createProcessExecutor({
      name: 'box',
      commands: { echo: { command: (input) => ['echo', String((input as { text?: unknown }).text)] } },
    });
    const server = await serve({ executors: { box: local } });
    return { executor: createRemoteExecutor({ ...client(server), name: 'box' }), echo: 'echo' };
  },
  api,
);

describeHarnessContract(
  'remote（服务端：核心包 harness）',
  async ({ script }) => {
    const { store, harness } = localHarness(script);
    const server = await serve({ store, harness });
    return {
      harness: createRemoteHarness(client(server)),
      // 日志也经远端读：同一个服务挂着存储。
      store: createRemoteSessionStore(client(server)),
      agent,
    };
  },
  api,
);

describeOrchestratorContract(
  'remote（服务端：核心包编排器）',
  async ({ script }) => {
    // 模型慢一点：第二轮提交、取消的请求到达时第一轮还在跑，第二轮还在排队。
    const { store, harness } = localHarness(script, 150);
    const server = await serve({ store, orchestrator: createOrchestrator({ harness, store }) });
    return {
      orchestrator: createRemoteOrchestrator(client(server)),
      store: createRemoteSessionStore(client(server)),
      agent,
    };
  },
  api,
);

describeMemoryStoreContract(
  'remote（服务端：ctx-memory 的内存存储）',
  async () => createRemoteMemoryStore(client(await serve({ memory: createInMemoryMemoryStore() }))),
  api,
);

// ---- harness 的流和中途断开 ----

function eventKinds(entries: readonly Entry[]): string[] {
  return entries.map((entry) =>
    entry.type === 'event' ? entry.kind : entry.type === 'message' ? entry.message.role : entry.type,
  );
}

function runEnded(entries: readonly Entry[]): unknown[] {
  return entries.flatMap((entry) =>
    entry.type === 'event' && entry.kind === CTX_EVENTS.runEnded
      ? [(entry.data as { stopReason?: unknown }).stopReason]
      : [],
  );
}

async function eventually<T>(read: () => Promise<T>, ok: (value: T) => boolean, ms = 3_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (ok(value) || Date.now() > deadline) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('远程 harness', () => {
  test('stream：事件顺序和进程内一样，工具结果在两次模型调用之间', async () => {
    const { store, harness } = localHarness([
      { type: 'tool-call', id: 'call-1', input: { text: 'marker-42' } },
      { type: 'text', text: '好了' },
    ]);
    const remote = createRemoteHarness(client(await serve({ harness })));
    const types: string[] = [];
    for await (const event of remote.stream({ session: 's', agent, input: '回显', runId: 'run-s' })) {
      expect(event.runId).toBe('run-s');
      types.push(event.type);
    }
    expect(types).toEqual([
      'run.started',
      'model.started',
      'tool.called',
      'tool.returned',
      'model.ended',
      'model.started',
      'text.delta',
      'model.ended',
      'run.ended',
    ]);
    expect(eventKinds(await store.list('s')).at(-1)).toBe(CTX_EVENTS.runEnded);
  });

  test('agent.settings 缺省不收 headers、providerOptions，allowedSettings 放行；allowedModels 之外的模型 400', async () => {
    const { harness } = localHarness([{ type: 'text', text: '好' }]);
    const strict = createRemoteHarness(client(await serve({ harness, allowedModels: ['other'] })));
    const post = (settings: Record<string, unknown>, remote = createRemoteHarness(client(server))) =>
      remote.run({ session: 's', agent: { ...agent, settings }, input: '在吗' });
    const server = await serve({ harness });

    for (const settings of [
      { headers: { authorization: 'Bearer x' } },
      { providerOptions: { openai: {} } },
      { nope: 1 },
    ]) {
      const error = await refuse(post(settings));
      expect(isRemoteError(error) && error.status).toBe(400);
      expect((error as Error).message).toMatch(/not accepted by this server/);
    }
    expect((await post({ temperature: 0.2, maxRetries: 0, timeoutMs: 5000 })).stopReason).toBe('end_turn');

    const wrongModel = await refuse(strict.run({ session: 's', agent, input: '在吗' }));
    expect(isRemoteError(wrongModel) && wrongModel.status).toBe(400);
    expect((wrongModel as Error).message).toMatch(/is not allowed by this server/);

    const open = localHarness([{ type: 'text', text: '好' }]);
    const allowed = await serve({
      harness: open.harness,
      allowedModels: [agent.model],
      allowedSettings: [...DEFAULT_ALLOWED_SETTINGS, 'headers'],
    });
    const result = await post({ headers: { 'x-trace': 'abc' } }, createRemoteHarness(client(allowed)));
    expect(result.stopReason).toBe('end_turn');
    const started = (await open.store.list('s')).find(
      (entry) => entry.type === 'event' && entry.kind === CTX_EVENTS.runStarted,
    );
    expect(JSON.stringify(started)).not.toContain('abc');
    expect(JSON.stringify(started)).toContain('"x-trace":"[redacted]"');
  });

  test('stream：客户端中途不读了，服务端中止这一轮并写 ctx.run.ended（aborted）', async () => {
    const { store, harness } = localHarness([
      { type: 'tool-call', id: 'call-1', input: { wait: true } },
      { type: 'text', text: '不该到这里' },
    ]);
    const remote = createRemoteHarness(client(await serve({ harness })));
    const started = Date.now();
    for await (const event of remote.stream({ session: 's', agent, input: '等着' })) {
      if (event.type === 'tool.called') break;
    }
    const log = await eventually(
      () => store.list('s'),
      (entries) => runEnded(entries).length > 0,
    );
    expect(runEnded(log)).toEqual(['aborted']);
    expect(Date.now() - started).toBeLessThan(4_000);
  });

  test('run：signal 中途中止，服务端取消这一轮，run 照常返回 aborted', async () => {
    const { store, harness } = localHarness([
      { type: 'tool-call', id: 'call-1', input: { wait: true } },
      { type: 'text', text: '不该到这里' },
    ]);
    const remote = createRemoteHarness(client(await serve({ harness })));
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 150);
    const result = await remote.run({ session: 's', agent, input: '等着', signal: controller.signal });
    expect(result.stopReason).toBe('aborted');
    expect(runEnded(await store.list('s'))).toEqual(['aborted']);
  });

  test('模型不是名字时客户端直接抛，服务端拒绝', async () => {
    const server = await serve({ harness: localHarness([]).harness });
    const remote = createRemoteHarness(client(server));
    const model = createScriptedModel([]);
    await expect(remote.run({ session: 's', agent: { model }, input: 'x' })).rejects.toThrow(/model name string/);
    const response = await fetch(`${server.baseUrl}/runs`, {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ session: 's', agent: { model: { provider: 'x' } } }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: {
        message: 'RunRequest.agent.model must be a model name string; model objects cannot cross the boundary',
        type: 'invalid_request_error',
      },
    });
  });
});

// ---- 鉴权和安全缺省 ----

function guardedServer(): Promise<RemoteServer> {
  return serve({ store: createMemoryStore(), maxBodyBytes: 1_024 });
}

describe('会话的条目分页', () => {
  test('服务端一次最多回 maxListEntries 条并带 more；客户端的 list 自己接着读，结果不变', async () => {
    const store = createMemoryStore();
    await store.append(
      's',
      Array.from({ length: 10 }, (_, i) => userEntry(String(i + 1))),
    );
    const server = await serve({ store, maxListEntries: 3 });
    const raw = await fetch(`${server.baseUrl}/sessions/s/entries`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    const body = (await raw.json()) as { entries: unknown[]; more?: boolean };
    expect([body.entries.length, body.more]).toEqual([3, true]);

    const remote = createRemoteSessionStore(client(server));
    const texts = async (options?: Parameters<typeof remote.list>[1]) =>
      (await remote.list('s', options)).map((entry) => (entry.type === 'message' ? entry.message.content : ''));
    expect(await texts()).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10']);
    expect(await texts({ after: 4, limit: 5 })).toEqual(['5', '6', '7', '8', '9']);
    expect(await texts({ limit: 2 })).toEqual(['1', '2']);
    expect(await texts({ last: 2 })).toEqual(['9', '10']);
  });

  test('没有 watch 的存储：轮询一页一页读，长会话也读得完', async () => {
    const inner = createMemoryStore();
    await inner.append(
      's',
      Array.from({ length: 10 }, (_, i) => userEntry(String(i + 1))),
    );
    const store: SessionStore = {
      append: (session, entries, options) => inner.append(session, entries, options),
      list: (session, options) => inner.list(session, options),
      clear: (session) => inner.clear(session),
      sessions: (options) => inner.sessions(options),
    };
    const remote = createRemoteSessionStore(client(await serve({ store, maxListEntries: 3, pollIntervalMs: 5 })));
    const controller = new AbortController();
    const seen: number[] = [];
    for await (const entry of remote.watch('s', { signal: controller.signal })) {
      seen.push(entry.seq);
      if (seen.length === 10) controller.abort();
    }
    expect(seen).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });
});

describe('鉴权和安全缺省', () => {
  test('没带或带错 token 是 401', async () => {
    const { baseUrl } = await guardedServer();
    expect((await fetch(`${baseUrl}/sessions`)).status).toBe(401);
    const wrong = await fetch(`${baseUrl}/sessions`, { headers: { authorization: 'Bearer nope' } });
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toEqual({
      error: { message: 'unauthorized: send Authorization: Bearer <token>', type: 'authentication_error' },
    });
    const lower = await fetch(`${baseUrl}/sessions`, { headers: { authorization: `bearer ${accessToken}` } });
    expect(lower.status).toBe(200);
    const store = createRemoteSessionStore({ baseUrl, accessToken: 'wrong' });
    const error: unknown = await store.sessions().catch((caught: unknown) => caught);
    expect(isRemoteError(error) && [error.status, error.type]).toEqual([401, 'authentication_error']);
  });

  test('空的 accessToken 直接报错；听在非本机地址上没有 token 就不启动', async () => {
    const store = createMemoryStore();
    for (const empty of ['', '   ']) {
      expect(() => createRemoteHandler({ store, accessToken: empty })).toThrow(/`accessToken` is empty/);
      await expect(startRemote({ store, accessToken: empty })).rejects.toThrow(/`accessToken` is empty/);
    }
    await expect(startRemote({ store, host: '0.0.0.0' })).rejects.toThrow(/Refusing to listen on 0\.0\.0\.0/);
    for (const extra of [{ accessToken: 't' }, { allowUnauthenticated: true }]) {
      const open = await startRemote({ store, host: '0.0.0.0', ...extra });
      await open.close();
    }
  });

  test('带 Origin 是 403，除非在白名单', async () => {
    const { baseUrl } = await guardedServer();
    const headers = { authorization: `Bearer ${accessToken}`, origin: 'https://evil.example' };
    expect((await fetch(`${baseUrl}/sessions`, { headers })).status).toBe(403);
    const allowed = await serve({ store: createMemoryStore(), allowedOrigins: ['https://app.example'] });
    const ok = await fetch(`${allowed.baseUrl}/sessions`, { headers: { ...headers, origin: 'https://app.example' } });
    expect(ok.status).toBe(200);
  });

  test('Host 只认监听地址', async () => {
    const { origin } = await guardedServer();
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = httpRequest(
        `${origin}/sessions`,
        { headers: { host: 'attacker.example', authorization: `Bearer ${accessToken}` } },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        },
      );
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(403);
  });

  test('超过 body 上限是 413', async () => {
    const { baseUrl } = await guardedServer();
    const response = await fetch(`${baseUrl}/sessions/s/entries`, {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ entries: [{ type: 'message', message: { role: 'user', content: 'x'.repeat(2_000) } }] }),
    });
    expect(response.status).toBe(413);
    expect(((await response.json()) as { error: { type: string } }).error.type).toBe('request_too_large');
  });

  test('没挂的组件、不认识的路径是 404，错误带 status', async () => {
    const { baseUrl } = await guardedServer();
    const harness = createRemoteHarness({ baseUrl, accessToken });
    const error: unknown = await harness.run({ session: 's', agent, input: 'x' }).catch((caught: unknown) => caught);
    expect(isRemoteError(error) && [error.status, error.message]).toEqual([
      404,
      'this server does not serve a harness',
    ]);
    expect((await fetch(`${baseUrl}/nope`, { headers: { authorization: `Bearer ${accessToken}` } })).status).toBe(404);
  });

  test('分页和 kinds 走查询参数；limit 不是数字是 400；kind 里带逗号客户端直接报错', async () => {
    const remote = await serve({ store: createMemoryStore() });
    const store = createRemoteSessionStore(client(remote));
    for (const name of ['b', 'a%', 'a', 'ab']) await store.append(name, [userEntry('x')]);
    await store.append('a', [eventEntry('pet.whisper', { text: 'w' }), eventEntry('pet.reminder', { text: 'r' })]);
    const get = (path: string) =>
      fetch(`${remote.baseUrl}${path}`, { headers: { authorization: `Bearer ${accessToken}` } });
    expect(await (await get('/sessions?prefix=a&after=a&limit=1')).json()).toEqual({ sessions: ['a%'] });
    expect(await store.sessions({ prefix: 'a', limit: 2 })).toEqual(['a', 'a%']);
    expect(await store.sessions({ after: 'a%' })).toEqual(['ab', 'b']);
    expect((await get('/sessions?limit=abc')).status).toBe(400);
    expect(
      ((await (await get('/sessions/a/entries?kinds=pet.whisper,nope')).json()) as { entries: unknown[] }).entries,
    ).toHaveLength(1);
    expect(((await (await get('/sessions/a/entries?kinds=')).json()) as { entries: unknown[] }).entries).toHaveLength(
      0,
    );
    expect((await store.list('a', { kinds: ['pet.reminder', 'pet.whisper'] })).length).toBe(2);
    await expect(store.list('a', { kinds: ['a,b'] })).rejects.toThrow(/comma/);
  });

  test('basePath：只认前缀下的路径', async () => {
    const remote = await serve({ store: createMemoryStore(), basePath: '/ctx' });
    expect(remote.baseUrl.endsWith('/ctx')).toBe(true);
    const store = createRemoteSessionStore(client(remote));
    await store.append('a', [{ type: 'message', message: { role: 'user', content: 'hi' } }]);
    expect(await store.sessions()).toEqual(['a']);
    expect(
      (await fetch(`${remote.origin}/sessions`, { headers: { authorization: `Bearer ${accessToken}` } })).status,
    ).toBe(404);
  });
});

describe('远程执行环境', () => {
  test('连不上时返回可重试的错误，不抛', async () => {
    const server = await startRemote({ executors: [createFunctionExecutor('fn')] });
    await server.close();
    const executor = createRemoteExecutor({ baseUrl: server.baseUrl, name: 'fn' });
    const output = await executor.execute({ id: 'c', name: 'echo', input: {} }, { session: 's' });
    expect(output).toMatchObject({ type: 'error', retryable: true });
    expect(output.type === 'error' && output.message).toMatch(/Could not reach remote executor "fn"/);
  });

  test('服务端没有这个执行环境：错误带上可用的名字', async () => {
    const server = await serve({ executors: [createFunctionExecutor('fn')] });
    const output = await createRemoteExecutor({ ...client(server), name: 'other' }).execute(
      { id: 'c', name: 'echo', input: {} },
      { session: 's' },
    );
    expect(output.type === 'error' && output.message).toMatch(/HTTP 404.*no executor named "other"; available: fn/);
    const listed = await fetch(`${server.baseUrl}/executors`, { headers: { authorization: `Bearer ${accessToken}` } });
    expect(await listed.json()).toEqual({ executors: ['fn'] });
  });

  test('客户端中止时服务端的执行也收到中止', async () => {
    let aborted = false;
    const local = createFunctionExecutor('fn').register(
      { name: 'wait', inputSchema: { type: 'object' } },
      async (_, context) => {
        await waitForAbort(context.signal, 5_000);
        aborted = context.signal?.aborted === true;
        return { type: 'text', text: 'done' };
      },
    );
    const executor = createRemoteExecutor({ ...client(await serve({ executors: [local] })), name: 'fn' });
    const output = await executor.execute(
      { id: 'c', name: 'wait', input: {} },
      { session: 's', signal: AbortSignal.timeout(100) },
    );
    expect(output.type === 'error' && output.message).toMatch(/cancelled/);
    expect(await eventually(async () => aborted, Boolean)).toBe(true);
  });
});

describe('远程记忆存储', () => {
  const auth = { authorization: `Bearer ${accessToken}` };

  test('没挂 memory：/memory/* 是 404，客户端抛 RemoteError 而不是 not_found', async () => {
    const server = await serve({ store: createMemoryStore() });
    const response = await fetch(`${server.baseUrl}/memory/notes`, { headers: auth });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: { message: 'this server does not serve a memory store', type: 'not_found_error' },
    });
    const error: unknown = await createRemoteMemoryStore(client(server))
      .core.get()
      .catch((caught: unknown) => caught);
    expect(isRemoteError(error) && [error.status, error.type]).toEqual([404, 'not_found_error']);
  });

  test('未知路径 404，方法不对 405，输入不对 400 invalid_request', async () => {
    const server = await serve({ memory: createInMemoryMemoryStore() });
    const call = (method: string, path: string, body?: unknown) =>
      fetch(`${server.baseUrl}${path}`, {
        method,
        headers: { ...auth, 'content-type': 'application/json' },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    for (const path of ['/memory', '/memory/nope', '/memory/notes/nope', '/memory/facts/f1/nope', '/memory/core/x/y']) {
      expect([path, (await call('GET', path)).status]).toEqual([path, 404]);
    }
    const wrongMethod: [string, string][] = [
      ['DELETE', '/memory/notes'],
      ['GET', '/memory/notes/settle'],
      ['POST', '/memory/notes/head'],
      ['GET', '/memory/facts/search'],
      ['GET', '/memory/facts/f1/close'],
      ['PUT', '/memory/procedures'],
      ['GET', '/memory/procedures/p1/retire'],
      ['POST', '/memory/core'],
      ['POST', '/memory/core/history'],
    ];
    for (const [method, path] of wrongMethod) {
      const response = await call(method, path, method === 'GET' ? undefined : {});
      const { error } = (await response.json()) as { error: { type: string } };
      expect([method, path, response.status, error.type]).toEqual([method, path, 405, 'method_not_allowed']);
    }
    const bad = await call('POST', '/memory/notes/settle', { ids: 'n1', at: 1 });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: { type: string } }).error.type).toBe('invalid_request');
    expect((await call('GET', '/memory/notes/head')).status).toBe(400);
    expect((await call('GET', '/memory/facts?limit=abc')).status).toBe(400);
    expect((await call('GET', '/memory/procedures?active=yes')).status).toBe(400);
    const missing = await call('POST', '/memory/facts/missing/close', { at: 1 });
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { error: { type: string } }).error.type).toBe('not_found');
  });

  test('basePath：前缀下能用，根上的 /memory 是 404；id 里的 / 经转义过线', async () => {
    const server = await serve({ memory: createInMemoryMemoryStore(), basePath: '/ctx' });
    const store = createRemoteMemoryStore(client(server));
    await store.core.set('画像', 1);
    expect(await store.core.get()).toEqual({ text: '画像', at: 1 });
    const fact = await store.facts.add({
      subject: 'user',
      text: '主人喜欢乌龙茶',
      validFrom: 1,
      confidence: 0.9,
      salience: 0.5,
      sources: [{ session: 'a/b', from: 1, upTo: 1 }],
    });
    expect((await store.facts.cite(fact.id, [{ session: 'a/b', from: 2, upTo: 3 }])).sources).toHaveLength(2);
    expect((await fetch(`${server.origin}/memory/core`, { headers: auth })).status).toBe(404);
    const error: unknown = await store.procedures.retire('x/y', 1).catch((caught: unknown) => caught);
    expect(error instanceof CtxError && error.type).toBe('not_found');
  });
});

// ---- 端到端：三个服务，各管一样 ----

/** 装成更新的服务端：第二条的格式版本比客户端认识的高。 */
function newer(entries: Entry[]): Entry[] {
  return entries.map((entry) => (entry.seq === 2 ? { ...entry, v: 99 } : entry));
}

describe('比客户端新的条目', () => {
  test('缺省抛 unsupported_version；unreadable: placeholder 时换成 ctx.unreadable', async () => {
    const memory = createMemoryStore();
    await memory.append('s', [userEntry('一'), userEntry('二')]);
    const store: SessionStore = {
      append: (session, entries, options) => memory.append(session, entries, options),
      list: async (session, options) => newer(await memory.list(session, options)),
      clear: (session) => memory.clear(session),
      sessions: (options) => memory.sessions(options),
    };
    const server = await serve({ store, pollIntervalMs: 10 });
    const strict = createRemoteSessionStore(client(server));
    await expect(strict.list('s')).rejects.toMatchObject({ type: 'unsupported_version' });
    expect(await strict.list('s', { limit: 1 })).toHaveLength(1);

    const lenient = createRemoteSessionStore({ ...client(server), unreadable: 'placeholder' });
    expect(eventKinds(await lenient.list('s'))).toEqual(['user', CTX_EVENTS.unreadable]);
    const controller = new AbortController();
    const seen: string[] = [];
    for await (const entry of lenient.watch('s', { signal: controller.signal })) {
      seen.push(...eventKinds([entry]));
      if (seen.length === 2) controller.abort();
    }
    expect(seen).toEqual(['user', CTX_EVENTS.unreadable]);
  });
});

describe('长请求、断线和上限', () => {
  const auth = { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' };
  const quick = { retry: { minDelayMs: 20, maxDelayMs: 100 } };
  const result: RunResult = { runId: 'r', text: '好的', messages: [], recorded: [], stopReason: 'end_turn' };

  test('等结果的时候发心跳：正文前面是换行，客户端照常拿到结果', async () => {
    const harness: Harness = {
      async run() {
        await pause(120);
        return result;
      },
    };
    const local = createFunctionExecutor('fn').register({ name: 'slow', inputSchema: { type: 'object' } }, async () => {
      await pause(120);
      return { type: 'text', text: '跑完了' };
    });
    const server = await serve({ harness, executors: [local], heartbeatMs: 20 });
    const raw = await fetch(`${server.baseUrl}/runs`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ session: 's', agent }),
    });
    const text = await raw.text();
    expect(text.startsWith('\n')).toBe(true);
    expect(JSON.parse(text)).toEqual(result);
    expect(await createRemoteHarness(client(server)).run({ session: 's', agent })).toEqual(result);
    const executor = createRemoteExecutor({ ...client(server), name: 'fn' });
    expect(await executor.execute({ id: 'c', name: 'slow', input: {} }, { session: 's' })).toEqual({
      type: 'text',
      text: '跑完了',
    });
  });

  test('心跳发出去以后才出的错：200 加 { error, status }，客户端转成 RemoteError；原文只进日志', async () => {
    const logged: unknown[] = [];
    const harness: Harness = {
      async run() {
        await pause(80);
        throw new Error('open /var/lib/secret.db failed');
      },
    };
    const server = await serve({
      harness,
      heartbeatMs: 20,
      logger: { warn: (message, data) => void logged.push({ message, ...data }) },
    });
    const failure = await createRemoteHarness(client(server))
      .run({ session: 's', agent })
      .catch((error: unknown) => error);
    expect(isRemoteError(failure) && failure.status).toBe(500);
    expect((failure as Error).message).toMatch(/^internal error \(ref [0-9a-f]{8}\)/);
    expect(JSON.stringify(logged)).toContain('secret.db');
  });

  test('内部错误不回原文；协议错误（CtxError）照旧带着 type', async () => {
    const memory = createMemoryStore();
    const store: SessionStore = {
      ...memory,
      list: () => Promise.reject(new Error('SQLITE_IOERR: /data/ctx.db')),
      clear: () => Promise.reject(new CtxError('not_found', '没有这个会话')),
    };
    const remote = createRemoteSessionStore({ ...client(await serve({ store })), ...quick });
    const failure = await remote.list('s').catch((error: unknown) => error);
    expect(isRemoteError(failure) && failure.status).toBe(500);
    expect((failure as Error).message).not.toContain('ctx.db');
    expect(await remote.clear('s').catch((error: unknown) => error)).toMatchObject({ status: 404, type: 'not_found' });
  });

  test('空闲的流也有心跳行，客户端跳过', async () => {
    const store = createMemoryStore();
    const server = await serve({ store, heartbeatMs: 20 });
    const controller = new AbortController();
    const response = await fetch(`${server.baseUrl}/sessions/s/entries/stream`, {
      headers: auth,
      signal: controller.signal,
    });
    const { value } = await response.body!.getReader().read();
    expect(new TextDecoder().decode(value)).toMatch(/^\n+$/);
    controller.abort();

    const seen: Entry[] = [];
    const watching = new AbortController();
    const done = (async () => {
      for await (const entry of createRemoteSessionStore(client(server)).watch('s', { signal: watching.signal })) {
        seen.push(entry);
      }
    })();
    await pause(80);
    await store.append('s', [userEntry('一')]);
    await eventually(
      async () => seen.length,
      (count) => count === 1,
    );
    watching.abort();
    await done;
    expect(seen.map((entry) => entry.seq)).toEqual([1]);
  });

  test('watch：服务重启后按最后读到的 seq 重连，不重不漏', async () => {
    const store = createMemoryStore();
    const first = await startRemote({ accessToken, store });
    const port = Number(new URL(first.origin).port);
    const seen: number[] = [];
    const controller = new AbortController();
    const remote = createRemoteSessionStore({ baseUrl: first.baseUrl, accessToken, ...quick });
    const done = (async () => {
      for await (const entry of remote.watch('s', { signal: controller.signal })) seen.push(entry.seq);
    })();
    await store.append('s', [userEntry('一')]);
    await eventually(
      async () => seen.length,
      (count) => count === 1,
    );
    await first.close();
    await store.append('s', [userEntry('二')]);
    await serve({ store, port });
    await store.append('s', [userEntry('三')]);
    await eventually(
      async () => seen.length,
      (count) => count === 3,
    );
    controller.abort();
    await done;
    expect(seen).toEqual([1, 2, 3]);
  });

  test('watch：一直连不上，试够次数就抛', async () => {
    const server = await startRemote({ accessToken, store: createMemoryStore() });
    await server.close();
    const remote = createRemoteSessionStore({
      baseUrl: server.baseUrl,
      accessToken,
      retry: { retries: 2, minDelayMs: 5 },
    });
    const read = (async () => {
      for await (const _ of remote.watch('s')) break;
    })();
    await expect(read).rejects.toThrow(/fetch failed/);
  });

  test('append：响应丢了自己重试，不记两遍，返回值是写进去的那些', async () => {
    const store = createMemoryStore();
    const server = await serve({ store });
    const remote = createRemoteSessionStore({ ...client(server), ...quick, fetch: losingFirstPost() });
    const written = await remote.append('s', [userEntry('一'), eventEntry('app.note', { text: '二' })]);
    expect(written.map((entry) => entry.seq)).toEqual([1, 2]);
    expect(await store.list('s')).toHaveLength(2);
  });

  test('append：带 expectSeq 的那一批响应丢了，重试时的冲突认得出是自己写的', async () => {
    const store = createMemoryStore();
    const server = await serve({ store });
    const remote = createRemoteSessionStore({ ...client(server), ...quick, fetch: losingFirstPost() });
    const written = await remote.append('s', [userEntry('一')], { expectSeq: 0 });
    expect(written.map((entry) => entry.seq)).toEqual([1]);
    expect(await store.list('s')).toHaveLength(1);
    // 真的冲突（末尾不是自己推后的）照旧抛。
    await expect(remote.append('s', [userEntry('二')], { expectSeq: 0 })).rejects.toMatchObject({ type: 'conflict' });
    expect(await store.list('s')).toHaveLength(1);
  });

  test('done：服务重启后不空转，结束了从会话日志还原结果', async () => {
    // 第一个服务收下提交；查状态的请求都到第二个服务，它的编排器不认识这次提交（重启后的样子）。
    const { store, harness } = localHarness([{ type: 'text', text: '好的' }], 200);
    const orchestrator = createOrchestrator({ harness, store });
    const first = await serve({ store, orchestrator });
    let status: 'running' | 'completed' = 'running';
    let polls = 0;
    const restarted: Orchestrator = {
      submit: () => Promise.reject(new Error('unused')),
      status: async () => {
        polls += 1;
        return status;
      },
      cancel: async () => false,
      close: async () => {},
    };
    const second = await serve({ store, orchestrator: restarted });
    const remote = createRemoteOrchestrator({
      baseUrl: first.baseUrl,
      accessToken,
      retry: { minDelayMs: 50, maxDelayMs: 400 },
      fetch: (input, init) =>
        fetch(init?.method === 'GET' ? urlOf(input).replace(first.baseUrl, second.baseUrl) : input, init),
    });
    const handle = await remote.submit({ session: 'restart', agent, input: '在吗', runId: 'run-restart' });
    await eventually(
      async () => runEnded(await store.list('restart')),
      (ended) => ended.length === 1,
    );
    await pause(400);
    expect(polls).toBeGreaterThan(0);
    expect(polls).toBeLessThan(12);
    status = 'completed';
    const restored = await handle.done;
    expect(restored).toMatchObject({ runId: 'run-restart', stopReason: 'end_turn', text: '好的' });
    expect(eventKinds(restored.recorded)).toEqual(['ctx.run.started', 'user', 'assistant', 'ctx.run.ended']);
    await orchestrator.close();
  });

  test('编排器不认识的运行：给了会话名就从日志找，日志里也没有才是 404', async () => {
    const { store, harness } = localHarness([{ type: 'text', text: '好的' }]);
    const ran = await harness.run({ session: 's', agent, input: '在吗', runId: 'run-1' });
    const idle: Orchestrator = {
      submit: () => Promise.reject(new Error('unused')),
      status: async () => undefined,
      cancel: async () => false,
      close: async () => {},
    };
    const server = await serve({ store, orchestrator: idle });
    const get = (path: string): Promise<Response> => fetch(`${server.baseUrl}${path}`, { headers: auth });
    expect((await get('/orchestrator/runs/run-1')).status).toBe(404);
    expect((await get('/orchestrator/runs/nope?session=s')).status).toBe(404);
    const found = await get('/orchestrator/runs/run-1?session=s');
    expect(found.status).toBe(200);
    const body = (await found.json()) as { status: string; result: RunResult };
    expect(body.status).toBe('completed');
    expect(body.result).toMatchObject({ runId: 'run-1', text: '好的', stopReason: 'end_turn' });
    expect(body.result.messages).toEqual(ran.messages);
    expect(body.result.recorded.map((entry) => entry.seq)).toEqual(ran.recorded.map((entry) => entry.seq));
  });

  test('到了并发上限回 429（retryable），放掉以后又能用', async () => {
    const { store, harness } = localHarness(
      [
        { type: 'text', text: '一' },
        { type: 'text', text: '二' },
      ],
      200,
    );
    const server = await serve({ store, harness, maxRuns: 1, maxStreams: 1 });
    const remote = createRemoteHarness(client(server));
    const running = remote.run({ session: 'a', agent, input: '在吗' });
    await pause(50);
    const refused = await remote.run({ session: 'b', agent, input: '在吗' }).catch((error: unknown) => error);
    expect(refused).toMatchObject({ status: 429, type: 'rate_limit_error', retryable: true });
    expect((await running).stopReason).toBe('end_turn');
    expect((await remote.run({ session: 'b', agent, input: '在吗' })).stopReason).toBe('end_turn');

    const open = new AbortController();
    const stream = await fetch(`${server.baseUrl}/sessions/a/entries/stream`, { headers: auth, signal: open.signal });
    expect(stream.status).toBe(200);
    const second = await fetch(`${server.baseUrl}/sessions/a/entries/stream`, { headers: auth });
    expect(second.status).toBe(429);
    open.abort();
    await eventually(
      async () => {
        const controller = new AbortController();
        const again = await fetch(`${server.baseUrl}/sessions/a/entries/stream`, {
          headers: auth,
          signal: controller.signal,
        });
        controller.abort();
        return again.status;
      },
      (code) => code === 200,
    );
  });
});

describe('端到端', () => {
  test('本机 harness + 远程子进程执行环境 + 远程会话存储，跑一轮 run_command', async () => {
    const workdir = await mkdtemp(join(tmpdir(), 'ctx-remote-e2e-'));
    try {
      // 1. 会话存储服务
      const storeServer = await serve({ store: createMemoryStore() });
      // 2. 执行环境服务：ctx-exec 的子进程执行环境
      const execServer = await serve({ executors: [createProcessExecutor({ name: 'sandbox', cwd: workdir })] });
      // 3. harness 服务：核心包的 harness，会话和执行环境都是远端的客户端
      const store = createRemoteSessionStore(client(storeServer));
      const sandbox = createRemoteExecutor({ ...client(execServer), name: 'sandbox' });
      const tools = createToolRegistry();
      for (const definition of await sandbox.tools()) tools.add(definition);
      const model = createScriptedModel(
        [
          { type: 'tool-call', id: 'call-1', input: { command: 'echo hello' } },
          { type: 'text', text: '命令输出了 hello。' },
        ],
        { tool: 'run_command' },
      );
      const harnessServer = await serve({
        harness: createHarness({
          store,
          context: createContextBuilder({ store }),
          tools,
          executors: [sandbox],
          models: () => model,
        }),
      });

      const result = await createRemoteHarness(client(harnessServer)).run({
        session: 'e2e',
        agent: { model: 'scripted', tools: ['run_command'] },
        input: '跑一下 echo hello',
      });
      expect(result.stopReason).toBe('end_turn');
      expect(result.text).toBe('命令输出了 hello。');

      // 日志在会话存储服务里，换一个客户端读
      const log = await createRemoteSessionStore(client(storeServer)).list('e2e');
      expect(eventKinds(log)).toEqual([
        CTX_EVENTS.runStarted,
        'user',
        'assistant',
        'tool',
        'assistant',
        CTX_EVENTS.runEnded,
      ]);
      const toolMessage = log.find((entry) => entry.type === 'message' && entry.message.role === 'tool');
      const content = JSON.stringify(toolMessage);
      expect(content).toContain('run_command');
      expect(content).toContain('<exit_code>0</exit_code>');
      expect(content).toContain('hello');
    } finally {
      await rm(workdir, { recursive: true, force: true });
    }
  });
});
