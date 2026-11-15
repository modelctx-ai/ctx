import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

import {
  createContextBuilder,
  createHarness,
  createMemoryStore,
  createToolRegistry,
  jsonSchema,
  tool,
  type ToolRegistry,
} from '@modelctx-ai/ctx';
import { createScriptedModel, describeExecutorContract } from '@modelctx-ai/ctx/testing';
import { describe, test } from 'vite-plus/test';

import {
  createMcpHub,
  namespaced,
  toolOutputFromMcp,
  type McpConnectOptions,
  type McpConnector,
  type McpToolSet,
} from './index.ts';

/** 和 `@ai-sdk/mcp` 给出的工具一样：输入结构是 `jsonSchema(...)`。 */
const fake = (text: string) =>
  tool({ description: text, inputSchema: jsonSchema({ type: 'object', properties: {} }), execute: async () => text });

/** 调用时原样回这个值的工具，用来造各种形状的 MCP 结果。 */
const returning = (value: unknown) =>
  tool({ description: 'big', inputSchema: jsonSchema({ type: 'object' }), execute: async () => value });

/** 回显工具：像 MCP 服务器那样回 `{ content: [{ type: 'text' }] }`。 */
const echoTool = tool({
  description: '原样返回',
  inputSchema: jsonSchema<{ text: string }>({ type: 'object', properties: { text: { type: 'string' } } }),
  execute: async (input) => ({ content: [{ type: 'text', text: JSON.stringify(input) }], isError: false }),
});

describeExecutorContract(
  'mcp hub',
  () => ({
    executor: createMcpHub(
      { local: { command: 'x' } },
      { connector: async () => ({ tools: async () => ({ echo: echoTool }), close: async () => {} }) },
    ),
    echo: 'local__echo',
  }),
  { describe, test },
);

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

async function waitFor(check: () => boolean, ms = 3000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error('condition not met in time');
    await delay(10);
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function describedTools(registry: ToolRegistry): string[] {
  return registry.list().map((info) => `${info.name}@${info.source}:${info.description}`);
}

/** 结果被截断时末尾的那一行。 */
const truncated = (dropped: number) =>
  `[… truncated ${dropped} more characters; narrow the request (filters, paging, a smaller range) to see the rest]`;

/**
 * 假连接器：每台服务器给同一份工具表（可以换），记下连接时拿到的钩子，测试从外面报断开、报工具变了。
 * 列工具回的是发请求那一刻的工具表，`listDelay` 毫秒以后才回。
 */
function controllable(tools: McpToolSet) {
  const state = {
    tools,
    listDelay: 0,
    fail: undefined as Error | undefined,
    listed: 0,
    opened: {} as Record<string, number>,
    closed: {} as Record<string, number>,
    hooks: {} as Record<string, McpConnectOptions | undefined>,
  };
  const connector: McpConnector = async (name, _config, options) => {
    state.opened[name] = (state.opened[name] ?? 0) + 1;
    state.hooks[name] = options;
    return {
      tools: async () => {
        state.listed += 1;
        const answer = state.tools;
        if (state.listDelay > 0) await delay(state.listDelay);
        if (state.fail) throw state.fail;
        return answer;
      },
      close: async () => {
        state.closed[name] = (state.closed[name] ?? 0) + 1;
      },
    };
  };
  return { state, connector };
}

interface RemoteTool {
  name: string;
  description: string;
  inputSchema: { type: 'object' };
}

interface RpcRequest {
  id?: number;
  method: string;
  params?: { name?: string; protocolVersion?: string };
}

/**
 * 最小的远程 MCP 服务器，只给测试用。工具调用回工具自己的名字。
 * `http` 是 Streamable HTTP：POST 回 JSON，GET 是服务器往客户端推消息的事件流，带会话号。
 * `sse` 是旧的 SSE：GET 是事件流（先发 endpoint），POST 只回 202，回答走事件流。
 * `push()` 往事件流里推一条消息，`drop()` 掐断事件流，`expire()` 再让现有会话失效（带旧会话号的请求得到 404）。
 */
async function startRemoteServer(kind: 'http' | 'sse') {
  const tools: RemoteTool[] = [{ name: 'one', description: '一', inputSchema: { type: 'object' } }];
  const streams = new Set<ServerResponse>();
  let generation = 1;
  const session = () => `session-${generation}`;
  const push = (message: object): void => {
    for (const stream of streams) stream.write(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
  };
  const drop = (): void => {
    for (const stream of streams) stream.end();
  };
  const answer = (message: RpcRequest): object => {
    switch (message.method) {
      case 'initialize':
        return {
          result: {
            protocolVersion: message.params?.protocolVersion,
            capabilities: { tools: { listChanged: true } },
            serverInfo: { name: 'remote', version: '0.0.0' },
          },
        };
      case 'tools/list':
        return { result: { tools } };
      case 'tools/call':
        return { result: { content: [{ type: 'text', text: message.params?.name ?? '' }] } };
      default:
        return { error: { code: -32601, message: `unknown method ${message.method}` } };
    }
  };
  const server = createServer((request, response) => {
    const sent = request.headers['mcp-session-id'];
    if (sent !== undefined && sent !== session()) {
      response.writeHead(404).end('session not found');
      return;
    }
    if (request.method === 'GET') {
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        ...(kind === 'http' ? { 'mcp-session-id': session() } : {}),
      });
      if (kind === 'sse') response.write('event: endpoint\ndata: /messages\n\n');
      else response.flushHeaders();
      streams.add(response);
      response.on('close', () => streams.delete(response));
      return;
    }
    if (request.method !== 'POST') {
      response.writeHead(200).end();
      return;
    }
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      body += chunk;
    });
    request.on('end', () => {
      const message = JSON.parse(body) as RpcRequest;
      if (message.id === undefined || kind === 'sse') response.writeHead(202).end();
      if (message.id === undefined) return;
      const reply = { jsonrpc: '2.0', id: message.id, ...answer(message) };
      if (kind === 'sse') {
        push(reply);
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': session() });
      response.end(JSON.stringify(reply));
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`,
    tools,
    streams,
    push,
    drop,
    expire(): void {
      generation += 1;
      drop();
    },
    async close(): Promise<void> {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

const TOOLS_CHANGED = { jsonrpc: '2.0', method: 'notifications/tools/list_changed' };

describe('mcp hub', () => {
  test('按服务器加前缀、按 include/exclude 过滤，失败和停用都记在状态里', async () => {
    const closed: string[] = [];
    const connector: McpConnector = async (name) => {
      if (name === 'broken') throw new Error('spawn ENOENT');
      return {
        tools: async () => ({ search: fake('s'), fetch: fake('f'), 'read file': fake('r') }),
        close: async () => {
          closed.push(name);
        },
      };
    };
    const hub = createMcpHub(
      {
        web: { url: 'https://mcp.example/api', exclude: ['fetch', 'read file'] },
        local: { command: 'node', include: ['read file'] },
        broken: { command: 'missing' },
        off: { command: 'node', enabled: false },
      },
      { connector },
    );
    const statuses = await hub.connect();
    assert.deepEqual(
      statuses.find((status) => status.name === 'broken'),
      {
        name: 'broken',
        state: 'failed',
        error: 'spawn ENOENT',
      },
    );
    assert.equal(statuses.find((status) => status.name === 'off')?.state, 'disabled');
    assert.deepEqual(Object.keys(hub.toolSet()).toSorted(), ['local__read_file', 'web__search']);
    assert.deepEqual(
      (await hub.tools()).map((definition) => `${definition.name}@${definition.source}→${definition.executor}`),
      ['web__search@mcp:web→mcp', 'local__read_file@mcp:local→mcp'],
    );

    const registry = createToolRegistry().addTool('local_only', fake('x'));
    assert.equal(hub.registerInto(registry), 2);
    assert.deepEqual(
      registry.list().map((info) => `${info.name}@${info.source}`),
      ['local_only@local', 'web__search@mcp:web', 'local__read_file@mcp:local'],
    );
    assert.equal(hub.registerInto(registry), 2, '重复注册会替换，不报重名');

    await hub.close();
    assert.deepEqual(closed.toSorted(), ['local', 'web']);
    assert.deepEqual(hub.toolSet(), {});
    assert.deepEqual(await hub.tools(), []);
  });

  test('前缀后的名字合法且不超过 64', () => {
    assert.equal(namespaced('my.server', 'do it'), 'my_server__do_it');
    assert.equal(namespaced('s', 'x'.repeat(100)).length, 64);
  });

  test('列工具出错时关掉连接；同时调 connect 只连一次', async () => {
    const opened: string[] = [];
    const closed: string[] = [];
    const connector: McpConnector = async (name) => {
      opened.push(name);
      await delay(10);
      return {
        tools: async () => {
          if (name === 'resources') throw new Error('Server does not support tools');
          return { search: fake('s') };
        },
        close: async () => {
          closed.push(name);
        },
      };
    };
    const hub = createMcpHub({ resources: { command: 'x' }, web: { command: 'y' } }, { connector });
    const [first, second] = await Promise.all([hub.connect(), hub.connect()]);
    assert.deepEqual(first, second);
    assert.deepEqual(first, [
      { name: 'resources', state: 'failed', error: 'Server does not support tools' },
      { name: 'web', state: 'connected', tools: ['web__search'] },
    ]);
    assert.deepEqual(opened.toSorted(), ['resources', 'web']);
    assert.deepEqual(closed, ['resources']);

    await hub.connect();
    assert.deepEqual(opened.toSorted(), ['resources', 'resources', 'web'], '失败的下次再试，连上的不再连');
    await hub.close();
    assert.deepEqual(closed.toSorted(), ['resources', 'resources', 'web']);
  });

  test('超过时限的服务器记为失败并关掉连接，别的服务器照常', async () => {
    const closed: string[] = [];
    const signals = new Map<string, AbortSignal | undefined>();
    const never = new Promise<never>(() => {});
    const connector: McpConnector = async (name, _config, options) => {
      signals.set(name, options?.signal);
      if (name === 'hangs') return never;
      if (name === 'late') await delay(150);
      return {
        tools: async () => (name === 'slow' ? never : { ok: fake('ok') }),
        close: async () => {
          closed.push(name);
        },
      };
    };
    const hub = createMcpHub(
      {
        hangs: { command: 'x' },
        late: { command: 'x' },
        slow: { command: 'x', timeoutMs: 30 },
        good: { command: 'x' },
      },
      { connector, timeoutMs: 60 },
    );
    const statuses = await hub.connect();
    assert.deepEqual(statuses, [
      { name: 'hangs', state: 'failed', error: 'timed out after 60ms' },
      { name: 'late', state: 'failed', error: 'timed out after 60ms' },
      { name: 'slow', state: 'failed', error: 'timed out after 30ms' },
      { name: 'good', state: 'connected', tools: ['good__ok'] },
    ]);
    assert.equal(signals.get('hangs')?.aborted, true, '超时会中止连接用的 signal');
    assert.deepEqual(closed, ['slow']);
    await waitFor(() => closed.includes('late'));
    assert.deepEqual(Object.keys(hub.toolSet()), ['good__ok'], '超时以后才连上的也关掉，不收它的工具');
    await hub.close();
  });

  test('改名后重名的工具留第一个，其余记进 skipped；registerInto 不替换别的来源的同名工具', async () => {
    const connector: McpConnector = async (name) => ({
      tools: async (): Promise<McpToolSet> =>
        name === 'my.srv'
          ? { 'read file': fake('A1'), read_file: fake('A2') }
          : { read_file: fake('B1'), search: fake('B2') },
      close: async () => {},
    });
    const warned: string[] = [];
    const hub = createMcpHub(
      { 'my.srv': { command: 'x' }, my_srv: { command: 'y' } },
      { connector, logger: { warn: (message) => warned.push(message) } },
    );
    assert.deepEqual(await hub.connect(), [
      { name: 'my.srv', state: 'connected', tools: ['my_srv__read_file'], skipped: ['read_file'] },
      { name: 'my_srv', state: 'connected', tools: ['my_srv__search'], skipped: ['read_file'] },
    ]);
    assert.equal(hub.toolSet()['my_srv__read_file']?.description, 'A1');

    const registry = createToolRegistry().addTool('my_srv__search', fake('local'));
    assert.equal(hub.registerInto(registry), 1);
    assert.deepEqual(describedTools(registry), ['my_srv__search@local:local', 'my_srv__read_file@mcp:my.srv:A1']);
    assert.deepEqual(warned, ['MCP tool "my_srv__search" from server "my_srv" skipped: name already registered']);
    assert.equal(hub.registerInto(registry), 1, '再注册一次也一样');
    await hub.close();
  });

  test('close 清空状态，从写过的注册表里删掉这些工具；连接中途关掉也不留连接', async () => {
    const hub = createMcpHub(
      { web: { url: 'https://mcp.example/api' } },
      { connector: async () => ({ tools: async () => ({ search: fake('s') }), close: async () => {} }) },
    );
    await hub.connect();
    const one = createToolRegistry().addTool('local', fake('l'));
    const two = createToolRegistry();
    assert.equal(hub.registerInto(one), 1);
    assert.equal(hub.registerInto(two), 1);
    await hub.close();
    assert.deepEqual(hub.status(), []);
    assert.deepEqual(hub.toolSet(), {});
    assert.deepEqual(describedTools(one), ['local@local:l']);
    assert.equal(two.size, 0);

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const closed: string[] = [];
    const slow = createMcpHub(
      { s: { command: 'x' } },
      {
        connector: async () => {
          await gate;
          return { tools: async () => ({}), close: async () => void closed.push('s') };
        },
      },
    );
    const connecting = slow.connect();
    await slow.close();
    release();
    assert.deepEqual(await connecting, []);
    await waitFor(() => closed.length === 1);
    assert.deepEqual(slow.status(), []);
  });

  test('真的 stdio 服务器：不提供工具的会被关掉，不回话的按时限放弃并结束进程', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ctx-mcp-'));
    const pids = { resources: join(dir, 'resources.pid'), silent: join(dir, 'silent.pid') };
    const hub = createMcpHub(
      {
        resources: {
          command: process.execPath,
          args: [fixture('no-tools-server.mjs')],
          env: { PIDFILE: pids.resources },
        },
        silent: { command: process.execPath, args: [fixture('silent-server.mjs')], env: { PIDFILE: pids.silent } },
      },
      { timeoutMs: 1500 },
    );
    try {
      assert.deepEqual(await hub.connect(), [
        { name: 'resources', state: 'failed', error: 'Server does not support tools' },
        { name: 'silent', state: 'failed', error: 'timed out after 1500ms' },
      ]);
      for (const file of Object.values(pids)) {
        await waitFor(() => existsSync(file));
        const pid = Number(readFileSync(file, 'utf8'));
        await waitFor(() => !alive(pid));
      }
    } finally {
      await hub.close();
    }
  });

  test('真的起一个 stdio 服务器，列工具、调工具', async () => {
    const hub = createMcpHub({
      echo: {
        command: process.execPath,
        args: [fileURLToPath(new URL('./fixtures/echo-server.mjs', import.meta.url))],
        env: { ECHO_PREFIX: '回声：' },
      },
    });
    try {
      const [status] = await hub.connect();
      assert.deepEqual(status, { name: 'echo', state: 'connected', tools: ['echo__echo', 'echo__shout'] });
      const [definition] = await hub.tools();
      assert.deepEqual(definition, {
        name: 'echo__echo',
        description: '原样返回',
        inputSchema: {
          type: 'object',
          properties: { text: { type: 'string' } },
          required: ['text'],
          additionalProperties: false,
        },
        executor: 'mcp',
        source: 'mcp:echo',
      });
      const output = await hub.execute({ id: 'c1', name: 'echo__echo', input: { text: '在吗' } }, { session: 's' });
      assert.deepEqual(output, { type: 'text', text: '回声：在吗' });
    } finally {
      await hub.close();
    }
  });

  test('hub 作为执行环境接进 harness：模型调用 MCP 工具，结果回到模型', async () => {
    const hub = createMcpHub(
      { web: { url: 'https://mcp.example/api' } },
      { connector: async () => ({ tools: async () => ({ echo: echoTool }), close: async () => {} }) },
    );
    await hub.connect();
    const registry = createToolRegistry();
    hub.registerInto(registry);
    const store = createMemoryStore();
    const harness = createHarness({
      store,
      context: createContextBuilder({ store }),
      tools: registry,
      executors: [hub],
    });
    const model = createScriptedModel(
      [
        { type: 'tool-call', id: 'c1', input: { text: '在吗' } },
        { type: 'text', text: '好' },
      ],
      { tool: 'web__echo' },
    );
    const result = await harness.run({ session: 's', agent: { model }, input: '回显' });
    assert.equal(result.stopReason, 'end_turn');
    assert.match(JSON.stringify(model.doGenerateCalls[1]!.prompt.at(-1)), /在吗/);
    await hub.close();
  });

  test('MCP 结果转成协议的结果：文字合成一段，图片是文件，isError 是错误', () => {
    assert.deepEqual(
      toolOutputFromMcp({
        content: [
          { type: 'text', text: 'a' },
          { type: 'text', text: 'b' },
        ],
      }),
      {
        type: 'text',
        text: 'a\nb',
      },
    );
    assert.deepEqual(
      toolOutputFromMcp({
        content: [
          { type: 'text', text: '截图' },
          { type: 'image', data: 'aGk=', mimeType: 'image/png' },
        ],
      }),
      {
        type: 'content',
        parts: [
          { type: 'text', text: '截图' },
          { type: 'file', mediaType: 'image/png', data: { type: 'data', data: 'aGk=' } },
        ],
      },
    );
    assert.deepEqual(toolOutputFromMcp({ content: [{ type: 'text', text: '文件不存在' }], isError: true }), {
      type: 'error',
      message: '文件不存在',
    });
    assert.deepEqual(toolOutputFromMcp({ toolResult: { ok: true } }), {
      type: 'json',
      value: { toolResult: { ok: true } },
    });
  });

  test('工具说明超过 maxDescriptionChars 的截断并注明，缺省 2000；toolSet 里是原样', async () => {
    const long = '说'.repeat(5000);
    const connector: McpConnector = async () => ({
      tools: async () => ({ long: fake(long), short: fake('短') }),
      close: async () => {},
    });
    const hub = createMcpHub({ s: { command: 'x' } }, { connector });
    await hub.connect();
    const cut = `${'说'.repeat(2000)}… [description truncated, 3000 more characters]`;
    assert.deepEqual(
      (await hub.tools()).map((definition) => definition.description),
      [cut, '短'],
    );
    assert.equal(hub.toolSet()['s__long']?.description, long);
    const registry = createToolRegistry();
    hub.registerInto(registry);
    assert.equal(registry.get('s__long')?.description, cut);
    await hub.close();

    const small = createMcpHub({ s: { command: 'x' } }, { connector, maxDescriptionChars: 10 });
    await small.connect();
    assert.equal(
      (await small.tools())[0]?.description,
      `${'说'.repeat(10)}… [description truncated, 4990 more characters]`,
    );
    await small.close();

    const unlimited = createMcpHub({ s: { command: 'x' } }, { connector, maxDescriptionChars: 0 });
    await unlimited.connect();
    assert.equal((await unlimited.tools())[0]?.description, long);
    await unlimited.close();
  });

  test('toolOutputFromMcp 带上限：文字截断并注明省略多少，放不下的文件换成说明，json 和错误同样处理', () => {
    const limits = { maxOutputChars: 10, maxFileBytes: 6 };
    assert.deepEqual(toolOutputFromMcp('x'.repeat(25), limits), {
      type: 'text',
      text: `${'x'.repeat(10)}\n${truncated(15)}`,
    });
    assert.deepEqual(
      toolOutputFromMcp(
        {
          content: [
            { type: 'text', text: 'aaaaaa' },
            { type: 'text', text: 'bbbbbb' },
          ],
        },
        limits,
      ),
      { type: 'text', text: `aaaaaa\nbbb\n${truncated(3)}` },
    );
    // 文字合起来算：第二段只剩 4 个字符的额度，第三段不要了。文件合起来算：第二张放不下。
    assert.deepEqual(
      toolOutputFromMcp(
        {
          content: [
            { type: 'text', text: 'aaaaaa' },
            { type: 'image', data: 'aGk=', mimeType: 'image/png' },
            { type: 'text', text: 'bbbbbb' },
            { type: 'image', data: 'A'.repeat(16), mimeType: 'image/png' },
            { type: 'text', text: 'cc' },
          ],
        },
        limits,
      ),
      {
        type: 'content',
        parts: [
          { type: 'text', text: 'aaaaaa' },
          { type: 'file', mediaType: 'image/png', data: { type: 'data', data: 'aGk=' } },
          { type: 'text', text: `bbbb\n${truncated(4)}` },
          {
            type: 'text',
            text: '[image/png file omitted: its 12 bytes do not fit in the 6-byte limit for files in one tool result]',
          },
        ],
      },
    );
    assert.deepEqual(toolOutputFromMcp({ rows: 'y'.repeat(50) }, limits), {
      type: 'text',
      text: `{"rows":"y\n${truncated(51)}`,
    });
    assert.deepEqual(toolOutputFromMcp({ content: [{ type: 'text', text: 'e'.repeat(30) }], isError: true }, limits), {
      type: 'error',
      message: `${'e'.repeat(10)}\n${truncated(20)}`,
    });
    assert.deepEqual(
      toolOutputFromMcp('😀'.repeat(6), { maxOutputChars: 5 }),
      { type: 'text', text: `😀😀\n${truncated(8)}` },
      '不把一个字符切成两半',
    );

    // 不给上限，或上限是 0、Infinity：原样。
    const big = { content: [{ type: 'text', text: 'x'.repeat(25) }] };
    assert.deepEqual(toolOutputFromMcp(big), { type: 'text', text: 'x'.repeat(25) });
    assert.deepEqual(toolOutputFromMcp(big, { maxOutputChars: 0 }), { type: 'text', text: 'x'.repeat(25) });
    assert.deepEqual(toolOutputFromMcp(big, { maxOutputChars: Infinity }), { type: 'text', text: 'x'.repeat(25) });
    assert.deepEqual(toolOutputFromMcp({ rows: 'y'.repeat(50) }, { maxOutputChars: 100 }), {
      type: 'json',
      value: { rows: 'y'.repeat(50) },
    });
  });

  test('execute 按缺省上限收结果：500 万字符的文字截到 10 万，超过 5 MiB 的图片换成说明；上限可以关', async () => {
    const text = 'x'.repeat(5_000_000);
    const image = 'A'.repeat(7_000_000);
    const connector: McpConnector = async () => ({
      tools: async () => ({
        text: returning({ content: [{ type: 'text', text }] }),
        image: returning({
          content: [
            { type: 'text', text: '截图' },
            { type: 'image', data: image, mimeType: 'image/png' },
          ],
        }),
      }),
      close: async () => {},
    });
    const hub = createMcpHub({ s: { command: 'x' } }, { connector });
    await hub.connect();
    const cut = await hub.execute({ id: 'c1', name: 's__text', input: {} }, { session: 's' });
    assert.equal(cut.type === 'text' && cut.text, `${'x'.repeat(100_000)}\n${truncated(4_900_000)}`);
    assert.deepEqual(await hub.execute({ id: 'c2', name: 's__image', input: {} }, { session: 's' }), {
      type: 'content',
      parts: [
        { type: 'text', text: '截图' },
        {
          type: 'text',
          text: '[image/png file omitted: its 5250000 bytes do not fit in the 5242880-byte limit for files in one tool result]',
        },
      ],
    });
    await hub.close();

    const unlimited = createMcpHub({ s: { command: 'x' } }, { connector, maxOutputChars: 0, maxFileBytes: 0 });
    await unlimited.connect();
    const whole = await unlimited.execute({ id: 'c1', name: 's__text', input: {} }, { session: 's' });
    assert.equal(whole.type === 'text' && whole.text.length, 5_000_000);
    const kept = await unlimited.execute({ id: 'c2', name: 's__image', input: {} }, { session: 's' });
    assert.equal(kept.type === 'content' && kept.parts[1]?.type, 'file');
    await unlimited.close();
  });

  test('不回应的工具到 callTimeoutMs 返回错误并中止底层请求；服务器自己的时限优先，调用方的 signal 照旧生效', async () => {
    const seen: AbortSignal[] = [];
    const hang = tool({
      description: '不回话',
      inputSchema: jsonSchema({ type: 'object' }),
      execute: async (_input, { abortSignal }) => {
        if (abortSignal) seen.push(abortSignal);
        return await new Promise<string>(() => {});
      },
    });
    const connector: McpConnector = async () => ({
      tools: async () => ({ hang, echo: echoTool }),
      close: async () => {},
    });
    const hub = createMcpHub(
      { quick: { command: 'x' }, patient: { command: 'x', callTimeoutMs: 80 } },
      { connector, callTimeoutMs: 30 },
    );
    await hub.connect();

    const started = Date.now();
    assert.deepEqual(await hub.execute({ id: 'c1', name: 'quick__hang', input: {} }, { session: 's' }), {
      type: 'error',
      message:
        'MCP tool "quick__hang" (tool "hang" on server "quick") timed out after 30ms. ' +
        'The request was cancelled on this side; the server may still be running it.',
    });
    assert.ok(Date.now() - started < 1000);
    assert.equal(seen[0]?.aborted, true, '到点中止传给工具的 signal');

    const slower = await hub.execute({ id: 'c2', name: 'patient__hang', input: {} }, { session: 's' });
    assert.equal(
      slower.type === 'error' &&
        slower.message.startsWith('MCP tool "patient__hang" (tool "hang" on server "patient") timed out after 80ms.'),
      true,
    );

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);
    assert.deepEqual(
      await hub.execute({ id: 'c3', name: 'patient__hang', input: {} }, { session: 's', signal: controller.signal }),
      { type: 'error', message: 'Aborted while MCP tool "patient__hang" was running.' },
    );
    assert.equal(seen[2]?.aborted, true, '调用方中止也传给工具');

    const echoed = await hub.execute({ id: 'c4', name: 'quick__echo', input: { text: '在' } }, { session: 's' });
    assert.deepEqual(echoed, { type: 'text', text: '{"text":"在"}' });
    await hub.close();
  });

  test('连接断开：状态变 failed，工具从 tools() 和写过的注册表里去掉，execute 说明断开了；connect() 重连后都回来', async () => {
    const { state, connector } = controllable({ a: fake('A') });
    const warned: string[] = [];
    const hub = createMcpHub(
      { s: { command: 'x' }, other: { command: 'y' } },
      { connector, logger: { warn: (message) => warned.push(message) } },
    );
    await hub.connect();
    const registry = createToolRegistry().addTool('local', fake('l'));
    assert.equal(hub.registerInto(registry), 2);

    state.hooks['s']?.onClose?.('pipe broke');
    assert.deepEqual(hub.status(), [
      { name: 's', state: 'failed', error: 'disconnected: pipe broke' },
      { name: 'other', state: 'connected', tools: ['other__a'] },
    ]);
    assert.deepEqual(Object.keys(hub.toolSet()), ['other__a']);
    assert.deepEqual(
      (await hub.tools()).map((definition) => definition.name),
      ['other__a'],
    );
    assert.deepEqual(describedTools(registry), ['local@local:l', 'other__a@mcp:other:A']);
    assert.deepEqual(warned, ['MCP server "s" disconnected']);
    await waitFor(() => state.closed['s'] === 1);
    assert.deepEqual(await hub.execute({ id: 'c1', name: 's__a', input: {} }, { session: 's' }), {
      type: 'error',
      message: 'MCP server "s" is disconnected (pipe broke), so tool "s__a" is unavailable until it reconnects.',
    });
    assert.equal((await hub.execute({ id: 'c2', name: 'other__a', input: {} }, { session: 's' })).type, 'text');

    // 旧连接再报一次关闭：已经不用它了，不动。
    const old = state.hooks['s'];
    old?.onClose?.('again');
    assert.deepEqual(hub.status()[0], { name: 's', state: 'failed', error: 'disconnected: pipe broke' });

    state.tools = { a: fake('A'), b: fake('B') };
    assert.deepEqual(await hub.connect(), [
      { name: 's', state: 'connected', tools: ['s__a', 's__b'] },
      { name: 'other', state: 'connected', tools: ['other__a'] },
    ]);
    assert.deepEqual(state.opened, { s: 2, other: 1 }, '只重连断开的那台');
    assert.deepEqual(describedTools(registry), [
      'local@local:l',
      's__a@mcp:s:A',
      's__b@mcp:s:B',
      'other__a@mcp:other:A',
    ]);
    assert.deepEqual(await hub.execute({ id: 'c3', name: 's__a', input: {} }, { session: 's' }), {
      type: 'text',
      text: 'A',
    });
    // 上一条连接迟到的关闭和通知不影响新连接。
    old?.onClose?.('late');
    old?.onToolsChanged?.();
    assert.equal(hub.status()[0]?.state, 'connected');
    await hub.close();
    assert.deepEqual(describedTools(registry), ['local@local:l']);

    // 还在列工具的时候就断了：这次连接算失败，连接关掉。
    let closed = 0;
    const dying = createMcpHub(
      { s: { command: 'x' } },
      {
        connector: async (_name, _config, options) => ({
          tools: async () => {
            options?.onClose?.('died early');
            return await new Promise<McpToolSet>(() => {});
          },
          close: async () => {
            closed += 1;
          },
        }),
      },
    );
    assert.deepEqual(await dying.connect(), [{ name: 's', state: 'failed', error: 'died early' }]);
    assert.equal(closed, 1);
    await dying.close();
  });

  test('收到 list_changed 重新列工具，refresh() 手动刷新；并发的刷新一次接一次，列不出来保留原来的', async () => {
    const { state, connector } = controllable({ a: fake('A') });
    const hub = createMcpHub({ s: { command: 'x' }, off: { command: 'x', enabled: false } }, { connector });
    await hub.connect();
    const registry = createToolRegistry();
    hub.registerInto(registry);

    state.tools = { b: fake('B') };
    state.hooks['s']?.onToolsChanged?.();
    await waitFor(() => registry.has('s__b'));
    assert.deepEqual(hub.status()[0], { name: 's', state: 'connected', tools: ['s__b'] });
    assert.deepEqual(describedTools(registry), ['s__b@mcp:s:B']);
    assert.deepEqual(await hub.execute({ id: 'c1', name: 's__b', input: {} }, { session: 's' }), {
      type: 'text',
      text: 'B',
    });
    assert.equal((await hub.execute({ id: 'c2', name: 's__a', input: {} }, { session: 's' })).type, 'error');

    state.tools = { c: fake('C') };
    assert.deepEqual(await hub.refresh('s'), [
      { name: 's', state: 'connected', tools: ['s__c'] },
      { name: 'off', state: 'disabled' },
    ]);

    // 正在列的那一次是变化之前答的：跑完再列一次，几个调用等到的都是最后的结果。
    state.listDelay = 30;
    const listed = state.listed;
    const first = hub.refresh();
    state.tools = { d: fake('D') };
    state.hooks['s']?.onToolsChanged?.();
    const [one, two] = await Promise.all([first, hub.refresh('s'), hub.refresh()]);
    assert.deepEqual(one, two);
    assert.deepEqual(one[0], { name: 's', state: 'connected', tools: ['s__d'] });
    assert.equal(state.listed - listed, 2);
    state.listDelay = 0;

    state.fail = new Error('list failed');
    assert.deepEqual((await hub.refresh())[0], {
      name: 's',
      state: 'connected',
      tools: ['s__d'],
      refreshError: 'list failed',
    });
    assert.deepEqual(describedTools(registry), ['s__d@mcp:s:D']);
    state.fail = undefined;
    assert.deepEqual((await hub.refresh())[0], { name: 's', state: 'connected', tools: ['s__d'] });

    // 没连上的、不认识的名字：不动，不抛。
    assert.equal((await hub.refresh('off')).length, 2);
    assert.equal((await hub.refresh('nope')).length, 2);
    assert.deepEqual(state.opened, { s: 1 });
    await hub.close();
    assert.deepEqual(await hub.refresh(), []);
  });

  test('真的 stdio 服务器：不回话的调用按时限返回，list_changed 后多出工具，进程退出后状态 failed、能重连', async () => {
    const server = { command: process.execPath, args: [fixture('flaky-server.mjs')] };
    const hub = createMcpHub({ flaky: server, impatient: { ...server, callTimeoutMs: 100 } });
    const call = async (name: string, text = '') => {
      const output = await hub.execute({ id: `c-${name}`, name, input: { text } }, { session: 's' });
      return output.type === 'text' ? output.text : output.type === 'error' ? `error: ${output.message}` : '';
    };
    try {
      const names = ['echo', 'hang', 'late', 'quit', 'grow'];
      assert.deepEqual(await hub.connect(), [
        { name: 'flaky', state: 'connected', tools: names.map((name) => `flaky__${name}`) },
        { name: 'impatient', state: 'connected', tools: names.map((name) => `impatient__${name}`) },
      ]);

      assert.match(await call('impatient__hang'), /^error: .* timed out after 100ms/);
      // 超时以后服务器才回话：这个回答没人要了，后面的调用不受影响。
      assert.match(await call('impatient__late', '晚了'), /^error: .* timed out after 100ms/);
      await delay(200);
      assert.match(await call('impatient__echo', '在吗'), /^\d+:在吗$/);

      assert.equal(await call('flaky__grow', '长'), '长');
      await waitFor(() => hub.toolSet()['flaky__extra'] !== undefined);
      assert.deepEqual(hub.status()[0], {
        name: 'flaky',
        state: 'connected',
        tools: [...names, 'extra'].map((name) => `flaky__${name}`),
      });

      const before = await call('flaky__echo');
      assert.match(before, /^\d+:$/);
      assert.match(
        await call('flaky__quit'),
        /^error: MCP server "flaky" disconnected while tool "flaky__quit" was running/,
      );
      assert.deepEqual(hub.status()[0], {
        name: 'flaky',
        state: 'failed',
        error: 'disconnected: server process exited',
      });
      assert.deepEqual(
        (await hub.tools()).map((definition) => definition.source),
        names.map(() => 'mcp:impatient'),
      );
      assert.equal(
        await call('flaky__echo'),
        'error: MCP server "flaky" is disconnected (server process exited), so tool "flaky__echo" is unavailable until it reconnects.',
      );

      assert.deepEqual((await hub.connect())[0], {
        name: 'flaky',
        state: 'connected',
        tools: names.map((name) => `flaky__${name}`),
      });
      const after = await call('flaky__echo');
      assert.match(after, /^\d+:$/);
      assert.notEqual(after, before, '重连起的是新进程');
    } finally {
      await hub.close();
    }
  });

  test('Streamable HTTP 服务器：经事件流收到 list_changed 后更新工具，会话过期按断开处理、能重连', async () => {
    const remote = await startRemoteServer('http');
    const hub = createMcpHub({ web: { url: remote.url } });
    try {
      assert.deepEqual(await hub.connect(), [{ name: 'web', state: 'connected', tools: ['web__one'] }]);
      await waitFor(() => remote.streams.size > 0);
      remote.tools.push({ name: 'two', description: '二', inputSchema: { type: 'object' } });
      remote.push(TOOLS_CHANGED);
      await waitFor(() => hub.toolSet()['web__two'] !== undefined);
      assert.deepEqual(await hub.execute({ id: 'c1', name: 'web__two', input: {} }, { session: 's' }), {
        type: 'text',
        text: 'two',
      });

      remote.expire();
      const output = await hub.execute({ id: 'c2', name: 'web__one', input: {} }, { session: 's' });
      assert.equal(
        output.type === 'error' &&
          output.message.startsWith('MCP server "web" disconnected while tool "web__one" was running'),
        true,
        JSON.stringify(output),
      );
      assert.deepEqual(hub.status(), [{ name: 'web', state: 'failed', error: 'disconnected: session expired' }]);
      assert.deepEqual(await hub.tools(), []);

      assert.deepEqual(await hub.connect(), [{ name: 'web', state: 'connected', tools: ['web__one', 'web__two'] }]);
      assert.deepEqual(await hub.execute({ id: 'c3', name: 'web__one', input: {} }, { session: 's' }), {
        type: 'text',
        text: 'one',
      });
    } finally {
      await hub.close();
      await remote.close();
    }
  });

  test('SSE 服务器：经事件流收到 list_changed 后更新工具，事件流断了按断开处理、能重连', async () => {
    const remote = await startRemoteServer('sse');
    const hub = createMcpHub({ old: { url: remote.url, type: 'sse' } });
    try {
      assert.deepEqual(await hub.connect(), [{ name: 'old', state: 'connected', tools: ['old__one'] }]);
      remote.tools.push({ name: 'two', description: '二', inputSchema: { type: 'object' } });
      remote.push(TOOLS_CHANGED);
      await waitFor(() => hub.toolSet()['old__two'] !== undefined);

      remote.drop();
      await waitFor(() => hub.status()[0]?.state === 'failed');
      assert.deepEqual(hub.status(), [{ name: 'old', state: 'failed', error: 'disconnected: SSE stream closed' }]);
      assert.deepEqual(await hub.execute({ id: 'c1', name: 'old__one', input: {} }, { session: 's' }), {
        type: 'error',
        message:
          'MCP server "old" is disconnected (SSE stream closed), so tool "old__one" is unavailable until it reconnects.',
      });

      assert.deepEqual(await hub.connect(), [{ name: 'old', state: 'connected', tools: ['old__one', 'old__two'] }]);
      assert.deepEqual(await hub.execute({ id: 'c2', name: 'old__two', input: {} }, { session: 's' }), {
        type: 'text',
        text: 'two',
      });
    } finally {
      await hub.close();
      await remote.close();
    }
  });
});
