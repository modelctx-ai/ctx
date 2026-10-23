import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import { createToolRegistry, tool } from '@modelctx-ai/ctx';
import { z } from 'zod';

import { createMcpHub, namespaced, type McpConnector } from './index.ts';

const fake = (text: string) => tool({ description: text, inputSchema: z.object({}), execute: async () => text });

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
