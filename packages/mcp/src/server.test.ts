import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

import { createFunctionExecutor } from '@modelctx-ai/ctx';
import type { JsonObject, ToolCall, ToolOutput } from '@modelctx-ai/ctx-protocol';
import { describe, test } from 'vite-plus/test';

import { createMcpHub } from './index.ts';
import {
  createMcpHttpHandler,
  createMcpServer,
  serveMcpStdio,
  toolOutputToMcp,
  type McpCallContext,
} from './server.ts';

const PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

/** 一个函数执行环境：回显、回会话、回图片、出错、等到中止。 */
function box() {
  return createFunctionExecutor('box')
    .register(
      {
        name: 'echo',
        description: '原样返回',
        inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      },
      (input) => ({ type: 'text', text: (input as { text: string }).text }),
    )
    .register({ name: 'where', inputSchema: { type: 'object' } }, (_input, context) => ({
      type: 'json',
      value: { session: context.session, runId: context.runId ?? null },
    }))
    .register({ name: 'picture', inputSchema: { type: 'object' } }, () => ({
      type: 'content',
      parts: [
        { type: 'text', text: '一个像素' },
        { type: 'file', mediaType: 'image/png', data: { type: 'data', data: PIXEL } },
      ],
    }))
    .register({ name: 'broken', inputSchema: { type: 'object' } }, () => ({
      type: 'error',
      message: '磁盘满了',
      retryable: true,
    }))
    .register(
      { name: 'wait', inputSchema: { type: 'object' } },
      (_input, context) =>
        new Promise<ToolOutput>((resolve) => {
          context.signal?.addEventListener('abort', () => resolve({ type: 'text', text: 'aborted' }), { once: true });
        }),
    );
}

function errorOf(response: JsonObject | undefined): { code: number; message: string } {
  assert.ok(response && 'error' in response, `expected an error, got ${JSON.stringify(response)}`);
  return response['error'] as { code: number; message: string };
}

function resultOf(response: JsonObject | undefined): unknown {
  assert.ok(response && 'result' in response, `expected a result, got ${JSON.stringify(response)}`);
  return response['result'];
}

async function listen(handler: ReturnType<typeof createMcpHttpHandler>) {
  const server = createServer((req, res) => void handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe('createMcpServer：把执行环境包成 MCP 服务器', () => {
  test('经 Streamable HTTP 给 MCP 客户端（ctx-mcp 自己的 hub）用：列工具、调工具、会话来自 context、结果都转回来', async () => {
    const results: { call: ToolCall; output: ToolOutput; context: McpCallContext }[] = [];
    const server = createMcpServer({
      executors: [box()],
      context: { session: 'user:42', runId: 'run-7' },
      onResult: (call, output, context) => void results.push({ call, output, context }),
    });
    const http = await listen(createMcpHttpHandler(server));
    const hub = createMcpHub({ ctx: { url: http.url } });
    try {
      const [status] = await hub.connect();
      assert.deepEqual(status?.state === 'connected' ? status.tools : [], [
        'ctx__echo',
        'ctx__where',
        'ctx__picture',
        'ctx__broken',
        'ctx__wait',
      ]);
      const context = { session: 'ignored' };
      assert.deepEqual(await hub.execute({ id: 'a', name: 'ctx__echo', input: { text: '在吗' } }, context), {
        type: 'text',
        text: '在吗',
      });
      assert.deepEqual(await hub.execute({ id: 'b', name: 'ctx__where', input: {} }, context), {
        type: 'text',
        text: '{"session":"user:42","runId":"run-7"}',
      });
      const picture = await hub.execute({ id: 'c', name: 'ctx__picture', input: {} }, context);
      assert.deepEqual(picture, {
        type: 'content',
        parts: [
          { type: 'text', text: '一个像素' },
          { type: 'file', mediaType: 'image/png', data: { type: 'data', data: PIXEL } },
        ],
      });
      const broken = await hub.execute({ id: 'd', name: 'ctx__broken', input: {} }, context);
      assert.equal(broken.type, 'error');
      assert.match(broken.type === 'error' ? broken.message : '', /磁盘满了\nretryable: true/);
      const invalid = await hub.execute({ id: 'e', name: 'ctx__echo', input: {} }, context);
      assert.match(invalid.type === 'error' ? invalid.message : '', /Invalid input for tool echo/);
      assert.deepEqual(
        results.map(({ call, context: seen }) => [call.name, seen.session]),
        [
          ['echo', 'user:42'],
          ['where', 'user:42'],
          ['picture', 'user:42'],
          ['broken', 'user:42'],
          ['echo', 'user:42'],
        ],
      );
    } finally {
      await hub.close();
      await http.close();
    }
  });

  test('经 stdio：真的起一个进程', async () => {
    const hub = createMcpHub({
      ctx: {
        command: process.execPath,
        args: ['--conditions=@modelctx-ai/source', fileURLToPath(new URL('./fixtures/ctx-server.ts', import.meta.url))],
        env: { CTX_SESSION: 'stdio-session' },
      },
    });
    try {
      const [status] = await hub.connect();
      assert.deepEqual(status, { name: 'ctx', state: 'connected', tools: ['ctx__where'] });
      assert.deepEqual(await hub.execute({ id: 'a', name: 'ctx__where', input: {} }, { session: 'x' }), {
        type: 'text',
        text: 'stdio-session/r1',
      });
    } finally {
      await hub.close();
    }
  });

  test('maxOutputChars：超长的结果截断并注明，onResult 收到的是截过的；0 不限', async () => {
    const long = `marker${'x'.repeat(5_000)}`;
    const seen: ToolOutput[] = [];
    const call = (server: ReturnType<typeof createMcpServer>) =>
      server.handle({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'echo', arguments: { text: long } },
      });
    const limited = createMcpServer({
      executors: [box()],
      context: { session: 's' },
      maxOutputChars: 1_000,
      onResult: (_call, output) => void seen.push(output),
    });
    const { content } = resultOf(await call(limited)) as { content: { text: string }[] };
    const text = content.map((block) => block.text).join('');
    assert.ok(text.length < 2_000, `截过的结果有 ${text.length} 个字符`);
    assert.ok(text.startsWith('marker'));
    assert.match(text.replace('marker', ''), /\d/, '注明省略了多少');
    assert.equal(seen[0]?.type === 'text' && seen[0].text, text);
    const unlimited = createMcpServer({ executors: [box()], context: { session: 's' }, maxOutputChars: 0 });
    const full = resultOf(await call(unlimited)) as { content: { text: string }[] };
    assert.equal(full.content[0]?.text, long);
  });

  test('JSON-RPC：版本协商、ping、不认识的方法、通知不回话、客户端取消正在跑的调用', async () => {
    const server = createMcpServer({ executors: { box: box() }, context: () => ({ session: 's' }) });
    const init = await server.handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26' },
    });
    assert.equal((resultOf(init) as { protocolVersion: string }).protocolVersion, '2025-03-26');
    const future = await server.handle({
      jsonrpc: '2.0',
      id: 2,
      method: 'initialize',
      params: { protocolVersion: '2099-01-01' },
    });
    assert.equal((resultOf(future) as { protocolVersion: string }).protocolVersion, '2025-06-18');
    assert.deepEqual(await server.handle({ jsonrpc: '2.0', id: 3, method: 'ping' }), {
      jsonrpc: '2.0',
      id: 3,
      result: {},
    });
    assert.equal(errorOf(await server.handle({ jsonrpc: '2.0', id: 4, method: 'resources/list' })).code, -32601);
    assert.equal(await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), undefined);
    assert.equal(errorOf(await server.handle([{ jsonrpc: '2.0', id: 5, method: 'ping' }])).code, -32600);
    const unknown = await server.handle({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'nope' } });
    assert.match(errorOf(unknown).message, /Unknown tool: nope/);
    const waiting = server.handle({
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'wait', arguments: {} },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await server.handle({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 7 } });
    assert.deepEqual(resultOf(await waiting), { content: [{ type: 'text', text: 'aborted' }] });
  });

  test('serveMcpStdio：一行一条，解析不了回 Parse error，输入结束就停', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const lines: unknown[] = [];
    output.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split('\n')) if (line.trim()) lines.push(JSON.parse(line));
    });
    const done = serveMcpStdio(createMcpServer({ executors: [box()], context: { session: 's' } }), { input, output });
    input.write('{"jsonrpc":"2.0","id":1,"method":"ping"}\n');
    input.write('not json\n');
    input.end();
    await done;
    // 不排队：先到的请求不一定先回。
    assert.equal(lines.length, 2);
    assert.ok(lines.some((line) => isDeepStrictEqual(line, { jsonrpc: '2.0', id: 1, result: {} })));
    assert.ok(
      lines.some((line) =>
        isDeepStrictEqual(line, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }),
      ),
    );
  });

  test('HTTP 的缺省安全：带 Origin 403、要 token 时 401、GET 405、通知 202', async () => {
    const server = createMcpServer({ executors: [box()], context: { session: 's' } });
    const http = await listen(createMcpHttpHandler(server, { accessToken: 'secret-token' }));
    const post = (body: unknown, headers: Record<string, string> = {}) =>
      fetch(http.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer secret-token', ...headers },
        body: JSON.stringify(body),
      });
    try {
      assert.equal(
        (await post({ jsonrpc: '2.0', id: 1, method: 'ping' }, { origin: 'https://evil.example' })).status,
        403,
      );
      assert.equal(
        (await post({ jsonrpc: '2.0', id: 1, method: 'ping' }, { authorization: 'Bearer nope' })).status,
        401,
      );
      assert.equal((await fetch(http.url, { headers: { authorization: 'Bearer secret-token' } })).status, 405);
      assert.equal((await post({ jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
      assert.equal((await post({ jsonrpc: '2.0', id: 1, method: 'ping' })).status, 200);
      assert.throws(() => createMcpHttpHandler(server, { accessToken: ' ' }), /`accessToken` is empty/);
    } finally {
      await http.close();
    }
  });

  test('toolOutputToMcp：json 带 structuredContent，地址是资源链接，非图片的内联文件是嵌入资源', () => {
    assert.deepEqual(toolOutputToMcp({ type: 'json', value: { a: 1 } }), {
      content: [{ type: 'text', text: '{"a":1}' }],
      structuredContent: { a: 1 },
    });
    assert.deepEqual(toolOutputToMcp({ type: 'json', value: [1] }), { content: [{ type: 'text', text: '[1]' }] });
    assert.deepEqual(
      toolOutputToMcp({
        type: 'content',
        parts: [
          {
            type: 'file',
            mediaType: 'application/pdf',
            data: { type: 'url', url: 'https://example.test/a.pdf' },
            filename: 'a.pdf',
          },
          { type: 'file', mediaType: 'text/csv', data: { type: 'text', text: 'a,b' }, filename: 'x.csv' },
        ],
      }),
      {
        content: [
          { type: 'resource_link', uri: 'https://example.test/a.pdf', name: 'a.pdf', mimeType: 'application/pdf' },
          { type: 'resource', resource: { uri: 'ctx-file:///x.csv', mimeType: 'text/csv', text: 'a,b' } },
        ],
      },
    );
  });
});
