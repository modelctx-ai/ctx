import assert from 'node:assert/strict';

import { generateText } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { describe, test } from 'vite-plus/test';

import { createModel, createModelRegistry } from './index.ts';

function urlOf(input: string | URL | Request): string {
  return input instanceof Request ? input.url : input.toString();
}

describe('models', () => {
  test('缺省按 openai-compatible 建模型，请求打到 baseUrl/chat/completions', async () => {
    const seen: { url: string; auth: string | null; body: Record<string, unknown> }[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      seen.push({
        url: urlOf(input),
        auth: headers.get('authorization'),
        body: JSON.parse(await new Response(init?.body).text()),
      });
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
    };
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

  test('anthropic 的 baseUrl 是服务根，补上 /v1；不写就用官方地址，不读 ANTHROPIC_BASE_URL', async () => {
    const seen: { url: string; key: string | null }[] = [];
    const original = globalThis.fetch;
    const env = process.env['ANTHROPIC_BASE_URL'];
    process.env['ANTHROPIC_BASE_URL'] = 'https://elsewhere.example/v1';
    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: urlOf(input), key: new Headers(init?.headers).get('x-api-key') });
      return new Response(
        JSON.stringify({
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          model: 'claude-test',
          content: [{ type: 'text', text: '在的' }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };
    try {
      const ask = async (baseUrl?: string) => {
        const spec = { provider: 'anthropic', apiKey: 'sk-ant', model: 'claude-test' };
        const model = createModel(baseUrl === undefined ? spec : { ...spec, baseUrl });
        const { text } = await generateText({ model, prompt: '在吗', maxRetries: 0, maxOutputTokens: 64 });
        assert.equal(text, '在的');
        return seen.at(-1)?.url;
      };
      assert.equal(await ask('https://api.deepseek.com/anthropic'), 'https://api.deepseek.com/anthropic/v1/messages');
      assert.equal(await ask('https://api.anthropic.com/v1/'), 'https://api.anthropic.com/v1/messages');
      assert.equal(await ask('https://api.anthropic.com'), 'https://api.anthropic.com/v1/messages');
      assert.equal(await ask(), 'https://api.anthropic.com/v1/messages');
      assert.equal(seen.at(-1)?.key, 'sk-ant');
    } finally {
      globalThis.fetch = original;
      if (env === undefined) delete process.env['ANTHROPIC_BASE_URL'];
      else process.env['ANTHROPIC_BASE_URL'] = env;
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
