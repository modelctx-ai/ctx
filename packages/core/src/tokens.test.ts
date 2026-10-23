import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { APICallError } from 'ai';

import { describeError, redact } from './errors.ts';
import { estimateTextTokens, estimateTokens } from './tokens.ts';

describe('tokens', () => {
  test('中文一字约一个 token，英文约四个字符一个', () => {
    assert.equal(estimateTextTokens('今天下雨'), 4);
    assert.equal(estimateTextTokens('abcdefgh'), 2);
    assert.equal(estimateTextTokens('带伞 ok'), 3);
  });

  test('消息带固定开销，附件按定额算', () => {
    assert.equal(estimateTokens({ role: 'user', content: '在吗' }), 6);
    const withImage = estimateTokens({
      role: 'user',
      content: [
        { type: 'text', text: '看图' },
        { type: 'image', image: new URL('https://example.com/a.png') },
      ],
    });
    assert.equal(withImage, 4 + 2 + 256);
  });
});

describe('errors', () => {
  test('去掉密钥', () => {
    assert.equal(redact('key=sk-secret-123 again sk-secret-123', ['sk-secret-123', undefined]), 'key=*** again ***');
  });

  test('接口错误带状态码和正文片段', () => {
    const error = new APICallError({
      message: 'Bad Request',
      url: 'https://example.test/v1/chat/completions',
      requestBodyValues: {},
      statusCode: 400,
      responseBody: '{"error":"bad key sk-secret-123"}',
    });
    const described = describeError(error, { secrets: ['sk-secret-123'] });
    assert.equal(described.status, 400);
    assert.equal(described.detail, '{"error":"bad key ***"}');
    assert.equal(describeError(new Error('  多余   空白 ')).message, '多余 空白');
  });
});
