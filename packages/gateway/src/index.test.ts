import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';

import {
  assistantEntry,
  createContext,
  createMemoryStore,
  eventEntry,
  userEntry,
  type ModelMessage,
} from '@modelctx-ai/ctx';

import { replaceHistory, startGateway, toChatMessages, withContext, type Gateway } from './index.ts';

interface Seen {
  method: string;
  path: string;
  auth: string | undefined;
  body: string;
}

async function body(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

describe('gateway', () => {
  const seen: Seen[] = [];
  let upstreamUrl = '';
  const upstream = createServer(async (req, res) => {
    seen.push({
      method: req.method ?? '',
      path: req.url ?? '',
      auth: req.headers.authorization,
      body: await body(req),
    });
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'demo' }] }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"在"}}]}\n\n');
    setTimeout(() => {
      res.write('data: {"choices":[{"delta":{"content":"的"}}]}\n\n');
      res.end('data: [DONE]\n\n');
    }, 10);
  });

  let gateway: Gateway;
  const history: ModelMessage[] = [
    { role: 'assistant', content: '碎碎念：\n先把这一小步做完' },
    { role: 'user', content: '昨天说过要带伞' },
    { role: 'assistant', content: '带了' },
  ];

  before(async () => {
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/v1`;
    gateway = await startGateway({
      upstream: { baseUrl: upstreamUrl, apiKey: 'real-key' },
      accessToken: 'local-token',
      rewrite: replaceHistory(() => history),
    });
  });

  after(async () => {
    await gateway.close();
    upstream.close();
  });

  test('把截断历史换成全文，流式回复原样转回，上游拿到的是真密钥', async () => {
    const response = await fetch(`${gateway.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer local-token' },
      body: JSON.stringify({
        model: 'demo',
        stream: true,
        messages: [
          { role: 'system', content: '你是女仆' },
          { role: 'user', content: '只剩最近一轮' },
          { role: 'assistant', content: '旧回复' },
          { role: 'user', content: '今天呢' },
        ],
      }),
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'text/event-stream');
    const text = await response.text();
    assert.match(text, /"在"[\s\S]*"的"[\s\S]*\[DONE\]/);

    const sent = JSON.parse(seen.at(-1)!.body);
    assert.equal(seen.at(-1)?.auth, 'Bearer real-key');
    assert.equal(sent.model, 'demo');
    assert.equal(sent.stream, true);
    assert.deepEqual(
      sent.messages.map((message: { role: string; content: string }) => `${message.role}:${message.content}`),
      [
        'system:你是女仆',
        'assistant:碎碎念：\n先把这一小步做完',
        'user:昨天说过要带伞',
        'assistant:带了',
        'user:今天呢',
      ],
    );
  });

  test('没带或带错本机令牌就拒绝', async () => {
    const missing = await fetch(`${gateway.baseUrl}/chat/completions`, { method: 'POST', body: '{}' });
    assert.equal(missing.status, 401);
    const wrong = await fetch(`${gateway.baseUrl}/models`, { headers: { authorization: 'Bearer nope' } });
    assert.equal(wrong.status, 401);
  });

  test('别的路径原样转发，前缀外的路径 404', async () => {
    const models = await fetch(`${gateway.baseUrl}/models`, { headers: { authorization: 'Bearer local-token' } });
    assert.deepEqual(await models.json(), { data: [{ id: 'demo' }] });
    assert.equal(seen.at(-1)?.path, '/v1/models');
    assert.equal((await fetch(`${gateway.origin}/other`)).status, 404);
  });

  test('坏 JSON 回 400，上游连不上回 502', async () => {
    const bad = await fetch(`${gateway.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer local-token' },
      body: '{not json',
    });
    assert.equal(bad.status, 400);
    const dead = await startGateway({ upstream: { baseUrl: 'http://127.0.0.1:9/v1' } });
    try {
      const response = await fetch(`${dead.baseUrl}/models`);
      assert.equal(response.status, 502);
    } finally {
      await dead.close();
    }
  });

  test('请求体超过上限回 413', async () => {
    const small = await startGateway({ upstream: { baseUrl: upstreamUrl }, maxBodyBytes: 16 });
    try {
      const response = await fetch(`${small.baseUrl}/chat/completions`, { method: 'POST', body: 'x'.repeat(64) });
      assert.equal(response.status, 413);
    } finally {
      await small.close();
    }
  });
});

describe('rewrite', () => {
  test('全文最后一条已经是这句用户话时，不重复带', async () => {
    const rewrite = replaceHistory(() => [{ role: 'user', content: '今天呢' }]);
    const out = await rewrite({ messages: [{ role: 'user', content: '今天呢' }] });
    assert.deepEqual(out.messages, [{ role: 'user', content: '今天呢' }]);
  });

  test('withContext 用上下文的视图作为历史', async () => {
    const context = createContext({
      store: createMemoryStore(),
      thread: 't',
      projection: {
        events: {
          whisper: {
            fold: true,
            render: (events) => ({ role: 'assistant', content: events.map((e) => e.text).join('\n') }),
          },
        },
      },
    });
    await context.append(eventEntry('whisper', { text: '在呢' }), userEntry('看一下测试'), assistantEntry('好'));
    const out = await withContext(context, { keepSystem: false })({
      messages: [
        { role: 'system', content: '丢掉' },
        { role: 'user', content: '继续' },
      ],
    });
    assert.deepEqual(
      out.messages.map((message) => `${message.role}:${message.content}`),
      ['assistant:在呢', 'user:看一下测试', 'assistant:好', 'user:继续'],
    );
  });

  test('工具调用、工具结果和图片转成 OpenAI 的写法', () => {
    const converted = toChatMessages([
      {
        role: 'user',
        content: [
          { type: 'text', text: '看图' },
          { type: 'image', image: 'aGVsbG8=', mediaType: 'image/png' },
        ],
      },
      {
        role: 'assistant',
        content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'weather', input: { city: '台北' } }],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'c1',
            toolName: 'weather',
            output: { type: 'json', value: { sky: '晴' } },
          },
        ],
      },
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: '想一想' },
          { type: 'text', text: '晴天' },
        ],
      },
    ]);
    assert.deepEqual(converted, [
      {
        role: 'user',
        content: [
          { type: 'text', text: '看图' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' } },
        ],
      },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'weather', arguments: '{"city":"台北"}' } }],
      },
      { role: 'tool', tool_call_id: 'c1', content: '{"sky":"晴"}' },
      { role: 'assistant', content: '晴天' },
    ]);
  });
});
