import assert from 'node:assert/strict';

import { CTX_EVENTS, toolApprovalEntry, type AgentSpec, type JsonObject } from '@modelctx-ai/ctx-protocol';
import { describe, test } from 'vite-plus/test';

import { createContextBuilder } from './builder.ts';
import { createHarness } from './harness.ts';
import { createMemoryStore } from './store.ts';
import { createScriptedModel } from './testing.ts';
import { createToolRegistry } from './tools.ts';

function setup() {
  const store = createMemoryStore();
  const tools = createToolRegistry();
  const executed: unknown[] = [];
  tools.executor.register({ name: 'echo', description: '原样返回', inputSchema: { type: 'object' } }, (input) => {
    executed.push(input);
    return { type: 'json', value: input };
  });
  tools.add(tools.executor.definition('echo')!);
  return { store, tools, executed, harness: createHarness({ store, context: createContextBuilder({ store }), tools }) };
}

const toolThenText = (text: string) =>
  createScriptedModel([
    { type: 'tool-call', id: 'c1', input: { text: 'hi' } },
    { type: 'text', text },
  ]);

const weather: JsonObject = {
  type: 'object',
  properties: { city: { type: 'string' }, rain: { type: 'boolean' } },
  required: ['city', 'rain'],
};

describe('AgentSpec：结构化输出', () => {
  test('最后的回答按 schema 解析进 RunResult.output，模型收到 JSON 格式的要求', async () => {
    const { harness } = setup();
    const model = createScriptedModel([{ type: 'text', text: '{"city":"台北","rain":true}' }]);
    const result = await harness.run({
      session: 's',
      agent: { model, output: { schema: weather, name: 'weather' } },
      input: '台北下雨吗？',
    });
    assert.equal(result.stopReason, 'end_turn');
    assert.deepEqual(result.output, { city: '台北', rain: true });
    assert.equal(model.doGenerateCalls[0]!.responseFormat?.type, 'json');
  });

  test('回答不是合 schema 的 JSON：以 error 结束，error.type 是 invalid_output', async () => {
    const { harness, store } = setup();
    for (const text of ['会下雨', '{"city":"台北"}']) {
      const result = await harness.run({
        session: 's',
        agent: { model: createScriptedModel([{ type: 'text', text }]), output: { schema: weather } },
        input: '台北下雨吗？',
      });
      assert.equal(result.stopReason, 'error');
      assert.equal(result.error?.type, 'invalid_output');
      assert.equal(result.output, undefined);
    }
    const last = (await store.list('s')).at(-1);
    assert.equal(last?.type === 'event' && last.kind, CTX_EVENTS.runEnded);
  });
});

describe('AgentSpec：工具选择', () => {
  test("toolChoice 交给模型：'none'、{ tool }；点名的工具不在这一轮的工具里时 invalid_request", async () => {
    const { harness } = setup();
    const none = createScriptedModel([{ type: 'text', text: '好' }]);
    await harness.run({ session: 'a', agent: { model: none, toolChoice: 'none' }, input: '在吗' });
    assert.deepEqual(none.doGenerateCalls[0]!.toolChoice, { type: 'none' });
    const forced = toolThenText('好了');
    await harness.run({ session: 'b', agent: { model: forced, toolChoice: { tool: 'echo' } }, input: '回显' });
    assert.deepEqual(forced.doGenerateCalls[0]!.toolChoice, { type: 'tool', toolName: 'echo' });
    const missing = await harness.run({
      session: 'c',
      agent: { model: createScriptedModel([]), toolChoice: { tool: 'nope' } },
      input: '在吗',
    });
    assert.equal(missing.stopReason, 'error');
    assert.equal(missing.error?.type, 'invalid_request');
  });
});

describe('AgentSpec：权限', () => {
  test('deny：不执行，模型看到拒绝，这一轮继续', async () => {
    const { harness, executed } = setup();
    const model = toolThenText('被拒了');
    const result = await harness.run({
      session: 's',
      agent: { model, permissions: { tools: { echo: 'deny' } } },
      input: '回显',
    });
    assert.equal(result.stopReason, 'end_turn');
    assert.deepEqual(executed, []);
    assert.match(JSON.stringify(model.doGenerateCalls[1]!.prompt), /denied by the agent's permissions/);
  });

  test('ask：写下调用和确认请求后以 requires_action 停下；确认了，下一轮先执行再接着走', async () => {
    const { harness, store, executed } = setup();
    const model = toolThenText('回显好了');
    const agent: AgentSpec = { model, permissions: { default: 'ask' } };
    const first = await harness.run({ session: 's', agent, input: '回显' });
    assert.equal(first.stopReason, 'requires_action');
    assert.deepEqual(
      first.pending?.map((call) => call.name),
      ['echo'],
    );
    assert.deepEqual(
      first.approvals?.map((approval) => approval.callId),
      ['c1'],
    );
    assert.deepEqual(executed, []);
    await store.append('s', [toolApprovalEntry(first.approvals[0]!.approvalId, { approved: true })]);
    const second = await harness.run({ session: 's', agent });
    assert.deepEqual(executed, [{ text: 'hi' }]);
    assert.equal(second.stopReason, 'end_turn');
    assert.equal(second.text, '回显好了');
  });

  test('不认识的权限值是 invalid_request', async () => {
    const { harness } = setup();
    const result = await harness.run({
      session: 's',
      agent: { model: createScriptedModel([]), permissions: { tools: { echo: 'maybe' as never } } },
      input: '在吗',
    });
    assert.equal(result.error?.type, 'invalid_request');
  });
});

describe('AgentSpec：预算和版本', () => {
  test('maxTotalTokens 用完：在步骤之间停下，stopReason 是 max_budget', async () => {
    const { harness, executed } = setup();
    const model = toolThenText('不该走到这');
    const result = await harness.run({
      session: 's',
      agent: { model, budget: { maxTotalTokens: 1 } },
      input: '回显',
    });
    assert.equal(result.stopReason, 'max_budget');
    assert.equal(executed.length, 1, '这一步的工具照常执行完');
    assert.equal(model.doGenerateCalls.length, 1, '没有下一步');
  });

  test('预算不是正数是 invalid_request', async () => {
    const { harness } = setup();
    const result = await harness.run({
      session: 's',
      agent: { model: createScriptedModel([]), budget: { maxDurationMs: -1 } },
      input: '在吗',
    });
    assert.equal(result.error?.type, 'invalid_request');
  });

  test('version 和其余新字段原样记进 ctx.run.started', async () => {
    const { harness, store } = setup();
    await harness.run({
      session: 's',
      agent: {
        model: createScriptedModel([{ type: 'text', text: '好' }]),
        version: 'support@3',
        budget: { maxDurationMs: 60_000 },
        permissions: { tools: { echo: 'ask' } },
      },
      input: '在吗',
    });
    const started = (await store.list('s'))[0];
    const agent = started?.type === 'event' ? (started.data as { agent?: Record<string, unknown> }).agent : undefined;
    assert.equal(agent?.['version'], 'support@3');
    assert.deepEqual(agent?.['budget'], { maxDurationMs: 60_000 });
    assert.deepEqual(agent?.['permissions'], { tools: { echo: 'ask' } });
  });
});
