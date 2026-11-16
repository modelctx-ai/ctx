import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createContextBuilder,
  createHarness,
  createOrchestrator,
  createToolRegistry,
  CTX_EVENTS,
  tool,
  type SessionStore,
} from '@modelctx-ai/ctx';
import {
  createScriptedModel,
  describeHarnessContract,
  describeOrchestratorContract,
  type ModelScript,
} from '@modelctx-ai/ctx/testing';
import { describe, test } from 'vite-plus/test';
import { z } from 'zod';

import { createSqliteStore } from './index.ts';

const api = { describe, test };

/** 工具结果的上限调小：契约按它查截断，也让超长结果的用例轻一些。 */
const maxToolOutputChars = 2_000;

/** SQLite 存储 + 回显工具 + 按剧本回答的模型。 */
function fixture({ script }: ModelScript) {
  const store = createSqliteStore({ path: ':memory:' });
  const tools = createToolRegistry();
  tools.executor.register(
    {
      name: 'echo',
      description: '原样返回输入',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
    },
    (input) => ({ type: 'json', value: input }),
  );
  tools.add(tools.executor.definition('echo')!);
  const harness = createHarness({ store, context: createContextBuilder({ store }), tools, maxToolOutputChars });
  return { store, harness, agent: { model: createScriptedModel(script) } };
}

describeHarnessContract('sqlite（核心包 harness）', fixture, api, { maxToolOutputChars });

describeOrchestratorContract(
  'sqlite（核心包编排器）',
  (setup) => {
    const { store, harness, agent } = fixture(setup);
    return { store, agent, orchestrator: createOrchestrator({ harness, store }) };
  },
  api,
);

/** 第 `n` 步的工具；`hangAt` 那一步不返回，模拟进程在工具执行时崩掉。 */
function steps(hangAt?: number) {
  const executed: number[] = [];
  const tools = createToolRegistry().addTool(
    'step',
    tool({
      description: '做一步',
      inputSchema: z.object({ n: z.number() }),
      execute: async ({ n }) => {
        executed.push(n);
        if (n === hangAt) return new Promise<never>(() => {});
        return `第${n}步完成`;
      },
    }),
  );
  return { tools, executed };
}

function harnessOn(store: SessionStore, hangAt?: number) {
  const { tools, executed } = steps(hangAt);
  return { harness: createHarness({ store, context: createContextBuilder({ store }), tools }), executed };
}

describe('sqlite：崩溃后从日志续跑', () => {
  test('两个连接共用一个库：第二次工具执行时第一个没了，第二个 recover 续跑到 end_turn，第一次的工具不重复执行', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'ctx-resume-')), 'ctx.db');
    const before = createSqliteStore({ path });
    const crashed = harnessOn(before, 2);
    void crashed.harness.run({
      session: 's',
      agent: {
        model: createScriptedModel(
          [
            { type: 'tool-call', id: 'c1', input: { n: 1 } },
            { type: 'tool-call', id: 'c2', input: { n: 2 } },
          ],
          { tool: 'step' },
        ),
      },
      input: '做两步',
    });
    for (let i = 0; i < 200 && crashed.executed.length < 2; i += 1) await new Promise((r) => setTimeout(r, 5));
    assert.deepEqual(crashed.executed, [1, 2]);

    const after = createSqliteStore({ path });
    const restarted = harnessOn(after);
    const model = createScriptedModel([{ type: 'text', text: '第二步结果未知' }], { tool: 'step' });
    const orchestrator = createOrchestrator({ harness: restarted.harness, store: after, resume: () => ({ model }) });
    const [recovered] = await orchestrator.recover!();
    assert.equal(typeof recovered?.resumed, 'string');
    await orchestrator.close();

    const roles = (await after.list('s')).map((entry) =>
      entry.type === 'message' ? entry.message.role : entry.type === 'event' ? entry.kind : entry.type,
    );
    assert.deepEqual(roles, [
      CTX_EVENTS.runStarted,
      'user',
      'assistant',
      'tool',
      'assistant',
      'tool',
      CTX_EVENTS.runEnded,
      CTX_EVENTS.runStarted,
      'assistant',
      CTX_EVENTS.runEnded,
    ]);
    assert.deepEqual(restarted.executed, []);
    assert.match(JSON.stringify(model.doGenerateCalls[0]!.prompt), /第1步完成/);
    after.close();
  });
});
