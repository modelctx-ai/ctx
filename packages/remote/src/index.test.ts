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
import { CTX_EVENTS, eventEntry, userEntry, type Entry, type SessionStore } from '@modelctx-ai/ctx-protocol';
import {
  type ModelScriptStep,
  describeExecutorContract,
  describeHarnessContract,
  describeOrchestratorContract,
  describeSessionStoreContract,
} from '@modelctx-ai/ctx-protocol/testing';
import { afterAll, describe, expect, test } from 'vite-plus/test';

import {
  createRemoteExecutor,
  createRemoteHarness,
  createRemoteOrchestrator,
  createRemoteSessionStore,
  isRemoteError,
} from './index.ts';
import { startRemote, type RemoteServer, type StartRemoteOptions } from './server.ts';

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
      append: (session, entries) => memory.append(session, entries),
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

// ---- 端到端：三个服务，各管一样 ----

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
