import assert from 'node:assert/strict';

import { describe, test } from 'vite-plus/test';

import {
  checkJsonSchema,
  errorOutput,
  isValidToolName,
  limitToolOutput,
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

describe('checkJsonSchema', () => {
  const schema = {
    type: 'object',
    properties: {
      city: { type: 'string', minLength: 1, maxLength: 4 },
      days: { type: 'integer', minimum: 1, maximum: 7 },
      unit: { enum: ['c', 'f'] },
      tags: { type: 'array', items: { type: 'string' }, maxItems: 2 },
      where: { anyOf: [{ type: 'string' }, { type: 'object', required: ['lat', 'lon'] }] },
      note: { type: ['string', 'null'] },
    },
    required: ['city'],
    additionalProperties: false,
  };

  test('合规的输入没有问题', () => {
    assert.deepEqual(checkJsonSchema(schema, { city: '台北' }), []);
    assert.deepEqual(
      checkJsonSchema(schema, { city: '台北', days: 3, unit: 'f', tags: ['a'], where: { lat: 1, lon: 2 }, note: null }),
      [],
    );
    assert.deepEqual(checkJsonSchema({ type: 'object' }, {}), []);
    assert.deepEqual(checkJsonSchema(true, 1), []);
  });

  test('报出来的问题带着位置，模型照着能改', () => {
    assert.deepEqual(checkJsonSchema(schema, null), ['input must be object, got null']);
    assert.deepEqual(checkJsonSchema(schema, {}), ['city is required']);
    assert.deepEqual(checkJsonSchema(schema, { city: 5 }), ['city must be string, got number']);
    assert.deepEqual(checkJsonSchema(schema, { city: '台北', days: 1.5 }), ['days must be integer, got number']);
    assert.deepEqual(checkJsonSchema(schema, { city: '台北', days: 9 }), ['days must be <= 7']);
    assert.deepEqual(checkJsonSchema(schema, { city: '台北', unit: 'k' }), ['unit must be one of ["c","f"]']);
    assert.deepEqual(checkJsonSchema(schema, { city: '台北', tags: ['a', 2] }), ['tags[1] must be string, got number']);
    assert.deepEqual(checkJsonSchema(schema, { city: '台北', extra: 1 }), ['extra is not a known property']);
    assert.deepEqual(checkJsonSchema(schema, { city: '台北市信义区' }), ['city must be at most 4 characters']);
    assert.match(
      checkJsonSchema(schema, { city: '台北', where: { lat: 1 } })[0]!,
      /^where matches none of the allowed shapes/,
    );
    assert.equal(checkJsonSchema(schema, { city: 1, days: 'x', unit: 'k', tags: 1, extra: 1 }, 2).length, 2);
  });

  test('不认识的关键字和引用一概放行；nullable、patternProperties、prefixItems 认识', () => {
    assert.deepEqual(checkJsonSchema({ $ref: '#/definitions/x' }, 1), []);
    assert.deepEqual(checkJsonSchema({ type: 'string', format: 'email', not: { type: 'string' } }, 'x'), []);
    assert.deepEqual(checkJsonSchema({ type: 'string', pattern: '(' }, 'x'), [], '编不出来的 pattern 不拦');
    assert.deepEqual(checkJsonSchema({ type: 'string', nullable: true }, null), []);
    const map = { type: 'object', patternProperties: { '^x-': { type: 'number' } }, additionalProperties: false };
    assert.deepEqual(checkJsonSchema(map, { 'x-a': 1 }), []);
    assert.deepEqual(checkJsonSchema(map, { 'x-a': '1', b: 2 }), [
      'x-a must be number, got string',
      'b is not a known property',
    ]);
    const tuple = { type: 'array', prefixItems: [{ type: 'string' }], items: { type: 'number' } };
    assert.deepEqual(checkJsonSchema(tuple, ['a', 1, 2]), []);
    assert.deepEqual(checkJsonSchema(tuple, ['a', 'b']), ['[1] must be number, got string']);
  });
});

describe('limitToolOutput', () => {
  test('没超的原样返回；没给上限、0、Infinity 都是不限', () => {
    const output: ToolOutput = { type: 'text', text: 'x'.repeat(100) };
    assert.equal(limitToolOutput(output, 100), output);
    for (const none of [undefined, 0, -1, Infinity]) assert.equal(limitToolOutput(output, none), output);
  });

  test('文字、错误、json 超了就截断并注明省略多少', () => {
    const text = limitToolOutput({ type: 'text', text: 'x'.repeat(100) }, 10);
    assert.equal(
      text.type === 'text' && text.text.startsWith(`${'x'.repeat(10)}\n[… truncated 90 more characters`),
      true,
    );
    const error = limitToolOutput(errorOutput('e'.repeat(50), { retryable: true }), 10);
    assert.equal(error.type === 'error' && error.retryable, true);
    assert.match(error.type === 'error' ? error.message : '', /truncated 40 more characters/);
    const json = limitToolOutput({ type: 'json', value: { rows: Array.from({ length: 50 }, (_, i) => i) } }, 20);
    assert.equal(json.type, 'text');
    assert.match(json.type === 'text' ? json.text : '', /^\{"rows":\[0,1,2,3,4,5\n\[… truncated 130 more characters/);
  });

  test('不把一对代理项切成两半', () => {
    const clipped = limitToolOutput({ type: 'text', text: 'a😀b😀' }, 2);
    assert.equal(clipped.type === 'text' && clipped.text.startsWith('a\n[…'), true);
  });

  test('content：各段合起来算，放不下的文件换成说明，超的那段文字截断、后面的文字不要', () => {
    const output: ToolOutput = {
      type: 'content',
      parts: [
        { type: 'text', text: 'a'.repeat(30) },
        { type: 'file', mediaType: 'image/png', data: { type: 'data', data: 'B'.repeat(100) } },
        { type: 'file', mediaType: 'image/png', data: { type: 'url', url: 'https://example.com/a.png' } },
        { type: 'text', text: 'c'.repeat(30) },
        { type: 'text', text: 'd'.repeat(30) },
      ],
    };
    const limited = limitToolOutput(output, 50);
    assert.equal(limited.type, 'content');
    const parts = limited.type === 'content' ? limited.parts : [];
    assert.deepEqual(
      parts.map((part) => (part.type === 'text' ? part.text.slice(0, 24) : part.data.type)),
      ['a'.repeat(24), '[image/png file omitted:', 'url', 'c'.repeat(20) + '\n[… '],
    );
  });
});
