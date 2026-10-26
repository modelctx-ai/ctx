import assert from 'node:assert/strict';

import {
  assistantEntry,
  eventEntry,
  summaryEntry,
  textOf,
  userEntry,
  type Entry,
  type NewEntry,
  type SessionStore,
} from '@modelctx-ai/ctx-protocol';
import { MockLanguageModelV4 } from 'ai/test';
import { describe, test } from 'vite-plus/test';

import { createContextBuilder } from './builder.ts';
import { findLossySummaries, recompactLossy } from './migrate.ts';
import { createMemoryStore } from './store.ts';

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

function summarizer(text: string, finishReason: 'stop' | 'length' = 'stop'): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doGenerate: {
      content: [{ type: 'text', text }],
      finishReason: { unified: finishReason, raw: finishReason },
      usage,
      warnings: [],
    },
  });
}

/** 存储里的 id 在 `legacy` 里的条目读出来带 `v: 0`，模拟 0.2 写的行（升级后形状已是当前版本）。 */
function withLegacy(base: SessionStore, legacy: Set<string>): SessionStore {
  const mark = (entry: Entry): Entry => (legacy.has(entry.id) ? { ...entry, v: 0 } : entry);
  return { ...base, list: async (session, options) => (await base.list(session, options)).map(mark) };
}

/**
 * 构造 0.2 留下的会话：`late` 到得晚（`at` 比摘要的锚点大，`seq` 却在 `covers` 之前），
 * 旧规则（按 `at`）下可见，新规则（按 `seq`）下被摘要盖住。
 */
async function seed(store: SessionStore, session: string, legacy: Set<string>) {
  const append = async (entry: NewEntry): Promise<Entry> => {
    const [written] = await store.append(session, [entry]);
    return written!;
  };
  const early = await append(userEntry('问题一', { at: 100 }));
  const late = await append(assistantEntry('晚到的回答', { at: 500 }));
  const framework = await append(eventEntry('ctx.run.ended', { at: 600, data: { runId: 'r', stopReason: 'end' } }));
  const note = await append(eventEntry('app.note', { at: 650, text: '晚到的笔记' }));
  const anchor = await append(userEntry('问题二', { at: 300 }));
  const summary = await append(summaryEntry('旧摘要：问题一和二', anchor.seq, { at: 700, source: 'model' }));
  const after = await append(userEntry('之后的问题', { at: 800 }));
  legacy.add(summary.id);
  return { early, late, framework, note, anchor, summary, after };
}

describe('findLossySummaries / recompactLossy', () => {
  test('找出被新规则盖住、旧规则下可见的条目；不含摘要、框架事件和锚点之前的条目', async () => {
    const legacy = new Set<string>();
    const base = createMemoryStore();
    const store = withLegacy(base, legacy);
    const e = await seed(base, 's', legacy);
    assert.deepEqual(await findLossySummaries(store), [
      { session: 's', summaryId: e.summary.id, covers: e.anchor.seq, hidden: [e.late.seq, e.note.seq] },
    ]);
    assert.deepEqual(await findLossySummaries(store, { session: 's' }), await findLossySummaries(store));
    assert.deepEqual(await findLossySummaries(store, { session: 'other' }), []);
  });

  test('只看 v 为 0 的摘要：新写的摘要、没有被盖住的条目、锚点不存在都不报', async () => {
    const legacy = new Set<string>();
    const base = createMemoryStore();
    const store = withLegacy(base, legacy);
    await seed(base, 'current', new Set());
    assert.deepEqual(await findLossySummaries(store), [], '摘要是 v1');

    const clean = await base.append('clean', [userEntry('一', { at: 1 }), userEntry('二', { at: 2 })]);
    const [summary] = await base.append('clean', [summaryEntry('摘要', clean[1]!.seq, { at: 3 })]);
    legacy.add(summary!.id);
    assert.deepEqual(await findLossySummaries(store), [], '时间顺序和日志顺序一致，没有差别');

    const [orphan] = await base.append('orphan', [summaryEntry('摘要', 99999, { at: 3 })]);
    legacy.add(orphan!.id);
    assert.deepEqual(await findLossySummaries(store), [], '找不到 covers 对应的条目就无从比较');
  });

  test('遍历所有会话要翻页', async () => {
    const legacy = new Set<string>();
    const base = createMemoryStore();
    const store = withLegacy(base, legacy);
    for (const name of ['a', 'b', 'c', 'd', 'e']) await seed(base, name, legacy);
    const found = await findLossySummaries(store, { pageSize: 2 });
    assert.deepEqual(
      found.map((item) => item.session),
      ['a', 'b', 'c', 'd', 'e'],
    );
  });

  test('recompactLossy：covers 不变，输入是旧摘要加被盖住的条目，新摘要取代旧摘要，再找为空', async () => {
    const legacy = new Set<string>();
    const base = createMemoryStore();
    const store = withLegacy(base, legacy);
    const e = await seed(base, 's', legacy);
    const model = summarizer('新摘要：包含晚到的回答');
    const builder = createContextBuilder({
      store,
      model,
      projection: {
        events: { 'app.note': { render: ([note]) => ({ role: 'user', content: `note: ${note?.text}` }) } },
      },
    });

    const before = await builder.view('s');
    assert.ok(!before.messages.some((message) => textOf(message).includes('晚到')), '修复前模型看不到晚到的条目');

    const [finding] = await findLossySummaries(store);
    const written = await recompactLossy(builder, finding!, { instructions: '压缩' });
    assert.equal(written?.covers, e.anchor.seq);
    assert.equal(written?.v, 1);
    assert.equal(written?.text, '新摘要：包含晚到的回答');
    assert.ok(written.seq > e.after.seq);

    // 输入：旧摘要的文字 + 被盖住的条目；不含已经被旧摘要正确覆盖的条目，也不含框架事件。
    const sent = JSON.stringify(model.doGenerateCalls[0]!.prompt);
    assert.match(sent, /旧摘要：问题一和二/);
    assert.match(sent, /晚到的回答/);
    assert.match(sent, /晚到的笔记/);
    assert.ok(!sent.includes('问题一"'), '不重复旧摘要已经覆盖的条目');
    assert.ok(!sent.includes('ctx.run.ended'));

    // 同样的 covers，后写的生效：视图以新摘要开头，之后的条目照旧。
    const after = await builder.view('s');
    assert.match(textOf(after.messages[0]!), /新摘要：包含晚到的回答/);
    assert.ok(!after.messages.some((message) => textOf(message).includes('旧摘要')));
    assert.equal(textOf(after.messages.at(-1)!), '之后的问题');

    assert.deepEqual(await findLossySummaries(store), [], '新摘要是 v1，不会再被找到');
    // 同时写了一条 ctx.compacted。
    const compacted = (await store.list('s', { kinds: ['ctx.compacted'] })).at(-1);
    assert.equal(compacted?.type === 'event' && (compacted.data as { summaryId?: string }).summaryId, written?.id);
  });

  test('被盖住的条目再也进不了 compact 的输入，只有 recompactLossy 能把它们并进摘要', async () => {
    const legacy = new Set<string>();
    const base = createMemoryStore();
    const store = withLegacy(base, legacy);
    const e = await seed(base, 's', legacy);
    const builder = createContextBuilder({ store, model: summarizer('普通压缩') });
    // 普通 compact 只压摘要之后的历史，`covers` 只会更大；晚到的条目在 `covers` 之前，它碰不到。
    const plain = await builder.compact('s', { keep: 100, minimum: 1 });
    assert.equal(plain, null);

    const [finding] = await findLossySummaries(store);
    const fixed = await recompactLossy(createContextBuilder({ store, model: summarizer('修复后') }), finding!);
    assert.equal(fixed?.covers, e.anchor.seq);
  });

  test('没有模型时报清楚的错；摘要被截断或为空时不写', async () => {
    const legacy = new Set<string>();
    const base = createMemoryStore();
    const store = withLegacy(base, legacy);
    await seed(base, 's', legacy);
    const [finding] = await findLossySummaries(store);
    await assert.rejects(recompactLossy(createContextBuilder({ store }), finding!), /No language model/);

    const warned: string[] = [];
    const truncated = createContextBuilder({
      store,
      model: summarizer('半截', 'length'),
      logger: { warn: (message) => warned.push(message) },
    });
    assert.equal(await recompactLossy(truncated, finding!), null);
    assert.equal(await recompactLossy(createContextBuilder({ store, model: summarizer('  ') }), finding!), null);
    assert.equal((await findLossySummaries(store)).length, 1, '没写，仍然需要修复');
    assert.deepEqual(warned, ['summary hit maxOutputTokens; history not compacted']);
  });
});
