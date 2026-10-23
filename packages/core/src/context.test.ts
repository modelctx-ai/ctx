import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { tool } from 'ai';
import { convertArrayToReadableStream, MockLanguageModelV4 } from 'ai/test';
import { z } from 'zod';

import { createContext } from './context.ts';
import {
  assistantEntry,
  eventEntry,
  messageEntry,
  textOf,
  userEntry,
  type ContextEntry,
  type NewEntry,
} from './entry.ts';
import { defineSource } from './sources.ts';
import { createMemoryStore, type ContextStore } from './store.ts';
import { createToolRegistry } from './tools.ts';

type GenerateResult = Awaited<ReturnType<MockLanguageModelV4['doGenerate']>>;
type StreamResult = Awaited<ReturnType<MockLanguageModelV4['doStream']>>;
type StreamPart = StreamResult['stream'] extends ReadableStream<infer Part> ? Part : never;

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

function textStream(text: string): StreamResult {
  const parts: StreamPart[] = [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: '1' },
    { type: 'text-delta', id: '1', delta: text },
    { type: 'text-end', id: '1' },
    { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
  ];
  return { stream: convertArrayToReadableStream(parts) };
}

/** 包一层存储：每次追加先等一会儿，或者按需失败。 */
function wrapStore(base: ContextStore, before: (entries: readonly NewEntry[]) => Promise<void>): ContextStore {
  return {
    ...base,
    append: async (thread, entries) => {
      await before(entries);
      return base.append(thread, entries);
    },
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

  test('stream：recorded 等回复写进日志才给出，含先写的用户这句', async () => {
    const base = createMemoryStore();
    const context = createContext({
      store: wrapStore(base, () => delay(20)),
      thread: 't',
      model: new MockLanguageModelV4({ doStream: [textStream('你好'), textStream('嗯')] }),
    });
    const { result, recorded } = await context.stream({ input: '嗨' });
    assert.equal(await result.text, '你好');
    assert.deepEqual(shapeOf(await recorded), ['user:嗨', 'assistant:text']);
    assert.deepEqual(shapeOf(await base.list('t')), ['user:嗨', 'assistant:text']);

    const quiet = await context.stream({ input: '不记', record: false });
    await quiet.result.consumeStream();
    assert.deepEqual(await quiet.recorded, []);
    assert.equal((await base.list('t')).length, 2);
  });

  test('stream 出错时 recorded 只有用户这句；onError 只在给了回调或 logger 时接管', async () => {
    const failing = () =>
      new MockLanguageModelV4({
        doStream: async () => {
          throw new Error('401 Unauthorized');
        },
      });
    const printed: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      printed.push(args[0]);
    };
    try {
      const warned: string[] = [];
      const logged = createContext({
        store: createMemoryStore(),
        thread: 't',
        model: failing(),
        logger: { warn: (message) => warned.push(message) },
      });
      const first = await logged.stream({ input: '在吗', maxRetries: 0 });
      assert.deepEqual(shapeOf(await first.recorded), ['user:在吗']);
      assert.deepEqual(warned, ['stream failed']);

      const plain = createContext({ store: createMemoryStore(), thread: 't', model: failing() });
      const seen: unknown[] = [];
      const second = await plain.stream({ input: '在吗', maxRetries: 0, onError: (error) => seen.push(error) });
      await second.recorded;
      assert.equal((seen[0] as Error | undefined)?.message, '401 Unauthorized');
      assert.equal(printed.length, 0);

      const third = await plain.stream({ input: '还在吗', maxRetries: 0 });
      assert.deepEqual(shapeOf(await third.recorded), ['user:还在吗']);
      assert.equal((printed[0] as Error | undefined)?.message, '401 Unauthorized', '缺省交给 AI SDK 的 console.error');
    } finally {
      console.error = original;
    }
  });

  test('stream 的回复写不进日志时 recorded reject 并告警；不读流也会跑完', async () => {
    let writes = 0;
    const warned: string[] = [];
    const context = createContext({
      store: wrapStore(createMemoryStore(), async () => {
        writes += 1;
        if (writes > 1) throw new Error('disk full');
      }),
      thread: 't',
      model: new MockLanguageModelV4({ doStream: textStream('你好') }),
      logger: { warn: (message) => warned.push(message) },
    });
    const { recorded } = await context.stream({ input: '嗨' });
    await assert.rejects(recorded, /disk full/);
    assert.deepEqual(warned, ['failed to record streamed response']);
  });

  test('投影出的 system 消息不进 messages，文字按顺序接到这次的指令后面', async () => {
    let clock = 0;
    const model = new MockLanguageModelV4({ doGenerate: textResult('好') });
    const context = createContext({
      store: createMemoryStore({ now: () => (clock += 1) }),
      thread: 't',
      model,
      sources: [defineSource('task', () => '当前任务：写周报')],
      projection: {
        summary: (entry) => ({ role: 'system', content: `摘要：${entry.text}` }),
        events: { note: { render: (events) => ({ role: 'system', content: `备注：${events[0]?.text}` }) } },
        message: (entry) =>
          entry.meta?.['persona'] ? { role: 'system', content: textOf(entry.message) } : entry.message,
      },
    });
    const [, covered] = await context.append(userEntry('很早的话'), assistantEntry('很早的回答'));
    await context.append({ type: 'summary', text: '聊过早先的事', covers: { at: covered!.at, seq: covered!.seq } });
    await context.append(
      messageEntry({ role: 'system', content: '说话简短' }),
      eventEntry('note', { text: '主人在开会' }),
      userEntry('人设：傲娇', { meta: { persona: true } }),
      userEntry('在吗'),
    );

    const prepared = await context.prepare({ instructions: '你是桌宠' });
    assert.equal(
      prepared.instructions,
      '你是桌宠\n\n当前任务：写周报\n\n摘要：聊过早先的事\n\n说话简短\n\n备注：主人在开会\n\n人设：傲娇',
    );
    assert.deepEqual(prepared.messages, [{ role: 'user', content: '在吗' }]);

    await context.generate({ instructions: '你是桌宠', input: '今天呢' });
    const prompt = model.doGenerateCalls[0]!.prompt;
    assert.deepEqual(
      prompt.map((message) => message.role),
      ['system', 'user', 'user'],
    );
    assert.equal(prompt[0]?.content, prepared.instructions);
  });

  test('没有模型时什么都不写；inputKey 让失败后的重试不再记一遍用户这句', async () => {
    const bare = createContext({ store: createMemoryStore(), thread: 't' });
    await assert.rejects(bare.generate({ input: '在吗' }), /No language model/);
    await assert.rejects(bare.stream({ input: '在吗' }), /No language model/);
    assert.deepEqual(await bare.entries(), []);

    let fail = true;
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        if (fail) throw new Error('network down');
        return textResult('三点了');
      },
    });
    const context = createContext({ store: createMemoryStore(), thread: 't', model });
    await assert.rejects(context.generate({ input: '几点了？', inputKey: 'turn-1', maxRetries: 0 }), /network down/);
    assert.deepEqual(shapeOf(await context.entries()), ['user:几点了？'], '先记下的用户这句留在日志里');
    fail = false;
    const retry = await context.generate({ input: '几点了？', inputKey: 'turn-1', maxRetries: 0 });
    assert.deepEqual(shapeOf(retry.recorded), ['assistant:text']);
    assert.deepEqual(shapeOf(await context.entries()), ['user:几点了？', 'assistant:text']);
    assert.deepEqual(
      model.doGenerateCalls.at(-1)!.prompt.map((message) => message.role),
      ['user'],
    );
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

  test('compact：没有可压的就不调模型；摘要被截断时不写', async () => {
    const unused = new MockLanguageModelV4({ doGenerate: textResult('不该用到') });
    const short = createContext({ store: createMemoryStore(), thread: 't', model: unused });
    for (let i = 0; i < 6; i += 1) await short.append(userEntry(`问题${i}`), assistantEntry(`回答${i}`));
    assert.equal(await short.compact({ minimum: 0 }), null);
    assert.equal(unused.doGenerateCalls.length, 0);

    const warned: string[] = [];
    const truncated = new MockLanguageModelV4({
      doGenerate: { ...textResult('主人喜欢简短的提'), finishReason: { unified: 'length', raw: 'max_tokens' } },
    });
    const context = createContext({
      store: createMemoryStore(),
      thread: 't',
      model: truncated,
      logger: { warn: (message) => warned.push(message) },
    });
    for (let i = 0; i < 10; i += 1) await context.append(userEntry(`问题${i}`), assistantEntry(`回答${i}`));
    assert.equal(await context.compact({ keep: 4, minimum: 4 }), null);
    assert.equal(truncated.doGenerateCalls.length, 1);
    assert.deepEqual(await context.entries({ types: ['summary'] }), []);
    assert.deepEqual(warned, ['summary hit maxOutputTokens; history not compacted']);
  });

  test('compact 的输入里图片、文件只留占位，不带数据', async () => {
    const summarizer = new MockLanguageModelV4({ doGenerate: textResult('截了图') });
    let clock = 0;
    const context = createContext({
      store: createMemoryStore({ now: () => (clock += 1) }),
      thread: 't',
      model: summarizer,
    });
    const data = Buffer.alloc(3000, 7).toString('base64');
    await context.append(
      messageEntry({
        role: 'user',
        content: [
          { type: 'text', text: '看图' },
          { type: 'image', image: data, mediaType: 'image/png' },
        ],
      }),
      messageEntry({
        role: 'assistant',
        content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'screenshot', input: {} }],
      }),
      messageEntry({
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'c1',
            toolName: 'screenshot',
            output: {
              type: 'content',
              value: [
                { type: 'text', text: '截好了' },
                { type: 'file', mediaType: 'image/png', data: { type: 'data', data } },
              ],
            },
          },
        ],
      }),
      assistantEntry('好'),
    );
    for (let i = 0; i < 4; i += 1) await context.append(userEntry(`问题${i}`), assistantEntry(`回答${i}`));
    assert.ok(await context.compact({ keep: 2, minimum: 1 }));
    const sent = JSON.stringify(summarizer.doGenerateCalls[0]!.prompt);
    assert.match(sent, /user: 看图 \[image image\/png\]/);
    assert.match(sent, /screenshot returned 截好了 \[file image\/png\]/);
    assert.ok(!sent.includes(data.slice(0, 64)), '不带 base64');
  });

  test('没有模型时报清楚的错', async () => {
    const context = createContext({ store: createMemoryStore(), thread: 't' });
    await assert.rejects(context.generate({ prompt: 'hi' }), /No language model/);
  });
});
