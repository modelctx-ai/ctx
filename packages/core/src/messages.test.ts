import assert from 'node:assert/strict';

import type { ModelMessage } from 'ai';
import { describe, test } from 'vite-plus/test';

import type { Message, ToolOutput } from '@modelctx-ai/ctx-protocol';

import {
  AI_SDK_PART_TYPES,
  fromModelMessage,
  fromModelMessages,
  fromUserContent,
  toModelMessage,
  toModelMessages,
  toUserContent,
} from './messages.ts';

const PNG = new Uint8Array([1, 2, 3]);

/** AI SDK 每种部件各一个例子。键必须正好是 `AI_SDK_PART_TYPES` 的键：漏一种或多一种都编译不过。 */
const SAMPLES = {
  text: { role: 'user', content: [{ type: 'text', text: 'hi', providerOptions: { a: { b: 1 } } }] },
  image: { role: 'user', content: [{ type: 'image', image: PNG, mediaType: 'image/png' }] },
  file: {
    role: 'user',
    content: [{ type: 'file', mediaType: 'application/pdf', data: { type: 'data', data: PNG }, filename: 'a.pdf' }],
  },
  reasoning: {
    role: 'assistant',
    content: [{ type: 'reasoning', text: 'think', providerOptions: { anthropic: { signature: 's' } } }],
  },
  'reasoning-file': {
    role: 'assistant',
    content: [{ type: 'reasoning-file', mediaType: 'image/png', data: { type: 'data', data: PNG } }],
  },
  custom: {
    role: 'assistant',
    content: [{ type: 'custom', kind: 'openai.compaction', providerOptions: { openai: { id: 'c' } } }],
  },
  'tool-call': {
    role: 'assistant',
    content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'read', input: { path: '/a' }, providerExecuted: true }],
  },
  'tool-result': {
    role: 'tool',
    content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'read', output: { type: 'text', value: 'ok' } }],
  },
  'tool-approval-request': {
    role: 'assistant',
    content: [
      {
        type: 'tool-approval-request',
        approvalId: 'a1',
        toolCallId: 'c1',
        reason: 'r',
        isAutomatic: true,
        signature: 'sig',
        inputSchemaInput: { path: '/a' },
      },
    ],
  },
  'tool-approval-response': {
    role: 'tool',
    content: [
      { type: 'tool-approval-response', approvalId: 'a1', approved: true, reason: 'ok', providerExecuted: false },
    ],
  },
} as const satisfies Record<keyof typeof AI_SDK_PART_TYPES, ModelMessage>;

function partTypes(message: Message | ModelMessage): string[] {
  return typeof message.content === 'string' ? [] : message.content.map((part) => part.type);
}

function file(data: unknown): Message {
  return fromModelMessage({ role: 'user', content: [{ type: 'file', mediaType: 'x/y', data }] } as ModelMessage);
}

function dataOf(message: Message) {
  return typeof message.content === 'string' || message.role === 'tool' || message.content[0]?.type !== 'file'
    ? undefined
    : message.content[0].data;
}

function bad(message: unknown): () => Message {
  return () => fromModelMessage(message as ModelMessage);
}

function isUnsupported(error: Error): boolean {
  return error.name === 'unsupported_part';
}

describe('Message 和 AI SDK 的 ModelMessage 互转', () => {
  test('AI SDK 每种部件都能转进来，转出去，再转回来得到同一个 Message', () => {
    for (const [type, sample] of Object.entries(SAMPLES)) {
      const ctx = fromModelMessage(sample);
      // 全是 JSON：序列化再读回来不变。
      assert.deepEqual(JSON.parse(JSON.stringify(ctx)), ctx, type);
      assert.deepEqual(fromModelMessage(toModelMessage(ctx)), ctx, type);
      assert.equal(partTypes(ctx).length, 1, type);
    }
  });

  test('样例覆盖 AI_SDK_PART_TYPES 的每个键', () => {
    const seen = new Set(Object.values(SAMPLES).flatMap((sample) => partTypes(sample)));
    assert.deepEqual([...seen].toSorted(), Object.keys(AI_SDK_PART_TYPES).toSorted());
  });

  test('image 并入 file；字节变 base64；mediaType 缺省写 image', () => {
    assert.deepEqual(fromModelMessage(SAMPLES.image), {
      role: 'user',
      content: [{ type: 'file', mediaType: 'image/png', data: { type: 'data', data: 'AQID' } }],
    });
    assert.deepEqual(
      fromModelMessage({ role: 'user', content: [{ type: 'image', image: new URL('https://e.com/a') }] }),
      {
        role: 'user',
        content: [{ type: 'file', mediaType: 'image', data: { type: 'url', url: 'https://e.com/a' } }],
      },
    );
  });

  test('文件数据的各种写法', () => {
    assert.deepEqual(dataOf(file(PNG)), { type: 'data', data: 'AQID' });
    assert.deepEqual(dataOf(file(PNG.buffer)), { type: 'data', data: 'AQID' });
    assert.deepEqual(dataOf(file(Buffer.from(PNG))), { type: 'data', data: 'AQID' });
    assert.deepEqual(dataOf(file('AQID')), { type: 'data', data: 'AQID' });
    assert.deepEqual(dataOf(file('https://e.com/a')), { type: 'url', url: 'https://e.com/a' });
    assert.deepEqual(dataOf(file(new URL('https://e.com/a'))), { type: 'url', url: 'https://e.com/a' });
    assert.deepEqual(dataOf(file({ type: 'url', url: new URL('https://e.com/a') })), {
      type: 'url',
      url: 'https://e.com/a',
    });
    assert.deepEqual(dataOf(file({ type: 'reference', reference: { openai: 'f1' } })), {
      type: 'reference',
      reference: { openai: 'f1' },
    });
    assert.deepEqual(dataOf(file({ type: 'text', text: 'inline' })), { type: 'text', text: 'inline' });
    assert.deepEqual(dataOf(file({ openai: 'f1' })), { type: 'reference', reference: { openai: 'f1' } });
  });

  test('ctx 的每种文件数据转出去是 AI SDK 带标签的写法，字节是 Uint8Array 之外的东西也能读回', () => {
    const message: Message = {
      role: 'user',
      content: [
        { type: 'file', mediaType: 'a/b', data: { type: 'data', data: 'AQID' } },
        { type: 'file', mediaType: 'a/b', data: { type: 'url', url: 'https://e.com/a' } },
        { type: 'file', mediaType: 'a/b', data: { type: 'reference', reference: { openai: 'f1' } } },
        { type: 'file', mediaType: 'a/b', data: { type: 'text', text: 'inline' } },
      ],
    };
    assert.deepEqual(fromModelMessage(toModelMessage(message)), message);
  });

  test('字符串内容、system、没有可选字段时不多出键', () => {
    const messages: Message[] = [
      { role: 'system', content: 'be brief' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'yo' },
      { role: 'assistant', content: [{ type: 'tool-call', id: 'c', name: 'n', input: null }] },
    ];
    assert.deepEqual(fromModelMessages(toModelMessages(messages)), messages);
    assert.deepEqual(toModelMessages(messages)[1], { role: 'user', content: 'hi' });
  });

  test('工具结果的各种输出', () => {
    const outputs: ToolOutput[] = [
      { type: 'text', text: 'ok' },
      { type: 'json', value: { n: [1, null] } },
      { type: 'error', message: 'bad' },
      { type: 'error', message: 'bad', retryable: true, data: { code: 1 } },
      {
        type: 'content',
        parts: [
          { type: 'text', text: 'see' },
          { type: 'file', mediaType: 'image/png', data: { type: 'data', data: 'AQID' } },
        ],
      },
    ];
    for (const output of outputs) {
      const message: Message = { role: 'tool', content: [{ type: 'tool-result', id: 'c', name: 'n', output }] };
      assert.deepEqual(fromModelMessage(toModelMessage(message)), message);
    }
  });

  test('用户输入：UserContent 转成 MessageContent 再转回来', () => {
    assert.equal(fromUserContent('hi'), 'hi');
    const content = fromUserContent([
      { type: 'text', text: 'a' },
      { type: 'image', image: PNG, mediaType: 'image/png' },
    ]);
    assert.deepEqual(content, [
      { type: 'text', text: 'a' },
      { type: 'file', mediaType: 'image/png', data: { type: 'data', data: 'AQID' } },
    ]);
    assert.deepEqual(fromUserContent(toUserContent(content)), content);
  });

  test('不认识的角色、部件、文件数据抛 unsupported_part', () => {
    assert.throws(bad({ role: 'robot', content: 'x' }), isUnsupported);
    assert.throws(bad({ role: 'user', content: [{ type: 'hologram' }] }), isUnsupported);
    assert.throws(bad({ role: 'assistant', content: [{ type: 'image', image: 'x' }] }), isUnsupported);
    assert.throws(bad({ role: 'tool', content: [{ type: 'text', text: 'x' }] }), isUnsupported);
    assert.throws(
      bad({ role: 'user', content: [{ type: 'file', mediaType: 'a/b', data: { type: 'weird' } }] }),
      isUnsupported,
    );
    assert.throws(
      bad({
        role: 'assistant',
        content: [{ type: 'reasoning-file', mediaType: 'a/b', data: { type: 'reference', reference: {} } }],
      }),
      isUnsupported,
    );
    assert.throws(() => fromUserContent([{ type: 'hologram' }] as never), isUnsupported);
  });
});
