import assert from 'node:assert/strict';

import { APICallError } from 'ai';
import { describe, test } from 'vite-plus/test';

import { describeError, redact } from './errors.ts';

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
