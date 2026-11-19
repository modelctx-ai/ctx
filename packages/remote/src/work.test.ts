import {
  createContextBuilder,
  createFunctionExecutor,
  createHarness,
  createMemoryStore,
  createToolRegistry,
} from '@modelctx-ai/ctx';
import { createScriptedModel } from '@modelctx-ai/ctx/testing';
import {
  checkJsonSchema,
  pendingToolCalls,
  PROTOCOL_SCHEMA,
  resolveSchemaRefs,
  toolApprovalEntry,
  toolResultEntry,
  type AgentSpec,
  type Executor,
} from '@modelctx-ai/ctx-protocol';
import { afterAll, describe, expect, test } from 'vite-plus/test';

import { createRemoteWorker } from './index.ts';
import { startRemote, type Principal, type RemoteServer, type StartRemoteOptions } from './server.ts';

const TOKEN = 'work-token-0123456789';

const servers: RemoteServer[] = [];
afterAll(async () => {
  await Promise.all(servers.map((server) => server.close()));
});

const LOOKUP = {
  name: 'lookup',
  description: '查内网的订单',
  inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
};

const script = [
  { type: 'tool-call', id: 'c1', input: { id: '42' } },
  { type: 'text', text: '订单 42 已经发货了' },
] as const;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check: () => Promise<boolean>): Promise<void> {
  for (const started = Date.now(); !(await check()); await sleep(10)) {
    if (Date.now() - started > 5_000) throw new Error('timed out');
  }
}

/**
 * `lookup` 绑在 `worker` 上、`ship` 绑在 `warehouse` 上，都在别处执行。harness 在这个进程里，和服务端共用会话存储；
 * worker 只连服务端。
 */
async function setup(options: Partial<StartRemoteOptions> = {}) {
  const store = createMemoryStore();
  const tools = createToolRegistry()
    .add({ ...LOOKUP, executor: 'worker' })
    .add({ name: 'ship', description: '发货', inputSchema: { type: 'object' }, executor: 'warehouse' });
  const harness = createHarness({
    store,
    context: createContextBuilder({ store }),
    tools,
    external: ['worker', 'warehouse'],
  });
  const server = await startRemote({ store, accessToken: TOKEN, pollIntervalMs: 10, ...options });
  servers.push(server);
  const ran: unknown[] = [];
  const executor = createFunctionExecutor('worker').register(LOOKUP, (input) => {
    ran.push(input);
    return { type: 'text', text: '订单 42 已发货' };
  });
  const worker = createRemoteWorker({ baseUrl: server.baseUrl, accessToken: TOKEN, executor });
  /** 在 `session` 里跑一轮，模型调一次 `tool`，以 `requires_action` 停下。 */
  const stopAt = (session: string, tool = 'lookup', extra: Partial<AgentSpec> = {}) =>
    harness.run({
      session,
      agent: { model: createScriptedModel(script, { tool }), ...extra },
      input: '订单 42 到哪了？',
    });
  return { store, harness, server, worker, ran, stopAt };
}

describe('按执行环境的名字领工作', () => {
  test('只领到归这个执行环境的；执行完结果写回会话，下一轮接着走', async () => {
    const { store, harness, server, worker, ran } = await setup();
    const model = createScriptedModel(script, { tool: 'lookup' });
    const first = await harness.run({ session: 's1', agent: { model }, input: '订单 42 到哪了？' });
    expect(first.stopReason).toBe('requires_action');
    await harness.run({
      session: 's2',
      agent: { model: createScriptedModel(script, { tool: 'ship' }) },
      input: '发货',
    });

    const step = await worker.step();
    expect(step.failed).toEqual([]);
    expect(step.executed).toEqual([
      {
        session: 's1',
        runId: first.runId,
        seq: (await store.list('s1'))[2]!.seq,
        call: { id: 'c1', name: 'lookup', input: { id: '42' } },
        executor: 'worker',
      },
    ]);
    expect(ran).toEqual([{ id: '42' }]);
    const log = await store.list('s1');
    expect(log.at(-1)).toMatchObject({ source: 'worker', key: 'ctx.tool-result:c1', message: { role: 'tool' } });
    expect(pendingToolCalls(log)).toEqual([]);
    expect(await worker.step()).toEqual({ executed: [], failed: [] });

    const second = await harness.run({ session: 's1', agent: { model } });
    expect(second.stopReason).toBe('end_turn');
    expect(second.text).toBe('订单 42 已经发货了');

    // `ship` 的归 `warehouse`：线上的形状合 schema。
    const warehouse = createRemoteWorker({
      baseUrl: server.baseUrl,
      accessToken: TOKEN,
      executor: createFunctionExecutor('warehouse'),
    });
    const claimed = await warehouse.claim();
    expect(claimed.map((item) => [item.session, item.call.name])).toEqual([['s2', 'ship']]);
    const shape = resolveSchemaRefs(PROTOCOL_SCHEMA, 'ClaimedToolCall');
    expect(claimed.flatMap((item) => checkJsonSchema(shape, JSON.parse(JSON.stringify(item))))).toEqual([]);
  });

  test('limit：一次最多领几个，剩下的下次领', async () => {
    const { worker, stopAt } = await setup();
    await stopAt('a');
    await stopAt('b');
    expect((await worker.claim({ limit: 1 })).map((item) => item.session)).toEqual(['a']);
    expect((await worker.claim({ limit: 1 })).map((item) => item.session)).toEqual(['b']);
    expect(await worker.claim()).toEqual([]);
  });

  test('租约：领走的在租约内不给别的领取，过期了再给；结果写回以后不再给', async () => {
    const { store, worker, stopAt } = await setup();
    await stopAt('s');
    const [first] = await worker.claim({ leaseMs: 50 });
    expect(first?.call.id).toBe('c1');
    expect(await worker.claim()).toEqual([]);
    await sleep(70);
    const [again] = await worker.claim({ leaseMs: 50 });
    expect(again?.call.id).toBe('c1');
    await store.append('s', [toolResultEntry(again!.call, { type: 'text', text: '别处执行了' })]);
    await sleep(70);
    expect(await worker.claim()).toEqual([]);
  });

  test('等确认的：还没决定、被拒绝的领不到，确认了才领得到', async () => {
    const { store, worker, stopAt } = await setup();
    const asking = { permissions: { default: 'ask' } } as const;
    const first = await stopAt('s', 'lookup', asking);
    const [approval] = first.approvals ?? [];
    expect(approval?.callId).toBe('c1');
    expect(await worker.claim()).toEqual([]);
    await store.append('s', [toolApprovalEntry(approval!.approvalId, { approved: true })]);
    const [claimed] = await worker.claim();
    expect(claimed?.approval).toEqual({ approvalId: approval!.approvalId, decision: { approved: true } });

    const second = await stopAt('t', 'lookup', asking);
    await store.append('t', [toolApprovalEntry(second.approvals![0]!.approvalId, { approved: false })]);
    expect(await worker.claim()).toEqual([]);
  });

  test('长轮询：一个都没有时等到有了再回，等到头还没有就回空', async () => {
    const { worker, stopAt } = await setup();
    const started = Date.now();
    expect(await worker.claim({ waitMs: 50 })).toEqual([]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(45);
    const waiting = worker.claim({ waitMs: 5_000 });
    await sleep(30);
    await stopAt('s');
    expect((await waiting).map((item) => item.call.id)).toEqual(['c1']);
  });

  test('调用方走了的长轮询不再领、不占着调用', async () => {
    const { worker, stopAt } = await setup();
    const controller = new AbortController();
    const gone = worker.claim({ waitMs: 5_000, signal: controller.signal });
    await sleep(30);
    controller.abort();
    await expect(gone).rejects.toThrow(/aborted/);
    await sleep(30);
    await stopAt('s');
    // 隔几次轮询：那个请求还在扫的话会先把它领走。
    await sleep(50);
    expect((await worker.claim()).map((item) => item.call.id)).toEqual(['c1']);
  });

  test('主体只领得到看得见的会话里的', async () => {
    const principals: Readonly<Record<string, Principal>> = { 'token-a': { id: 'a', sessionPrefixes: ['a/'] } };
    const { server, stopAt } = await setup({
      accessToken: undefined,
      authenticate: (request) => principals[/^bearer\s+(.+)$/i.exec(request.headers.authorization ?? '')?.[1] ?? ''],
    });
    await stopAt('a/1');
    await stopAt('b/1');
    const worker = createRemoteWorker({
      baseUrl: server.baseUrl,
      accessToken: 'token-a',
      executor: createFunctionExecutor('worker'),
    });
    expect((await worker.claim()).map((item) => item.session)).toEqual(['a/1']);
  });

  test('执行时抛错的不记结果，算 failed；租约过了再领到', async () => {
    const { store, server, stopAt } = await setup();
    await stopAt('s');
    let attempts = 0;
    const flaky: Executor = {
      name: 'worker',
      async execute() {
        attempts += 1;
        if (attempts === 1) throw new Error('sandbox is down');
        return { type: 'text', text: '好了' };
      },
    };
    const worker = createRemoteWorker({ baseUrl: server.baseUrl, accessToken: TOKEN, executor: flaky, leaseMs: 50 });
    const first = await worker.step();
    expect(first.executed).toEqual([]);
    expect(first.failed.map((item) => item.call.id)).toEqual(['c1']);
    expect(pendingToolCalls(await store.list('s'))).toHaveLength(1);
    await sleep(70);
    expect((await worker.step()).executed.map((item) => item.call.id)).toEqual(['c1']);
    expect(pendingToolCalls(await store.list('s'))).toEqual([]);
  });

  test('run：领到就执行，直到 signal 中止；服务端没挂会话存储时抛 404', async () => {
    const { store, worker, ran, stopAt } = await setup();
    const controller = new AbortController();
    const running = worker.run(controller.signal);
    await stopAt('s');
    await until(async () => pendingToolCalls(await store.list('s')).length === 0);
    controller.abort();
    await running;
    expect(ran).toEqual([{ id: '42' }]);

    const bare = await startRemote({ accessToken: TOKEN });
    servers.push(bare);
    const lost = createRemoteWorker({
      baseUrl: bare.baseUrl,
      accessToken: TOKEN,
      executor: createFunctionExecutor('worker'),
    });
    await expect(lost.run(new AbortController().signal)).rejects.toMatchObject({ status: 404 });
  });

  test('run 中止时正在执行的不记结果：那不是工具的结果', async () => {
    const { store, server, stopAt } = await setup();
    await stopAt('s');
    let begin!: () => void;
    const begun = new Promise<void>((resolve) => (begin = resolve));
    const slow: Executor = {
      name: 'worker',
      execute: (_call, context) =>
        new Promise((resolve) => {
          begin();
          context.signal?.addEventListener('abort', () => resolve({ type: 'error', message: 'cancelled' }), {
            once: true,
          });
        }),
    };
    const worker = createRemoteWorker({ baseUrl: server.baseUrl, accessToken: TOKEN, executor: slow });
    const controller = new AbortController();
    const running = worker.run(controller.signal);
    await begun;
    controller.abort();
    await running;
    expect(pendingToolCalls(await store.list('s'))).toHaveLength(1);
  });

  test('请求不对：400；方法不对 405；路径不对 404', async () => {
    const { server } = await setup();
    const headers = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
    const post = (path: string, body: unknown) =>
      fetch(`${server.baseUrl}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
    for (const body of [{ limit: 0 }, { limit: 1.5 }, { waitMs: -1 }, { leaseMs: 0 }, { leaseMs: 'x' }, []]) {
      expect((await post('/work/worker/claim', body)).status).toBe(400);
    }
    expect((await fetch(`${server.baseUrl}/work/worker/claim`, { headers })).status).toBe(405);
    expect((await post('/work/worker/take', {})).status).toBe(404);
    expect((await post('/work', {})).status).toBe(404);
  });
});
