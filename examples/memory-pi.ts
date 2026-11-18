// 记忆接进自己管上下文的 harness：pi 跑循环、自己存对话，记忆照样从 ctx 的日志里学，也照样交回给它。
//
//   node examples/memory-pi.ts
//
// 和 `memory.ts` 一样白天 `gate`、夜里 `consolidate`，读的是适配器实时写下的会话日志（trace 那条约定）。回到 pi 有两条路：
// `memory.source()` 作为适配器的上下文来源，每轮记下输入之后召回，画像和相关的事实接在系统提示后面（不进 pi 自己的会话）；
// `recall` 工具经 MCP 交给 pi，模型自己查，调用回到记忆这个执行环境（execute 那条约定）。
//
// 要装 pi（见 `pi.ts`），没装就跳过。模型是本机的假 Anthropic 接口，提取用剧本，不联网。
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createMemoryStore as createSessionStore } from '@modelctx-ai/ctx';
import { createMemory, createMemoryStore } from '@modelctx-ai/ctx-memory';
import { createPiHarness } from '@modelctx-ai/ctx-pi';
import { createFakeAnthropicApi, FAKE_MODEL } from '@modelctx-ai/ctx-pi/testing';
import { createScriptedExtractionModel } from '@modelctx-ai/ctx-protocol/testing';

import { isMain, type Log } from './model.ts';
import { piInstalled } from './pi.ts';

const command = process.env.CTX_PI_COMMAND ?? 'pi';

export interface MemoryPiExample {
  /** 门控记下的笔记、巩固新增的事实各几条。 */
  readonly notes: number;
  readonly facts: number;
  /** 第二个会话交给 pi 的系统提示里有没有记忆。 */
  readonly injected: boolean;
  /** `recall` 工具结果条目的 `source`：执行它的执行环境。 */
  readonly recallSource: string | undefined;
  /** `recall` 查到的事实回到了模型（下一次请求里有）。 */
  readonly recalled: boolean;
  readonly answer: string;
}

export async function main(log: Log = console.log): Promise<MemoryPiExample | undefined> {
  if (!piInstalled()) {
    log(`没装 pi（${command} --version 跑不了），跳过。`);
    return undefined;
  }
  const root = mkdtempSync(path.join(tmpdir(), 'ctx-example-memory-pi-'));
  const sessions = createSessionStore();
  const memory = createMemory({
    store: createMemoryStore(),
    scope: 'user:42',
    sessions,
    extraction: createScriptedExtractionModel({
      values: { facts: ['主人对花生过敏'], decisions: null, since: null, lesson: null },
    }),
    topics: { user: '主人的偏好和习惯' },
    gate: { theta: 0.5, auto: false },
  });

  const api = await createFakeAnthropicApi({
    tool: 'recall',
    script: [
      { type: 'text', text: '记下了，以后推荐吃的都避开花生。' },
      { type: 'tool-call', id: 'toolu_1', input: { query: '过敏 忌口' } },
      { type: 'text', text: '推荐番茄炒蛋：不放花生，也没有别的坚果。' },
    ],
  });
  // pi 的代理目录（模型的配置在 `models.json`）、家目录、会话都是临时的，子进程只拿到这几个环境变量。
  const agentDir = path.join(root, 'agent');
  const cwd = path.join(root, 'work');
  mkdirSync(agentDir);
  mkdirSync(cwd);
  writeFileSync(path.join(agentDir, 'models.json'), JSON.stringify(api.models));

  const harness = createPiHarness({
    store: sessions,
    // 记忆是一个执行环境：它的 `recall` 工具经 MCP 交给 pi。
    executors: [memory],
    // 记忆也是一个上下文来源：适配器每轮记下输入之后收一次，接在系统提示后面。
    sources: [memory.source({ k: 5 })],
    command,
    cwd,
    sessionDir: path.join(root, 'sessions'),
    bare: true,
    env: {
      PATH: process.env.PATH,
      HOME: path.join(root, 'home'),
      TMPDIR: root,
      PI_CODING_AGENT_DIR: agentDir,
      PI_OFFLINE: '1',
      PI_SKIP_VERSION_CHECK: '1',
      PI_TELEMETRY: '0',
      NO_PROXY: '127.0.0.1,localhost',
    },
  });
  const agent = { model: FAKE_MODEL, instructions: '你是生活助手，回答一两句话。', maxSteps: 3 };

  // 周一：主人说了一件该记住的事。pi 跑这一轮，适配器把每一步写进 ctx 的会话日志。
  const monday = await harness.run({
    session: 'chat:monday',
    agent,
    input: '记住：我对花生过敏，以后推荐吃的都要避开',
  });
  log(`周一 → ${monday.stopReason}：${monday.text}`);

  // 记忆只读日志，不管这一轮是谁跑的。
  const notes = await memory.gate('chat:monday');
  const report = await memory.consolidate();
  log(`门控记下 ${notes.length} 条笔记；巩固新增 ${report.facts.added} 条事实`);

  // 周五：另一个 ctx 会话，pi 那边也是新会话，它自己的记录里没有周一说的话。
  const friday = await harness.run({ session: 'chat:friday', agent, input: '晚饭推荐个菜' });
  log(`周五 → ${friday.stopReason}：${friday.text}`);
  const injected = (api.requests[1]?.system ?? '').includes('主人对花生过敏');
  log(`交给 pi 的系统提示里${injected ? '带着' : '没有'}记忆`);
  const recallSource = (await sessions.list('chat:friday')).find(
    (entry) => entry.type === 'message' && entry.message.role === 'tool',
  )?.source;
  const recalled = JSON.stringify(api.requests[2]?.messages ?? []).includes('主人对花生过敏');
  log(`recall 工具由 ${recallSource ?? '（没调）'} 执行，查到的${recalled ? '回到了' : '没回到'}模型`);

  await api.close();
  return { notes: notes.length, facts: report.facts.added, injected, recallSource, recalled, answer: friday.text };
}

if (isMain(import.meta.url)) await main();
