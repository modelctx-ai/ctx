import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { generateText } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';

import { createModel, createModelRegistry } from './index.ts';

describe('models', () => {
  test('缺省按 openai-compatible 建模型，请求打到 baseUrl/chat/completions', async () => {
    const seen: { url: string; auth: string | null; body: Record<string, unknown> }[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      seen.push({ url: String(input), auth: headers.get('authorization'), body: JSON.parse(String(init?.body)) });
      return new Response(
        JSON.stringify({
          id: 'x',
          created: 0,
          model: 'demo',
          choices: [{ index: 0, message: { role: 'assistant', content: '在的' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;
    try {
      const model = createModel({ baseUrl: 'https://example.test/v1/', apiKey: 'secret', model: 'demo' });
      const { text } = await generateText({ model, prompt: '在吗', maxRetries: 0 });
      assert.equal(text, '在的');
      assert.equal(seen[0]?.url, 'https://example.test/v1/chat/completions');
      assert.equal(seen[0]?.auth, 'Bearer secret');
      assert.equal(seen[0]?.body['model'], 'demo');
    } finally {
      globalThis.fetch = original;
    }
  });

  test('可以注册别的服务商，未知服务商报清楚的错', () => {
    const mock = new MockLanguageModelV4();
    const registry = createModelRegistry().register('mock', () => mock);
    assert.equal(registry.create({ provider: 'mock', model: 'x' }), mock);
    assert.deepEqual(registry.providers(), ['openai-compatible', 'anthropic', 'mock']);
    assert.throws(() => registry.create({ provider: 'nope', model: 'x' }), /Unknown model provider "nope"/);
    assert.throws(() => registry.create({ model: ' ' }), /needs `model`/);
    assert.throws(() => registry.create({ model: 'x' }), /need `baseUrl`/);
  });
});
