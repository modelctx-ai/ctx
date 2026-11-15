import assert from 'node:assert/strict';

import { describe, test } from 'vite-plus/test';

import { estimateFileTokens, estimateTextTokens, estimateTokens } from './tokens.ts';

function base64(bytes: number): string {
  return Buffer.alloc(bytes, 7).toString('base64');
}

describe('tokens', () => {
  test('中文一字约一个 token，英文约四个字符一个', () => {
    assert.equal(estimateTextTokens('今天下雨'), 4);
    assert.equal(estimateTextTokens('abcdefgh'), 2);
    assert.equal(estimateTextTokens('带伞 ok'), 3);
  });

  test('别的文字（西里尔、泰文、表情）约两个字符一个，不按 ASCII 的四个算', () => {
    assert.equal(estimateTextTokens('Привет'), 3);
    assert.equal(estimateTextTokens('สวัสดี'), 3);
    assert.equal(estimateTextTokens('😀😀'), 4);
    assert.equal(estimateTextTokens('ok Привет 你好'), 1 + 3 + 2);
  });

  test('附件按内容算：内联文字按字数，base64 按大小，图片分两档，不知道大小的按一张小图', () => {
    assert.equal(estimateFileTokens('text/plain', { type: 'text', text: 'a'.repeat(1_000_000) }), 250_000);
    assert.equal(estimateFileTokens('image/png', { type: 'data', data: base64(30_000) }), 256);
    assert.equal(estimateFileTokens('image/jpeg', { type: 'data', data: base64(2_000_000) }), 1600);
    assert.equal(estimateFileTokens('application/pdf', { type: 'data', data: base64(5_000_000) }), 250_000);
    assert.equal(estimateFileTokens('application/pdf', { type: 'data', data: base64(100) }), 256);
    assert.equal(estimateFileTokens('text/csv', { type: 'data', data: base64(4_000) }), 1_000);
    assert.equal(estimateFileTokens('image/png', { type: 'url', url: 'https://example.com/a.png' }), 256);
    assert.equal(estimateFileTokens('application/pdf', { type: 'reference', reference: { openai: 'file-1' } }), 256);
    // 消息里和工具结果里的文件走同一个估算。
    const file = {
      type: 'file' as const,
      mediaType: 'image/jpeg',
      data: { type: 'data' as const, data: base64(2_000_000) },
    };
    assert.equal(estimateTokens({ role: 'user', content: [file] }), 4 + 1600);
    assert.equal(
      estimateTokens({
        role: 'tool',
        content: [{ type: 'tool-result', id: 'c', name: 'n', output: { type: 'content', parts: [file] } }],
      }),
      4 + 1 + 1600,
    );
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

  test('工具结果里的小图按一张小图算，不去数 base64', () => {
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
