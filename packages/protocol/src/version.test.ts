import assert from 'node:assert/strict';

import { describe, test } from 'vite-plus/test';

import { ENTRY_VERSION, upgradeEntry } from './version.ts';

/**
 * v0 的黄金样例：0.2 及以前存进 `body` 的样子（AI SDK 的 `ModelMessage` 原样，二进制和 URL 用 `\u0000ctx` 标记，
 * 摘要的 `covers` 是 `{ at, seq }`）。照 ADR 0005 手写，不是从真实数据库导出的：
 * 实际的 yoyo 夹具里只有纯文本，没有二进制和 URL。
 */
const BASE = { id: 'e1', session: 's', seq: 3, at: 1_700_000_000_000 };
const BYTES = { '\u0000ctx': 'bytes', base64: 'AQID' };
const URL_MARK = { '\u0000ctx': 'url', href: 'https://example.com/a.png' };

function message(body: unknown) {
  return { ...BASE, type: 'message', message: body };
}

function upgraded(raw: unknown) {
  return upgradeEntry(raw);
}

describe('upgradeEntry v0 → v1', () => {
  test('纯文本消息只多一个 v: 0', () => {
    const entry = upgraded(message({ role: 'user', content: 'hi' }));
    assert.deepEqual(entry, { ...BASE, type: 'message', v: 0, message: { role: 'user', content: 'hi' } });
  });

  test('保留 key、source、meta', () => {
    const entry = upgraded({ ...message({ role: 'system', content: 'x' }), key: 'k', source: 'app', meta: { a: 1 } });
    assert.equal(entry.key, 'k');
    assert.equal(entry.source, 'app');
    assert.deepEqual(entry.meta, { a: 1 });
  });

  test('图片：Uint8Array 标记变 base64，image 并入 file', () => {
    const entry = upgraded(
      message({
        role: 'user',
        content: [
          { type: 'text', text: 'look' },
          { type: 'image', image: BYTES, mediaType: 'image/png' },
          { type: 'image', image: URL_MARK },
          { type: 'file', mediaType: 'application/pdf', data: BYTES, filename: 'a.pdf' },
          { type: 'file', mediaType: 'image/png', data: { type: 'data', data: BYTES } },
          {
            type: 'file',
            mediaType: 'image/png',
            data: { type: 'url', url: URL_MARK, originalUrl: 'https://o.example/x' },
          },
        ],
      }),
    );
    assert.deepEqual(entry.type === 'message' ? entry.message : undefined, {
      role: 'user',
      content: [
        { type: 'text', text: 'look' },
        { type: 'file', mediaType: 'image/png', data: { type: 'data', data: 'AQID' } },
        { type: 'file', mediaType: 'image', data: { type: 'url', url: 'https://example.com/a.png' } },
        { type: 'file', mediaType: 'application/pdf', data: { type: 'data', data: 'AQID' }, filename: 'a.pdf' },
        { type: 'file', mediaType: 'image/png', data: { type: 'data', data: 'AQID' } },
        { type: 'file', mediaType: 'image/png', data: { type: 'url', url: 'https://o.example/x' } },
      ],
    });
  });

  test('裸字符串的图片数据：地址当地址，其余当 base64', () => {
    const entry = upgraded(
      message({
        role: 'user',
        content: [
          { type: 'image', image: 'https://example.com/b.png' },
          { type: 'image', image: 'data:image/png;base64,AAAA' },
          { type: 'image', image: 'AQID', mediaType: 'image/jpeg' },
        ],
      }),
    );
    assert.deepEqual(entry.type === 'message' ? entry.message.content : undefined, [
      { type: 'file', mediaType: 'image', data: { type: 'url', url: 'https://example.com/b.png' } },
      { type: 'file', mediaType: 'image', data: { type: 'url', url: 'data:image/png;base64,AAAA' } },
      { type: 'file', mediaType: 'image/jpeg', data: { type: 'data', data: 'AQID' } },
    ]);
  });

  test('助手：推理签名、工具调用、reasoning-file、custom、审批请求', () => {
    const entry = upgraded(
      message({
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'think', providerOptions: { anthropic: { signature: 'sig' } } },
          { type: 'reasoning-file', mediaType: 'image/png', data: { type: 'data', data: BYTES } },
          { type: 'custom', kind: 'openai.compaction', providerOptions: { openai: { id: 'c1' } } },
          { type: 'text', text: 'ok' },
          { type: 'tool-call', toolCallId: 'c1', toolName: 'read', input: { path: '/a', '\u0000ctx': 'x' } },
          { type: 'tool-call', toolCallId: 'c2', toolName: 'ping', input: {}, providerExecuted: true },
          { type: 'tool-approval-request', approvalId: 'a1', toolCallId: 'c1', reason: 'r', signature: 's' },
        ],
      }),
    );
    assert.deepEqual(entry.type === 'message' ? entry.message : undefined, {
      role: 'assistant',
      content: [
        { type: 'reasoning', text: 'think', providerOptions: { anthropic: { signature: 'sig' } } },
        { type: 'reasoning-file', mediaType: 'image/png', data: { type: 'data', data: 'AQID' } },
        { type: 'custom', kind: 'openai.compaction', providerOptions: { openai: { id: 'c1' } } },
        { type: 'text', text: 'ok' },
        // 只有恰好两个键的对象才是编码标记；这里有别的键，原样保留。
        { type: 'tool-call', id: 'c1', name: 'read', input: { path: '/a', '\u0000ctx': 'x' } },
        { type: 'tool-call', id: 'c2', name: 'ping', input: {}, providerExecuted: true },
        { type: 'tool-approval-request', approvalId: 'a1', callId: 'c1', reason: 'r', signature: 's' },
      ],
    });
  });

  test('助手：纯字符串内容和 providerOptions', () => {
    const entry = upgraded(message({ role: 'assistant', content: 'done', providerOptions: { x: { a: 1 } } }));
    assert.deepEqual(entry.type === 'message' ? entry.message : undefined, {
      role: 'assistant',
      content: 'done',
      providerOptions: { x: { a: 1 } },
    });
  });

  test('工具结果：text、json、error-text、error-json、旧式内容分段', () => {
    const entry = upgraded(
      message({
        role: 'tool',
        content: [
          { type: 'tool-result', toolCallId: 'c1', toolName: 'a', output: { type: 'text', value: 'ok' } },
          { type: 'tool-result', toolCallId: 'c2', toolName: 'b', output: { type: 'json', value: { n: 1 } } },
          { type: 'tool-result', toolCallId: 'c3', toolName: 'c', output: { type: 'error-text', value: 'bad' } },
          {
            type: 'tool-result',
            toolCallId: 'c4',
            toolName: 'd',
            output: { type: 'error-json', value: { message: 'bad', retryable: true } },
          },
          {
            type: 'tool-result',
            toolCallId: 'c5',
            toolName: 'e',
            output: {
              type: 'content',
              value: [
                { type: 'text', text: 'see' },
                { type: 'file-data', data: 'AQID', mediaType: 'image/png' },
                { type: 'image-url', url: 'https://example.com/i.png' },
              ],
            },
          },
          { type: 'tool-approval-response', approvalId: 'a1', approved: false, reason: 'no' },
        ],
      }),
    );
    assert.deepEqual(entry.type === 'message' ? entry.message : undefined, {
      role: 'tool',
      content: [
        { type: 'tool-result', id: 'c1', name: 'a', output: { type: 'text', text: 'ok' } },
        { type: 'tool-result', id: 'c2', name: 'b', output: { type: 'json', value: { n: 1 } } },
        { type: 'tool-result', id: 'c3', name: 'c', output: { type: 'error', message: 'bad' } },
        { type: 'tool-result', id: 'c4', name: 'd', output: { type: 'error', message: 'bad', retryable: true } },
        {
          type: 'tool-result',
          id: 'c5',
          name: 'e',
          output: {
            type: 'content',
            parts: [
              { type: 'text', text: 'see' },
              { type: 'file', mediaType: 'image/png', data: { type: 'data', data: 'AQID' } },
              { type: 'file', mediaType: 'image', data: { type: 'url', url: 'https://example.com/i.png' } },
            ],
          },
        },
        { type: 'tool-approval-response', approvalId: 'a1', approved: false, reason: 'no' },
      ],
    });
  });

  test('摘要：covers.seq 成为 covers，其余不变', () => {
    const entry = upgraded({ ...BASE, type: 'summary', text: 'sum', covers: { at: 1_699_999_999_999, seq: 2 } });
    assert.deepEqual(entry, { ...BASE, type: 'summary', v: 0, text: 'sum', covers: 2 });
  });

  test('事件不变', () => {
    const raw = { ...BASE, type: 'event', kind: 'app.note', text: 'n', data: { a: [1, 2] } };
    assert.deepEqual(upgraded(raw), { ...raw, v: 0 });
  });

  test('遇到不认识的部件或角色抛 unsupported_part', () => {
    assert.throws(
      () => upgraded(message({ role: 'user', content: [{ type: 'hologram' }] })),
      (error: Error) => error.name === 'unsupported_part',
    );
    assert.throws(
      () => upgraded(message({ role: 'robot', content: 'x' })),
      (error: Error) => error.name === 'unsupported_part',
    );
  });
});

describe('upgradeEntry 其他版本', () => {
  test('当前版本的行原样通过', () => {
    const raw = { ...BASE, type: 'message', v: ENTRY_VERSION, message: { role: 'user', content: 'hi' } };
    assert.deepEqual(upgradeEntry(raw), raw);
  });

  test('v1 的消息里长得像 v0 标记的对象不被还原', () => {
    const input = { '\u0000ctx': 'bytes', base64: 'AQID' };
    const raw = {
      ...BASE,
      type: 'message',
      v: 1,
      message: { role: 'assistant', content: [{ type: 'tool-call', id: 'c', name: 'n', input }] },
    };
    assert.deepEqual(upgradeEntry(raw), raw);
  });

  test('比自己认识的更高的版本抛 unsupported_version', () => {
    const raw = { ...BASE, type: 'event', kind: 'k', v: ENTRY_VERSION + 1 };
    assert.throws(
      () => upgradeEntry(raw),
      (error: Error) => error.name === 'unsupported_version' && /Upgrade/.test(error.message),
    );
  });

  test('v 不是非负整数、行不是对象时抛 unsupported_version', () => {
    for (const raw of [
      { ...BASE, type: 'event', kind: 'k', v: -1 },
      { ...BASE, v: 0.5 },
      { ...BASE, v: '1' },
      null,
      7,
    ]) {
      assert.throws(
        () => upgradeEntry(raw),
        (error: Error) => error.name === 'unsupported_version',
      );
    }
  });
});
