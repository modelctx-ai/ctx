import assert from 'node:assert/strict';
import { createServer, request, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

import {
  assistantEntry,
  createContext,
  createContextBuilder,
  createMemoryStore,
  eventEntry,
  userEntry,
  type Message,
} from '@modelctx-ai/ctx';
import { afterAll, beforeAll, describe, test } from 'vite-plus/test';

import {
  createGatewayHandler,
  replaceHistory,
  startGateway,
  toChatMessages,
  withContext,
  type ChatMessage,
  type Gateway,
} from './index.ts';

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

/** fetch 不让改 Host，自己用 http.request 发。 */
function send(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: init.method ?? 'GET', headers: init.headers ?? {} }, (res) => {
      void body(res).then((text) => resolve({ status: res.statusCode ?? 0, body: text }), reject);
    });
    req.on('error', reject);
    req.end(init.body);
  });
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

async function waitFor(check: () => boolean, ms = 3000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error('condition not met in time');
    await delay(10);
  }
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
  const history: Message[] = [
    { role: 'assistant', content: '碎碎念：\n先把这一小步做完' },
    { role: 'user', content: '昨天说过要带伞' },
    { role: 'assistant', content: '带了' },
  ];

  beforeAll(async () => {
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/v1`;
    gateway = await startGateway({
      upstream: { baseUrl: upstreamUrl, apiKey: 'real-key' },
      accessToken: 'local-token',
      rewrite: replaceHistory(() => history),
    });
  });

  afterAll(async () => {
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
    const lower = await fetch(`${gateway.baseUrl}/models`, { headers: { authorization: 'bearer local-token' } });
    assert.equal(lower.status, 200, 'Bearer 不分大小写');
  });

  test('Host 不认识、带了没放行的 Origin 都回 403；本机的几种写法都认', async () => {
    const port = new URL(gateway.origin).port;
    const auth = { authorization: 'Bearer local-token' };
    const models = `${gateway.baseUrl}/models`;
    const before = seen.length;
    assert.equal((await send(models, { headers: { ...auth, host: `rebind.example:${port}` } })).status, 403);
    const fromPage = await send(`${gateway.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { ...auth, origin: 'https://evil.example', 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'x' }] }),
    });
    assert.equal(fromPage.status, 403);
    assert.match(fromPage.body, /origin not allowed/);
    assert.equal(seen.length, before, '挡下的请求不转发');
    for (const host of [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`, `LOCALHOST:${port}`]) {
      assert.equal((await send(models, { headers: { ...auth, host } })).status, 200, host);
    }

    const custom = await startGateway({
      upstream: { baseUrl: upstreamUrl },
      allowedHosts: ['proxy.lan:8080'],
      allowedOrigins: ['http://localhost:5173/'],
    });
    try {
      const page = { host: 'proxy.lan:8080', origin: 'http://localhost:5173' };
      assert.equal((await send(`${custom.baseUrl}/models`, { headers: page })).status, 200);
      assert.equal((await send(`${custom.baseUrl}/models`)).status, 403, '给了 allowedHosts 就只认这些');
    } finally {
      await custom.close();
    }

    const handler = createGatewayHandler({ upstream: { baseUrl: upstreamUrl } });
    const mounted = createServer((req, res) => void handler(req, res));
    const mountedPort = await listen(mounted);
    try {
      const url = `http://127.0.0.1:${mountedPort}/v1/models`;
      assert.equal(
        (await send(url, { headers: { host: 'app.example' } })).status,
        200,
        '处理函数不给 allowedHosts 就不查',
      );
      assert.equal((await send(url, { headers: { origin: 'https://evil.example' } })).status, 403);
    } finally {
      mounted.close();
    }
  });

  test('basePath 是空或 / 时挂在根上', async () => {
    for (const basePath of ['', '/']) {
      const root = await startGateway({ upstream: { baseUrl: upstreamUrl }, basePath });
      try {
        assert.equal(root.baseUrl, root.origin);
        const response = await fetch(`${root.baseUrl}/models`);
        assert.deepEqual(await response.json(), { data: [{ id: 'demo' }] });
        assert.equal(seen.at(-1)?.path, '/v1/models');
      } finally {
        await root.close();
      }
    }
  });

  test('请求体不是带 messages 数组的 JSON 对象时回 400', async () => {
    const before = seen.length;
    for (const raw of ['null', '[]', '"text"', '42', '{}', '{"messages":"x"}']) {
      const response = await fetch(`${gateway.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { authorization: 'Bearer local-token', 'content-type': 'application/json' },
        body: raw,
      });
      assert.equal(response.status, 400, raw);
      assert.deepEqual(await response.json(), {
        error: { message: 'request body must be a JSON object with messages', type: 'gateway_error' },
      });
    }
    assert.equal(seen.length, before);
  });

  test('调用方中途断开不算出错，上游请求也跟着断', async () => {
    let upstreamClosed = false;
    const endless = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const timer = setInterval(() => res.write('data: {"x":1}\n\n'), 10);
      res.on('close', () => {
        clearInterval(timer);
        upstreamClosed = true;
      });
    });
    const port = await listen(endless);
    const errors: unknown[] = [];
    const proxy = await startGateway({
      upstream: { baseUrl: `http://127.0.0.1:${port}/v1` },
      onError: (error) => errors.push(error),
    });
    try {
      await new Promise<void>((resolve) => {
        const req = request(`${proxy.baseUrl}/chat/completions`, { method: 'POST' }, (res) => {
          res.once('data', () => {
            req.destroy();
            resolve();
          });
        });
        req.on('error', () => {});
        req.end('{"messages":[]}');
      });
      await waitFor(() => upstreamClosed);
      await delay(50);
      assert.deepEqual(errors, []);
    } finally {
      await proxy.close();
      endless.closeAllConnections();
      endless.close();
    }
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

function picture(url: string): ChatMessage {
  return { role: 'user', content: [{ type: 'image_url', image_url: { url } }] };
}

/** 断言用：字符串原样，其它（null、分段）按 JSON 写出来。 */
function contentText(message: ChatMessage): string {
  return typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
}

describe('rewrite', () => {
  test('全文最后一条已经是这句用户话时，不重复带', async () => {
    const rewrite = replaceHistory(() => [{ role: 'user', content: '今天呢' }]);
    const out = await rewrite({ messages: [{ role: 'user', content: '今天呢' }] });
    assert.deepEqual(out.messages, [{ role: 'user', content: '今天呢' }]);
  });

  test('调用方最后一句用户话之后的工具调用、工具结果和预填原样接在后面', async () => {
    const rewrite = replaceHistory(() => [
      { role: 'user', content: '早先的话' },
      { role: 'assistant', content: '好' },
    ]);
    const out = await rewrite({
      messages: [
        { role: 'system', content: '你是助手' },
        { role: 'user', content: '截断的旧话' },
        { role: 'user', content: '台北天气？' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'c1', type: 'function', function: { name: 'weather', arguments: '{"city":"台北"}' } }],
        },
        { role: 'tool', tool_call_id: 'c1', content: '晴' },
        { role: 'assistant', content: '台北' },
      ],
    });
    assert.deepEqual(
      out.messages.map(
        (message) => `${message.role}${message.tool_calls ? '(tool_calls)' : ''}:${contentText(message)}`,
      ),
      [
        'system:你是助手',
        'user:早先的话',
        'assistant:好',
        'user:台北天气？',
        'assistant(tool_calls):null',
        'tool:晴',
        'assistant:台北',
      ],
    );
  });

  test('只有内容完全相同才去重：图片不一样的用户话不丢', async () => {
    const rewrite = replaceHistory(() => [
      {
        role: 'user',
        content: [{ type: 'file', mediaType: 'image', data: { type: 'url', url: 'https://example.com/a.png' } }],
      },
    ]);
    const other = await rewrite({ messages: [picture('https://example.com/b.png')] });
    assert.deepEqual(other.messages, [picture('https://example.com/a.png'), picture('https://example.com/b.png')]);
    const same = await rewrite({
      messages: [picture('https://example.com/a.png'), { role: 'assistant', content: '预填' }],
    });
    assert.deepEqual(same.messages, [picture('https://example.com/a.png'), { role: 'assistant', content: '预填' }]);
  });

  test('withContext 用上下文的视图作为历史；也可以给 builder 和会话名', async () => {
    const store = createMemoryStore();
    const context = createContext({
      store,
      session: 't',
      projection: {
        events: {
          'pet.whisper': {
            fold: true,
            render: (events) => ({ role: 'assistant', content: events.map((e) => e.text).join('\n') }),
          },
        },
      },
    });
    await context.append(eventEntry('pet.whisper', { text: '在呢' }), userEntry('看一下测试'), assistantEntry('好'));
    const out = await withContext(context, { keepSystem: false })({
      messages: [
        { role: 'system', content: '丢掉' },
        { role: 'user', content: '继续' },
      ],
    });
    assert.deepEqual(
      out.messages.map((message) => `${message.role}:${contentText(message)}`),
      ['assistant:在呢', 'user:看一下测试', 'assistant:好', 'user:继续'],
    );
    const viaBuilder = await withContext(
      createContextBuilder({ store }),
      't',
    )({ messages: [{ role: 'user', content: '继续' }] });
    assert.deepEqual(
      viaBuilder.messages.map((message) => `${message.role}:${contentText(message)}`),
      ['user:看一下测试', 'assistant:好', 'user:继续'],
      '这个 builder 没有事件规则，碎碎念不进视图',
    );
  });

  test('工具调用、工具结果和图片转成 OpenAI 的写法', () => {
    const converted = toChatMessages([
      {
        role: 'user',
        content: [
          { type: 'text', text: '看图' },
          { type: 'file', mediaType: 'image/png', data: { type: 'data', data: 'aGVsbG8=' } },
        ],
      },
      {
        role: 'assistant',
        content: [{ type: 'tool-call', id: 'c1', name: 'weather', input: { city: '台北' } }],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            id: 'c1',
            name: 'weather',
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

  test('文件的几种数据：mediaType 只写 image 也认，base64 变 data URL，地址原样，服务商的文件引用和内联文字跳过', () => {
    const converted = toChatMessages([
      {
        role: 'user',
        content: [
          { type: 'text', text: '看' },
          { type: 'file', mediaType: 'image', data: { type: 'data', data: 'aGVsbG8=' } },
          { type: 'file', mediaType: 'image/jpeg', data: { type: 'data', data: 'aGk=' } },
          { type: 'file', mediaType: 'image/png', data: { type: 'url', url: 'https://example.com/a.png' } },
          { type: 'file', mediaType: 'image/*', data: { type: 'data', data: 'aGk=' } },
          { type: 'file', mediaType: 'image', data: { type: 'reference', reference: { openai: 'file-1' } } },
          { type: 'file', mediaType: 'image', data: { type: 'text', text: '文字' } },
          { type: 'file', mediaType: 'application/pdf', data: { type: 'data', data: 'JVBERi0=' } },
        ],
      },
    ]);
    assert.deepEqual(converted, [
      {
        role: 'user',
        content: [
          { type: 'text', text: '看' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' } },
          { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,aGk=' } },
          { type: 'image_url', image_url: { url: 'https://example.com/a.png' } },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,aGk=' } },
        ],
      },
    ]);
  });
});
