import assert from 'node:assert/strict';

import { describe, test } from 'vite-plus/test';

import {
  errorOutput,
  isValidToolName,
  selectTools,
  toolOutputFromAiSdk,
  toolOutputToAiSdk,
  type AiSdkToolOutput,
  type ToolDefinition,
  type ToolOutput,
} from './tools.ts';

const tool = (name: string, extra: Partial<ToolDefinition> = {}): ToolDefinition => ({
  name,
  inputSchema: { type: 'object' },
  executor: 'local',
  ...extra,
});

describe('tool names', () => {
  test('各家接口的共同限制：[a-zA-Z0-9_-]，最多 64 个', () => {
    for (const ok of ['weather', 'fs__read_file', 'a-b_C9', 'x'.repeat(64)]) assert.ok(isValidToolName(ok), ok);
    for (const bad of ['', 'a b', 'a.b', '天气', 'x'.repeat(65)]) assert.ok(!isValidToolName(bad), bad);
  });
});

describe('selectTools', () => {
  const tools = [
    tool('weather_get', { source: 'local', tags: ['read'] }),
    tool('fs__read_file', { source: 'mcp:fs', tags: ['read'] }),
    tool('fs__write_file', { source: 'mcp:fs', tags: ['write'] }),
    tool('plain'),
  ];
  const names = (filter?: Parameters<typeof selectTools>[1]) => selectTools(tools, filter).map((t) => t.name);

  test('布尔、名字列表、函数', () => {
    assert.equal(names().length, 4);
    assert.equal(names(true).length, 4);
    assert.deepEqual(names(false), []);
    assert.deepEqual(names(['plain', 'weather_get', 'missing']), ['weather_get', 'plain'], '保持原来的顺序');
    assert.deepEqual(
      names((t) => t.name.startsWith('fs__')),
      ['fs__read_file', 'fs__write_file'],
    );
  });

  test('对象筛选：每一项任一个命中，给了的几项都要命中', () => {
    assert.deepEqual(names({ tags: ['read'] }), ['weather_get', 'fs__read_file']);
    assert.deepEqual(names({ sources: ['mcp:fs'], tags: ['read'] }), ['fs__read_file']);
    assert.deepEqual(names({ names: ['plain'], sources: ['local'] }), []);
    assert.equal(names({}).length, 4);
  });
});

describe('tool output ⇄ AI SDK', () => {
  const outputs: ToolOutput[] = [
    { type: 'text', text: '晴' },
    { type: 'json', value: { city: '台北', temps: [20, 25], rain: null } },
    errorOutput('文件不存在：/a/b'),
    errorOutput('超时了，可以重试', { retryable: true }),
    errorOutput('参数不对', { data: { field: 'city' } }),
    {
      type: 'content',
      parts: [
        { type: 'text', text: '截好了' },
        { type: 'file', mediaType: 'image/png', data: { type: 'data', data: 'aGk=' }, filename: 'a.png' },
        { type: 'file', mediaType: 'image', data: { type: 'url', url: 'https://example.com/a.png' } },
        { type: 'file', mediaType: 'image', data: { type: 'url', url: 'HTTPS://Example.com/b.png' } },
        { type: 'file', mediaType: 'application/pdf', data: { type: 'reference', reference: { openai: 'file_1' } } },
        { type: 'file', mediaType: 'text/plain', data: { type: 'text', text: '内联文档' } },
      ],
    },
  ];

  test('协议 → AI SDK → 协议 不丢信息', () => {
    for (const output of outputs) {
      assert.deepEqual(toolOutputFromAiSdk(toolOutputToAiSdk(output)), output, JSON.stringify(output));
    }
  });

  test('转成 AI SDK 的类型对得上', () => {
    assert.deepEqual(toolOutputToAiSdk({ type: 'text', text: 'x' }), { type: 'text', value: 'x' });
    assert.deepEqual(toolOutputToAiSdk(errorOutput('x')), { type: 'error-text', value: 'x' });
    assert.deepEqual(toolOutputToAiSdk(errorOutput('x', { retryable: false })), {
      type: 'error-json',
      value: { message: 'x', retryable: false },
    });
    const content = toolOutputToAiSdk(outputs[5]!);
    assert.ok(content.type === 'content');
    const url = content.value[2];
    assert.ok(url?.type === 'file' && url.data.type === 'url' && url.data.url instanceof URL);
  });

  test('AI SDK → 协议：二进制变 base64，已弃用的分段换成 file，自定义分段丢掉', () => {
    const output: AiSdkToolOutput = {
      type: 'content',
      value: [
        { type: 'file', mediaType: 'image/png', data: { type: 'data', data: new Uint8Array([104, 105]) } },
        { type: 'image-data', data: 'aGk=', mediaType: 'image/png' },
        { type: 'image-url', url: 'https://example.com/a.png' },
        { type: 'file-id', fileId: 'f1' },
        { type: 'custom' },
      ],
    };
    assert.deepEqual(toolOutputFromAiSdk(output), {
      type: 'content',
      parts: [
        { type: 'file', mediaType: 'image/png', data: { type: 'data', data: 'aGk=' } },
        { type: 'file', mediaType: 'image/png', data: { type: 'data', data: 'aGk=' } },
        { type: 'file', mediaType: 'image', data: { type: 'url', url: 'https://example.com/a.png' } },
        {
          type: 'file',
          mediaType: 'application/octet-stream',
          data: { type: 'reference', reference: { default: 'f1' } },
        },
      ],
    });
  });

  test('AI SDK → 协议：任意的 error-json 放进 data，拒绝执行变成错误', () => {
    assert.deepEqual(toolOutputFromAiSdk({ type: 'error-json', value: { code: 404 } }), {
      type: 'error',
      message: '{"code":404}',
      data: { code: 404 },
    });
    assert.deepEqual(toolOutputFromAiSdk({ type: 'execution-denied', reason: '用户拒绝' }), {
      type: 'error',
      message: '用户拒绝',
    });
  });
});
