// 搬会话：内存存储 → 导出成文件 → 导进 SQLite → 复制到远端存储，三边看到的上下文一样。
//
//   node examples/move-session.ts
//
// `seq` 是各个存储自己分配的，直接 `list` 再 `append` 会让摘要的 `covers` 指错位置：被压缩掉的历史重新出现，
// 或者摘要之后的话全被盖住。`exportSession`、`importSession`、`copySession` 搬的时候把这些位置换成目标存储的。
import { randomBytes } from 'node:crypto';
import { createReadStream, mkdtempSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  assistantEntry,
  copySession,
  createMemoryStore,
  exportSession,
  importSession,
  project,
  summaryEntry,
  textOf,
  userEntry,
  type SessionStore,
} from '@modelctx-ai/ctx';
import { createRemoteSessionStore } from '@modelctx-ai/ctx-remote';
import { startRemote } from '@modelctx-ai/ctx-remote/server';
import { createSqliteStore } from '@modelctx-ai/ctx-sqlite';

import { isMain, type Log } from './model.ts';

/** 模型会看到的消息，一行一条。 */
async function view(store: SessionStore, session: string): Promise<string[]> {
  const { messages } = project(await store.list(session));
  return messages.map((message) => `${message.role}：${textOf(message)}`);
}

export async function main(log: Log = console.log): Promise<string[][]> {
  const directory = mkdtempSync(path.join(tmpdir(), 'ctx-example-'));

  // 源：内存存储里一个压缩过的会话。前面先有别的会话，所以它的 `seq` 不从 1 起。
  const memory = createMemoryStore();
  await memory.append('user:7', [userEntry('别的用户的话'), assistantEntry('别的回答')]);
  const old = await memory.append('user:42', [
    userEntry('我下周去东京出差'),
    assistantEntry('好的，要帮你看天气吗？'),
    userEntry('不用，帮我记着周三要见客户'),
    assistantEntry('记下了：周三见客户。'),
  ]);
  await memory.append('user:42', [
    summaryEntry('用户下周去东京出差，周三要见客户。', old.at(-1)!.seq),
    userEntry('周三几点来着？'),
    assistantEntry('你没说具体时间，只说了周三见客户。'),
  ]);

  // 导出：JSON Lines，第一行是头，最后一行是条数。写成文件就是备份。
  const file = path.join(directory, 'user-42.jsonl');
  await writeFile(file, exportSession(memory, 'user:42'));

  // 导进 SQLite：文件流直接交给 `importSession`。同一份文件再导一次什么都不写。
  const sqlite = createSqliteStore({ path: path.join(directory, 'ctx.db') });
  await sqlite.append('user:9', [userEntry('库里已有的会话')]);
  const imported = await importSession(sqlite, createReadStream(file, 'utf8'));
  const again = await importSession(sqlite, createReadStream(file, 'utf8'));
  log(`导进 SQLite：写入 ${imported.written} 条；再导一次写入 ${again.written} 条，跳过 ${again.skipped} 条`);

  // 复制到远端存储，顺便改名。两个存储之间不经过文件。
  const accessToken = randomBytes(24).toString('base64url');
  const server = await startRemote({ store: createMemoryStore(), accessToken });
  try {
    const remote = createRemoteSessionStore({ baseUrl: server.baseUrl, accessToken });
    const copied = await copySession(sqlite, 'user:42', remote, 'archive:user:42');
    log(`复制到远端：写入 ${copied.written} 条，在 ${copied.session}`);

    const views = [await view(memory, 'user:42'), await view(sqlite, 'user:42'), await view(remote, 'archive:user:42')];
    for (const line of views[2]!) log(line);
    log(`三边的上下文${views.every((lines) => lines.join('\n') === views[0]!.join('\n')) ? '一样' : '不一样'}`);
    return views;
  } finally {
    await server.close();
    sqlite.close();
  }
}

if (isMain(import.meta.url)) await main();
