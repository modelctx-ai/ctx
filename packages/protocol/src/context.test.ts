import assert from 'node:assert/strict';

import { describe, test } from 'vite-plus/test';

import type { Message } from './message.ts';
import { collectFacts, defineSource, latestSummary, project, renderFacts, type EventRule } from './context.ts';
import {
  assistantEntry,
  eventEntry,
  messageEntry,
  userEntry,
  type Entry,
  type EventEntry,
  type NewEntry,
  type SummaryEntry,
} from './session.ts';
import { ENTRY_VERSION } from './version.ts';

const whisper: EventRule = {
  fold: true,
  render: (events: readonly EventEntry[]) => ({
    role: 'assistant',
    content: `碎碎念：\n${events.map((event) => event.text).join('\n')}`,
  }),
};

/** 照存储的样子补上 id、session、seq、at：协议包里没有存储实现。 */
async function seed(...drafts: NewEntry[]): Promise<Entry[]> {
  return drafts.map((draft, i) => ({
    ...draft,
    id: draft.id ?? `e${i}`,
    session: 's',
    seq: i + 1,
    at: draft.at ?? i + 1,
    v: ENTRY_VERSION,
  }));
}

function summaryOf(id: string, covers: Entry, seq: number): SummaryEntry {
  return {
    type: 'summary',
    text: id,
    covers: covers.seq,
    id,
    session: 's',
    seq,
    at: 100 + seq,
    v: ENTRY_VERSION,
  };
}

describe('project', () => {
  test('连续碎碎念合成一条，对话原句不截断', async () => {
    const entries = await seed(
      eventEntry('pet.whisper', { text: '在呢' }),
      eventEntry('pet.whisper', { text: '水记得喝一口哦' }),
      userEntry('今天海淀的天气要说完整，不要砍掉后半句'),
      assistantEntry('傍晚会下雨，出门带伞。'),
      eventEntry('pet.whisper', { text: '我在旁边盯着呢' }),
    );
    const { messages } = project(entries, { events: { 'pet.whisper': whisper } });
    assert.deepEqual(messages, [
      { role: 'assistant', content: '碎碎念：\n在呢\n水记得喝一口哦' },
      { role: 'user', content: '今天海淀的天气要说完整，不要砍掉后半句' },
      { role: 'assistant', content: '傍晚会下雨，出门带伞。' },
      { role: 'assistant', content: '碎碎念：\n我在旁边盯着呢' },
    ]);
  });

  test('没有规则的事件不进上下文，也不打断合并', async () => {
    const entries = await seed(
      eventEntry('pet.whisper', { text: '甲' }),
      eventEntry('pet.clipboard', { text: '复制了点东西' }),
      eventEntry('pet.whisper', { text: '乙' }),
    );
    const { messages } = project(entries, { events: { 'pet.whisper': whisper } });
    assert.deepEqual(messages, [{ role: 'assistant', content: '碎碎念：\n甲\n乙' }]);
  });

  test('摘要代替它覆盖的条目，并固定在最前', async () => {
    const entries = await seed(userEntry('很早的问题'), assistantEntry('很早的回答'), userEntry('新问题'));
    const summary: SummaryEntry = {
      type: 'summary',
      text: '聊过早先的事',
      covers: entries[1]!.seq,
      id: 's',
      session: 's',
      seq: 99,
      at: 99,
      v: ENTRY_VERSION,
    };
    const result = project([...entries, summary]);
    assert.equal(result.summary?.id, 's');
    assert.deepEqual(
      result.messages.map((message) => message.content),
      ['Summary of the earlier conversation:\n聊过早先的事', '新问题'],
    );
    assert.equal(result.items[0]?.pinned, true);
  });

  test('生效的摘要是覆盖范围最大的那一条，不看写入先后', async () => {
    const entries = await seed(userEntry('1'), userEntry('2'), userEntry('3'));
    const wide = summaryOf('wide', entries[1]!, 10);
    const narrow = summaryOf('narrow', entries[0]!, 11);
    assert.equal(latestSummary([...entries, wide, narrow])?.id, 'wide');
    assert.deepEqual(
      project([...entries, narrow, wide]).messages.map((message) => message.content),
      ['Summary of the earlier conversation:\nwide', '3'],
    );
  });

  test('覆盖范围相同时后写的摘要生效，不看出现的先后', async () => {
    const entries = await seed(userEntry('1'), userEntry('2'), userEntry('3'));
    const first = summaryOf('first', entries[1]!, 10);
    const second = summaryOf('second', entries[1]!, 11);
    assert.equal(latestSummary([first, second])?.id, 'second');
    assert.equal(latestSummary([second, first])?.id, 'second');
  });

  test('补写的旧记录：位置按 seq，投影顺序按 (at, seq)；摘要之后补写的仍然可见', async () => {
    // a、b 之后压缩（摘要 covers = b.seq），再补写 at 早于 b 的 late，再写 c。
    const entries = await seed(
      userEntry('a', { at: 10 }),
      userEntry('b', { at: 20 }),
      { type: 'summary', text: 'sum of a,b', covers: 2, id: 'sum', at: 30 },
      userEntry('late', { at: 15 }),
      userEntry('c', { at: 40 }),
    );
    assert.deepEqual(
      project(entries).messages.map((message) => message.content),
      ['Summary of the earlier conversation:\nsum of a,b', 'late', 'c'],
    );
  });

  test('投影项带它覆盖的条目的 seq 范围：from 是最小的，upTo 是最大的', async () => {
    const entries = await seed(
      eventEntry('pet.whisper', { text: '甲' }),
      eventEntry('pet.whisper', { text: '乙' }),
      userEntry('丙'),
    );
    const { items } = project(entries, { events: { 'pet.whisper': whisper } });
    assert.deepEqual(
      items.map((item) => [item.from, item.upTo]),
      [
        [1, 2],
        [3, 3],
      ],
    );
  });

  test('窗口从最旧开始裁，至少留最后一组', async () => {
    const entries = await seed(userEntry('1'), assistantEntry('2'), userEntry('3'), assistantEntry('4'));
    const two = project(entries, { window: { maxMessages: 2 } });
    assert.deepEqual(
      two.messages.map((message) => message.content),
      ['3', '4'],
    );
    assert.equal(two.dropped, 2);
    const tiny = project(entries, { window: { maxTokens: 1 } });
    assert.deepEqual(
      tiny.messages.map((message) => message.content),
      ['4'],
    );
  });

  test('工具调用和结果成组进出，开头不留孤立的工具结果', async () => {
    const call: Message = {
      role: 'assistant',
      content: [{ type: 'tool-call', id: 'c1', name: 'weather', input: { city: '台北' } }],
    };
    const result: Message = {
      role: 'tool',
      content: [{ type: 'tool-result', id: 'c1', name: 'weather', output: { type: 'text', text: '晴' } }],
    };
    const entries = await seed(userEntry('天气？'), messageEntry(call), messageEntry(result), assistantEntry('晴天。'));
    const kept = project(entries, { window: { maxMessages: 3 } });
    assert.deepEqual(
      kept.messages.map((message) => message.role),
      ['assistant', 'tool', 'assistant'],
    );
    const orphan = project(entries.slice(2));
    assert.deepEqual(
      orphan.messages.map((message) => message.role),
      ['assistant'],
    );
  });

  test('message 钩子可以改写或丢掉消息', async () => {
    const entries = await seed(userEntry('留下'), assistantEntry('丢掉'));
    const { messages } = project(entries, {
      message: (entry) => (entry.message.role === 'assistant' ? null : entry.message),
    });
    assert.deepEqual(messages, [{ role: 'user', content: '留下' }]);
  });
});

describe('context sources', () => {
  test('按来源顺序收集，空内容跳过，前后空白去掉', async () => {
    const facts = await collectFacts(
      [
        defineSource('task', ({ session }) => `  当前任务（${session}）：修天气地点  `),
        defineSource('empty', () => '   '),
        defineSource('clip', async () => '粘贴板：hello'),
        defineSource('none', () => null),
      ],
      { session: 's' },
    );
    assert.deepEqual(facts, [
      { source: 'task', text: '当前任务（s）：修天气地点' },
      { source: 'clip', text: '粘贴板：hello' },
    ]);
    assert.equal(renderFacts(facts, '上下文：'), '上下文：\n当前任务（s）：修天气地点\n粘贴板：hello');
  });

  test('一个来源出错或超时，不影响别的', async () => {
    const failed: string[] = [];
    const facts = await collectFacts(
      [
        defineSource('boom', () => {
          throw new Error('nope');
        }),
        defineSource('slow', () => new Promise((resolve) => setTimeout(() => resolve('太慢了'), 200))),
        defineSource('ok', () => '还在'),
      ],
      { session: 's', timeoutMs: 20, onError: (name) => failed.push(name) },
    );
    assert.deepEqual(
      facts.map((fact) => fact.text),
      ['还在'],
    );
    assert.deepEqual(failed.toSorted(), ['boom', 'slow']);
  });
});
