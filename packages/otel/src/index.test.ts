import assert from 'node:assert/strict';

import {
  createContextBuilder,
  createHarness,
  createMemoryStore,
  createToolRegistry,
  eventEntry,
  messageEntry,
  userEntry,
  CTX_EVENTS,
} from '@modelctx-ai/ctx';
import { createScriptedModel } from '@modelctx-ai/ctx/testing';
import { SpanStatusCode } from '@opentelemetry/api';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from '@opentelemetry/sdk-trace-base';
import { describe, test } from 'vite-plus/test';

import { deriveSpans, traceSession } from './index.ts';

function tracing() {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  return { exporter, tracer: provider.getTracer('ctx-otel-test') };
}

function harnessWithEcho() {
  const store = createMemoryStore();
  const tools = createToolRegistry();
  tools.executor.register({ name: 'echo', inputSchema: { type: 'object' } }, (input) => ({
    type: 'json',
    value: input,
  }));
  tools.add(tools.executor.definition('echo')!);
  return { store, harness: createHarness({ store, context: createContextBuilder({ store }), tools }) };
}

const parentOf = (span: ReadableSpan): string | undefined => span.parentSpanContext?.spanId;

describe('ctx-otel', () => {
  test('一轮带工具的运行：invoke_agent → 两次 chat → 一次 execute_tool，属性按 GenAI 语义约定', async () => {
    const { store, harness } = harnessWithEcho();
    const model = createScriptedModel([
      { type: 'tool-call', id: 'c1', input: { text: 'hi' } },
      { type: 'text', text: '好了' },
    ]);
    await harness.run({ session: 'user:42', agent: { model, name: 'helper' }, input: '回显', runId: 'r1' });

    const { exporter, tracer } = tracing();
    const traced = await traceSession(store, 'user:42', { tracer });
    assert.equal(traced.runs, 1);
    const spans = exporter.getFinishedSpans();
    const byName = new Map(spans.map((span) => [span.name, span]));
    assert.deepEqual(spans.map((span) => span.name).toSorted(), [
      'chat model',
      'chat model',
      'execute_tool echo',
      'invoke_agent helper',
    ]);
    const run = byName.get('invoke_agent helper')!;
    assert.equal(run.attributes['gen_ai.operation.name'], 'invoke_agent');
    assert.equal(run.attributes['gen_ai.conversation.id'], 'user:42');
    assert.equal(run.attributes['gen_ai.agent.name'], 'helper');
    assert.equal(run.attributes['ctx.run.id'], 'r1');
    assert.equal(run.attributes['ctx.run.stop_reason'], 'end_turn');
    assert.equal(run.attributes['gen_ai.usage.input_tokens'], 2);
    const chats = spans.filter((span) => span.name.startsWith('chat '));
    assert.ok(chats.every((span) => parentOf(span) === run.spanContext().spanId));
    assert.deepEqual(
      chats.map((span) => [span.attributes['ctx.step'], span.attributes['gen_ai.response.finish_reasons']]),
      [
        [0, ['tool-calls']],
        [1, ['stop']],
      ],
    );
    assert.equal(chats[0]!.attributes['gen_ai.provider.name'], 'scripted');
    assert.equal(chats[0]!.attributes['gen_ai.usage.output_tokens'], 1);
    const tool = byName.get('execute_tool echo')!;
    assert.equal(parentOf(tool), chats[0]!.spanContext().spanId);
    assert.equal(tool.attributes['gen_ai.tool.call.id'], 'c1');
    assert.equal(tool.status.code, SpanStatusCode.UNSET);

    // 再来一次：带上 upTo，结束了的运行不重复发。
    const again = await traceSession(store, 'user:42', { tracer, after: traced.upTo });
    assert.deepEqual(again, { runs: 0, upTo: traced.upTo });
    assert.equal(exporter.getFinishedSpans().length, 4);
  });

  test('出错的运行和没等到结果的工具调用是 ERROR；没结束的运行留到下一次', () => {
    const entries = [
      eventEntry(CTX_EVENTS.runStarted, { data: { runId: 'r1', agent: { model: 'm' } } }),
      userEntry('做'),
      messageEntry(
        { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'step', input: {} }] },
        { meta: { step: { runId: 'r1', step: 0, modelId: 'm-1' } } },
      ),
      eventEntry(CTX_EVENTS.error, { data: { runId: 'r1', message: 'model exploded' } }),
      eventEntry(CTX_EVENTS.runEnded, { data: { runId: 'r1', stopReason: 'error' } }),
      eventEntry(CTX_EVENTS.runStarted, { data: { runId: 'r2', agent: { model: 'm' } } }),
    ].map((entry, index) => ({ ...entry, id: `e${index}`, session: 's', seq: index + 1, at: 1000 + index, v: 1 }));
    const { runs, upTo } = deriveSpans(entries);
    assert.equal(upTo, 5, '到 r1 的 ctx.run.ended 为止');
    assert.equal(runs.length, 1);
    const [run] = runs;
    assert.equal(run?.error, 'model exploded');
    assert.equal(run?.children[0]?.name, 'chat m-1');
    assert.equal(run?.children[0]?.children[0]?.error, 'No result was recorded for this tool call.');
    assert.equal(run?.start, 1000);
    assert.equal(run?.end, 1004);
  });
});
