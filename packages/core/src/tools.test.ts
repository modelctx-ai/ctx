import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { tool } from 'ai';
import { z } from 'zod';

import { createToolRegistry } from './tools.ts';

const echo = tool({
  description: 'echo',
  inputSchema: z.object({ text: z.string() }),
  execute: async ({ text }) => text,
});

describe('tool registry', () => {
  test('按名字、来源或函数挑工具', () => {
    const registry = createToolRegistry()
      .add('echo', echo)
      .addAll({ search: echo, fetch: echo }, { source: 'mcp:web', tags: ['net'] });
    assert.equal(registry.size, 3);
    assert.deepEqual(Object.keys(registry.select()), ['echo', 'search', 'fetch']);
    assert.deepEqual(Object.keys(registry.select(false)), []);
    assert.deepEqual(Object.keys(registry.select(['fetch', 'missing'])), ['fetch']);
    assert.deepEqual(Object.keys(registry.select((info) => info.tags.includes('net'))), ['search', 'fetch']);
    assert.equal(registry.list().find((info) => info.name === 'echo')?.source, 'local');
  });

  test('非法名字和重名会报错，replace 可以覆盖', () => {
    const registry = createToolRegistry().add('echo', echo);
    assert.throws(() => registry.add('echo', echo), /already registered/);
    assert.throws(() => registry.add('有空格 的名字', echo), /Invalid tool name/);
    registry.add('echo', echo, { replace: true, source: 'x' });
    assert.equal(registry.list()[0]?.source, 'x');
  });

  test('按来源整批移除', () => {
    const registry = createToolRegistry()
      .add('a', echo, { source: 'mcp:one' })
      .add('b', echo, { source: 'mcp:one' })
      .add('c', echo);
    assert.equal(registry.removeSource('mcp:one'), 2);
    assert.deepEqual(
      registry.list().map((info) => info.name),
      ['c'],
    );
    assert.equal(registry.remove('c'), true);
    assert.equal(registry.has('c'), false);
  });
});
