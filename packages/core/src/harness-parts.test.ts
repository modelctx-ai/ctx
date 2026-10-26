import assert from 'node:assert/strict';

import { CTX_EVENTS, CtxError, type Entry, type RunEvent } from '@modelctx-ai/ctx-protocol';
import { describe, test, vi } from 'vite-plus/test';

import { createContextBuilder } from './builder.ts';
import { createHarness } from './harness.ts';
import { createMemoryStore } from './store.ts';
import { createScriptedModel } from './testing.ts';

// 模型回的东西里混进了 ctx 转换不了的部件（AI SDK 以后新加的）：换掉 `fromModelMessages` 让它抛 `unsupported_part`。
vi.mock('./messages.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./messages.ts')>();
  return {
    ...actual,
    fromModelMessages: (messages: Parameters<typeof actual.fromModelMessages>[0]) => {
      if (messages.some((message) => message.role === 'assistant')) {
        throw new CtxError(
          'unsupported_part',
          'Unsupported message assistant part "hologram"; ctx cannot convert it yet.',
        );
      }
      return actual.fromModelMessages(messages);
    },
  };
});

function kinds(entries: readonly Entry[]): string[] {
  return entries.map((entry) =>
    entry.type === 'event' ? entry.kind : entry.type === 'message' ? entry.message.role : entry.type,
  );
}

function setup() {
  const store = createMemoryStore();
  return { store, harness: createHarness({ store, context: createContextBuilder({ store }) }) };
}

describe('harness 遇到不认识的消息部件', () => {
  test('run：以 error 结束，写 ctx.error（unsupported_part）和 ctx.run.ended，不写半截的产出', async () => {
    const { store, harness } = setup();
    const model = createScriptedModel([{ type: 'text', text: '好' }]);
    const result = await harness.run({ session: 's', agent: { model }, input: '在吗' });
    assert.equal(result.stopReason, 'error');
    assert.equal(result.error?.type, 'unsupported_part');
    assert.deepEqual(result.messages, []);
    const log = await store.list('s');
    assert.deepEqual(kinds(log), [CTX_EVENTS.runStarted, 'user', CTX_EVENTS.error, CTX_EVENTS.runEnded]);
    const error = log.find((entry) => entry.type === 'event' && entry.kind === CTX_EVENTS.error);
    assert.equal(error?.type === 'event' && (error.data as { type?: string }).type, 'unsupported_part');
  });

  test('stream：同样以 error 结束', async () => {
    const { store, harness } = setup();
    const model = createScriptedModel([{ type: 'text', text: '好' }]);
    const events: RunEvent[] = [];
    for await (const event of harness.stream({ session: 's', agent: { model }, input: '在吗' })) events.push(event);
    const ended = events.at(-1);
    assert.equal(ended?.type === 'run.ended' && ended.result.stopReason, 'error');
    assert.equal(ended?.type === 'run.ended' && ended.result.error?.type, 'unsupported_part');
    assert.deepEqual(kinds(await store.list('s')), [
      CTX_EVENTS.runStarted,
      'user',
      CTX_EVENTS.error,
      CTX_EVENTS.runEnded,
    ]);
  });
});
