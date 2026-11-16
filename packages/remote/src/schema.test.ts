import { readFile, writeFile } from 'node:fs/promises';

import {
  createContextBuilder,
  createFunctionExecutor,
  createHarness,
  createMemoryStore,
  createOrchestrator,
  createToolRegistry,
} from '@modelctx-ai/ctx';
import { createScriptedModel } from '@modelctx-ai/ctx/testing';
import { createMemoryStore as createInMemoryMemoryStore } from '@modelctx-ai/ctx-memory';
import {
  checkJsonSchema,
  PROTOCOL_SCHEMA,
  resolveSchemaRefs,
  userEntry,
  type RunEvent,
} from '@modelctx-ai/ctx-protocol';
import { afterAll, describe, expect, test } from 'vite-plus/test';

import {
  createRemoteExecutor,
  createRemoteHarness,
  createRemoteMemoryStore,
  createRemoteOrchestrator,
  createRemoteSessionStore,
} from './index.ts';
import { openApiDocument, openApiOperations } from './openapi.ts';
import { startRemote, type RemoteServer } from './server.ts';

const accessToken = 'schema-token-0123456789';
const DOCS = new URL('../../../schema/', import.meta.url);

const servers: RemoteServer[] = [];
afterAll(async () => {
  await Promise.all(servers.map((server) => server.close()));
});

/** 按名字校验一个值；问题原样报出来，测试里一眼看得到是哪个字段。 */
function conforms(name: string, value: unknown): string[] {
  return checkJsonSchema(resolveSchemaRefs(PROTOCOL_SCHEMA, name), JSON.parse(JSON.stringify(value)), 20);
}

async function setup() {
  const store = createMemoryStore();
  const tools = createToolRegistry();
  tools.executor.register({ name: 'echo', description: '原样返回', inputSchema: { type: 'object' } }, (input) => ({
    type: 'json',
    value: input,
  }));
  tools.add(tools.executor.definition('echo')!);
  const script = [
    { type: 'tool-call', id: 'c1', input: { text: 'hi' } },
    { type: 'text', text: '好了' },
  ] as const;
  const harness = createHarness({
    store,
    context: createContextBuilder({ store }),
    tools,
    models: () => createScriptedModel(script, { tool: 'echo' }),
  });
  const server = await startRemote({
    store,
    harness,
    orchestrator: createOrchestrator({ harness, store }),
    executors: [tools.executor, createFunctionExecutor('box')],
    memory: createInMemoryMemoryStore(),
    accessToken,
  });
  servers.push(server);
  return { server, client: { baseUrl: server.baseUrl, accessToken } };
}

describe('JSON Schema 和 OpenAPI', () => {
  test('schema/ 下的两份文件和代码一致（UPDATE_SCHEMA=1 时重写）', async () => {
    const files = {
      'protocol.schema.json': PROTOCOL_SCHEMA,
      'openapi.json': openApiDocument(),
    };
    for (const [file, value] of Object.entries(files)) {
      const text = `${JSON.stringify(value, null, 2)}\n`;
      if (process.env['UPDATE_SCHEMA'] === '1') await writeFile(new URL(file, DOCS), text);
      // 文件归 Oxfmt 排版，按内容比，不按文字比。
      expect(
        JSON.parse(await readFile(new URL(file, DOCS), 'utf8')),
        `${file} 过期了：UPDATE_SCHEMA=1 pnpm test 重写`,
      ).toEqual(value);
    }
  });

  test('schema 不收没列出的键：TypeScript 加了字段而 schema 没加，下面的校验会红', () => {
    expect(conforms('ToolCall', { id: 'c', name: 'n', input: {} })).toEqual([]);
    expect(conforms('ToolCall', { id: 'c', name: 'n', input: {}, extra: 1 })).not.toEqual([]);
  });

  test('线上的真实值都合 schema：会话、harness、流、编排器、执行环境、记忆、发现', async () => {
    const { server, client } = await setup();
    const agent = { model: 'scripted', settings: { temperature: 0 } };
    const problems: Record<string, string[]> = {};
    const check = (name: string, value: unknown, where = name): void => {
      const issues = conforms(name, value);
      if (issues.length > 0) problems[where] = issues;
    };

    const info = await fetch(`${server.baseUrl}/protocol`, { headers: { authorization: `Bearer ${accessToken}` } });
    check('ProtocolInfo', await info.json());

    const harness = createRemoteHarness(client);
    const result = await harness.run({ session: 's', agent, input: '回显一下', parent: { session: 'p', runId: 'r' } });
    check('RunResult', result);
    const events: RunEvent[] = [];
    for await (const event of harness.stream({ session: 's', agent, input: '再来' })) events.push(event);
    events.forEach((event, index) => check('RunEvent', event, `RunEvent[${index}] ${event.type}`));

    const sessions = createRemoteSessionStore(client);
    await sessions.append('s', [userEntry('补一句', { key: 'k', meta: { tag: 'x' } })]);
    (await sessions.list('s')).forEach((entry, index) => check('Entry', entry, `Entry[${index}]`));

    const orchestrator = createRemoteOrchestrator(client);
    const handle = await orchestrator.submit({ session: 'o', agent, input: '排队' });
    check('RunResult', await handle.done);
    const wire = await fetch(`${server.baseUrl}/orchestrator/runs/${handle.runId}`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    const status = (await wire.json()) as { result?: unknown };
    check('RunResult', status.result, 'GET /orchestrator/runs/:runId result');
    check('RunStatus', await orchestrator.status(handle.runId));

    const executor = createRemoteExecutor({ ...client, name: 'local' });
    (await executor.tools()).forEach((definition) => check('ToolDefinition', definition));
    check('ToolOutput', await executor.execute({ id: 'x', name: 'echo', input: { a: 1 } }, { session: 's' }));
    check(
      'ToolOutput',
      await executor.execute({ id: 'y', name: 'nope', input: {} }, { session: 's' }),
      'ToolOutput error',
    );

    const memory = createRemoteMemoryStore(client);
    const [note] = await memory.notes.add([{ session: 's', from: 1, upTo: 2, at: 1, salience: 0.5 }]);
    check('Note', note);
    const source = { session: 's', from: 1, upTo: 2 };
    const fact = await memory.facts.add({
      subject: 'user',
      text: '喜欢喝茶',
      validFrom: 1,
      confidence: 0.9,
      salience: 0.5,
      sources: [source],
    });
    check('MemoryFact', fact);
    (await memory.facts.search({ text: '喝茶' })).forEach((hit) => check('FactHit', hit));
    check('Procedure', await memory.procedures.add({ when: '用户问天气', do: '先问城市', evidence: [source], at: 1 }));
    await memory.core.set('爱喝茶', 2);
    check('CoreVersion', await memory.core.get());

    expect(problems).toEqual({});
  });

  test('OpenAPI 列出的每条路径和方法服务端都认（不是「没有这条路径」的 404、不是 405）', async () => {
    const { server } = await setup();
    const unknown: string[] = [];
    for (const { method, path } of openApiOperations()) {
      const url = `${server.baseUrl}${path.replaceAll(/\{\w+\}/g, 'x')}`;
      const controller = new AbortController();
      const response = await fetch(url, {
        method: method.toUpperCase(),
        headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
        ...(method === 'get' || method === 'delete' ? {} : { body: '{}' }),
        signal: controller.signal,
      });
      // 流式的路径只看响应头，不读到底。
      const text = response.headers.get('content-type')?.includes('ndjson') ? '' : await response.text();
      controller.abort();
      if (response.status === 405 || (response.status === 404 && text.includes('not found: /'))) {
        unknown.push(`${method.toUpperCase()} ${path} → ${response.status}`);
      }
    }
    expect(unknown).toEqual([]);
  });
});
