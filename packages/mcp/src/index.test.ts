import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
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

import { createMcpHub, namespaced, toolOutputFromMcp, type McpConnector, type McpToolSet } from './index.ts';

/** 和 `@ai-sdk/mcp` 给出的工具一样：输入结构是 `jsonSchema(...)`。 */
const fake = (text: string) =>
  tool({ description: text, inputSchema: jsonSchema({ type: 'object', properties: {} }), execute: async () => text });

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
});
