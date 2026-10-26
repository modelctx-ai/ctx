import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

import { tool } from 'ai';
import { convertArrayToReadableStream, MockLanguageModelV4 } from 'ai/test';
import { z } from 'zod';
import { describe, test } from 'vite-plus/test';

import {
  assistantEntry,
  defineSource,
  eventEntry,
  messageEntry,
  textOf,
  userEntry,
  type Entry,
  type NewEntry,
  type SessionStore,
} from '@modelctx-ai/ctx-protocol';

import { createContext } from './context.ts';
import { createMemoryStore } from './store.ts';
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
function wrapStore(base: SessionStore, before: (entries: readonly NewEntry[]) => Promise<void>): SessionStore {
  return {
    ...base,
    append: async (session, entries) => {
      await before(entries);
      return base.append(session, entries);
    },
  };
}

/** 消息写成 `role:内容`，框架事件写成 kind，其余写类型。 */
function shapeOf(entries: readonly Entry[]): string[] {
  return entries.map((entry) => {
    if (entry.type === 'event') return entry.kind;
    if (entry.type !== 'message') return entry.type;
    const { content } = entry.message;
    if (typeof content === 'string') return `${entry.message.role}:${content}`;
    return `${entry.message.role}:${content.map((part) => part.type).join('+')}`;
  });
}

/** 只看消息。 */
function messagesOf(entries: readonly Entry[]): string[] {
  return shapeOf(entries.filter((entry) => entry.type === 'message'));
}

/** 每次一个新模型：流一开始就报 401。 */
function failingModel(): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doStream: async () => {
      throw new Error('401 Unauthorized');
    },
  });
}

describe('createContext', () => {
  test('generate 先记下用户这句，再记回复；字符串指令后面跟着事实', async () => {
    const model = new MockLanguageModelV4({ doGenerate: textResult('在的') });
    const context = createContext({
      store: createMemoryStore(),
      session: 'pet:main',
      model,
      sources: [defineSource('task', () => '当前任务：修天气地点')],
    });
    const result = await context.generate({ instructions: '你是桌宠', input: '在吗' });
    assert.equal(result.text, '在的');
    const prompt = model.doGenerateCalls[0]!.prompt;
    assert.deepEqual(prompt[0], { role: 'system', content: '你是桌宠\n\n当前任务：修天气地点' });
    assert.equal(prompt[1]?.role, 'user');
    assert.deepEqual(shapeOf(await context.entries()), [
      'ctx.run.started',
      'user:在吗',
      'assistant:text',
      'ctx.run.ended',
    ]);
    assert.equal(result.recorded.length, 4);
    assert.equal(result.stopReason, 'end_turn');
    assert.equal(typeof result.runId, 'string');
  });

  test('record:false 不写日志；prompt 函数拿到事实，放在最后', async () => {
    const model = new MockLanguageModelV4({ doGenerate: textResult('今天的你也很棒') });
    const store = createMemoryStore();
    const context = createContext({
      store,
      session: 't',
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
    const context = createContext({ store: createMemoryStore(), session: 't', model, tools });
    const result = await context.generate({ input: '天气？' });
    assert.equal(result.text, '台北晴。');
    assert.deepEqual(messagesOf(await context.entries()), [
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
      session: 't',
      model: new MockLanguageModelV4({ doStream: [textStream('你好'), textStream('嗯')] }),
    });
    const { result, recorded } = await context.stream({ input: '嗨' });
    assert.equal(await result.text, '你好');
    assert.deepEqual(shapeOf(await recorded), ['ctx.run.started', 'user:嗨', 'assistant:text', 'ctx.run.ended']);
    assert.deepEqual(messagesOf(await base.list('t')), ['user:嗨', 'assistant:text']);

    const quiet = await context.stream({ input: '不记', record: false });
    await quiet.result.consumeStream();
    assert.deepEqual(await quiet.recorded, []);
    assert.equal((await base.list('t')).length, 4);
  });

  test('stream 出错时 recorded 只有用户这句和 ctx.run.*；onError 只在给了回调或 logger 时接管', async () => {
    const printed: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      printed.push(args[0]);
    };
    try {
      const warned: string[] = [];
      const logged = createContext({
        store: createMemoryStore(),
        session: 't',
        model: failingModel(),
        logger: { warn: (message) => warned.push(message) },
      });
      const first = await logged.stream({ input: '在吗', maxRetries: 0 });
      assert.deepEqual(shapeOf(await first.recorded), ['ctx.run.started', 'user:在吗', 'ctx.error', 'ctx.run.ended']);
      assert.deepEqual(warned, ['stream failed']);

      const plain = createContext({ store: createMemoryStore(), session: 't', model: failingModel() });
      const seen: unknown[] = [];
      const second = await plain.stream({ input: '在吗', maxRetries: 0, onError: (error) => seen.push(error) });
      await second.recorded;
      assert.equal((seen[0] as Error | undefined)?.message, '401 Unauthorized');
      assert.equal(printed.length, 0);

      const third = await plain.stream({ input: '还在吗', maxRetries: 0 });
      assert.deepEqual(messagesOf(await third.recorded), ['user:还在吗']);
      assert.equal((printed[0] as Error | undefined)?.message, '401 Unauthorized', '缺省交给 AI SDK 的 console.error');
    } finally {
      console.error = original;
    }
  });

  test('stream 的回复写不进日志时 recorded reject 并告警；不读流也会跑完', async () => {
    let writes = 0;
    const warned: string[] = [];
    const context = createContext({
      // 前两次是 ctx.run.started 和用户这句，第三次写回复时失败。
      store: wrapStore(createMemoryStore(), async () => {
        writes += 1;
        if (writes > 2) throw new Error('disk full');
      }),
      session: 't',
      model: new MockLanguageModelV4({ doStream: textStream('你好') }),
      logger: { warn: (message) => warned.push(message) },
    });
    const { recorded } = await context.stream({ input: '嗨' });
    await assert.rejects(recorded, /disk full/);
    assert.deepEqual(warned, ['failed to record run']);
  });

  test('投影出的 system 消息不进 messages，文字按顺序接到这次的指令后面', async () => {
    let clock = 0;
    const model = new MockLanguageModelV4({ doGenerate: textResult('好') });
    const context = createContext({
      store: createMemoryStore({ now: () => (clock += 1) }),
      session: 't',
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
    const bare = createContext({ store: createMemoryStore(), session: 't' });
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
    const context = createContext({ store: createMemoryStore(), session: 't', model });
    await assert.rejects(context.generate({ input: '几点了？', inputKey: 'turn-1', maxRetries: 0 }), /network down/);
    assert.deepEqual(messagesOf(await context.entries()), ['user:几点了？'], '先记下的用户这句留在日志里');
    fail = false;
    const retry = await context.generate({ input: '几点了？', inputKey: 'turn-1', maxRetries: 0 });
    assert.deepEqual(messagesOf(retry.recorded), ['assistant:text']);
    assert.deepEqual(messagesOf(await context.entries()), ['user:几点了？', 'assistant:text']);
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
      session: 't',
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
    assert.match(JSON.stringify(view.messages[0]?.content), /主人每天下午喝水/);
    assert.equal(view.messages[1]?.content, '问题8');

    const [compacted] = await context.entries({ types: ['event'] });
    assert.deepEqual(compacted?.type === 'event' && [compacted.kind, compacted.data], [
      'ctx.compacted',
      { covers: summary?.covers, summaryId: summary?.id },
    ]);

    await context.append(userEntry('新的一句'));
    assert.equal(await context.compact({ keep: 4, minimum: 4 }), null, '摘要之后的历史不够长');
  });

  test('compact：没有可压的就不调模型；摘要被截断时不写', async () => {
    const unused = new MockLanguageModelV4({ doGenerate: textResult('不该用到') });
    const short = createContext({ store: createMemoryStore(), session: 't', model: unused });
    for (let i = 0; i < 6; i += 1) await short.append(userEntry(`问题${i}`), assistantEntry(`回答${i}`));
    assert.equal(await short.compact({ minimum: 0 }), null);
    assert.equal(unused.doGenerateCalls.length, 0);

    const warned: string[] = [];
    const truncated = new MockLanguageModelV4({
      doGenerate: { ...textResult('主人喜欢简短的提'), finishReason: { unified: 'length', raw: 'max_tokens' } },
    });
    const context = createContext({
      store: createMemoryStore(),
      session: 't',
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
      session: 't',
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
    const context = createContext({ store: createMemoryStore(), session: 't' });
    await assert.rejects(context.generate({ prompt: 'hi' }), /No language model/);
  });

  test('factsPlacement: prompt 把事实放进最后一条临时用户消息，system 前缀不变', async () => {
    const model = new MockLanguageModelV4({ doGenerate: [textResult('好'), textResult('好')] });
    let task = '写周报';
    const context = createContext({
      store: createMemoryStore(),
      session: 't',
      model,
      factsPlacement: 'prompt',
      sources: [defineSource('task', () => `当前任务：${task}`)],
    });
    await context.generate({ instructions: '你是桌宠', input: '在吗', prompt: '说一句' });
    task = '修 bug';
    await context.generate({ instructions: '你是桌宠', input: '还在吗' });
    const [first, second] = model.doGenerateCalls.map((call) => call.prompt);
    assert.deepEqual(first?.[0], { role: 'system', content: '你是桌宠' });
    assert.deepEqual(second?.[0], first?.[0], 'system 前缀一样');
    assert.deepEqual(first?.at(-1)?.content, [{ type: 'text', text: '当前任务：写周报\n\n说一句' }]);
    assert.deepEqual(second?.at(-1)?.content, [{ type: 'text', text: '当前任务：修 bug' }]);
    assert.ok(!JSON.stringify(await context.entries()).includes('当前任务'), '事实不写日志');
  });

  test('thread 是 session 的弃用别名；门面暴露 builder、executor、harness', async () => {
    const model = new MockLanguageModelV4({ doGenerate: textResult('在的') });
    const tools = createToolRegistry();
    const context = createContext({ store: createMemoryStore(), thread: 'old', model, tools });
    assert.equal(context.session, 'old');
    assert.equal(context.thread, 'old');
    assert.equal(context.executor, tools.executor);
    const result = await context.harness.run({ session: 'old', agent: { model }, input: '在吗' });
    assert.equal(result.text, '在的');
    assert.equal((await context.builder.view('old')).messages.length, 2);
    assert.throws(() => createContext({ store: createMemoryStore() } as never), /Pass `session`/);
  });

  test('generate 被取消时抛出；harness.run 同样的情况返回 aborted', async () => {
    const model = new MockLanguageModelV4({ doGenerate: textResult('不该说') });
    const context = createContext({ store: createMemoryStore(), session: 't', model });
    await assert.rejects(context.generate({ input: '在吗', signal: AbortSignal.abort() }));
    const result = await context.harness.run({ session: 't', agent: { model }, signal: AbortSignal.abort() });
    assert.equal(result.stopReason, 'aborted');
    assert.equal(model.doGenerateCalls.length, 0);
  });
});
