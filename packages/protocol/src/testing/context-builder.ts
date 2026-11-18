import assert from 'node:assert/strict';

import type { ContextBuilder } from '../context.ts';
import { textOf, type Message } from '../message.ts';
import { assistantEntry, CTX_EVENTS, eventEntry, summaryEntry, userEntry, type SessionStore } from '../session.ts';

import type { ContractTestApi } from './api.ts';
import type { ModelScript } from './harness.ts';
import { definition, dialogue, eventData, hasType, roundTrips } from './shared.ts';

export interface ContextBuilderFixture {
  readonly builder: ContextBuilder;
  /** builder 读的那个存储，用例往里写。 */
  readonly store: SessionStore;
}

/**
 * 每个用例调一次，拿到一个空的存储和读它的 builder。builder 用缺省的配置：没有事件规则、摘要按缺省渲染、不配窗口、
 * 不配来源。实现有 `compact` 时，摘要模型按这份剧本回答：每调一次取下一步，带 `truncated` 的那一步是被
 * `maxOutputTokens` 截断的输出（`finishReason` 是 `length`）。
 */
export type ContextBuilderFactory = (setup: ModelScript) => ContextBuilderFixture | Promise<ContextBuilderFixture>;

function said(messages: readonly Message[]): string[] {
  return messages.map((message) => `${message.role}:${textOf(message)}`);
}

export function describeContextBuilderContract(
  name: string,
  factory: ContextBuilderFactory,
  { describe, test }: ContractTestApi,
): void {
  describe(`ContextBuilder contract: ${name}`, () => {
    test('build：历史按顺序，input 接在后面，prompt 在最后；带上指令；不写日志；结果全是 JSON', async () => {
      const { builder, store } = await factory({ script: [] });
      await store.append('s', [userEntry('一'), assistantEntry('二')]);
      const before = await store.list('s');
      const call = await builder.build({ session: 's', instructions: '你是助手。', input: '三', prompt: '四' });
      assert.deepEqual(said(call.messages), ['user:一', 'assistant:二', 'user:三', 'user:四']);
      assert.ok(call.instructions?.includes('你是助手。'), '指令在 instructions 里');
      assert.ok(
        call.messages.every((message) => message.role !== 'system'),
        'messages 里没有 system 消息',
      );
      assert.deepEqual(call.tools, []);
      assert.ok(Array.isArray(call.facts));
      assert.deepEqual(call.projection.messages.length, 2, '投影里只有历史');
      assert.deepEqual(await store.list('s'), before, 'build 不改日志');
      assert.ok(roundTrips(call), 'PreparedCall 能 JSON 往返');
    });

    test('build：tools 是候选工具的子集（按名字）；别的会话的历史不串进来', async () => {
      const { builder, store } = await factory({ script: [] });
      await store.append('s', [userEntry('这边')]);
      await store.append('t', [userEntry('那边')]);
      const candidates = [definition('echo'), definition('lookup')];
      const call = await builder.build({ session: 's', tools: candidates });
      assert.ok(call.tools.every((tool) => candidates.some((candidate) => candidate.name === tool)));
      assert.deepEqual(said(call.messages), ['user:这边']);
    });

    test('不认识的投影名：build 和 view 都以 not_found 失败，不回退到缺省', async () => {
      const { builder, store } = await factory({ script: [] });
      await store.append('s', [userEntry('在吗')]);
      await assert.rejects(builder.build({ session: 's', projection: 'no-such-projection' }), hasType('not_found'));
      await assert.rejects(builder.view('s', { projection: 'no-such-projection' }), hasType('not_found'));
      assert.equal((await builder.view('s', { projection: 'default' })).messages.length, 1);
    });

    test('view：没有规则的事件不进上下文；摘要代替它盖住的条目，排在最前', async () => {
      const { builder, store } = await factory({ script: [] });
      const written = await store.append('s', [
        userEntry('甲'),
        eventEntry('app.note', { text: '模型看不到' }),
        assistantEntry('乙'),
        userEntry('丙'),
      ]);
      assert.deepEqual(said((await builder.view('s')).messages), ['user:甲', 'assistant:乙', 'user:丙']);
      await store.append('s', [summaryEntry('之前聊了甲和乙', written[2]!.seq)]);
      const view = await builder.view('s');
      assert.equal(view.messages.length, 2);
      assert.ok(textOf(view.messages[0]!).includes('之前聊了甲和乙'), '第一条是摘要');
      assert.equal(textOf(view.messages[1]!), '丙');
      assert.equal(view.summary?.text, '之前聊了甲和乙');
      assert.equal(view.items[0]?.pinned, true);
      assert.ok(roundTrips(view), 'Projection 能 JSON 往返');
    });

    test('window：maxMessages 留最近的几条，{} 不裁剪；build 和 view 一样', async () => {
      const { builder, store } = await factory({ script: [] });
      await store.append('s', dialogue(6));
      const two = await builder.view('s', { window: { maxMessages: 2 } });
      assert.deepEqual(said(two.messages), ['user:问4', 'assistant:答5']);
      assert.equal(two.dropped, 4);
      assert.equal((await builder.view('s', { window: {} })).messages.length, 6);
      const call = await builder.build({ session: 's', window: { maxMessages: 2 } });
      assert.deepEqual(said(call.messages), ['user:问4', 'assistant:答5']);
    });

    test('window.truncate：单条消息就超过 maxTokens 时截短它，留头尾；不给 truncate 原样交出', async () => {
      const { builder, store } = await factory({ script: [] });
      const long = `HEAD ${'lorem ipsum dolor sit amet '.repeat(2_000)}TAIL`;
      await store.append('s', [userEntry(long)]);
      const whole = await builder.view('s', { window: { maxTokens: 500 } });
      assert.equal(textOf(whole.messages[0]!), long, '缺省宁可超预算也不动最后一组');
      assert.equal(whole.truncated, 0);
      const cut = await builder.view('s', { window: { maxTokens: 500, truncate: true } });
      assert.equal(cut.messages.length, 1);
      assert.equal(cut.truncated, 1);
      assert.ok(cut.tokens <= 500, `估算 ${cut.tokens}`);
      const text = textOf(cut.messages[0]!);
      assert.ok(text.length < long.length / 10, `截到 ${text.length} 个字符`);
      assert.ok(text.startsWith('HEAD lorem') && text.endsWith('TAIL'), '头尾都在');
      const [stored] = await store.list('s');
      assert.equal(stored?.type === 'message' && textOf(stored.message), long, '日志里的原文不动');
    });

    test('build 的 tokens（有时）：整次调用的估算，不小于历史的，指令越长越大', async () => {
      const { builder, store } = await factory({ script: [] });
      await store.append('s', dialogue(4, 200));
      const short = await builder.build({ session: 's', instructions: '短' });
      if (short.tokens === undefined) return;
      assert.ok(short.tokens >= short.projection.tokens);
      const long = await builder.build({ session: 's', instructions: '很长的指令。'.repeat(500) });
      assert.ok((long.tokens ?? 0) > short.tokens + 1_000);
    });

    test('compact（有时）：历史不够长返回 null，不调模型，什么都不写', async () => {
      const { builder, store } = await factory({ script: [] });
      if (!builder.compact) return;
      await store.append('s', dialogue(3));
      const before = await store.list('s');
      assert.equal(await builder.compact('s'), null);
      assert.deepEqual(await store.list('s'), before);
      if (builder.compactDetailed) assert.equal((await builder.compactDetailed('s')).status, 'not_needed');
    });

    test('compact（有时）：较早的历史压成摘要并记 ctx.compacted，最近 keep 条原样留着，原条目还在', async () => {
      const { builder, store } = await factory({ script: [{ type: 'text', text: '摘要甲' }] });
      if (!builder.compact) return;
      const written = await store.append('s', dialogue(10));
      const summary = await builder.compact('s', { keep: 2, minimum: 1 });
      assert.equal(summary?.type, 'summary');
      assert.equal(summary?.text, '摘要甲');
      assert.equal(summary?.covers, written[7]!.seq, 'covers 是被保留的第一条之前');
      const log = await store.list('s');
      assert.equal(log.filter((entry) => entry.type === 'message').length, 10, '原条目都在');
      assert.deepEqual(eventData(log, CTX_EVENTS.compacted), [{ covers: summary?.covers, summaryId: summary?.id }]);
      const view = await builder.view('s');
      assert.equal(view.messages.length, 3);
      assert.ok(textOf(view.messages[0]!).includes('摘要甲'));
      assert.deepEqual(said(view.messages.slice(1)), ['user:问8', 'assistant:答9']);
      assert.equal(view.summary?.id, summary?.id);
    });

    test('compact（有时）：摘要被截断时不写，返回 null；compactDetailed（有时）说是 truncated，和 not_needed 分得开', async () => {
      const step = { type: 'text', text: '半截', truncated: true } as const;
      const { builder, store } = await factory({ script: [step, step] });
      if (!builder.compact) return;
      await store.append('s', dialogue(10));
      assert.equal(await builder.compact('s', { keep: 2, minimum: 1 }), null);
      assert.deepEqual(await store.list('s', { types: ['summary'] }), []);
      if (!builder.compactDetailed) return;
      const result = await builder.compactDetailed('s', { keep: 2, minimum: 1 });
      assert.equal(result.status, 'truncated');
      assert.equal(result.summary, undefined);
      assert.equal(result.compacted, 0);
      assert.equal(result.remaining, 8);
      assert.ok(roundTrips(result), 'CompactResult 能 JSON 往返');
    });

    test('compact（有时）：历史超过 maxInputTokens 时分段滚动摘要，最后只有一条生效的摘要', async () => {
      const script = Array.from({ length: 64 }, (_, index) => ({ type: 'text', text: `摘要${index + 1}` }) as const);
      const { builder, store } = await factory({ script });
      if (!builder.compact) return;
      // 40 条、每条四百个字符：无论怎么估，一次 1500 token 的输入都放不下。
      await store.append('s', dialogue(40, 400));
      const summary = await builder.compact('s', { keep: 2, minimum: 1, maxInputTokens: 1_500 });
      assert.ok(summary, '压缩了');
      assert.notEqual(summary.text, '摘要1', '不是一次调用压完的');
      const view = await builder.view('s');
      assert.equal(view.messages.length, 3, '一条摘要 + 最近 2 条');
      assert.equal(view.summary?.id, summary.id);
      assert.equal(view.items.filter((item) => item.pinned).length, 1);
      if (!builder.compactDetailed) return;
      await store.append('s', dialogue(40, 400));
      const result = await builder.compactDetailed('s', { keep: 2, minimum: 1, maxInputTokens: 1_500 });
      assert.equal(result.status, 'compacted');
      assert.ok(result.calls >= 2, `调了 ${result.calls} 次模型`);
      assert.equal(result.remaining, 0);
      assert.equal((await builder.view('s')).summary?.id, result.summary?.id);
    });
  });
}
