import assert from 'node:assert/strict';

import { describe, test } from 'vite-plus/test';

import { collectFacts, defineSource, renderFacts } from './sources.ts';

describe('context sources', () => {
  test('按来源顺序收集，空内容跳过，前后空白去掉', async () => {
    const facts = await collectFacts(
      [
        defineSource('task', () => '  当前任务：修天气地点  '),
        defineSource('empty', () => '   '),
        defineSource('clip', async () => '粘贴板：hello'),
        defineSource('none', () => null),
      ],
      { thread: 't' },
    );
    assert.deepEqual(facts, [
      { source: 'task', text: '当前任务：修天气地点' },
      { source: 'clip', text: '粘贴板：hello' },
    ]);
    assert.equal(renderFacts(facts, '上下文：'), '上下文：\n当前任务：修天气地点\n粘贴板：hello');
  });

  test('一个来源出错或超时，不影响别的', async () => {
    const failed: string[] = [];
    const facts = await collectFacts(
      [
        defineSource('boom', () => {
          throw new Error('nope');
        }),
        defineSource('slow', () => new Promise((resolve) => setTimeout(() => resolve('太慢了'), 200))),
        defineSource('ok', () => '还在'),
      ],
      { thread: 't', timeoutMs: 20, onError: (name) => failed.push(name) },
    );
    assert.deepEqual(
      facts.map((fact) => fact.text),
      ['还在'],
    );
    assert.deepEqual(failed.toSorted(), ['boom', 'slow']);
  });
});
