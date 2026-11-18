import assert from 'node:assert/strict';

import { selectTools, type ToolFilter, type ToolRegistry } from '../tools.ts';

import type { ContractTestApi } from './api.ts';
import { definition, roundTrips } from './shared.ts';

/** 每个用例调一次，拿到一个空的目录。 */
export type ToolRegistryFactory = () => ToolRegistry | Promise<ToolRegistry>;

export function describeToolRegistryContract(
  name: string,
  factory: ToolRegistryFactory,
  { describe, test }: ContractTestApi,
): void {
  describe(`ToolRegistry contract: ${name}`, () => {
    test('add、has、get、size、list：按加入顺序，定义原样读回', async () => {
      const registry = await factory();
      assert.equal(registry.size, 0);
      const weather = definition('weather_get', { source: 'local', tags: ['read'] });
      const files = definition('fs__read_file', { source: 'mcp:fs', executor: 'mcp:fs' });
      assert.equal(registry.add(weather).add(files), registry, 'add 返回自己，可以连写');
      assert.equal(registry.size, 2);
      assert.ok(registry.has('weather_get'));
      assert.ok(!registry.has('missing'));
      assert.deepEqual(registry.get('fs__read_file'), files);
      assert.equal(registry.get('missing'), undefined);
      assert.deepEqual(registry.list(), [weather, files]);
      assert.ok(roundTrips(registry.list()), 'list() 能 JSON 往返');
    });

    test('名字不合法时抛错，不写入', async () => {
      const registry = await factory();
      for (const bad of ['', 'has space', '中文', 'a'.repeat(65), 'dot.name']) {
        assert.throws(() => registry.add(definition(bad)), Error, `名字 ${JSON.stringify(bad)}`);
      }
      assert.equal(registry.size, 0);
      registry.add(definition('a'.repeat(64)));
      assert.equal(registry.size, 1);
    });

    test('同名抛错，replace 时替换', async () => {
      const registry = await factory();
      registry.add(definition('weather_get'));
      assert.throws(() => registry.add(definition('weather_get', { description: '第二个' })));
      registry.add(definition('weather_get', { description: '新的' }), { replace: true });
      assert.equal(registry.size, 1);
      assert.equal(registry.get('weather_get')?.description, '新的');
    });

    test('remove 和 removeSource', async () => {
      const registry = await factory();
      registry
        .add(definition('a', { source: 'mcp:x' }))
        .add(definition('b', { source: 'mcp:x' }))
        .add(definition('c', { source: 'local' }));
      assert.equal(registry.remove('c'), true);
      assert.equal(registry.remove('c'), false);
      assert.equal(registry.removeSource('mcp:x'), 2);
      assert.equal(registry.removeSource('mcp:x'), 0);
      assert.equal(registry.size, 0);
    });

    test('select 的语义同 selectTools', async () => {
      const registry = await factory();
      registry
        .add(definition('weather_get', { source: 'local', tags: ['read', 'weather'] }))
        .add(definition('fs__read_file', { source: 'mcp:fs', tags: ['read'] }))
        .add(definition('fs__write_file', { source: 'mcp:fs', tags: ['write'] }))
        .add(definition('plain'));
      const names = (filter?: ToolFilter) =>
        (filter === undefined ? registry.select() : registry.select(filter)).map((tool) => tool.name);
      const filters: ToolFilter[] = [
        true,
        false,
        ['plain', 'fs__read_file', 'missing'],
        { tags: ['read'] },
        { sources: ['mcp:fs'] },
        { sources: ['mcp:fs'], tags: ['read'] },
        { names: ['plain', 'weather_get'], tags: ['weather'] },
        {},
        (tool) => tool.name.startsWith('fs__'),
      ];
      assert.deepEqual(names(), ['weather_get', 'fs__read_file', 'fs__write_file', 'plain'], '缺省全部');
      for (const filter of filters) {
        assert.deepEqual(
          names(filter),
          selectTools(registry.list(), filter).map((tool) => tool.name),
          `filter: ${typeof filter === 'function' ? 'function' : JSON.stringify(filter)}`,
        );
      }
      assert.deepEqual(names({ sources: ['mcp:fs'], tags: ['read'] }), ['fs__read_file']);
      assert.deepEqual(names(false), []);
    });
  });
}
