import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { tool } from 'ai';
import { convertArrayToReadableStream, MockLanguageModelV4 } from 'ai/test';
import { z } from 'zod';

import { createContext } from './context.ts';
import { assistantEntry, eventEntry, userEntry, type ContextEntry } from './entry.ts';
import { defineSource } from './sources.ts';
import { createMemoryStore } from './store.ts';
import { createToolRegistry } from './tools.ts';

type GenerateResult = Awaited<ReturnType<MockLanguageModelV4['doGenerate']>>;

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

function textResult(text: string): GenerateResult {
  return {
    content: [{ type: 'text', text }],
    finishReason: { unified: 'stop', raw: 'stop' },
    usage,
    warnings: [],
  };
}

function shapeOf(entries: readonly ContextEntry[]): string[] {
  return entries.map((entry) => {
    if (entry.type !== 'message') return `${entry.type}`;
    const { content } = entry.message;
    if (typeof content === 'string') return `${entry.message.role}:${content}`;
    return `${entry.message.role}:${content.map((part) => part.type).join('+')}`;
  });
}

describe('createContext', () => {
  test('generate 先记下用户这句，再记回复；字符串指令后面跟着事实', async () => {
    const model = new MockLanguageModelV4({ doGenerate: textResult('在的') });
    const context = createContext({
      store: createMemoryStore(),
      thread: 'pet:main',
      model,
      sources: [defineSource('task', () => '当前任务：修天气地点')],
    });
    const result = await context.generate({ instructions: '你是桌宠', input: '在吗' });
    assert.equal(result.text, '在的');
    const prompt = model.doGenerateCalls[0]!.prompt;
    assert.deepEqual(prompt[0], { role: 'system', content: '你是桌宠\n\n当前任务：修天气地点' });
    assert.equal(prompt[1]?.role, 'user');
    assert.deepEqual(shapeOf(await context.entries()), ['user:在吗', 'assistant:text']);
    assert.equal(result.recorded.length, 2);
  });

  test('record:false 不写日志；prompt 函数拿到事实，放在最后', async () => {
    const model = new MockLanguageModelV4({ doGenerate: textResult('今天的你也很棒') });
    const store = createMemoryStore();
    const context = createContext({
      store,
      thread: 't',
      model,
      sources: [defineSource('task', () => '当前任务：写周报')],
      projection: {
        events: {
          whisper: {
            fold: true,
            render: (events) => ({ role: 'assistant', content: events.map((event) => event.text).join('\n') }),
          },
        },
      },
    });
    await context.append(eventEntry('whisper', { text: '在呢' }), eventEntry('whisper', { text: '喝水' }));
    await context.generate({
      instructions: '只说一句',
      prompt: (facts) => `${facts.map((fact) => fact.text).join('\n')}\n请再说一句碎碎念。`,
      record: false,
      temperature: 0.8,
    });
    const call = model.doGenerateCalls[0]!;
    assert.deepEqual(call.prompt[0], { role: 'system', content: '只说一句' });
    assert.deepEqual(call.prompt[1]?.content, [{ type: 'text', text: '在呢\n喝水' }]);
    assert.deepEqual(call.prompt.at(-1)?.content, [{ type: 'text', text: '当前任务：写周报\n请再说一句碎碎念。' }]);
    assert.equal(call.temperature, 0.8);
    assert.equal((await store.list('t')).length, 2);
  });

  test('工具多步调用：调用、结果和最后的回答都记下', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: [
        {
          content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'weather', input: '{"city":"台北"}' }],
          finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
          usage,
          warnings: [],
        },
        textResult('台北晴。'),
      ],
    });
    const tools = createToolRegistry().add(
      'weather',
      tool({
        description: '查天气',
        inputSchema: z.object({ city: z.string() }),
        execute: async ({ city }) => `${city}晴`,
      }),
    );
    const context = createContext({ store: createMemoryStore(), thread: 't', model, tools });
    const result = await context.generate({ input: '天气？' });
    assert.equal(result.text, '台北晴。');
    assert.deepEqual(shapeOf(await context.entries()), [
      'user:天气？',
      'assistant:tool-call',
      'tool:tool-result',
      'assistant:text',
    ]);
    assert.ok(model.doGenerateCalls[0]!.tools?.some((item) => item.name === 'weather'));

    const none = new MockLanguageModelV4({ doGenerate: textResult('好') });
    await context.generate({ model: none, input: '不用工具', tools: false });
    assert.equal(none.doGenerateCalls[0]!.tools, undefined);
  });

  test('stream 结束后把回复写进日志', async () => {
    const model = new MockLanguageModelV4({
      doStream: {
        stream: convertArrayToReadableStream([
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id: '1' },
          { type: 'text-delta', id: '1', delta: '你' },
          { type: 'text-delta', id: '1', delta: '好' },
          { type: 'text-end', id: '1' },
          { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
        ]),
      },
    });
    const context = createContext({ store: createMemoryStore(), thread: 't', model });
    const recorded = new Promise<readonly ContextEntry[]>((resolve) => {
      void context.stream({ input: '嗨', onRecorded: resolve }).then((result) => result.consumeStream());
    });
    assert.deepEqual(shapeOf(await recorded), ['assistant:text']);
    assert.deepEqual(shapeOf(await context.entries()), ['user:嗨', 'assistant:text']);
  });

  test('compact 把旧历史压成摘要，之后的视图从摘要开始', async () => {
    const summarizer = new MockLanguageModelV4({ doGenerate: textResult('主人每天下午喝水，喜欢简短的提醒。') });
    let clock = 0;
    const context = createContext({
      store: createMemoryStore({ now: () => (clock += 1) }),
      thread: 't',
      model: summarizer,
    });
    for (let i = 0; i < 10; i += 1) {
      await context.append(userEntry(`问题${i}`), assistantEntry(`回答${i}`));
    }
    const summary = await context.compact({ keep: 4, minimum: 4 });
    assert.equal(summary?.text, '主人每天下午喝水，喜欢简短的提醒。');
    const sent = summarizer.doGenerateCalls[0]!.prompt.at(-1)?.content;
    assert.match(JSON.stringify(sent), /user: 问题0/);
    assert.doesNotMatch(JSON.stringify(sent), /问题8/);

    const view = await context.view();
    assert.equal(view.messages.length, 5);
    assert.match(String(view.messages[0]?.content), /主人每天下午喝水/);
    assert.equal(view.messages[1]?.content, '问题8');

    await context.append(userEntry('新的一句'));
    assert.equal(await context.compact({ keep: 4, minimum: 4 }), null, '摘要之后的历史不够长');
  });

  test('没有模型时报清楚的错', async () => {
    const context = createContext({ store: createMemoryStore(), thread: 't' });
    await assert.rejects(context.generate({ prompt: 'hi' }), /No language model/);
  });
});
