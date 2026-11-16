import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

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
import { createMemoryStore as createInMemoryMemoryStore } from '@modelctx-ai/ctx-memory';
import { afterAll, describe, expect, test } from 'vite-plus/test';

import { createConformanceHandler, type ConformanceInstanceOptions } from './conformance-server.ts';
import type { ConformanceSetup } from './conformance-wire.ts';
import { describeConformance } from './conformance.ts';

const accessToken = 'conformance-token-0123456789';

function waitForAbort(signal: AbortSignal | undefined, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => (clearTimeout(timer), resolve()), { once: true });
  });
}

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

/** 参考实现的一致性实例：核心包的内存组件，按 `setup` 的剧本、钟、延迟。 */
function create(setup: ConformanceSetup): ConformanceInstanceOptions {
  let ticks = 0;
  const clock = setup.clock;
  const now = clock === undefined || clock === 'real' ? Date.now : () => clock.at + clock.step * ticks++;
  const store = createMemoryStore({ now });
  const tools = createToolRegistry();
  tools.executor.register(
    {
      name: 'echo',
      description: '原样返回输入',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
    },
    (input) => ({ type: 'json', value: input }),
  );
  tools.add(tools.executor.definition('echo')!);
  const scripted = createScriptedModel(setup.script ?? []);
  const model = setup.delayMs ? slow(scripted, setup.delayMs) : scripted;
  const harness = createHarness({ store, context: createContextBuilder({ store }), tools, models: () => model });
  const names = new Set(setup.components);
  return {
    ...(names.has('sessions') ? { store } : {}),
    ...(names.has('harness') ? { harness } : {}),
    ...(names.has('orchestrator') ? { orchestrator: createOrchestrator({ harness, store }) } : {}),
    ...(names.has('executors') ? { executors: [tools.executor, createFunctionExecutor('spare')] } : {}),
    ...(names.has('memory') ? { memory: createInMemoryMemoryStore() } : {}),
    agent: { model: 'scripted' },
    executor: { name: 'local', echo: 'echo' },
  };
}

const handler = createConformanceHandler({ create, accessToken });
const server: Server = createServer((req, res) => void handler(req, res));
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
afterAll(
  () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    }),
);

// 对一个地址跑全部能跨进程的组件的契约：和别的语言写的服务端走同一条路。
describeConformance(baseUrl, { accessToken }, { describe, test });

describe('一致性模式的入口', () => {
  test('不认识的组件、错的 clock 是 400；没有令牌是 401；实例之外的路径是 404', async () => {
    const post = (body: unknown, token = accessToken) =>
      fetch(`${baseUrl}/conformance/instances`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    expect((await post({ components: ['context'] })).status).toBe(400);
    expect((await post({ components: ['sessions'], clock: { at: 'x' } })).status).toBe(400);
    expect((await post({ components: ['sessions'] }, 'wrong')).status).toBe(401);
    expect((await fetch(`${baseUrl}/conformance/instances/nope/protocol`)).status).toBe(404);
    const created = (await (await post({ components: ['sessions'] })).json()) as { baseUrl: string };
    const info = await fetch(`${baseUrl}${created.baseUrl}/protocol`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(((await info.json()) as { components: unknown }).components).toEqual({ sessions: { watch: true } });
  });
});
