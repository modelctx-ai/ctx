// 单进程：SQLite 会话存储加一个模型，带一个工具。
//
//   node examples/single-process.ts
//
// 会话日志在一个 SQLite 文件里，进程重启后接着用；工具是进程内的函数。
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createContextBuilder, createHarness, createOrchestrator, createToolRegistry } from '@modelctx-ai/ctx';
import { createSqliteStore } from '@modelctx-ai/ctx-sqlite';
import { tool } from 'ai';
import { z } from 'zod';

import { exampleModel, isMain, type Log } from './model.ts';

export async function main(log: Log = console.log): Promise<string> {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'ctx-example-')), 'ctx.db');
  const store = createSqliteStore({ path: file });

  // 工具：zod 写输入结构，执行函数放进注册表自带的函数执行环境。
  const tools = createToolRegistry().addTool(
    'weather',
    tool({
      description: '查一个城市今天的天气',
      inputSchema: z.object({ city: z.string() }),
      execute: async ({ city }) => `${city}：晴，26℃，傍晚有阵雨`,
    }),
  );

  const harness = createHarness({ store, context: createContextBuilder({ store }), tools });
  // 编排器给每个会话排队；`owner` 是这个进程的名字，`recover` 只收自己断掉的运行。
  const orchestrator = createOrchestrator({ harness, store, owner: 'single-process' });
  await orchestrator.recover?.();

  const model = exampleModel(
    [
      { type: 'tool-call', id: 'call-1', input: { city: '台北' } },
      { type: 'text', text: '台北今天晴，26℃，傍晚有阵雨，带把伞。' },
    ],
    'weather',
  );
  const handle = await orchestrator.submit({
    session: 'user:42',
    agent: { model, instructions: '你是生活助手，回答一两句话。', maxSteps: 4 },
    input: '台北下午要带伞吗？',
  });
  const result = await handle.done;
  log(`回答：${result.text}`);

  // 日志里有这一轮的全部：开始、用户这句、工具调用、工具结果、回答、结束。
  const entries = await store.list('user:42');
  for (const entry of entries) {
    log(
      `${entry.seq}\t${entry.type === 'message' ? entry.message.role : entry.type === 'event' ? entry.kind : entry.type}`,
    );
  }

  await orchestrator.close();
  store.close();
  return result.text;
}

if (isMain(import.meta.url)) await main();
