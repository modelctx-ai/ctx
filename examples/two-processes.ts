// 记录开着、两个进程共用一个 SQLite 库：一个会话同一时刻只有一个未结束的运行，崩溃留下的运行由 `recover` 收走。
//
//   node examples/two-processes.ts
//
// 为了一个文件就能跑，这里的「两个进程」是同一个文件上的两个连接，各有自己的存储、harness 和编排器，
// 和两个真的进程走的是同一条路：互斥靠日志里的 `ctx.run.started` / `ctx.run.ended` 和写入时的 `expectSeq`，
// 不靠进程内的锁。
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createContextBuilder, createHarness, createOrchestrator, runStartedEntry } from '@modelctx-ai/ctx';
import { createSqliteStore } from '@modelctx-ai/ctx-sqlite';

import { exampleModel, isMain, type Log } from './model.ts';

/** 一个「进程」：自己的连接、harness 和编排器。`owner` 是它的名字，写进它开始的每个运行。 */
function processOn(file: string, owner: string) {
  const store = createSqliteStore({ path: file });
  const harness = createHarness({ store, context: createContextBuilder({ store }) });
  const orchestrator = createOrchestrator({ harness, store, owner });
  return { store, harness, orchestrator };
}

export async function main(log: Log = console.log): Promise<string[]> {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'ctx-example-')), 'shared.db');
  const session = 'shared';
  const out: string[] = [];
  const say = (line: string): void => {
    out.push(line);
    log(line);
  };

  // 进程 A 开始了一轮，没跑完就崩了：日志里只有 ctx.run.started，没有 ctx.run.ended。
  const a = processOn(file, 'worker-a');
  await a.store.append(session, [runStartedEntry({ runId: 'run-crashed', agent: {}, owner: 'worker-a' })]);
  a.store.close();

  // 进程 B 在同一个会话上提交：那一轮还没结束，B 不能插进去。
  const b = processOn(file, 'worker-b');
  const model = exampleModel([{ type: 'text', text: '在的。' }]);
  const blocked = await (await b.orchestrator.submit({ session, agent: { model }, input: '在吗' })).done;
  say(`B 提交：${blocked.stopReason}（${blocked.error?.type}）`);

  // B 的 recover 不收 A 的运行：owner 不同。不然两个都活着的进程会互相把对方正在跑的运行判成断掉的。
  say(`B recover：收走 ${(await b.orchestrator.recover?.())?.length ?? 0} 个`);

  // A 重启：先 recover，给自己断掉的那一轮补上 ctx.run.ended，会话才空出来。
  const restarted = processOn(file, 'worker-a');
  const recovered = (await restarted.orchestrator.recover?.()) ?? [];
  say(`A 重启后 recover：收走 ${recovered.map((run) => run.runId).join('、')}`);

  // 现在 B 可以跑了。
  const done = await (await b.orchestrator.submit({ session, agent: { model }, input: '在吗' })).done;
  say(`B 再提交：${done.stopReason}，回答「${done.text}」`);

  const kinds = (await b.store.list(session, { types: ['event'] })).map((entry) =>
    entry.type === 'event'
      ? `${entry.kind}(${String((entry.data as { runId?: string } | undefined)?.runId).slice(0, 11)})`
      : '',
  );
  say(`生命周期事件：${kinds.join(' → ')}`);

  await b.orchestrator.close();
  await restarted.orchestrator.close();
  b.store.close();
  restarted.store.close();
  return out;
}

if (isMain(import.meta.url)) await main();
