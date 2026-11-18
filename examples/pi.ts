// 外部 harness：pi 自己跑循环，ctx 的工具经 MCP 交给它，它的每一步实时写进 ctx 的会话日志。
//
//   node examples/pi.ts
//
// 要装 pi（`npm install --global @earendil-works/pi-coding-agent`，`pi` 在 PATH 上，或 CTX_PI_COMMAND 指过去），没装就
// 跳过。缺省模型是本机的假 Anthropic 接口（`@modelctx-ai/ctx-pi/testing`），pi 的代理目录、家目录和会话放在临时目录，不读
// 本机的设置和凭证。用真的模型，走本机 pi 自己的配置和登录：
//
//   CTX_EXAMPLE_PI_MODEL=anthropic/claude-sonnet-4-5 node examples/pi.ts
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createOrchestrator, createToolRegistry } from '@modelctx-ai/ctx';
import { createPiHarness } from '@modelctx-ai/ctx-pi';
import { createFakeAnthropicApi, FAKE_MODEL } from '@modelctx-ai/ctx-pi/testing';
import { CTX_EVENTS, type Entry, type HarnessInfo } from '@modelctx-ai/ctx-protocol';
import { createSqliteStore } from '@modelctx-ai/ctx-sqlite';
import { tool } from 'ai';
import { z } from 'zod';

import { isMain, type Log } from './model.ts';

const command = process.env.CTX_PI_COMMAND ?? 'pi';

/** 装没装 pi：`pi --version` 跑得通。子进程只拿到这几个环境变量，家目录和代理目录是临时的。 */
export function piInstalled(): boolean {
  const home = mkdtempSync(path.join(tmpdir(), 'ctx-example-pi-version-'));
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    PI_CODING_AGENT_DIR: path.join(home, 'agent'),
    PI_OFFLINE: '1',
    PI_SKIP_VERSION_CHECK: '1',
    PI_TELEMETRY: '0',
  };
  try {
    execFileSync(command, ['--version'], { stdio: 'ignore', timeout: 30_000, env, cwd: home });
    return true;
  } catch {
    return false;
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

const WEATHER: Record<string, string> = { 台北: '晴，26℃，傍晚有阵雨', 高雄: '晴，31℃' };

export interface PiExample {
  /** 两轮的回答。 */
  readonly answers: readonly string[];
  /** 两轮的 `ctx.run.started` 记下的 pi 会话：第二轮续接第一轮的。 */
  readonly sessions: readonly (string | undefined)[];
  /** 工具结果条目的 `source`：执行这个工具的执行环境。 */
  readonly toolSources: readonly (string | undefined)[];
}

export async function main(log: Log = console.log): Promise<PiExample | undefined> {
  if (!piInstalled()) {
    log(`没装 pi（${command} --version 跑不了），跳过。`);
    return undefined;
  }
  const root = mkdtempSync(path.join(tmpdir(), 'ctx-example-pi-'));
  const store = createSqliteStore({ path: path.join(root, 'ctx.db') });

  // ctx 的工具：经 MCP 交给 pi，调用回到注册表自带的函数执行环境。pi 自带的工具（`read`、`bash`）要在 `builtinTools`
  // 里列出来才交出去，这里一个都不交。
  const tools = createToolRegistry().addTool(
    'weather',
    tool({
      description: '查一个城市今天的天气',
      inputSchema: z.object({ city: z.string() }),
      execute: async ({ city }) => `${city}：${WEATHER[city] ?? '没有数据'}`,
    }),
  );

  const real = process.env.CTX_EXAMPLE_PI_MODEL;
  const api = real
    ? undefined
    : await createFakeAnthropicApi({
        tool: 'weather',
        script: [
          { type: 'tool-call', id: 'toolu_1', input: { city: '台北' } },
          { type: 'text', text: '台北今天晴，26℃，傍晚有阵雨，带把伞。' },
          { type: 'tool-call', id: 'toolu_2', input: { city: '高雄' } },
          { type: 'text', text: '高雄晴，31℃，不用带伞。' },
        ],
      });
  // 它按工作目录存会话：同一个 ctx 会话的各轮要用同一个。
  const cwd = path.join(root, 'work');
  mkdirSync(cwd);
  let env: Record<string, string | undefined> | undefined;
  if (api) {
    // 假接口：pi 的代理目录（模型的配置在 `models.json`）、家目录都是临时的，子进程只拿到这几个环境变量。
    const agentDir = path.join(root, 'agent');
    mkdirSync(agentDir);
    writeFileSync(path.join(agentDir, 'models.json'), JSON.stringify(api.models));
    env = {
      PATH: process.env.PATH,
      HOME: path.join(root, 'home'),
      TMPDIR: root,
      PI_CODING_AGENT_DIR: agentDir,
      PI_OFFLINE: '1',
      PI_SKIP_VERSION_CHECK: '1',
      PI_TELEMETRY: '0',
      NO_PROXY: '127.0.0.1,localhost',
    };
  }

  const harness = createPiHarness({
    store,
    tools,
    command,
    cwd,
    sessionDir: path.join(root, 'sessions'),
    ...(env ? { bare: true, env } : {}),
  });
  // 它是一个 `Harness`：编排器照常排队、记 `owner`、`recover`。
  const orchestrator = createOrchestrator({ harness, store, owner: 'pi-example' });
  const agent = { model: real ?? FAKE_MODEL, instructions: '你是生活助手，回答一两句话。', maxSteps: 4 };

  const answers: string[] = [];
  for (const input of ['台北下午要带伞吗？', '那高雄呢？']) {
    const handle = await orchestrator.submit({ session: 'user:42', agent, input });
    const result = await handle.done;
    log(`${input} → ${result.stopReason}：${result.text}`);
    answers.push(result.text);
  }

  // 日志里两轮各有开始和结束，开始记着 pi 的会话；工具结果的 `source` 是执行它的执行环境。
  const entries = await store.list('user:42');
  for (const entry of entries) log(`${entry.seq}\t${describe(entry)}`);
  const sessions = entries
    .filter((entry) => entry.type === 'event' && entry.kind === CTX_EVENTS.runStarted)
    .map((entry) => harnessOf(entry)?.session);
  const toolSources = entries
    .filter((entry) => entry.type === 'message' && entry.message.role === 'tool')
    .map((entry) => entry.source);

  await orchestrator.close();
  await api?.close();
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
