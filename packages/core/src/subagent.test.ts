import assert from 'node:assert/strict';

import {
  addUsage,
  childRunOutput,
  childRunsOf,
  CTX_EVENTS,
  runStartedEntry,
  type Entry,
  type Harness,
  type RunRequest,
  type RunResult,
  type RunStartedData,
} from '@modelctx-ai/ctx-protocol';
import { MockLanguageModelV4 } from 'ai/test';
import { describe, test } from 'vite-plus/test';

import { createContextBuilder } from './builder.ts';
import { createHarness } from './harness.ts';
import { createOrchestrator, type InterruptedRun } from './orchestrator.ts';
import { createMemoryStore } from './store.ts';
import { createSubagentTool, type SubagentToolOptions } from './subagent.ts';
import { createScriptedModel } from './testing.ts';
import { createToolRegistry } from './tools.ts';

function started(entries: readonly Entry[]): RunStartedData | undefined {
  const entry = entries.find((item) => item.type === 'event' && item.kind === CTX_EVENTS.runStarted);
  return entry?.type === 'event' ? (entry.data as unknown as RunStartedData) : undefined;
}

function setup(subagent: Omit<SubagentToolOptions, 'name' | 'runner'> & { runner?: SubagentToolOptions['runner'] }) {
  const store = createMemoryStore();
  const tools = createToolRegistry();
  const harness = createHarness({ store, context: createContextBuilder({ store }), tools });
  const delegate = createSubagentTool({ name: 'delegate', runner: harness, store, ...subagent });
  tools.executor.register(delegate.definition, delegate.execute);
  tools.add(tools.executor.definition('delegate')!);
  return { store, harness };
}

const parentScript = (task: string, answer: string) =>
  createScriptedModel(
    [
      { type: 'tool-call', id: 'c1', input: { task } },
      { type: 'text', text: answer },
    ],
    { tool: 'delegate' },
  );

/** 卡住直到被取消的模型。 */
function hangingModel() {
  const entered = Promise.withResolvers<void>();
  const model = new MockLanguageModelV4({
    doGenerate: ({ abortSignal }) =>
      new Promise((_, reject) => {
        entered.resolve();
        abortSignal?.addEventListener('abort', () => reject(abortSignal.reason), { once: true });
      }),
  });
  return { model, entered: entered.promise };
}

describe('子 agent', () => {
  test('子会话的 ctx.run.started 带 parent；父会话的工具结果指向子会话，childRunsOf 找得到；用量可以往上加', async () => {
    const child = createScriptedModel([{ type: 'text', text: '查到了：三件' }]);
    const { store, harness } = setup({ agent: { model: child } });
    const parent = await harness.run({
      session: 'p',
      agent: { model: parentScript('数一下', '一共三件') },
      input: '有几件？',
    });
    assert.equal(parent.stopReason, 'end_turn');

    const runs = childRunsOf(await store.list('p'));
    assert.equal(runs.length, 1);
    const [run] = runs;
    assert.equal(run!.child.session, 'p/delegate/c1');
    assert.equal(run!.toolCallId, 'c1');
    assert.equal(run!.stopReason, 'end_turn');
    assert.equal(run!.text, '查到了：三件');

    const childLog = await store.list('p/delegate/c1');
    assert.deepEqual(started(childLog)?.parent, { session: 'p', runId: parent.runId, toolCallId: 'c1' });
    assert.equal(started(childLog)?.runId, run!.child.runId);
    assert.match(JSON.stringify(child.doGenerateCalls[0]!.prompt), /数一下/);

    const total = addUsage(parent.usage, ...runs.map((item) => item.usage));
    assert.equal(total.inputTokens, (parent.usage?.inputTokens ?? 0) + (run!.usage?.inputTokens ?? 0));
  });

  test("context: 'inherit'：子 agent 带着父会话到这次调用之前的投影，看不到那个没有结果的调用", async () => {
    const child = createScriptedModel([{ type: 'text', text: '好' }]);
    const { harness } = setup({ agent: { model: child }, context: 'inherit' });
    await harness.run({ session: 'p', agent: { model: parentScript('接着办', '办好了') }, input: '我叫阿青' });
    const prompt = JSON.stringify(child.doGenerateCalls[0]!.prompt);
    assert.match(prompt, /我叫阿青/);
    assert.match(prompt, /接着办/);
    assert.doesNotMatch(prompt, /delegate/);
  });

  test("context 缺省 'fresh'：子 agent 看不到父会话", async () => {
    const child = createScriptedModel([{ type: 'text', text: '好' }]);
    const { harness } = setup({ agent: { model: child } });
    await harness.run({ session: 'p', agent: { model: parentScript('接着办', '办好了') }, input: '我叫阿青' });
    assert.doesNotMatch(JSON.stringify(child.doGenerateCalls[0]!.prompt), /阿青/);
  });

  test('父运行取消，子运行跟着取消；子运行的结果仍然记在父会话里', async () => {
    const { model, entered } = hangingModel();
    const { store, harness } = setup({ agent: { model } });
    const controller = new AbortController();
    const running = harness.run({
      session: 'p',
      agent: { model: parentScript('慢慢来', '不会到这') },
      input: '开始',
      signal: controller.signal,
    });
    await entered;
    controller.abort();
    assert.equal((await running).stopReason, 'aborted');
    const childLog = await store.list('p/delegate/c1');
    const ended = childLog.find((entry) => entry.type === 'event' && entry.kind === CTX_EVENTS.runEnded);
    assert.equal(ended?.type === 'event' && (ended.data as { stopReason: string }).stopReason, 'aborted');
  });

  test('交给编排器：cancel 父运行时，以它为 parent 的运行一起取消', async () => {
    const gates: string[] = [];
    const gated: Harness = {
      run: (request: RunRequest) =>
        new Promise<RunResult>((resolve) => {
          gates.push(request.session);
          const base = { runId: request.runId!, text: '', messages: [], recorded: [] };
          request.signal?.addEventListener('abort', () => resolve({ ...base, stopReason: 'aborted' }), { once: true });
        }),
    };
    const orchestrator = createOrchestrator({ harness: gated });
    const parent = await orchestrator.submit({ session: 'p', agent: { model: 'fake' }, input: '开始' });
    const child = await orchestrator.submit({
      session: 'c',
      agent: { model: 'fake' },
      input: '子任务',
      parent: { session: 'p', runId: parent.runId, toolCallId: 'c1' },
    });
    const grandchild = await orchestrator.submit({
      session: 'g',
      agent: { model: 'fake' },
      input: '孙任务',
      parent: { session: 'c', runId: child.runId },
    });
    assert.equal(await orchestrator.cancel(parent.runId), true);
    assert.equal((await child.done).stopReason, 'aborted');
    assert.equal((await grandchild.done).stopReason, 'aborted');
    await orchestrator.close();
  });

  test('recover 把 parent 交给 resume', async () => {
    const store = createMemoryStore();
    const parent = { session: 'p', runId: 'r-parent', toolCallId: 'c1' };
    await store.append('c', [runStartedEntry({ runId: 'r-child', agent: { model: 'fake' }, parent })]);
    const seen: InterruptedRun[] = [];
    const orchestrator = createOrchestrator({
      harness: createHarness({ store, context: createContextBuilder({ store }) }),
      store,
      resume: (run) => {
        seen.push(run);
        return undefined;
      },
    });
    await orchestrator.recover!();
    assert.deepEqual(seen[0]?.parent, parent);
    await orchestrator.close();
  });

  test('parent 形状不对：invalid_request，不记进日志', async () => {
    const store = createMemoryStore();
    const harness = createHarness({ store, context: createContextBuilder({ store }) });
    const result = await harness.run({
      session: 's',
      agent: { model: createScriptedModel([]) },
      input: '在吗',
      parent: { session: 'p' } as never,
    });
    assert.equal(result.error?.type, 'invalid_request');
    assert.equal(started(await store.list('s'))?.parent, undefined);
  });

  test('childRunOutput：子运行出错是错误输出，data 里仍然指向子会话', () => {
    const output = childRunOutput(
      { session: 'c', runId: 'r' },
      { runId: 'r', text: '', stopReason: 'error', error: { message: '模型挂了', type: 'api_call' } },
    );
    assert.equal(output.type, 'error');
    assert.deepEqual(output.type === 'error' && output.data, {
      child: { session: 'c', runId: 'r' },
      stopReason: 'error',
      error: { message: '模型挂了', type: 'api_call' },
    });
  });
});
