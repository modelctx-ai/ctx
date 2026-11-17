// 外部 harness，换一种语言：pydantic-ai（Python）跑循环，会话日志和工具在 TypeScript 的 ctx-remote 里，
// 编排器经线上协议连它。三个角色各在一处：
//
//   ctx-remote（这个进程）        会话存储 + 执行环境 `local`
//   ctx-pydantic-ai serve（子进程）harness：历史从 ctx-remote 的日志来，每一步写回去，工具调用交给 `local`
//   编排器（这个进程）            createRemoteHarness 连 ctx-pydantic-ai
//
//   node examples/pydantic-ai.ts
//
// 要装 uv（`uv` 在 PATH 上），没装就跳过：它按 python/pydantic-ai/uv.lock 装好依赖再起服务。模型是 pydantic-ai 自带的
// `test` 模型：把给它的工具各调一次，再用 JSON 文字报结果，不联网、不要密钥。换真的模型照 python/pydantic-ai/README.md
// 起服务（`--model openai:gpt-5`，服务商的依赖和密钥照 pydantic-ai 的写法），没有对真实服务验证。
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

import { createFunctionExecutor, createMemoryStore, createOrchestrator } from '@modelctx-ai/ctx';
import { CTX_EVENTS, type Entry, type HarnessInfo } from '@modelctx-ai/ctx-protocol';
import { createRemoteHarness, createRemoteSessionStore } from '@modelctx-ai/ctx-remote';
import { startRemote } from '@modelctx-ai/ctx-remote/server';

import { isMain, type Log } from './model.ts';

const PROJECT = fileURLToPath(new URL('../python/pydantic-ai/', import.meta.url));

/** 装没装 uv：`uv --version` 跑得通。 */
export function uvInstalled(): boolean {
  try {
    execFileSync('uv', ['--version'], { stdio: 'ignore', timeout: 30_000 });
    return true;
  } catch {
    return false;
  }
}

/** 子进程只拿到找程序、装依赖要的环境变量（uv 自己的、代理和证书），没有别的凭证。 */
function childEnv(): NodeJS.ProcessEnv {
  const keep = /^(PATH|HOME|UV_.*|(HTTPS?|ALL|NO)_PROXY|(https?|all|no)_proxy|SSL_CERT_FILE)$/;
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => keep.test(name)));
  return { ...env, PYDANTIC_AI_NO_BANNER: '1' };
}

/** 起 `ctx-pydantic-ai serve`，等它打印出地址。 */
async function serve(remote: string, token: string): Promise<{ url: string; child: ChildProcess }> {
  const child = spawn(
    'uv',
    [
      'run',
      '--project',
      PROJECT,
      '--locked',
      '--quiet',
      'ctx-pydantic-ai',
      'serve',
      '--remote',
      remote,
      '--executor',
      'local',
      '--model',
      'test',
      '--port',
      '0',
    ],
    { env: { ...childEnv(), CTX_REMOTE_TOKEN: token }, stdio: ['ignore', 'pipe', 'inherit'] },
  );
  const lines = createInterface({ input: child.stdout });
  for await (const line of lines) {
    const url = /listening on (\S+)/.exec(line)?.[1];
    if (url) return { url, child };
  }
  throw new Error(`ctx-pydantic-ai exited (${child.exitCode}) before it listened`);
}

export interface PydanticAIExample {
  readonly answers: readonly string[];
  /** 每一轮 `ctx.run.started` 记下的 harness。 */
  readonly harnesses: readonly (string | undefined)[];
  /** 工具结果条目的 `source`：执行这个工具的执行环境。 */
  readonly toolSources: readonly (string | undefined)[];
}

export async function main(log: Log = console.log): Promise<PydanticAIExample | undefined> {
  if (!uvInstalled()) {
    log('没装 uv（uv --version 跑不了），跳过。');
    return undefined;
  }
  // 工具在 TypeScript 这边执行：pydantic-ai 只看到定义，调用经 ctx-remote 的 `/executors/local` 回到这里。
  const local = createFunctionExecutor('local').register(
    { name: 'forecast', description: '今天台北的天气', inputSchema: { type: 'object', properties: {} } },
    () => ({ type: 'text', text: '台北：晴，26℃，傍晚有阵雨' }),
  );
  const token = 'example-remote-token';
  const remote = await startRemote({ store: createMemoryStore(), executors: [local], accessToken: token });
  const { url, child } = await serve(remote.baseUrl, token);
  try {
    const store = createRemoteSessionStore({ baseUrl: remote.baseUrl, accessToken: token });
    const orchestrator = createOrchestrator({
      harness: createRemoteHarness({ baseUrl: url }),
      store,
      owner: 'pydantic-ai-example',
    });
    const agent = { model: 'test', instructions: '你是生活助手。', maxSteps: 4 };
    const answers: string[] = [];
    for (const input of ['台北下午要带伞吗？', '那晚上呢？']) {
      const result = await (await orchestrator.submit({ session: 'user:42', agent, input })).done;
      log(`${input} → ${result.stopReason}：${result.text}`);
      answers.push(result.text);
    }
    // 日志在 ctx-remote 里：两轮各有开始和结束，开始记着 harness 是 pydantic-ai；工具结果的 `source` 是 `local`。
    // pydantic-ai 不存对话：第二轮的历史是从这份日志投影出来的，`test` 模型在里面看到上一轮的工具结果，直接回答。
    const entries = await store.list('user:42');
    for (const entry of entries) log(`${entry.seq}\t${describe(entry)}`);
    await orchestrator.close();
    return {
      answers,
      harnesses: entries.filter(isStarted).map((entry) => harnessOf(entry)?.name),
      toolSources: entries
        .filter((entry) => entry.type === 'message' && entry.message.role === 'tool')
        .map((entry) => entry.source),
    };
  } finally {
    child.kill();
    await remote.close();
  }
}

function isStarted(entry: Entry): boolean {
  return entry.type === 'event' && entry.kind === CTX_EVENTS.runStarted;
}

function harnessOf(entry: Entry): HarnessInfo | undefined {
  if (entry.type !== 'event' || typeof entry.data !== 'object' || entry.data === null) return undefined;
  return (entry.data as { harness?: HarnessInfo }).harness;
}

function describe(entry: Entry): string {
  if (entry.type === 'event') {
    const harness = harnessOf(entry);
    return harness ? `${entry.kind}（${harness.name} ${harness.version ?? ''}）` : entry.kind;
  }
  if (entry.type === 'summary') return 'summary';
  return entry.source ? `${entry.message.role}（${entry.source}）` : entry.message.role;
}

if (isMain(import.meta.url)) await main();
