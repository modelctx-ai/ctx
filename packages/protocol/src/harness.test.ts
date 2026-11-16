import assert from 'node:assert/strict';

import { MockLanguageModelV4 } from 'ai/test';
import { describe, test } from 'vite-plus/test';

import { agentSpecToJson, modelName, pendingToolCalls, REDACTED_HEADER, toolResultEntry } from './harness.ts';
import { CTX_EVENTS, eventEntry, messageEntry, type Entry, type NewEntry } from './session.ts';

describe('agent spec', () => {
  test('模型对象记成 provider/modelId，名字原样', () => {
    assert.equal(modelName('anthropic/claude-sonnet-5'), 'anthropic/claude-sonnet-5');
    assert.equal(modelName(new MockLanguageModelV4({ provider: 'mock', modelId: 'm1' })), 'mock/m1');
  });

  test('settings.headers 只留名字，值不进日志', () => {
    const json = agentSpecToJson({
      model: 'm',
      settings: { temperature: 0, headers: { authorization: 'Bearer sk-secret', 'x-org': 'acme' } },
    });
    assert.deepEqual(json, {
      model: 'm',
      settings: { temperature: 0, headers: { authorization: REDACTED_HEADER, 'x-org': REDACTED_HEADER } },
    });
    assert.ok(!JSON.stringify(json).includes('sk-secret'));
  });

  test('可序列化部分只带给了的字段', () => {
    const json = agentSpecToJson({
      name: 'pet',
      model: new MockLanguageModelV4({ provider: 'mock', modelId: 'm1' }),
      tools: { tags: ['read'] },
      settings: { temperature: 0.2, stopSequences: ['\n\n'] },
    });
    assert.deepEqual(json, {
      model: 'mock/m1',
      name: 'pet',
      tools: { tags: ['read'] },
      settings: { temperature: 0.2, stopSequences: ['\n\n'] },
    });
    assert.deepEqual(JSON.parse(JSON.stringify(json)), json);
  });
});

/** 给新条目补上存储会填的字段。 */
function stored(entries: readonly NewEntry[]): Entry[] {
  return entries.map((entry, index) => ({ ...entry, id: `e${index}`, session: 's', seq: index + 1, at: index, v: 1 }));
}

const started = (runId: string) => eventEntry(CTX_EVENTS.runStarted, { data: { runId, agent: { model: 'm' } } });
const ended = (runId: string, stopReason: string) => eventEntry(CTX_EVENTS.runEnded, { data: { runId, stopReason } });
const calls = (...ids: string[]) =>
  messageEntry({
    role: 'assistant',
    content: ids.map((id) => ({ type: 'tool-call' as const, id, name: 'lookup', input: { id } })),
  });

describe('pendingToolCalls', () => {
  test('以 requires_action 结束的一轮留下的调用，去掉已经有结果的', () => {
    const log = stored([
      started('r1'),
      calls('a', 'b'),
      ended('r1', 'requires_action'),
      toolResultEntry({ id: 'a', name: 'lookup' }, { type: 'text', text: '好' }),
    ]);
    assert.deepEqual(pendingToolCalls(log), [
      { call: { id: 'b', name: 'lookup', input: { id: 'b' } }, runId: 'r1', seq: 2 },
    ]);
  });

  test('之后又有一轮以别的原因结束：之前等着的作废；没停下等的运行留下的悬空调用不算', () => {
    assert.deepEqual(
      pendingToolCalls(
        stored([started('r1'), calls('a'), ended('r1', 'requires_action'), started('r2'), ended('r2', 'end_turn')]),
      ),
      [],
    );
    assert.deepEqual(pendingToolCalls(stored([started('r1'), calls('a'), ended('r1', 'error')])), []);
    assert.deepEqual(pendingToolCalls(stored([started('r1'), calls('a')])), [], '还在跑的不算');
  });

  test('toolResultEntry 带幂等键', () => {
    assert.equal(toolResultEntry({ id: 'a', name: 'lookup' }, { type: 'text', text: '好' }).key, 'ctx.tool-result:a');
  });
});
