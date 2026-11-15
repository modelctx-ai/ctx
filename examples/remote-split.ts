// 拆开部署：会话存储一个进程，执行环境一个进程，harness 在第三个进程里经 HTTP 连它们。
//
//   node examples/remote-split.ts                 # 三个角色放在一个进程里跑一遍（各听一个本机端口）
//   node examples/remote-split.ts store           # 只起存储服务，打印地址和令牌
//   node examples/remote-split.ts sandbox         # 只起执行环境服务
//   CTX_STORE_URL=… CTX_SANDBOX_URL=… CTX_TOKEN=… node examples/remote-split.ts agent
//
// harness 这一侧只认协议：`createRemoteSessionStore` 是 `SessionStore`，`createRemoteExecutor` 是 `Executor`，
// 换成本地实现一行都不用改。
import { randomBytes } from 'node:crypto';

import {
  createContextBuilder,
  createFunctionExecutor,
  createHarness,
  createMemoryStore,
  createToolRegistry,
} from '@modelctx-ai/ctx';
import { createRemoteExecutor, createRemoteSessionStore } from '@modelctx-ai/ctx-remote';
import { startRemote } from '@modelctx-ai/ctx-remote/server';

import { exampleModel, isMain, type Log } from './model.ts';

/** 存储服务：这里用内存存储，换成 `createSqliteStore({ path })` 就落盘。 */
export function serveStore(accessToken: string) {
  return startRemote({ store: createMemoryStore(), accessToken });
}

/** 执行环境服务：工具在这个进程里跑，harness 那边只看到工具的定义。 */
export function serveSandbox(accessToken: string) {
  const sandbox = createFunctionExecutor('sandbox').register(
    {
      name: 'word_count',
      description: '数一段文字有多少个字符',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    },
    (input) => ({ type: 'text', text: String(Array.from((input as { text: string }).text).length) }),
  );
  return startRemote({ executors: [sandbox], accessToken });
}

/** harness 这一侧：存储和执行环境都在别处。 */
export async function runAgent(storeUrl: string, sandboxUrl: string, accessToken: string, log: Log): Promise<string> {
  const store = createRemoteSessionStore({ baseUrl: storeUrl, accessToken });
  const sandbox = createRemoteExecutor({ baseUrl: sandboxUrl, accessToken, name: 'sandbox' });
  const tools = createToolRegistry();
  for (const definition of await sandbox.tools()) tools.add(definition);

  const harness = createHarness({ store, context: createContextBuilder({ store }), tools, executors: [sandbox] });
  const model = exampleModel(
    [
      { type: 'tool-call', id: 'call-1', input: { text: '组件之间只通过协议交互' } },
      { type: 'text', text: '这句话有 11 个字符。' },
    ],
    'word_count',
  );
  const result = await harness.run({
    session: 'demo',
    agent: { model, instructions: '用工具数字数，回答一句话。', maxSteps: 4 },
    input: '「组件之间只通过协议交互」有多少个字？',
  });
  log(`回答：${result.text}`);
  // 日志在存储服务那边，从这里读回来。
  log(`日志：${(await store.list('demo')).length} 条，在 ${storeUrl}`);
  return result.text;
}

export async function main(log: Log = console.log): Promise<string> {
  const accessToken = randomBytes(24).toString('base64url');
  const storeServer = await serveStore(accessToken);
  const sandboxServer = await serveSandbox(accessToken);
  try {
    return await runAgent(storeServer.baseUrl, sandboxServer.baseUrl, accessToken, log);
  } finally {
    await storeServer.close();
    await sandboxServer.close();
  }
}

if (isMain(import.meta.url)) {
  const role = process.argv[2];
  if (role === 'store' || role === 'sandbox') {
    const accessToken = process.env.CTX_TOKEN ?? randomBytes(24).toString('base64url');
    const server = await (role === 'store' ? serveStore(accessToken) : serveSandbox(accessToken));
    console.log(`${role}: ${server.baseUrl}\nCTX_TOKEN=${accessToken}`);
  } else if (role === 'agent') {
    const { CTX_STORE_URL, CTX_SANDBOX_URL, CTX_TOKEN } = process.env;
    if (!CTX_STORE_URL || !CTX_SANDBOX_URL || !CTX_TOKEN) {
      throw new Error('agent needs CTX_STORE_URL, CTX_SANDBOX_URL and CTX_TOKEN');
    }
    await runAgent(CTX_STORE_URL, CTX_SANDBOX_URL, CTX_TOKEN, console.log);
  } else await main();
}
