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

function toolResult(id: string, name: string): Message {
  return { role: 'tool', content: [{ type: 'tool-result', id, name, output: { type: 'text', text: '好' } }] };
}

describe('project', () => {
  test('工具确认的部件不交给模型：去掉之后空了的消息不要，调用和结果照常配对', async () => {
    const entries = await seed(
      userEntry('删掉临时文件'),
      messageEntry({
        role: 'assistant',
        content: [
          { type: 'tool-call', id: 'c1', name: 'rm', input: { path: '/tmp/x' } },
          { type: 'tool-approval-request', approvalId: 'p1', callId: 'c1', reason: '要删文件' },
        ],
      }),
      messageEntry({ role: 'tool', content: [{ type: 'tool-approval-response', approvalId: 'p1', approved: true }] }),
      messageEntry(toolResult('c1', 'rm')),
      assistantEntry('删好了'),
    );
    assert.deepEqual(project(entries).messages, [
      { role: 'user', content: '删掉临时文件' },
      { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'rm', input: { path: '/tmp/x' } }] },
      toolResult('c1', 'rm'),
      { role: 'assistant', content: '删好了' },
    ]);
  });

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

  test('裁过之后开头不留助手消息：接着裁到下一条用户消息；一条用户消息都不剩时不动', async () => {
    const call: Message = { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'w', input: {} }] };
    const result: Message = {
      role: 'tool',
      content: [{ type: 'tool-result', id: 'c1', name: 'w', output: { type: 'text', text: '晴' } }],
    };
    const entries = await seed(
      userEntry('1'),
      assistantEntry('2'),
      userEntry('3'),
      messageEntry(call),
      messageEntry(result),
      assistantEntry('6'),
      userEntry('7'),
    );
    const roles = (maxMessages: number) =>
      project(entries, { window: { maxMessages } }).messages.map((message) => message.role);
    assert.deepEqual(roles(6), ['user', 'assistant', 'tool', 'assistant', 'user']);
    for (const maxMessages of [4, 3, 2, 1]) assert.deepEqual(roles(maxMessages), ['user'], String(maxMessages));
    assert.equal(project(entries, { window: { maxMessages: 6 } }).dropped, 2);
    assert.deepEqual(roles(7), ['user', 'assistant', 'user', 'assistant', 'tool', 'assistant', 'user'], '没裁就不动');
    // 没裁的历史以助手消息开头是应用自己写的，不替它改。
    const greeting = await seed(assistantEntry('早'), userEntry('早'));
    assert.deepEqual(
      project(greeting, { window: { maxMessages: 5 } }).messages.map((message) => message.role),
      ['assistant', 'user'],
    );
  });

  test('工具调用和结果按 id 配对：没有结果的调用补一条错误结果，没有调用的结果去掉', async () => {
    const call: Message = {
      role: 'assistant',
      content: [
        { type: 'text', text: '查一下' },
        { type: 'tool-call', id: 'c1', name: 'weather', input: {} },
        { type: 'tool-call', id: 'c2', name: 'clock', input: {} },
        { type: 'tool-call', id: 'c3', name: 'search', input: {}, providerExecuted: true },
      ],
    };
    // 运行断在工具调用之后：c1、c2 都没有结果。
    const dangling = project(await seed(userEntry('天气？'), messageEntry(call), userEntry('还在吗')));
    assert.deepEqual(
      dangling.messages.map((message) => message.role),
      ['user', 'assistant', 'tool', 'user'],
    );
    assert.deepEqual(dangling.messages[2]?.content, [
      {
        type: 'tool-result',
        id: 'c1',
        name: 'weather',
        output: { type: 'error', message: 'No result was recorded for this tool call.' },
      },
      {
        type: 'tool-result',
        id: 'c2',
        name: 'clock',
        output: { type: 'error', message: 'No result was recorded for this tool call.' },
      },
    ]);
    assert.deepEqual([dangling.items[2]?.from, dangling.items[2]?.upTo], [2, 2], '补的结果算在调用那一条上');
    assert.equal(
      dangling.tokens,
      dangling.items.reduce((sum, item) => sum + item.tokens, 0),
    );

    // 只回了一个，另带一个对不上的：对上的留下，对不上的去掉，没回的补上。
    const mixed: Message = {
      role: 'tool',
      content: [...(toolResult('c2', 'clock').content as []), ...(toolResult('zz', 'ghost').content as [])],
    };
    const partial = project(await seed(userEntry('天气？'), messageEntry(call), messageEntry(mixed)));
    assert.deepEqual(
      partial.messages
        .slice(2)
        .map((message) =>
          (message.content as unknown as { id: string; output: { type: string } }[]).map(
            (part) => `${part.id}:${part.output.type}`,
          ),
        ),
      [['c2:text'], ['c1:error']],
    );

    // 整条都对不上：这条工具消息不要。
    const stray = project(await seed(userEntry('在吗'), assistantEntry('在'), messageEntry(toolResult('zz', 'ghost'))));
    assert.deepEqual(
      stray.messages.map((message) => message.role),
      ['user', 'assistant'],
    );
  });

  test('一组折叠的事件有几十万条也不栈溢出', async () => {
    const entries: Entry[] = Array.from({ length: 200_000 }, (_, i) => ({
      ...eventEntry('pet.whisper', { text: '嗯' }),
      id: `e${i}`,
      session: 's',
      seq: i + 1,
      at: i + 1,
      v: ENTRY_VERSION,
    }));
    const { items } = project(entries, {
      events: { 'pet.whisper': { fold: true, render: () => ({ role: 'user', content: 'x' }) } },
    });
    assert.deepEqual([items[0]?.from, items[0]?.upTo], [1, 200_000]);
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

  test('only 只收这些名字，顺序按来源；没注册的名字、出错都记告警', async () => {
    const warnings: string[] = [];
    const facts = await collectFacts(
      [
        defineSource('task', () => '任务'),
        defineSource('clip', () => '粘贴板'),
        defineSource('boom', () => {
          throw new Error('nope');
        }),
      ],
      {
        session: 's',
        only: ['clip', 'ghost', 'task', 'boom'],
        logger: { warn: (message, data) => warnings.push(`${message}${data ? ` ${JSON.stringify(data)}` : ''}`) },
      },
    );
    assert.deepEqual(
      facts.map((fact) => fact.source),
      ['task', 'clip'],
    );
    assert.deepEqual(warnings, [
      'context source "ghost" is not registered',
      'context source "boom" failed {"error":"nope"}',
    ]);
  });
});
