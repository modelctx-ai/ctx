import assert from 'node:assert/strict';

import type { ModelMessage } from 'ai';
import { describe, test } from 'vite-plus/test';

import {
  assistantEntry,
  eventEntry,
  messageEntry,
  userEntry,
  type EventEntry,
  type NewEntry,
  type SummaryEntry,
} from './entry.ts';
import { project, type EventRule } from './projection.ts';
import { createMemoryStore } from './store.ts';

const whisper: EventRule = {
  fold: true,
  render: (events: readonly EventEntry[]) => ({
    role: 'assistant',
    content: `碎碎念：\n${events.map((event) => event.text).join('\n')}`,
  }),
};

async function seed(...drafts: NewEntry[]) {
  let clock = 0;
  const store = createMemoryStore({ now: () => (clock += 1) });
  return store.append('t', drafts);
}

describe('project', () => {
  test('连续碎碎念合成一条，对话原句不截断', async () => {
    const entries = await seed(
      eventEntry('whisper', { text: '在呢' }),
      eventEntry('whisper', { text: '水记得喝一口哦' }),
      userEntry('今天海淀的天气要说完整，不要砍掉后半句'),
      assistantEntry('傍晚会下雨，出门带伞。'),
      eventEntry('whisper', { text: '我在旁边盯着呢' }),
    );
    const { messages } = project(entries, { events: { whisper } });
    assert.deepEqual(messages, [
      { role: 'assistant', content: '碎碎念：\n在呢\n水记得喝一口哦' },
      { role: 'user', content: '今天海淀的天气要说完整，不要砍掉后半句' },
      { role: 'assistant', content: '傍晚会下雨，出门带伞。' },
      { role: 'assistant', content: '碎碎念：\n我在旁边盯着呢' },
    ]);
  });

  test('没有规则的事件不进上下文，也不打断合并', async () => {
    const entries = await seed(
      eventEntry('whisper', { text: '甲' }),
      eventEntry('clipboard', { text: '复制了点东西' }),
      eventEntry('whisper', { text: '乙' }),
    );
    const { messages } = project(entries, { events: { whisper } });
    assert.deepEqual(messages, [{ role: 'assistant', content: '碎碎念：\n甲\n乙' }]);
  });

  test('摘要代替它覆盖的条目，并固定在最前', async () => {
    const entries = await seed(userEntry('很早的问题'), assistantEntry('很早的回答'), userEntry('新问题'));
    const summary: SummaryEntry = {
      type: 'summary',
      text: '聊过早先的事',
      covers: { at: entries[1]!.at, seq: entries[1]!.seq },
      id: 's',
      thread: 't',
      seq: 99,
      at: 99,
    };
    const result = project([...entries, summary]);
    assert.equal(result.summary?.id, 's');
    assert.deepEqual(
      result.messages.map((message) => message.content),
      ['Summary of the earlier conversation:\n聊过早先的事', '新问题'],
    );
    assert.equal(result.items[0]?.pinned, true);
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
    const call: ModelMessage = {
      role: 'assistant',
      content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'weather', input: { city: '台北' } }],
    };
    const result: ModelMessage = {
      role: 'tool',
      content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'weather', output: { type: 'text', value: '晴' } }],
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
