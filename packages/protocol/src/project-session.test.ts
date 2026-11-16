import assert from 'node:assert/strict';

import { describe, test } from 'vite-plus/test';

import { latestSummary, project, projectSession, type EventRule, type ProjectionOptions } from './context.ts';
import type { Message } from './message.ts';
import { filterEntries, type Entry, type EventEntry, type ListOptions } from './session.ts';
import { estimateTokens } from './tokens.ts';
import { ENTRY_VERSION } from './version.ts';

/** 只有 `list` 的存储，数一共交出去多少条。 */
function storeOf(entries: readonly Entry[]) {
  let read = 0;
  return {
    get read() {
      return read;
    },
    async list(_session: string, options?: ListOptions): Promise<Entry[]> {
      const out = filterEntries(entries, options);
      read += out.length;
      return out;
    },
  };
}

/** 读整段再投影：`projectSession` 要和它一样。 */
function whole(entries: readonly Entry[], options: ProjectionOptions) {
  const summary = latestSummary(entries);
  return project(
    summary ? entries.filter((entry) => entry.seq > summary.covers || entry === summary) : entries,
    options,
  );
}

/** 比较时不看 `dropped`：只读了尾部时它只数读到的部分。 */
function shape(projection: ReturnType<typeof project>) {
  const { dropped: _dropped, ...rest } = projection;
  return rest;
}

/** 可重复的伪随机数。 */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const beats: EventRule = {
  fold: true,
  // 合成的一组有时渲染成两条很短的消息、有时一条长的：开头那组被切开时，切开的和完整的放不放得下不一样。
  render: (events: readonly EventEntry[]): Message[] =>
    events.length % 3 === 0
      ? [
          { role: 'assistant', content: '嗯' },
          { role: 'user', content: '短' },
        ]
      : [{ role: 'user', content: `心跳 ${events.length} 次，最后一次在 ${events.at(-1)!.at}` }],
};
const notes: EventRule = { render: (events) => ({ role: 'user', content: `备注：${events[0]!.text ?? ''}` }) };
const rules = { 'app.beat': beats, 'app.note': notes };

/** 一个会话：对话、工具调用（有的缺结果）、合并的事件、看不见的事件、补写的旧记录、`at` 在未来的提醒、摘要。 */
function sessionOf(next: () => number, size: number): Entry[] {
  const entries: Entry[] = [];
  let clock = 1_000;
  const push = (entry: Record<string, unknown>, at = clock): void => {
    const seq = entries.length + 1;
    entries.push({ ...entry, id: `e${seq}`, session: 's', seq, at, v: ENTRY_VERSION } as Entry);
  };
  while (entries.length < size) {
    clock += 1 + Math.floor(next() * 5);
    const roll = next();
    if (roll < 0.25) push({ type: 'message', message: { role: 'user', content: `问 ${entries.length}` } });
    else if (roll < 0.4) push({ type: 'message', message: { role: 'assistant', content: `答 ${entries.length}` } });
    else if (roll < 0.5) {
      const id = `call${entries.length}`;
      push({
        type: 'message',
        message: {
          role: 'assistant',
          content: [{ type: 'tool-call', id, name: 'look', input: { n: entries.length } }],
        },
      });
      if (next() < 0.85) {
        push({
          type: 'message',
          message: {
            role: 'tool',
            content: [
              {
                type: 'tool-result',
                id,
                name: 'look',
                output: { type: 'text', text: 'x'.repeat(1 + Math.floor(next() * 400)) },
              },
            ],
          },
        });
      }
    } else if (roll < 0.75) {
      const run = 1 + Math.floor(next() * 40);
      for (let i = 0; i < run && entries.length < size; i += 1) push({ type: 'event', kind: 'app.beat', text: 'tick' });
    } else if (roll < 0.82) push({ type: 'event', kind: 'app.note', text: `n${entries.length}` });
    else if (roll < 0.9) push({ type: 'event', kind: 'app.hidden' });
    else if (roll < 0.94) {
      // 补写的旧记录：`at` 比前面的早。
      push(
        { type: 'message', message: { role: 'user', content: `补写 ${entries.length}` } },
        clock - Math.floor(next() * 500),
      );
    } else if (roll < 0.97) {
      // 到期时间当 `at`：写得早，排在后面，有的排在整段的最后。
      push({ type: 'event', kind: 'app.note', text: `提醒 ${entries.length}` }, clock + Math.floor(next() * 50_000));
    } else if (entries.length > 10) {
      push({ type: 'summary', text: `摘要 ${entries.length}`, covers: Math.floor(next() * (entries.length - 1)) + 1 });
    }
  }
  return entries;
}

describe('projectSession', () => {
  test('随机的会话和窗口：结果和读整段再 project 一样', async () => {
    const next = random(20261116);
    let cases = 0;
    let bounded = 0;
    for (let round = 0; round < 400; round += 1) {
      const size = next() < 0.3 ? Math.floor(next() * 300) : 300 + Math.floor(next() * 4000);
      const entries = sessionOf(next, size);
      const roll = next();
      const window =
        roll < 0.1
          ? {}
          : roll < 0.45
            ? { maxMessages: Math.floor(next() * 60) }
            : roll < 0.8
              ? { maxTokens: 20 + Math.floor(next() * 3000), truncate: next() < 0.5 }
              : { maxMessages: 1 + Math.floor(next() * 30), maxTokens: 50 + Math.floor(next() * 1500) };
      const options: ProjectionOptions = { events: rules, window };
      const store = storeOf(entries);
      const got = await projectSession(store, 's', options);
      assert.deepEqual(
        shape(got),
        shape(whole(entries, options)),
        `第 ${round} 个（${size} 条，窗口 ${JSON.stringify(window)}）`,
      );
      cases += 1;
      if (store.read < entries.length) bounded += 1;
    }
    assert.equal(cases, 400);
    assert.ok(bounded > 100, `应当有不少只读了尾部的（${bounded}）`);
  });

  test('长会话只读尾部；写在最前面、到期时间在最后的提醒照样在窗口里', async () => {
    const entries: Entry[] = [];
    const add = (entry: Record<string, unknown>, at: number): void => {
      const seq = entries.length + 1;
      entries.push({ ...entry, id: `e${seq}`, session: 's', seq, at, v: ENTRY_VERSION } as Entry);
    };
    add({ type: 'event', kind: 'app.note', text: '明早九点开会' }, 10_000_000);
    for (let i = 0; i < 20_000; i += 1) {
      add({ type: 'message', message: { role: i % 2 ? 'assistant' : 'user', content: `第 ${i} 句` } }, 1_000 + i);
    }
    const store = storeOf(entries);
    const options: ProjectionOptions = { events: rules, window: { maxMessages: 6 } };
    const started = performance.now();
    const got = await projectSession(store, 's', options);
    const took = performance.now() - started;
    assert.deepEqual(shape(got), shape(whole(entries, options)));
    assert.equal(got.messages.at(-1)?.content, '备注：明早九点开会');
    assert.ok(store.read < 1_000, `读了 ${store.read} 条`);
    assert.ok(took < 1_000, `用了 ${took} 毫秒`);
  });

  test('开头那组合并的事件被切开：只挤掉它一组不算数，接着往前读', async () => {
    const entries: Entry[] = [];
    const add = (entry: Record<string, unknown>): void => {
      const seq = entries.length + 1;
      entries.push({ ...entry, id: `e${seq}`, session: 's', seq, at: seq, v: ENTRY_VERSION } as Entry);
    };
    add({ type: 'message', message: { role: 'user', content: '开头' } });
    for (let i = 0; i < 300; i += 1) add({ type: 'event', kind: 'app.beat', text: 'tick' });
    add({ type: 'message', message: { role: 'user', content: '问' } });
    add({ type: 'message', message: { role: 'assistant', content: '答' } });
    // 整段里 300 次心跳渲染成「嗯」「短」两条；只读最后 256 条时是切开的 254 次，渲染成一条长的。
    // 预算刚好放得下「短」「问」「答」：整段留下「短」，切开的那组放不下、被挤掉，只挤掉这一组时不能停。
    const maxTokens =
      estimateTokens({ role: 'user', content: '短' }) +
      estimateTokens({ role: 'user', content: '问' }) +
      estimateTokens({ role: 'assistant', content: '答' });
    const options: ProjectionOptions = { events: rules, window: { maxTokens } };
    const expected = whole(entries, options);
    assert.deepEqual(
      expected.messages.map((message) => message.content),
      ['短', '问', '答'],
    );
    assert.deepEqual(shape(await projectSession(storeOf(entries), 's', options)), shape(expected));
  });

  test('没有窗口、窗口是 {}：读生效的摘要之后的整段', async () => {
    const entries = sessionOf(random(7), 600);
    const summary = latestSummary(entries);
    const after = entries.filter((entry) => !summary || entry.seq > summary.covers).length;
    for (const window of [undefined, {}]) {
      const store = storeOf(entries);
      const options: ProjectionOptions = { events: rules, ...(window ? { window } : {}) };
      assert.deepEqual(await projectSession(store, 's', options), whole(entries, options));
      assert.ok(store.read >= after, `读了 ${store.read} 条，摘要之后有 ${after} 条`);
    }
  });
});
