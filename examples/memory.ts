// 记忆接进上下文：一个会话里说过的事，另一个会话里还记得。
//
//   node examples/memory.ts
//
// 白天 `gate` 给刚说的话打分、记笔记；夜里 `consolidate` 把笔记提取成事实、重写画像；
// 之后任何会话组装上下文时，`memory.source()` 把画像和相关的事实带进去。
import {
  createContextBuilder,
  createHarness,
  createMemoryStore as createSessionStore,
  createToolRegistry,
  userEntry,
  assistantEntry,
} from '@modelctx-ai/ctx';
import { createMemory, createMemoryStore } from '@modelctx-ai/ctx-memory';
import { createScriptedExtractionModel } from '@modelctx-ai/ctx-protocol/testing';

import { exampleModel, isMain, type Log } from './model.ts';

export async function main(log: Log = console.log): Promise<string> {
  const sessions = createSessionStore();
  const real = Boolean(process.env.CTX_EXAMPLE_BASE_URL && process.env.CTX_EXAMPLE_MODEL);

  const memory = createMemory({
    store: createMemoryStore(),
    // 一个用户一个作用域：几个用户共用一份存储时互相看不到。
    scope: 'user:42',
    sessions,
    // 提取：真的模型自己读对话；没有模型时用剧本里写好的结果，例子不联网也能跑。
    ...(real
      ? { model: exampleModel([]) }
      : {
          extraction: createScriptedExtractionModel({
            values: { facts: ['主人对花生过敏'], decisions: null, since: null, lesson: null },
          }),
        }),
    topics: { user: '主人的偏好和习惯' },
    gate: { theta: 0.5, auto: false },
  });

  // 第一个会话：主人说了一件该记住的事。这里直接把对话写进日志，省掉一轮模型调用。
  await sessions.append('chat:monday', [
    userEntry('记住：我对花生过敏，以后推荐吃的都要避开'),
    assistantEntry('记下了，以后避开花生。'),
  ]);
  const notes = await memory.gate('chat:monday');
  log(
    `门控：${notes.length} 条笔记，salience ${notes[0]?.salience.toFixed(2)}，${notes[0]?.settledAt === undefined ? '待处理' : '没过阈值'}`,
  );

  const report = await memory.consolidate();
  log(`巩固：处理 ${report.notes} 条笔记，新增 ${report.facts.added} 条事实，画像${report.core ? '重写了' : '没变'}`);

  // 第二个会话：上下文里带上记忆（来源），模型还能主动查（`recall` 工具）。
  const builder = createContextBuilder({ store: sessions, sources: [memory.source({ k: 5 })] });
  const tools = createToolRegistry();
  for (const definition of await memory.tools()) tools.add(definition);
  const harness = createHarness({ store: sessions, context: builder, tools, executors: [memory] });

  await sessions.append('chat:friday', [userEntry('晚饭推荐个菜')]);
  const injected = await memory.source().collect({ session: 'chat:friday' });
  log(`注入上下文的记忆：\n${injected ?? '（没有）'}`);

  const result = await harness.run({
    session: 'chat:friday',
    agent: { model: exampleModel([{ type: 'text', text: '清蒸鲈鱼，不放花生油。' }]), instructions: '你是生活助手。' },
  });
  log(`回答：${result.text}`);
  return injected ?? '';
}

if (isMain(import.meta.url)) await main();
