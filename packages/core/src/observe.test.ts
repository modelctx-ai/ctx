import assert from 'node:assert/strict';

import { CTX_EVENTS, stepMetaOf, type RunEvent } from '@modelctx-ai/ctx-protocol';
import { convertArrayToReadableStream, MockLanguageModelV4 } from 'ai/test';
import { describe, test } from 'vite-plus/test';

import { createContextBuilder } from './builder.ts';
import { createHarness } from './harness.ts';
import { createMemoryStore } from './store.ts';
import { createScriptedModel } from './testing.ts';
import { createToolRegistry } from './tools.ts';

function setup() {
  const store = createMemoryStore();
  const tools = createToolRegistry();
  tools.executor.register({ name: 'echo', inputSchema: { type: 'object' } }, (input) => ({
    type: 'json',
    value: input,
  }));
  tools.add(tools.executor.definition('echo')!);
  return { store, harness: createHarness({ store, context: createContextBuilder({ store }), tools }) };
}

const toolThenText = [
  { type: 'tool-call', id: 'c1', input: { text: 'hi' } },
  { type: 'text', text: '好了' },
] as const;

/** 带缓存、推理用量和服务商模型标识的模型。 */
function cachedModel() {
  const usage = {
    inputTokens: { total: 100, noCache: 65, cacheRead: 30, cacheWrite: 5 },
    outputTokens: { total: 20, text: 13, reasoning: 7 },
  };
  return new MockLanguageModelV4({
    provider: 'acme',
    modelId: 'acme-latest',
    doGenerate: async () => ({
      content: [{ type: 'text', text: '好' }],
      finishReason: { unified: 'stop', raw: 'stop' },
      usage,
      response: { modelId: 'acme-2026-01-01' },
      warnings: [],
    }),
    doStream: async () => ({
      stream: convertArrayToReadableStream([
        { type: 'stream-start', warnings: [] },
        { type: 'reasoning-start', id: 'r' },
        { type: 'reasoning-delta', id: 'r', delta: '先想想' },
        { type: 'reasoning-end', id: 'r' },
        { type: 'text-start', id: 't' },
        { type: 'text-delta', id: 't', delta: '好' },
        { type: 'text-end', id: 't' },
        { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
      ]),
    }),
  });
}

describe('用量和步骤', () => {
  test('每一步的助手消息带 meta.step：第几步、模型、这一步的用量；工具结果不带', async () => {
    const { store, harness } = setup();
    await harness.run({
      session: 's',
      agent: { model: createScriptedModel(toolThenText) },
      input: '回显',
      runId: 'r1',
    });
    const log = await store.list('s');
    const steps = log.map((entry) => stepMetaOf(entry));
    assert.deepEqual(
      steps.map((meta) => meta?.step),
      [undefined, undefined, 0, undefined, 1, undefined],
    );
    const [first, second] = steps.filter((meta) => meta !== undefined);
    assert.equal(first?.runId, 'r1');
    assert.equal(first?.provider, 'scripted');
    assert.equal(first?.finishReason, 'tool-calls');
    assert.equal(second?.finishReason, 'stop');
    assert.equal(first?.usage?.inputTokens, 1);
  });

  test('Usage 带缓存读写和推理 token；meta.step 记服务商响应里的模型标识', async () => {
    const { store, harness } = setup();
    const result = await harness.run({ session: 's', agent: { model: cachedModel() }, input: '在吗' });
    const expected = {
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
      cacheReadTokens: 30,
      cacheWriteTokens: 5,
      reasoningTokens: 7,
    };
    assert.deepEqual(result.usage, expected);
    const log = await store.list('s');
    const ended = log.at(-1);
    assert.deepEqual(ended?.type === 'event' && (ended.data as { usage?: unknown }).usage, expected);
    const meta = log.map((entry) => stepMetaOf(entry)).find((item) => item !== undefined);
    assert.equal(meta?.modelId, 'acme-2026-01-01');
    assert.deepEqual(meta?.usage, expected);
  });
});

describe('流和日志对齐', () => {
  test('run.started、model.ended、run.ended 带 seq：发出时日志已经写到那里', async () => {
    const { store, harness } = setup();
    const events: RunEvent[] = [];
    const seen: number[] = [];
    for await (const event of harness.stream({
      session: 's',
      agent: { model: createScriptedModel(toolThenText) },
      input: '回显',
    })) {
      events.push(event);
      if ('seq' in event && event.seq !== undefined) {
        seen.push((await store.list('s')).at(-1)?.seq ?? 0);
      }
    }
    const log = await store.list('s');
    const aligned = events.flatMap((event) => ('seq' in event && event.seq !== undefined ? [event.seq] : []));
    assert.deepEqual(
      events.flatMap((event) => ('seq' in event && event.seq !== undefined ? [event.type] : [])),
      ['run.started', 'model.ended', 'model.ended', 'run.ended'],
    );
    // ctx.run.started；第一步到工具结果；第二步到回答；ctx.run.ended。
    assert.deepEqual(aligned, [log[0]!.seq, log[3]!.seq, log[4]!.seq, log[5]!.seq]);
    assert.equal(log[5]?.type === 'event' && log[5].kind, CTX_EVENTS.runEnded);
    // 收到事件的时候，日志至少写到了事件说的位置。
    for (const [index, seq] of aligned.entries()) assert.ok(seen[index]! >= seq);
  });

  test('record: false 的事件不带 seq；推理增量是 reasoning.delta', async () => {
    const { harness } = setup();
    const events: RunEvent[] = [];
    for await (const event of harness.stream({
      session: 's',
      agent: { model: cachedModel() },
      input: '在吗',
      record: false,
    })) {
      events.push(event);
    }
    assert.ok(events.every((event) => !('seq' in event) || event.seq === undefined));
    assert.deepEqual(
      events.filter((event) => event.type === 'reasoning.delta'),
      [{ type: 'reasoning.delta', runId: events[0]!.runId, text: '先想想' }],
    );
    const ended = events.find((event) => event.type === 'model.ended');
    assert.equal(ended?.type === 'model.ended' && ended.usage?.reasoningTokens, 7);
  });
});
