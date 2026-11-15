import assert from 'node:assert/strict';

import { describe, test } from 'vite-plus/test';

import { eventEntry, filterEntries, summaryEntry, userEntry, type Entry, type SessionStore } from './session.ts';
import {
  SESSION_EXPORT_FORMAT,
  SESSION_EXPORT_VERSION,
  exportSession,
  importSession,
  type SessionExportHeader,
} from './transfer.ts';
import { ENTRY_VERSION, unreadableEntry } from './version.ts';

/** 只有导出、导入用得到的两个方法；`seq` 全库共用，从 `start` 之后起。 */
function tinyStore(start = 0): Pick<SessionStore, 'append' | 'list'> & { readonly batches: number[] } {
  const sessions = new Map<string, Entry[]>();
  const ids = new Set<string>();
  const batches: number[] = [];
  let seq = start;
  return {
    batches,
    async append(session, drafts) {
      batches.push(drafts.length);
      const list = sessions.get(session) ?? [];
      const written: Entry[] = [];
      for (const draft of drafts) {
        const id = draft.id ?? `t${seq + 1}`;
        if (ids.has(id) || list.some((entry) => draft.key !== undefined && entry.key === draft.key)) continue;
        seq += 1;
        ids.add(id);
        const entry = { ...draft, id, session, seq, at: draft.at ?? 0, v: ENTRY_VERSION } as Entry;
        list.push(entry);
        written.push(entry);
      }
      sessions.set(session, list);
      return written;
    },
    async list(session, options) {
      return filterEntries(sessions.get(session) ?? [], options);
    },
  };
}

function coversOf(entry: Entry | undefined): number | undefined {
  return entry?.type === 'summary' ? entry.covers : undefined;
}

function dataOf(entry: Entry | undefined): unknown {
  return entry?.type === 'event' ? entry.data : undefined;
}

async function text(source: AsyncIterable<string>): Promise<string> {
  let out = '';
  for await (const chunk of source) out += chunk;
  return out;
}

async function failure(promise: Promise<unknown>): Promise<{ type?: string; message: string }> {
  try {
    await promise;
  } catch (error) {
    return error as { type?: string; message: string };
  }
  throw new Error('应该抛错');
}

const HEADER = JSON.stringify({ format: SESSION_EXPORT_FORMAT, version: SESSION_EXPORT_VERSION, session: 's' });
const end = (entries: number): string => JSON.stringify({ end: true, entries });
const line = (seq: number, extra: object = {}): string =>
  JSON.stringify({ type: 'event', kind: 'app.tick', id: `e${seq}`, session: 's', seq, at: seq, v: 1, ...extra });

describe('exportSession', () => {
  test('第一行是头，中间每行一条条目，最后一行是条数', async () => {
    const store = tinyStore(50);
    await store.append('s', [userEntry('一'), userEntry('二'), userEntry('三')]);
    const file = await text(exportSession(store, 's', { pageSize: 2, now: () => 77 }));
    assert.ok(file.endsWith('\n'));
    const rows = file
      .trimEnd()
      .split('\n')
      .map((item) => JSON.parse(item) as Record<string, unknown>);
    assert.deepEqual(rows[0], {
      format: 'ctx.session',
      version: 1,
      session: 's',
      exportedAt: 77,
    } satisfies SessionExportHeader);
    assert.deepEqual(
      rows.slice(1, -1).map((row) => row['seq']),
      [51, 52, 53],
    );
    assert.deepEqual(rows.at(-1), { end: true, entries: 3 });
  });

  test('空会话也有头和结束行，导进去什么都不写', async () => {
    const file = await text(exportSession(tinyStore(), 'nothing'));
    assert.equal(file.trimEnd().split('\n').length, 2);
    const target = tinyStore();
    const result = await importSession(target, file);
    assert.equal(result.read, 0);
    assert.deepEqual(target.batches, []);
  });

  test('旧版本写的行导出时 v 写成当前版本：形状已经升过级', async () => {
    const store: Pick<SessionStore, 'list'> = {
      async list(_session, options) {
        const old = { type: 'message', message: { role: 'user', content: '旧' }, id: 'a', session: 's', seq: 1, at: 1 };
        return filterEntries([{ ...old, v: 0 } as Entry], options);
      },
    };
    const rows = (await text(exportSession(store, 's'))).trimEnd().split('\n');
    assert.equal((JSON.parse(rows[1]!) as { v: number }).v, ENTRY_VERSION);
  });

  test('读不了的行：缺省抛 unreadable，skip 时跳过', async () => {
    const store: Pick<SessionStore, 'list'> = {
      async list(_session, options) {
        const bad = unreadableEntry({ id: 'bad', session: 's', seq: 2, at: 2, v: 9 }, new Error('too new'));
        const good = { type: 'event', kind: 'app.tick', id: 'ok', session: 's', seq: 1, at: 1, v: 1 } as Entry;
        return filterEntries([good, bad], options);
      },
    };
    assert.equal((await failure(text(exportSession(store, 's')))).type, 'unreadable');
    const file = await text(exportSession(store, 's', { unreadable: 'skip' }));
    assert.deepEqual(JSON.parse(file.trimEnd().split('\n').at(-1)!), { end: true, entries: 1 });
  });
});

describe('importSession', () => {
  test('文本怎么切都行：整份、按行、切在行中间', async () => {
    const source = tinyStore(10);
    await source.append('s', [userEntry('一'), userEntry('二')]);
    const file = await text(exportSession(source, 's'));
    const pieces = [file.slice(0, 7), file.slice(7, 90), file.slice(90)];
    for (const input of [file, file.split('\n'), pieces, file.replaceAll('\n', '\r\n\r\n')]) {
      const target = tinyStore();
      // `split('\n')` 把换行拿掉了，补回去。
      const chunks = Array.isArray(input) && input !== pieces ? input.map((item) => `${item}\n`) : input;
      const result = await importSession(target, chunks, { session: 'copy' });
      assert.equal(result.written, 2);
      assert.equal(result.session, 'copy');
      assert.equal(result.header.session, 's');
      assert.deepEqual(
        (await target.list('copy')).map((entry) => entry.seq),
        [1, 2],
      );
    }
  });

  test('一批最多 batchSize 条；摘要之前先把攒着的写掉', async () => {
    const source = tinyStore();
    const written = await source.append('s', [userEntry('1'), userEntry('2'), userEntry('3')]);
    await source.append('s', [summaryEntry('摘要', written[2]!.seq), userEntry('4'), userEntry('5'), userEntry('6')]);
    const target = tinyStore(100);
    await importSession(target, exportSession(source, 's'), { batchSize: 5 });
    assert.deepEqual(target.batches, [3, 4]);
    const summary = (await target.list('s')).find((entry) => entry.type === 'summary');
    assert.equal(coversOf(summary), 103);
  });

  test('covers 指向已经不在的条目：换成它之前最后一条，一条都没有是 0', async () => {
    const lines = [
      HEADER,
      JSON.stringify({
        type: 'summary',
        text: '盖住的都删了',
        covers: 54,
        id: 's1',
        session: 's',
        seq: 60,
        at: 1,
        v: 1,
      }),
      line(61),
      JSON.stringify({ type: 'summary', text: '第二段', covers: 70, id: 's2', session: 's', seq: 62, at: 2, v: 1 }),
      end(3),
    ];
    const target = tinyStore(5);
    const result = await importSession(target, lines.join('\n'));
    const entries = await target.list('s');
    assert.equal(coversOf(entries[0]), 0);
    assert.equal(coversOf(entries[2]), 7, '指到自己之后的 covers 按它之前最后一条算');
    assert.equal(result.remap(59), 0);
    assert.equal(result.remap(60), 6);
    assert.equal(result.remap(1_000), 8);
  });

  test("ids: 'new' 时 ctx.compacted 的 summaryId 换成摘要的新 id", async () => {
    const source = tinyStore();
    const [first] = await source.append('s', [userEntry('一')]);
    const [summary] = await source.append('s', [summaryEntry('摘要', first!.seq, { id: 'old-summary' })]);
    await source.append('s', [eventEntry('ctx.compacted', { data: { covers: first!.seq, summaryId: summary!.id } })]);
    const target = tinyStore(20);
    await importSession(target, exportSession(source, 's'), { ids: 'new' });
    const entries = await target.list('s');
    assert.notEqual(entries[1]!.id, 'old-summary');
    assert.deepEqual(dataOf(entries[2]), { covers: 21, summaryId: entries[1]!.id });
  });

  test('不认识的文件不读', async () => {
    const store = tinyStore();
    assert.equal((await failure(importSession(store, ''))).type, 'invalid_request');
    assert.equal((await failure(importSession(store, 'not json\n'))).type, 'invalid_request');
    assert.equal((await failure(importSession(store, '[1]\n'))).type, 'invalid_request');
    assert.equal((await failure(importSession(store, `${line(1)}\n`))).type, 'invalid_request');
    const newer = JSON.stringify({ format: SESSION_EXPORT_FORMAT, version: SESSION_EXPORT_VERSION + 1, session: 's' });
    assert.equal((await failure(importSession(store, `${newer}\n`))).type, 'unsupported_version');
    assert.deepEqual(store.batches, []);
  });

  test('条目行有问题：版本比自己新、顺序倒了、结束行后面还有、条数对不上', async () => {
    const cases: [string[], string][] = [
      [[HEADER, line(1, { v: ENTRY_VERSION + 1 }), end(1)], 'unsupported_version'],
      [[HEADER, line(2), line(1), end(2)], 'invalid_request'],
      [[HEADER, line(1), end(1), line(2)], 'invalid_request'],
      [[HEADER, line(1), end(2)], 'invalid_request'],
      [[HEADER, JSON.stringify({ type: 'event', kind: 'x', seq: 1 }), end(1)], 'invalid_request'],
      [[HEADER, line(1)], 'invalid_request'],
    ];
    for (const [lines, type] of cases) {
      const error = await failure(importSession(tinyStore(), lines.join('\n')));
      assert.equal(error.type, type, lines.join(' | '));
    }
  });

  test('旧版本导出的行在导入时升级', async () => {
    const old = JSON.stringify({ type: 'summary', text: '旧摘要', covers: { at: 5, seq: 1 }, id: 'z', seq: 2, at: 9 });
    const target = tinyStore();
    await importSession(target, [HEADER, line(1), old, end(2)].join('\n'));
    const entries = await target.list('s');
    assert.equal(coversOf(entries[1]), 1);
  });

  test('signal 中止后不再写', async () => {
    const controller = new AbortController();
    controller.abort();
    const target = tinyStore();
    await assert.rejects(
      importSession(target, [HEADER, line(1), end(1)].join('\n'), {
        signal: controller.signal,
      }),
      /abort/i,
    );
    assert.deepEqual(target.batches, []);
  });
});
