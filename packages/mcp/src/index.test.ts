import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { createToolRegistry, tool, type ToolRegistry, type ToolSet } from '@modelctx-ai/ctx';
import { z } from 'zod';

import { createMcpHub, namespaced, type McpConnector } from './index.ts';

const fake = (text: string) => tool({ description: text, inputSchema: z.object({}), execute: async () => text });

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
  return registry.list().map((info) => {
    const found = registry.select([info.name])[info.name] as { description?: string } | undefined;
    return `${info.name}@${info.source}:${found?.description}`;
  });
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
    assert.deepEqual(Object.keys(hub.tools()).sort(), ['local__read_file', 'web__search']);

    const registry = createToolRegistry().add('local_only', fake('x'));
    assert.equal(hub.registerInto(registry), 2);
    assert.deepEqual(
      registry.list().map((info) => `${info.name}@${info.source}`),
      ['local_only@local', 'web__search@mcp:web', 'local__read_file@mcp:local'],
    );
    assert.equal(hub.registerInto(registry), 2, '重复注册会替换，不报重名');

    await hub.close();
    assert.deepEqual(closed.sort(), ['local', 'web']);
    assert.deepEqual(hub.tools(), {});
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
    assert.deepEqual(opened.sort(), ['resources', 'web']);
    assert.deepEqual(closed, ['resources']);

    await hub.connect();
    assert.deepEqual(opened.sort(), ['resources', 'resources', 'web'], '失败的下次再试，连上的不再连');
    await hub.close();
    assert.deepEqual(closed.sort(), ['resources', 'resources', 'web']);
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
    assert.deepEqual(Object.keys(hub.tools()), ['good__ok'], '超时以后才连上的也关掉，不收它的工具');
    await hub.close();
  });

  test('改名后重名的工具留第一个，其余记进 skipped；registerInto 不替换别的来源的同名工具', async () => {
    const connector: McpConnector = async (name) => ({
      tools: async (): Promise<ToolSet> =>
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
    assert.equal((hub.tools()['my_srv__read_file'] as { description?: string }).description, 'A1');

    const registry = createToolRegistry().add('my_srv__search', fake('local'));
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
    const one = createToolRegistry().add('local', fake('l'));
    const two = createToolRegistry();
    assert.equal(hub.registerInto(one), 1);
    assert.equal(hub.registerInto(two), 1);
    await hub.close();
    assert.deepEqual(hub.status(), []);
    assert.deepEqual(hub.tools(), {});
    assert.deepEqual(describedTools(one), ['local@local:l']);
    assert.equal(two.size, 0);

    let release = () => {};
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
      const execute = hub.tools()['echo__echo']?.execute as
        ((input: unknown, options: { toolCallId: string; messages: [] }) => Promise<unknown>) | undefined;
      const output = await execute?.({ text: '在吗' }, { toolCallId: 'c1', messages: [] });
      assert.deepEqual(output, { content: [{ type: 'text', text: '回声：在吗' }], isError: false });
    } finally {
      await hub.close();
    }
  });
});
