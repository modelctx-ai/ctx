import assert from 'node:assert/strict';

import { tool } from 'ai';
import { z } from 'zod';
import { describe, test } from 'vite-plus/test';

import { createFunctionExecutor } from './executor.ts';
import { createToolRegistry, toToolSet } from './tools.ts';

const echo = tool({
  description: 'echo',
  inputSchema: z.object({ text: z.string() }),
  execute: async ({ text }) => text,
});

const context = { session: 's', runId: 'r' };

describe('tool registry', () => {
  test('addTool 把 zod 工具转成 JSON Schema 定义，执行函数进注册表自带的执行环境', async () => {
    const registry = createToolRegistry().addTool('echo', echo, { tags: ['debug'] });
    assert.deepEqual(registry.get('echo'), {
      name: 'echo',
      description: 'echo',
      inputSchema: {
        $schema: 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
        additionalProperties: false,
      },
      executor: 'local',
      source: 'local',
      tags: ['debug'],
    });
    assert.deepEqual(await registry.executor.tools(), [registry.get('echo')]);
    assert.deepEqual(await registry.executor.execute({ id: 'c1', name: 'echo', input: { text: '在吗' } }, context), {
      type: 'text',
      text: '在吗',
    });
    const invalid = await registry.executor.execute({ id: 'c2', name: 'echo', input: { text: 1 } }, context);
    assert.equal(invalid.type, 'error');
    assert.match(invalid.type === 'error' ? invalid.message : '', /Invalid input for tool "echo"/);
  });

  test('按名字、来源、标签或函数挑工具；toolSet 包回 AI SDK 工具', () => {
    const registry = createToolRegistry()
      .addTool('echo', echo)
      .addAll({ search: echo, fetch: echo }, { source: 'mcp:web', tags: ['net'] });
    assert.equal(registry.size, 3);
    const names = (filter?: Parameters<typeof registry.select>[0]) => registry.select(filter).map((item) => item.name);
    assert.deepEqual(names(), ['echo', 'search', 'fetch']);
    assert.deepEqual(names(false), []);
    assert.deepEqual(names(['fetch', 'missing']), ['fetch']);
    assert.deepEqual(names({ tags: ['net'] }), ['search', 'fetch']);
    assert.deepEqual(
      names((info) => info.source === 'local'),
      ['echo'],
    );
    assert.deepEqual(Object.keys(registry.toolSet({ sources: ['mcp:web'] })), ['search', 'fetch']);
    assert.deepEqual(Object.keys(registry.toolSet()), ['echo', 'search', 'fetch']);
  });

  test('非法名字和重名会报错，replace 可以覆盖；不收没有 execute 的工具', () => {
    const registry = createToolRegistry().addTool('echo', echo);
    assert.throws(() => registry.addTool('echo', echo), /already registered/);
    assert.throws(() => registry.addTool('有空格 的名字', echo), /Invalid tool name/);
    registry.addTool('echo', echo, { replace: true, source: 'x' });
    assert.equal(registry.list()[0]?.source, 'x');
    assert.throws(() => registry.addTool('bare', tool({ inputSchema: z.object({}) })), /no execute function/);
  });

  test('按来源整批移除，函数执行环境里的也一起拿掉', () => {
    const registry = createToolRegistry()
      .addTool('a', echo, { source: 'mcp:one' })
      .addTool('b', echo, { source: 'mcp:one' })
      .addTool('c', echo);
    assert.equal(registry.removeSource('mcp:one'), 2);
    assert.deepEqual(
      registry.list().map((info) => info.name),
      ['c'],
    );
    assert.equal(registry.executor.has('a'), false);
    assert.equal(registry.remove('c'), true);
    assert.equal(registry.has('c'), false);
    assert.equal(registry.executor.has('c'), false);
  });

  test('toToolSet：execute 转给绑定的执行环境，结果按 ToolOutput 交回模型', async () => {
    const remote = createFunctionExecutor('remote').register(
      { name: 'shout', inputSchema: { type: 'object' } },
      (input) => ({
        type: 'error',
        message: `不会喊：${JSON.stringify(input)}`,
      }),
    );
    const set = toToolSet([remote.definition('shout')!], [remote], { session: 's' });
    const shout = set['shout']!;
    const output = await shout.execute!({ x: 1 }, { toolCallId: 'c1', messages: [], context: {} });
    assert.deepEqual(output, { type: 'error', message: '不会喊：{"x":1}' });
    assert.deepEqual(await shout.toModelOutput!({ toolCallId: 'c1', input: {}, output }), {
      type: 'error-text',
      value: '不会喊：{"x":1}',
    });
  });
});
