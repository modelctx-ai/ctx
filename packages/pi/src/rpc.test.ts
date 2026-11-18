import assert from 'node:assert/strict';

import { describe, test } from 'vite-plus/test';

import {
  addUsages,
  assistantMessageOf,
  errorOfMessage,
  finishReasonOf,
  parseRecord,
  promptOf,
  toolOutputOf,
  usageOf,
} from './rpc.ts';

describe('pi 的 RPC 记录和换算', () => {
  test('一行一个 JSON 对象，带 type；结尾的 \\r 去掉，别的不认', () => {
    assert.deepEqual(parseRecord('{"type":"agent_start"}\r'), { type: 'agent_start' });
    assert.equal(parseRecord('not json'), undefined);
    assert.equal(parseRecord('{"no":"type"}'), undefined);
    assert.equal(parseRecord('[1]'), undefined);
    // JSON 字符串里的 U+2028 不是换行。
    assert.deepEqual(parseRecord('{"type":"x","text":"a b"}'), { type: 'x', text: 'a b' });
  });

  test('用量：输入含缓存读到和写进缓存的，推理是输出的一部分，0 的不写', () => {
    assert.deepEqual(usageOf({ input: 10, output: 5, cacheRead: 3, cacheWrite: 0, totalTokens: 18, reasoning: 2 }), {
      inputTokens: 13,
      outputTokens: 5,
      totalTokens: 18,
      cacheReadTokens: 3,
      reasoningTokens: 2,
    });
    assert.equal(usageOf(undefined), undefined);
    assert.deepEqual(
      addUsages({ inputTokens: 1, totalTokens: 1 }, { inputTokens: 2, outputTokens: 3, totalTokens: 5 }),
      {
        inputTokens: 3,
        outputTokens: 3,
        totalTokens: 6,
      },
    );
  });

  test('finishReason 照 AI SDK 的写法', () => {
    assert.equal(finishReasonOf('stop'), 'stop');
    assert.equal(finishReasonOf('toolUse'), 'tool-calls');
    assert.equal(finishReasonOf('length'), 'length');
    assert.equal(finishReasonOf('deferred'), 'other');
    assert.equal(finishReasonOf('pending'), undefined);
  });

  test('助手消息：文字、推理（签名进 providerOptions.pi）、工具调用（名字换回 ctx 的），空文字不要', () => {
    const message = assistantMessageOf(
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '想', thinkingSignature: 'sig' },
          { type: 'thinking', thinking: '', thinkingSignature: 'opaque', redacted: true },
          { type: 'text', text: '' },
          { type: 'text', text: '好' },
          { type: 'toolCall', id: 'c1', name: 'mcp__ctx__echo', arguments: { text: 'a' } },
        ],
      },
      (name) => name.replace(/^mcp__ctx__/, ''),
    );
    assert.deepEqual(message, {
      role: 'assistant',
      content: [
        { type: 'reasoning', text: '想', providerOptions: { pi: { thinkingSignature: 'sig' } } },
        { type: 'reasoning', text: '', providerOptions: { pi: { thinkingSignature: 'opaque', redacted: true } } },
        { type: 'text', text: '好' },
        { type: 'tool-call', id: 'c1', name: 'echo', input: { text: 'a' } },
      ],
    });
  });

  test('工具结果：ctx 的工具还原 structuredContent 成 json；截断了只有文字；带图的是 content；出错是 error', () => {
    const text = [{ type: 'text', text: '{"text":"a"}' }] as const;
    const mcp = { content: text, structuredContent: { content: text, structuredContent: { text: 'a' } } };
    assert.deepEqual(toolOutputOf(mcp, false, true), { type: 'json', value: { text: 'a' } });
    assert.deepEqual(toolOutputOf({ content: text, structuredContent: { content: text } }, false, true), {
      type: 'text',
      text: '{"text":"a"}',
    });
    assert.deepEqual(toolOutputOf(mcp, false, false), { type: 'text', text: '{"text":"a"}' }, '不是 ctx 的工具不还原');
    assert.deepEqual(
      toolOutputOf(
        {
          content: [
            { type: 'text', text: '图：' },
            { type: 'image', data: 'AA==', mimeType: 'image/png' },
          ],
        },
        false,
        false,
      ),
      {
        type: 'content',
        parts: [
          { type: 'text', text: '图：' },
          { type: 'file', mediaType: 'image/png', data: { type: 'data', data: 'AA==' } },
        ],
      },
    );
    assert.deepEqual(toolOutputOf({ content: [{ type: 'text', text: 'boom' }] }, true, true), {
      type: 'error',
      message: 'boom',
    });
    assert.deepEqual(toolOutputOf(undefined, true, false), { type: 'error', message: 'The tool failed.' });
  });

  test('模型调用的错误：状态码定能不能重试，JSON 的响应体取 message，上下文过长是 context_overflow', () => {
    assert.deepEqual(errorOfMessage('500 {"type":"error","error":{"type":"api_error","message":"model exploded"}}'), {
      message: 'model exploded',
      type: 'api_call',
      retryable: true,
      statusCode: 500,
    });
    assert.deepEqual(errorOfMessage('401 {"message":"bad key"}'), {
      message: 'bad key',
      type: 'api_call',
      retryable: false,
      statusCode: 401,
    });
    const overflow = errorOfMessage(
      '400 {"type":"error","error":{"message":"prompt is too long: 210000 tokens > 200000 maximum"}}',
    );
    assert.equal(overflow.type, 'context_overflow');
    assert.equal(overflow.retryable, false);
    assert.deepEqual(errorOfMessage('fetch failed'), { message: 'fetch failed', type: 'pi' });
    assert.equal(errorOfMessage('503 upstream gone').message, 'upstream gone');
  });

  test('用户输入：文字按顺序连起来，内联的图片放进 images，放不下的文件换成说明', () => {
    assert.deepEqual(promptOf('你好', undefined, '补一句'), { message: '你好\n\n补一句', images: [] });
    assert.deepEqual(
      promptOf([
        { type: 'text', text: '看图' },
        { type: 'file', mediaType: 'image/png', data: { type: 'data', data: 'AA==' } },
        { type: 'file', mediaType: 'text/plain', data: { type: 'text', text: '附件' } },
        { type: 'file', mediaType: 'application/pdf', filename: 'a.pdf', data: { type: 'data', data: 'JVBE' } },
        { type: 'file', mediaType: 'image/jpeg', data: { type: 'url', url: 'https://example.com/a.jpg' } },
      ]),
      {
        message: '看图\n\n附件\n\n[application/pdf file a.pdf not passed to pi]\n\n[image/jpeg file not passed to pi]',
        images: [{ type: 'image', data: 'AA==', mimeType: 'image/png' }],
      },
    );
  });
});
