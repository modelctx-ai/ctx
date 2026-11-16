import {
  createContextBuilder,
  createFunctionExecutor,
  createHarness,
  createMemoryStore,
  createOrchestrator,
  userEntry,
} from '@modelctx-ai/ctx';
import { createScriptedModel } from '@modelctx-ai/ctx/testing';
import { createMemoryStore as createInMemoryMemoryStore } from '@modelctx-ai/ctx-memory';
import { afterAll, describe, expect, test } from 'vite-plus/test';

import {
  createRemoteExecutor,
  createRemoteHarness,
  createRemoteMemoryStore,
  createRemoteOrchestrator,
  createRemoteSessionStore,
  isRemoteError,
} from './index.ts';
import { createRemoteHandler, startRemote, type Principal, type RemoteServer } from './server.ts';

const PRINCIPALS: Readonly<Record<string, Principal>> = {
  'token-a': { id: 'tenant-a', sessionPrefixes: ['tenant-a/'], memoryScopes: ['tenant-a'] },
  'token-b': { id: 'tenant-b', sessionPrefixes: ['tenant-b/'], memoryScopes: ['tenant-b'] },
  'token-admin': { id: 'ops', admin: true },
};

const servers: RemoteServer[] = [];
afterAll(async () => {
  await Promise.all(servers.map((server) => server.close()));
});

async function setup() {
  const store = createMemoryStore();
  const echo = createFunctionExecutor('box').register({ name: 'echo', inputSchema: { type: 'object' } }, (input) => ({
    type: 'json',
    value: input,
  }));
  const harness = createHarness({
    store,
    context: createContextBuilder({ store }),
    models: () => createScriptedModel([{ type: 'text', text: '好' }]),
  });
  const server = await startRemote({
    store,
    executors: [echo],
    harness,
    orchestrator: createOrchestrator({ harness, store }),
    memory: createInMemoryMemoryStore(),
    authenticate: (request) => PRINCIPALS[/^bearer\s+(.+)$/i.exec(request.headers.authorization ?? '')?.[1] ?? ''],
  });
  servers.push(server);
  await store.append('tenant-a/1', [userEntry('a 的')]);
  await store.append('tenant-a/2', [userEntry('a 的')]);
  await store.append('tenant-b/1', [userEntry('b 的')]);
  const as = (accessToken: string) => ({ baseUrl: server.baseUrl, accessToken });
  return { server, store, as };
}

async function statusOf(run: Promise<unknown>): Promise<unknown> {
  const error = await run.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  return isRemoteError(error) ? [error.status, error.type] : error;
}

const FORBIDDEN = [403, 'permission_error'];

/** 谁都认不出。 */
const authenticate = (): Principal | undefined => undefined;

describe('authenticate 和 Principal', () => {
  test('认不出的请求是 401', async () => {
    const { server } = await setup();
    expect((await fetch(`${server.baseUrl}/sessions`)).status).toBe(401);
    const store = createRemoteSessionStore({ baseUrl: server.baseUrl, accessToken: 'nope' });
    expect(await statusOf(store.sessions())).toEqual([401, 'authentication_error']);
  });

  test('会话：只列、只读写前缀里的，范围外 403', async () => {
    const { as } = await setup();
    const a = createRemoteSessionStore(as('token-a'));
    expect(await a.sessions()).toEqual(['tenant-a/1', 'tenant-a/2']);
    expect(await a.sessions({ prefix: 'tenant-a/2' })).toEqual(['tenant-a/2']);
    expect(await a.sessions({ prefix: 'tenant-b/' })).toEqual([]);
    expect(await a.sessions({ limit: 1 })).toEqual(['tenant-a/1']);
    expect((await a.list('tenant-a/1')).length).toBe(1);
    expect(await statusOf(a.list('tenant-b/1'))).toEqual(FORBIDDEN);
    expect(await statusOf(a.append('tenant-b/1', [userEntry('混进去')]))).toEqual(FORBIDDEN);
    expect(await statusOf(a.clear('tenant-b/1'))).toEqual(FORBIDDEN);
    const admin = createRemoteSessionStore(as('token-admin'));
    expect(await admin.sessions()).toEqual(['tenant-a/1', 'tenant-a/2', 'tenant-b/1']);
  });

  test('执行环境：context.session 和会话的 open、close 都按前缀查', async () => {
    const { as } = await setup();
    const box = createRemoteExecutor({ ...as('token-a'), name: 'box' });
    const call = { id: 'c', name: 'echo', input: { n: 1 } };
    expect(await box.execute(call, { session: 'tenant-a/1' })).toEqual({ type: 'json', value: { n: 1 } });
    // 执行环境不抛：403 变成给模型看的错误结果。
    const refused = await box.execute(call, { session: 'tenant-b/1' });
    expect(refused.type === 'error' && refused.message).toMatch(/may not access session "tenant-b\/1"/);
    await box.open('tenant-a/1');
    expect(await statusOf(box.open('tenant-b/1'))).toEqual(FORBIDDEN);
    expect(await statusOf(box.close('tenant-b/1'))).toEqual(FORBIDDEN);
  });

  test('运行：会话、父运行的会话、继承的会话都要在范围里', async () => {
    const { as } = await setup();
    const harness = createRemoteHarness(as('token-a'));
    const agent = { model: 'scripted' };
    expect((await harness.run({ session: 'tenant-a/3', agent, input: '你好' })).stopReason).toBe('end_turn');
    expect(await statusOf(harness.run({ session: 'tenant-b/3', agent, input: '你好' }))).toEqual(FORBIDDEN);
    expect(
      await statusOf(
        harness.run({ session: 'tenant-a/4', agent, input: '你好', parent: { session: 'tenant-b/1', runId: 'r' } }),
      ),
    ).toEqual(FORBIDDEN);
    expect(
      await statusOf(
        harness.run({
          session: 'tenant-a/4',
          agent: { ...agent, context: { inherit: { session: 'tenant-b/1' } } },
          input: '你好',
        }),
      ),
    ).toEqual(FORBIDDEN);
  });

  test('编排器：提交按前缀查；别人的运行查不到、取消不了；事件只发范围里的；recover 要 admin', async () => {
    const { as } = await setup();
    const a = createRemoteOrchestrator(as('token-a'));
    const b = createRemoteOrchestrator(as('token-b'));
    const controller = new AbortController();
    const seen: string[] = [];
    const events = (async () => {
      for await (const event of a.events({ signal: controller.signal })) {
        seen.push(event.session);
        if (event.type === 'run.completed' && event.session === 'tenant-a/5') controller.abort();
      }
    })();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const agent = { model: 'scripted' };
    expect(await statusOf(a.submit({ session: 'tenant-b/5', agent, input: '你好' }))).toEqual(FORBIDDEN);
    const other = await b.submit({ session: 'tenant-b/5', agent, input: '你好' });
    await other.done;
    const mine = await a.submit({ session: 'tenant-a/5', agent, input: '你好' });
    await mine.done;
    await events;
    expect(new Set(seen)).toEqual(new Set(['tenant-a/5']));
    expect(await a.status(mine.runId)).toBe('completed');
    expect(await statusOf(a.status(other.runId))).toEqual(FORBIDDEN);
    expect(await statusOf(a.cancel(other.runId))).toEqual(FORBIDDEN);
    expect(await statusOf(a.recover())).toEqual(FORBIDDEN);
    expect(await createRemoteOrchestrator(as('token-admin')).recover()).toEqual([]);
  });

  test('记忆：只能碰自己的作用域', async () => {
    const { as } = await setup();
    const a = createRemoteMemoryStore({ ...as('token-a'), scope: 'tenant-a' });
    await a.notes.add([{ session: 'tenant-a/1', from: 1, upTo: 1, at: 10, salience: 0.8 }]);
    expect((await a.notes.list()).length).toBe(1);
    expect(await statusOf(a.scope('tenant-b').notes.list())).toEqual(FORBIDDEN);
    expect(await statusOf(createRemoteMemoryStore(as('token-a')).notes.list())).toEqual(FORBIDDEN);
    expect((await createRemoteMemoryStore({ ...as('token-admin'), scope: 'tenant-a' }).notes.list()).length).toBe(1);
  });

  test('accessToken 和 authenticate 二选一；听在非本机地址上有 authenticate 就能启动', async () => {
    const store = createMemoryStore();
    expect(() => createRemoteHandler({ store, accessToken: 't', authenticate })).toThrow(/either `accessToken`/);
    const open = await startRemote({ store, host: '0.0.0.0', authenticate });
    await open.close();
  });
});
