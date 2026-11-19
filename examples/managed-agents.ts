// 外部 harness：Claude Managed Agents 在 Anthropic 那边跑循环，ctx 的工具作为自定义工具交给它，它的事件流实时写进
// ctx 的会话日志。
//
//   node examples/managed-agents.ts
//
// 缺省对着本机的假 Managed Agents 接口（`@modelctx-ai/ctx-managed-agents/testing`）跑，客户端用假密钥、只连本机。
// 用真的服务：事先建好 agent 和执行环境，给它们的 id 和这次用的模型，密钥取 ANTHROPIC_API_KEY（没有对真实服务验证）：
//
//   CTX_EXAMPLE_MA_AGENT=agent_… CTX_EXAMPLE_MA_ENVIRONMENT=env_… CTX_EXAMPLE_MA_MODEL=… node examples/managed-agents.ts
import path from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

import Anthropic from '@anthropic-ai/sdk';
import { createOrchestrator, createToolRegistry } from '@modelctx-ai/ctx';
import { createManagedAgentsHarness } from '@modelctx-ai/ctx-managed-agents';
import { createFakeManagedAgents } from '@modelctx-ai/ctx-managed-agents/testing';
import { CTX_EVENTS, type Entry, type HarnessInfo } from '@modelctx-ai/ctx-protocol';
import { createSqliteStore } from '@modelctx-ai/ctx-sqlite';
import { tool } from 'ai';
import { z } from 'zod';

import { isMain, type Log } from './model.ts';

const WEATHER: Record<string, string> = { 台北: '晴，26℃，傍晚有阵雨', 高雄: '晴，31℃' };

export interface ManagedAgentsExample {
  /** 两轮的回答。 */
  readonly answers: readonly string[];
  /** 两轮的 `ctx.run.started` 记下的 Managed Agents 会话：第二轮续接第一轮的。 */
  readonly sessions: readonly (string | undefined)[];
  /** 工具结果条目的 `source`：执行这个工具的执行环境。 */
  readonly toolSources: readonly (string | undefined)[];
}

export async function main(log: Log = console.log): Promise<ManagedAgentsExample> {
  const root = mkdtempSync(path.join(tmpdir(), 'ctx-example-managed-agents-'));
  const store = createSqliteStore({ path: path.join(root, 'ctx.db') });

  // ctx 的工具：作为自定义工具交给 Managed Agents，调用回到注册表自带的函数执行环境。它容器里的内置工具要在
  // `builtinTools` 里列出来才交出去，这里一个都不交。
  const tools = createToolRegistry().addTool(
    'weather',
    tool({
      description: '查一个城市今天的天气',
      inputSchema: z.object({ city: z.string() }),
      execute: async ({ city }) => `${city}：${WEATHER[city] ?? '没有数据'}`,
    }),
  );

  const {
    CTX_EXAMPLE_MA_AGENT: agentId,
    CTX_EXAMPLE_MA_ENVIRONMENT: environmentId,
    CTX_EXAMPLE_MA_MODEL: model,
  } = process.env;
  const real = agentId && environmentId && model ? { agentId, environmentId, model } : undefined;
  const fake = real
    ? undefined
    : await createFakeManagedAgents({
        tool: 'weather',
        script: [
          { type: 'tool-call', id: 'sevt_tool_1', input: { city: '台北' } },
          { type: 'text', text: '台北今天晴，26℃，傍晚有阵雨，带把伞。' },
          { type: 'tool-call', id: 'sevt_tool_2', input: { city: '高雄' } },
          { type: 'text', text: '高雄晴，31℃，不用带伞。' },
        ],
      });
  // 假接口：密钥是假的、只连本机。真的服务：密钥取 ANTHROPIC_API_KEY。
  const client = fake
    ? new Anthropic({ apiKey: 'sk-ant-example-not-a-real-key', baseURL: fake.url, maxRetries: 0 })
    : new Anthropic();

  const harness = createManagedAgentsHarness({
    store,
    client,
    agent: real?.agentId ?? 'agent_example',
    environmentId: real?.environmentId ?? 'env_example',
    tools,
  });
  // 它是一个 `Harness`：编排器照常排队、记 `owner`、`recover`。
  const orchestrator = createOrchestrator({ harness, store, owner: 'managed-agents-example' });
  const agent = { model: real?.model ?? 'claude-example', instructions: '你是生活助手，回答一两句话。', maxSteps: 4 };

  const answers: string[] = [];
  for (const input of ['台北下午要带伞吗？', '那高雄呢？']) {
    const handle = await orchestrator.submit({ session: 'user:42', agent, input });
    const result = await handle.done;
    log(`${input} → ${result.stopReason}：${result.text}`);
    answers.push(result.text);
  }

  // 日志里两轮各有开始和结束，开始记着 Managed Agents 的会话；工具结果的 `source` 是执行它的执行环境。
  const entries = await store.list('user:42');
  for (const entry of entries) log(`${entry.seq}\t${describe(entry)}`);
  const sessions = entries
    .filter((entry) => entry.type === 'event' && entry.kind === CTX_EVENTS.runStarted)
    .map((entry) => harnessOf(entry)?.session);
  const toolSources = entries
    .filter((entry) => entry.type === 'message' && entry.message.role === 'tool')
    .map((entry) => entry.source);

  await orchestrator.close();
  await fake?.close();
  store.close();
  return { answers, sessions, toolSources };
}

function harnessOf(entry: Entry): HarnessInfo | undefined {
  if (entry.type !== 'event' || typeof entry.data !== 'object' || entry.data === null) return undefined;
  return (entry.data as { harness?: HarnessInfo }).harness;
}

function describe(entry: Entry): string {
  if (entry.type === 'event') {
    const harness = harnessOf(entry);
    return harness ? `${entry.kind}（${harness.name} ${harness.version ?? ''}，会话 ${harness.session}）` : entry.kind;
  }
  if (entry.type === 'summary') return 'summary';
  return entry.source ? `${entry.message.role}（${entry.source}）` : entry.message.role;
}

if (isMain(import.meta.url)) await main();
