import assert from 'node:assert/strict';

import { describe, test } from 'vite-plus/test';

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
        { type: 'file', mediaType: 'image', data: { type: 'url', url: 'https://example.com/a.png' } },
      ],
    });
    assert.equal(withImage, 4 + 2 + 256);
  });

  test('工具结果里的图片、文件按附件定额算，不去数 base64', () => {
    const data = Buffer.alloc(30_000, 7).toString('base64');
    const tokens = estimateTokens({
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          id: 'c1',
          name: 'screenshot',
          output: {
            type: 'content',
            parts: [
              { type: 'text', text: '截好了' },
              { type: 'file', mediaType: 'image/png', data: { type: 'data', data } },
              { type: 'file', mediaType: 'image/png', data: { type: 'data', data } },
            ],
          },
        },
      ],
    });
    assert.equal(tokens, 4 + estimateTextTokens('screenshot') + 3 + 2 * 256);
  });
});
