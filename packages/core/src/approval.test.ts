import assert from 'node:assert/strict';

import {
  CTX_EVENTS,
  pendingToolCalls,
  TOOL_RESULT_KEY_PREFIX,
  toolApprovalEntry,
  type AgentSpec,
  type Entry,
  type Hooks,
  type RunEvent,
  type RunResult,
} from '@modelctx-ai/ctx-protocol';
import { describe, test } from 'vite-plus/test';

import { createContextBuilder } from './builder.ts';
import { createFunctionExecutor } from './executor.ts';
import { createHarness, type HarnessOptions } from './harness.ts';
import { runPendingTools } from './pending.ts';
import { createMemoryStore } from './store.ts';
import { createScriptedModel } from './testing.ts';
import { createToolRegistry } from './tools.ts';

function setup(options: Partial<HarnessOptions> = {}) {
  const store = createMemoryStore();
  const tools = createToolRegistry();
  const executed: unknown[] = [];
  tools.executor.register({ name: 'echo', description: '原样返回', inputSchema: { type: 'object' } }, (input) => {
    executed.push(input);
    return { type: 'json', value: input };
  });
  tools.add(tools.executor.definition('echo')!);
  const harness = createHarness({ store, context: createContextBuilder({ store }), tools, ...options });
  return { store, tools, executed, harness };
}

const script = () =>
  createScriptedModel([
    { type: 'tool-call', id: 'c1', input: { text: 'rm' } },
    { type: 'text', text: '好了' },
  ]);

const echoHi = (id: string) =>
  createScriptedModel([
    { type: 'tool-call', id, input: { text: 'hi' } },
    { type: 'text', text: '好' },
  ]);

function kinds(entries: readonly Entry[]): string[] {
  return entries.map((entry) =>
    entry.type === 'event' ? entry.kind : entry.type === 'message' ? entry.message.role : entry.type,
  );
}

function partsOf(entry: Entry | undefined): string[] {
  if (entry?.type !== 'message' || typeof entry.message.content === 'string') return [];
  return entry.message.content.map((part) => part.type);
}

async function collect(events: AsyncIterable<RunEvent>): Promise<RunEvent[]> {
  const out: RunEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

/** `beforeTool` 对 `rm` 回 `ask`，记下问过几次。 */
function asking() {
  const asked: string[] = [];
  const hooks: Hooks = {
    beforeTool: (call) => {
      asked.push(call.id);
      return JSON.stringify(call.input).includes('rm') ? { ask: true, reason: '会删文件' } : undefined;
    },
  };
  return { asked, hooks };
}

async function firstRun(harness: ReturnType<typeof setup>['harness'], agent: AgentSpec): Promise<RunResult> {
  const result = await harness.run({ session: 's', agent, input: '删掉' });
  assert.equal(result.stopReason, 'requires_action');
  return result;
}

describe('人工确认', () => {
  test('beforeTool 回 ask：不执行，确认请求和调用写在同一条助手消息里，以 requires_action 结束', async () => {
    const { asked, hooks } = asking();
    const { harness, store, executed } = setup({ hooks });
    const model = script();
    const result = await firstRun(harness, { model });
    assert.deepEqual(executed, []);
    assert.deepEqual(asked, ['c1']);
    assert.deepEqual(result.pending, [{ id: 'c1', name: 'echo', input: { text: 'rm' } }]);
    const [approval] = result.approvals ?? [];
    assert.equal(approval?.callId, 'c1');
    assert.equal(approval?.reason, '会删文件');

    const entries = await store.list('s');
    assert.deepEqual(kinds(entries), [CTX_EVENTS.runStarted, 'user', 'assistant', CTX_EVENTS.runEnded]);
    assert.deepEqual(partsOf(entries[2]), ['tool-call', 'tool-approval-request']);
    // 日志、RunResult.messages、pendingToolCalls 说的是同一个确认请求。
    const [pending] = pendingToolCalls(entries);
    assert.deepEqual(pending?.approval, { approvalId: approval.approvalId, reason: '会删文件' });
    assert.ok(JSON.stringify(result.messages).includes(approval.approvalId));
  });

  test('确认了：下一轮先执行（不再问 beforeTool），结果带幂等键，模型看到结果、看不到确认部件', async () => {
    const { asked, hooks } = asking();
    const { harness, store, executed } = setup({ hooks });
    const model = script();
    const first = await firstRun(harness, { model });
    await store.append('s', [toolApprovalEntry(first.approvals![0]!.approvalId, { approved: true })]);
    const second = await harness.run({ session: 's', agent: { model } });
    assert.equal(second.stopReason, 'end_turn');
    assert.equal(second.text, '好了');
    assert.deepEqual(executed, [{ text: 'rm' }]);
    assert.deepEqual(asked, ['c1']);
    assert.deepEqual(kinds(second.recorded), [CTX_EVENTS.runStarted, 'tool', 'assistant', CTX_EVENTS.runEnded]);
    assert.equal(second.recorded[1]?.key, `${TOOL_RESULT_KEY_PREFIX}c1`);
    const prompt = JSON.stringify(model.doGenerateCalls[1]!.prompt);
    assert.doesNotMatch(prompt, /tool-approval/);
    assert.match(prompt, /"text":"rm"/);
    assert.deepEqual(pendingToolCalls(await store.list('s')), []);
  });

  test('拒绝了：不执行，模型看到没被确认和原因', async () => {
    const { hooks } = asking();
    const { harness, store, executed } = setup({ hooks });
    const model = script();
    const first = await firstRun(harness, { model });
    await store.append('s', [toolApprovalEntry(first.approvals![0]!.approvalId, { approved: false, reason: '不行' })]);
    const second = await harness.run({ session: 's', agent: { model } });
    assert.equal(second.stopReason, 'end_turn');
    assert.deepEqual(executed, []);
    assert.match(JSON.stringify(model.doGenerateCalls[1]!.prompt), /was not approved: 不行/);
  });

  test('没决定就跑下一轮：不执行，模型看到缺结果；这一轮结束后它不再等待，迟到的确认不算数', async () => {
    const { hooks } = asking();
    const { harness, store, executed } = setup({ hooks });
    const model = createScriptedModel([
      { type: 'tool-call', id: 'c1', input: { text: 'rm' } },
      { type: 'text', text: '那就不删' },
      { type: 'text', text: '还是不删' },
    ]);
    const first = await firstRun(harness, { model });
    const second = await harness.run({ session: 's', agent: { model }, input: '算了' });
    assert.equal(second.text, '那就不删');
    assert.deepEqual(executed, []);
    assert.match(JSON.stringify(model.doGenerateCalls[1]!.prompt), /No result was recorded/);
    assert.deepEqual(pendingToolCalls(await store.list('s')), []);
    await store.append('s', [toolApprovalEntry(first.approvals![0]!.approvalId, { approved: true })]);
    await harness.run({ session: 's', agent: { model }, input: '嗯' });
    assert.deepEqual(executed, []);
  });

  test('确认的决定先于这一轮的输入落下：日志里结果在新输入之前', async () => {
    const { hooks } = asking();
    const { harness, store } = setup({ hooks });
    const model = script();
    const first = await firstRun(harness, { model });
    await store.append('s', [toolApprovalEntry(first.approvals![0]!.approvalId, { approved: true })]);
    const second = await harness.run({ session: 's', agent: { model }, input: '删完了吗' });
    assert.deepEqual(kinds(second.recorded), [CTX_EVENTS.runStarted, 'tool', 'user', 'assistant', CTX_EVENTS.runEnded]);
  });

  test('允许的调用：beforeTool 每次调用只问一次（非流式和流式）', async () => {
    const { asked, hooks } = asking();
    const { harness, executed } = setup({ hooks });
    await harness.run({ session: 'a', agent: { model: echoHi('a1') }, input: '回显' });
    await collect(harness.stream({ session: 'b', agent: { model: echoHi('b1') }, input: '回显' }));
    assert.deepEqual(asked, ['a1', 'b1']);
    assert.deepEqual(executed, [{ text: 'hi' }, { text: 'hi' }]);
  });

  test('流式：run.ended 带 approvals；确认了的调用在下一轮的 run.started 之后报 tool.returned', async () => {
    const { hooks } = asking();
    const { harness, store } = setup({ hooks });
    const model = script();
    const first = await collect(harness.stream({ session: 's', agent: { model }, input: '删掉' }));
    const ended = first.at(-1);
    assert.equal(ended?.type, 'run.ended');
    const approval = ended?.type === 'run.ended' ? ended.result.approvals?.[0] : undefined;
    assert.equal(approval?.callId, 'c1');
    assert.ok(!first.some((event) => event.type === 'tool.returned'));
    const entries = await store.list('s');
    assert.deepEqual(partsOf(entries[2]), ['tool-call', 'tool-approval-request']);

    await store.append('s', [toolApprovalEntry(approval.approvalId, { approved: true })]);
    const second = await collect(harness.stream({ session: 's', agent: { model } }));
    assert.deepEqual(
      second.slice(0, 3).map((event) => event.type),
      ['run.started', 'tool.returned', 'model.started'],
    );
    const returned = second[1];
    assert.equal(returned?.type === 'tool.returned' && returned.callId, 'c1');
  });

  test('确认了，但这一轮的权限是 deny：不执行，deny 优先', async () => {
    const { harness, store, executed } = setup();
    const model = script();
    const first = await firstRun(harness, { model, permissions: { default: 'ask' } });
    await store.append('s', [toolApprovalEntry(first.approvals![0]!.approvalId, { approved: true })]);
    const second = await harness.run({ session: 's', agent: { model, permissions: { default: 'deny' } } });
    assert.deepEqual(executed, []);
    assert.equal(second.stopReason, 'end_turn');
    assert.match(JSON.stringify(model.doGenerateCalls[1]!.prompt), /denied by the agent's permissions/);
  });

  test('runPendingTools 只执行确认了的调用；执行过的下一轮不再执行', async () => {
    const { harness, store, tools, executed } = setup();
    const model = script();
    const agent: AgentSpec = { model, permissions: { default: 'ask' } };
    const first = await firstRun(harness, agent);
    const before = await runPendingTools(store, 's', { executor: tools.executor });
    assert.deepEqual(before.executed, []);
    assert.equal(before.remaining[0]?.approval?.approvalId, first.approvals![0]!.approvalId);
    assert.deepEqual(executed, []);

    await store.append('s', [toolApprovalEntry(first.approvals![0]!.approvalId, { approved: true })]);
    const after = await runPendingTools(store, 's', { executor: tools.executor });
    assert.equal(after.executed.length, 1);
    const second = await harness.run({ session: 's', agent });
    assert.equal(second.stopReason, 'end_turn');
    assert.deepEqual(executed, [{ text: 'rm' }]);
  });

  test('runPendingTools 不碰被拒绝的调用：拒绝由下一轮的 harness 写上', async () => {
    const { harness, store, tools, executed } = setup();
    const model = script();
    const agent: AgentSpec = { model, permissions: { default: 'ask' } };
    const first = await firstRun(harness, agent);
    await store.append('s', [toolApprovalEntry(first.approvals![0]!.approvalId, { approved: false })]);
    const done = await runPendingTools(store, 's', { executor: tools.executor });
    assert.deepEqual(done.executed, []);
    assert.deepEqual(executed, []);
    await harness.run({ session: 's', agent });
    assert.match(JSON.stringify(model.doGenerateCalls[1]!.prompt), /was not approved\./);
  });

  test('ask 权限、绑到外部执行环境：确认了也留给执行方，harness 不执行', async () => {
    const store = createMemoryStore();
    const tools = createToolRegistry().add({
      name: 'lookup',
      inputSchema: { type: 'object' },
      executor: 'worker',
    });
    const harness = createHarness({ store, context: createContextBuilder({ store }), tools, external: ['worker'] });
    const worked: unknown[] = [];
    const worker = createFunctionExecutor('worker').register(
      { name: 'lookup', inputSchema: { type: 'object' } },
      (input) => {
        worked.push(input);
        return { type: 'text', text: '订单 42 已发货' };
      },
    );
    const model = createScriptedModel(
      [
        { type: 'tool-call', id: 'c1', input: { id: '42' } },
        { type: 'text', text: '发货了' },
      ],
      { tool: 'lookup' },
    );
    const agent: AgentSpec = { model, permissions: { default: 'ask' } };
    const first = await harness.run({ session: 's', agent, input: '订单 42 呢' });
    assert.equal(first.approvals?.[0]?.callId, 'c1');
    assert.deepEqual((await runPendingTools(store, 's', { executor: worker })).executed, []);
    await store.append('s', [toolApprovalEntry(first.approvals[0].approvalId, { approved: true })]);
    assert.equal((await runPendingTools(store, 's', { executor: worker })).executed.length, 1);
    assert.deepEqual(worked, [{ id: '42' }]);
    const second = await harness.run({ session: 's', agent });
    assert.equal(second.text, '发货了');
    assert.deepEqual(kinds(second.recorded), [CTX_EVENTS.runStarted, 'assistant', CTX_EVENTS.runEnded]);
  });

  test('不写日志的运行：等确认的调用照样不执行，结果里有 approvals', async () => {
    const { hooks } = asking();
    const { harness, store, executed } = setup({ hooks });
    const result = await harness.run({ session: 's', agent: { model: script() }, input: '删掉', record: false });
    assert.equal(result.stopReason, 'requires_action');
    assert.equal(result.approvals?.[0]?.callId, 'c1');
    assert.deepEqual(executed, []);
    assert.deepEqual(await store.list('s'), []);
  });
});
