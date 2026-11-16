import assert from 'node:assert/strict';

import { APICallError, RetryError } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { describe, test } from 'vite-plus/test';

import {
  assistantEntry,
  CTX_EVENTS,
  eventEntry,
  isContextOverflow,
  messageEntry,
  textOf,
  userEntry,
  type AgentSpec,
  type Entry,
  type Logger,
  type NewEntry,
  type OverflowSpec,
  type RunEvent,
} from '@modelctx-ai/ctx-protocol';

import { createContextBuilder } from './builder.ts';
import { createContext } from './context.ts';
import { isContextOverflowError } from './errors.ts';
import { createHarness, errorInfo } from './harness.ts';
import { createMemoryStore } from './store.ts';
import { createScriptedModel } from './testing.ts';

type GenerateResult = Awaited<ReturnType<MockLanguageModelV4['doGenerate']>>;
type GenerateCall = Parameters<MockLanguageModelV4['doGenerate']>[0];

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

function textResult(text: string): GenerateResult {
  return { content: [{ type: 'text', text }], finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [] };
}

/** 一次模型调用收到的东西：指令，和每条消息的角色加文字。 */
interface Seen {
  readonly system: string;
  readonly messages: readonly string[];
}

function seenOf(call: GenerateCall): Seen {
  let system = '';
  const messages: string[] = [];
  for (const message of call.prompt) {
    if (message.role === 'system') {
      system += message.content;
      continue;
    }
    const text = message.content
      .map((part) => {
        if (part.type === 'text') return part.text;
        return part.type === 'tool-result' ? JSON.stringify(part.output) : `[${part.type}]`;
      })
      .join('');
    messages.push(`${message.role}: ${text}`);
  }
  return { system, messages };
}

/** 记下每次调用的模型。压缩指令开头的那次是摘要，回 `摘要`；别的回 `好的`。 */
function recorder() {
  const chats: Seen[] = [];
  const summaries: Seen[] = [];
  const model = new MockLanguageModelV4({
    provider: 'mock',
    modelId: 'chat',
    doGenerate: async (call) => {
      const seen = seenOf(call);
      if (seen.system.startsWith('You compress conversation history')) {
        summaries.push(seen);
        return textResult('摘要');
      }
      chats.push(seen);
      return textResult('好的');
    },
  });
  return { model, chats, summaries };
}

function chat(count: number, chars: number): NewEntry[] {
  const filler = 'lorem ipsum dolor sit amet '.repeat(Math.ceil(chars / 27)).slice(0, chars);
  return Array.from({ length: count }, (_, index) =>
    index % 2 === 0 ? userEntry(`问 ${index}：${filler}`) : assistantEntry(`答 ${index}：${filler}`),
  );
}

function kinds(entries: readonly Entry[]): string[] {
  return entries.map((entry) =>
    entry.type === 'event' ? entry.kind : entry.type === 'message' ? entry.message.role : entry.type,
  );
}

function users(entries: readonly Entry[]): string[] {
  return entries.flatMap((entry) =>
    entry.type === 'message' && entry.message.role === 'user' ? [textOf(entry.message)] : [],
  );
}

function agentWith(model: AgentSpec['model'], overflow?: OverflowSpec): AgentSpec {
  return { model, settings: { maxRetries: 0 }, ...(overflow ? { context: { overflow } } : {}) };
}

function apiError(statusCode: number, message: string, responseBody?: string): APICallError {
  return new APICallError({
    message,
    url: 'https://example.test/v1/chat/completions',
    requestBodyValues: {},
    statusCode,
    ...(responseBody !== undefined ? { responseBody } : {}),
  });
}

describe('isContextOverflowError（各服务商的写法没有对真实服务验证）', () => {
  test('认得常见的错误码和消息', () => {
    const overflows: unknown[] = [
      apiError(
        400,
        "This model's maximum context length is 128000 tokens. However, your messages resulted in 130532 tokens.",
        '{"error":{"code":"context_length_exceeded"}}',
      ),
      apiError(400, 'Bad Request', '{"error":{"type":"invalid_request_error","code":"context_length_exceeded"}}'),
      apiError(400, 'Your input exceeds the context window of this model. Please adjust your input and try again.'),
      apiError(400, 'prompt is too long: 213462 tokens > 200000 maximum'),
      apiError(400, 'input length and `max_tokens` exceed context limit: 195000 + 20000 > 200000'),
      apiError(413, 'Request exceeds the maximum size', '{"error":{"type":"request_too_large"}}'),
      apiError(
        400,
        'The input token count (1200000) exceeds the maximum number of tokens allowed (1048576).',
        '{"error":{"status":"INVALID_ARGUMENT"}}',
      ),
      apiError(400, "This model's maximum prompt length is 131072 but the request contains 140000 tokens."),
      apiError(400, 'Input is too long for requested model.'),
      apiError(400, 'too many tokens: total number of tokens in the prompt cannot exceed 4081'),
      apiError(400, 'Please reduce the length of the messages or completion.'),
      apiError(400, 'Prompt contains 9000 tokens, too large for model with 8192 maximum context length'),
      apiError(400, 'the request exceeds the available context size, try increasing it'),
      new Error('ContextWindowExceededError: litellm.BadRequestError'),
      new RetryError({
        message: 'Failed after 3 attempts',
        reason: 'maxRetriesExceeded',
        errors: [apiError(400, 'prompt is too long: 213462 tokens > 200000 maximum')],
      }),
      { type: 'context_overflow', message: '已经标过的 ErrorInfo' },
    ];
    for (const error of overflows) {
      assert.equal(isContextOverflowError(error), true, error instanceof Error ? error.message : JSON.stringify(error));
    }
  });

  test('别的错误不认：限流、鉴权、普通的 400、输出上限', () => {
    const others: unknown[] = [
      apiError(429, 'Rate limit reached: too many tokens per minute. Limit 30000, Requested 40000.'),
      apiError(401, 'Incorrect API key provided. The context window is irrelevant here.'),
      apiError(400, 'Invalid value for temperature'),
      apiError(400, 'max_tokens: 100000 > 64000, which is the maximum allowed number of output tokens'),
      apiError(500, 'Internal server error'),
      new Error('socket hang up'),
      'prompt is too long',
      undefined,
    ];
    for (const error of others) assert.equal(isContextOverflowError(error), false, String(error));
  });

  test('errorInfo 把它标成 context_overflow、不可重试，状态码和响应正文留着', () => {
    const info = errorInfo(apiError(400, 'prompt is too long: 213462 tokens > 200000 maximum', '{"type":"error"}'));
    assert.deepEqual(info, {
      message: 'prompt is too long: 213462 tokens > 200000 maximum',
      type: 'context_overflow',
      retryable: false,
      statusCode: 400,
      responseBody: '{"type":"error"}',
    });
    assert.equal(isContextOverflow(info), true);
    assert.equal(errorInfo(apiError(500, 'Internal server error')).type, 'api_call');
  });
});

describe('harness：服务商报上下文过长', () => {
  test('run 以 error 结束，error.type 是 context_overflow；ctx.error 也记着这个类型', async () => {
    const store = createMemoryStore();
    const harness = createHarness({ store, context: createContextBuilder({ store }) });
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        throw apiError(400, "This model's maximum context length is 8192 tokens.");
      },
    });
    const result = await harness.run({ session: 's', agent: agentWith(model), input: '在吗' });
    assert.equal(result.stopReason, 'error');
    assert.equal(result.error?.type, 'context_overflow');
    assert.equal(result.error?.retryable, false);
    assert.equal(result.error?.statusCode, 400);
    const [error] = await store.list('s', { kinds: [CTX_EVENTS.error] });
    assert.equal(error?.type === 'event' && (error.data as { type?: string }).type, 'context_overflow');
  });

  test('stream 也一样：run.ended 的结果带 context_overflow', async () => {
    const store = createMemoryStore();
    const harness = createHarness({ store, context: createContextBuilder({ store }) });
    const model = new MockLanguageModelV4({
      doStream: async () => {
        throw apiError(400, 'prompt is too long: 213462 tokens > 200000 maximum');
      },
    });
    const events: RunEvent[] = [];
    for await (const event of harness.stream({ session: 's', agent: agentWith(model), input: '在吗' })) {
      events.push(event);
    }
    const ended = events.at(-1);
    assert.equal(ended?.type === 'run.ended' && ended.result.error?.type, 'context_overflow');
  });
});

describe('harness：失败的重试不让历史变长', () => {
  test('上一轮失败留下的输入，这一轮带同样的输入来（不给 inputKey）不再记一遍；换一句照常记', async () => {
    const store = createMemoryStore();
    const harness = createHarness({ store, context: createContextBuilder({ store }) });
    const model = createScriptedModel([
      { type: 'error', message: 'prompt is too long: 9000 tokens > 8192 maximum' },
      { type: 'error', message: 'network down' },
      { type: 'text', text: '三点了' },
      { type: 'error', message: 'network down' },
      { type: 'text', text: '晴' },
    ]);
    const agent = agentWith(model);
    assert.equal((await harness.run({ session: 's', agent, input: '几点了？' })).error?.type, 'context_overflow');
    assert.equal((await harness.run({ session: 's', agent, input: '几点了？' })).stopReason, 'error');
    const third = await harness.run({ session: 's', agent, input: '几点了？' });
    assert.equal(third.text, '三点了');
    assert.deepEqual(users(await store.list('s')), ['几点了？'], '三轮只记了一句');
    assert.ok(!third.recorded.some((entry) => entry.type === 'message' && entry.message.role === 'user'));
    assert.deepEqual(
      model.doGenerateCalls.map((call) => seenOf(call).messages),
      [['user: 几点了？'], ['user: 几点了？'], ['user: 几点了？']],
      '每次交给模型的都只有一句',
    );

    assert.equal((await harness.run({ session: 's', agent, input: '天气呢？' })).stopReason, 'error');
    assert.equal((await harness.run({ session: 's', agent, input: '我是说今天的天气' })).text, '晴');
    assert.deepEqual(users(await store.list('s')), ['几点了？', '天气呢？', '我是说今天的天气']);
  });

  test('上一轮成功了、或者中间有别的内容：同样的话照常再记', async () => {
    const store = createMemoryStore();
    const harness = createHarness({ store, context: createContextBuilder({ store }) });
    const model = createScriptedModel([
      { type: 'text', text: '在' },
      { type: 'text', text: '还在' },
      { type: 'error', message: 'network down' },
      { type: 'text', text: '好了' },
    ]);
    const agent = agentWith(model);
    await harness.run({ session: 's', agent, input: '在吗' });
    await harness.run({ session: 's', agent, input: '在吗' });
    assert.deepEqual(users(await store.list('s')), ['在吗', '在吗'], '上一轮成功：是新的一句');

    assert.equal((await harness.run({ session: 's', agent, input: '继续' })).stopReason, 'error');
    // 失败之后应用写了一条事件：两轮之间有别的内容，不当成重试。
    await store.append('s', [eventEntry('whisper', { text: '喝水' })]);
    assert.equal((await harness.run({ session: 's', agent, input: '继续' })).text, '好了');
    assert.deepEqual(users(await store.list('s')), ['在吗', '在吗', '继续', '继续']);
  });

  test('流式的一轮同样认重试', async () => {
    const store = createMemoryStore();
    const harness = createHarness({ store, context: createContextBuilder({ store }) });
    const agent = agentWith(
      createScriptedModel([
        { type: 'error', message: 'network down' },
        { type: 'text', text: '在' },
      ]),
    );
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const events: RunEvent[] = [];
      for await (const event of harness.stream({ session: 's', agent, input: '在吗' })) events.push(event);
      assert.equal(events.at(-1)?.type, 'run.ended');
    }
    assert.deepEqual(users(await store.list('s')), ['在吗']);
  });
});

describe('harness：agent.context.overflow', () => {
  test('缺省关着：多长都原样交给模型', async () => {
    const store = createMemoryStore();
    const { model, chats } = recorder();
    const harness = createHarness({ store, context: createContextBuilder({ store, model }) });
    await store.append('s', chat(40, 400));
    const result = await harness.run({ session: 's', agent: agentWith(model), input: '接着说' });
    assert.equal(result.stopReason, 'end_turn', result.error?.message);
    assert.equal(chats[0]!.messages.length, 41);
    assert.equal((await store.list('s', { types: ['summary'] })).length, 0);
  });

  test('没超就什么都不做', async () => {
    const store = createMemoryStore();
    const { model, chats, summaries } = recorder();
    const harness = createHarness({ store, context: createContextBuilder({ store, model }) });
    await store.append('s', chat(10, 40));
    const result = await harness.run({
      session: 's',
      agent: agentWith(model, { maxTokens: 10_000 }),
      input: '接着说',
    });
    assert.equal(result.stopReason, 'end_turn', result.error?.message);
    assert.equal(chats[0]!.messages.length, 11);
    assert.equal(summaries.length, 0);
  });

  test('超了先压缩（缺省）：追加摘要，模型看到摘要、最近几条和这一轮的输入；overflow 记进 ctx.run.started', async () => {
    const store = createMemoryStore();
    const { model, chats, summaries } = recorder();
    const harness = createHarness({ store, context: createContextBuilder({ store, model }) });
    await store.append('s', chat(40, 400));
    const overflow: OverflowSpec = { maxTokens: 2_000, compact: { keep: 4, maxInputTokens: 3_000 } };
    const result = await harness.run({ session: 's', agent: agentWith(model, overflow), input: '接着说' });
    assert.equal(result.stopReason, 'end_turn', result.error?.message);
    assert.equal(result.text, '好的');
    assert.ok(summaries.length > 1, '历史比摘要模型的上限长，分了段');
    assert.equal(chats.length, 1);
    assert.match(chats[0]!.messages[0]!, /^user: Summary of the earlier conversation:\n摘要$/);
    assert.equal(chats[0]!.messages.length, 5, '摘要 + 最近 4 条');
    assert.equal(chats[0]!.messages.at(-1), 'user: 接着说', '这一轮的输入原样在最后');
    const log = await store.list('s');
    assert.ok(kinds(log).includes('summary') && kinds(log).includes(CTX_EVENTS.compacted));
    assert.deepEqual(kinds(log).slice(-2), ['assistant', CTX_EVENTS.runEnded], '压缩写的条目不妨碍这一轮接着写');
    const [started] = await store.list('s', { kinds: [CTX_EVENTS.runStarted] });
    const agent = started?.type === 'event' ? (started.data as { agent: { context?: unknown } }).agent : undefined;
    assert.deepEqual(agent?.context, { overflow });
    // 下一轮从摘要读起，不用再压。
    const before = summaries.length;
    await harness.run({ session: 's', agent: agentWith(model, overflow), input: '再说一句' });
    assert.equal(summaries.length, before);
  });

  test('builder 没配摘要模型：压缩用这一轮的模型', async () => {
    const store = createMemoryStore();
    const { model, chats, summaries } = recorder();
    const harness = createHarness({ store, context: createContextBuilder({ store }) });
    await store.append('s', chat(40, 400));
    const result = await harness.run({
      session: 's',
      agent: agentWith(model, { maxTokens: 2_000, compact: { keep: 4 } }),
      input: '接着说',
    });
    assert.equal(result.stopReason, 'end_turn', result.error?.message);
    assert.equal(summaries.length, 1);
    assert.equal(chats[0]!.messages.length, 5);
  });

  test('strategy trim：只裁剪，什么都不写；交给模型的在上限之内', async () => {
    const store = createMemoryStore();
    const { model, chats, summaries } = recorder();
    const harness = createHarness({ store, context: createContextBuilder({ store, model }) });
    await store.append('s', chat(40, 400));
    const result = await harness.run({
      session: 's',
      agent: { ...agentWith(model, { maxTokens: 1_000, strategy: 'trim' }), instructions: '你是助手。' },
      input: '接着说',
    });
    assert.equal(result.stopReason, 'end_turn', result.error?.message);
    assert.equal(summaries.length, 0);
    assert.equal((await store.list('s', { types: ['summary'] })).length, 0);
    const seen = chats[0]!;
    assert.ok(seen.messages.length < 12 && seen.messages.length >= 2, `留下 ${seen.messages.length} 条`);
    assert.ok(seen.messages[0]!.startsWith('user: '), '开头是用户消息');
    assert.equal(seen.messages.at(-1), 'user: 接着说');
    assert.ok(seen.messages.join('\n').length / 4 < 1_000);
  });

  test('压缩没做成（摘要模型出错）：告警，接着裁剪，这一轮照常跑', async () => {
    const store = createMemoryStore();
    const warned: string[] = [];
    const logger: Logger = { warn: (message) => warned.push(message) };
    const chats: Seen[] = [];
    const model = new MockLanguageModelV4({
      doGenerate: async (call) => {
        const seen = seenOf(call);
        if (seen.system.startsWith('You compress')) throw new Error('summary model is down');
        chats.push(seen);
        return textResult('好的');
      },
    });
    const harness = createHarness({ store, context: createContextBuilder({ store, model }), logger });
    await store.append('s', chat(40, 400));
    const result = await harness.run({
      session: 's',
      agent: agentWith(model, { maxTokens: 1_000 }),
      input: '接着说',
    });
    assert.equal(result.stopReason, 'end_turn', result.error?.message);
    assert.deepEqual(warned, ['compaction failed while the context is over its limit; trimming instead']);
    assert.ok(chats[0]!.messages.length < 12);
  });

  test('单条消息就超预算：截短它再交给模型，日志里的原文不动', async () => {
    const store = createMemoryStore();
    const { model, chats } = recorder();
    const harness = createHarness({ store, context: createContextBuilder({ store, model }) });
    const essay = `开头${'很长的一段话。'.repeat(20_000)}结尾`;
    const result = await harness.run({
      session: 's',
      agent: agentWith(model, { maxTokens: 2_000, strategy: 'trim' }),
      input: essay,
    });
    assert.equal(result.stopReason, 'end_turn', result.error?.message);
    const [only] = chats[0]!.messages;
    assert.equal(chats[0]!.messages.length, 1);
    assert.ok(only!.length < 4_000, `交给模型的有 ${only!.length} 个字符`);
    assert.match(only!, /^user: 开头很长的一段话。/);
    assert.match(only!, /characters omitted to fit the context window/);
    assert.match(only!, /很长的一段话。结尾$/);
    assert.deepEqual(users(await store.list('s')), [essay], '日志里是原文');
  });

  test('最后一组是巨大的工具结果：截短结果，调用和结果仍然成对', async () => {
    const store = createMemoryStore();
    const { model, chats } = recorder();
    const harness = createHarness({ store, context: createContextBuilder({ store, model }) });
    await store.append('s', [
      userEntry('查一下'),
      messageEntry({
        role: 'assistant',
        content: [{ type: 'tool-call', id: 'c1', name: 'search', input: { q: 'x' } }],
      }),
      messageEntry({
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            id: 'c1',
            name: 'search',
            output: { type: 'json', value: { rows: Array.from({ length: 20_000 }, (_, index) => `row ${index}`) } },
          },
        ],
      }),
    ]);
    const result = await harness.run({
      session: 's',
      agent: agentWith(model, { maxTokens: 1_500, strategy: 'trim' }),
    });
    assert.equal(result.stopReason, 'end_turn', result.error?.message);
    const seen = chats[0]!.messages;
    assert.deepEqual(
      seen.map((message) => message.split(':')[0]),
      ['user', 'assistant', 'tool'],
    );
    assert.match(seen[2]!, /row 0/);
    assert.match(seen[2]!, /characters omitted/);
    assert.ok(seen[2]!.length < 6_000);
  });

  test('strategy error：超了就不调模型，以 context_overflow 结束', async () => {
    const store = createMemoryStore();
    const { model, chats, summaries } = recorder();
    const harness = createHarness({ store, context: createContextBuilder({ store, model }) });
    await store.append('s', chat(40, 400));
    const result = await harness.run({
      session: 's',
      agent: agentWith(model, { maxTokens: 1_000, strategy: 'error' }),
      input: '接着说',
    });
    assert.equal(result.stopReason, 'error');
    assert.equal(result.error?.type, 'context_overflow');
    assert.equal(result.error?.retryable, false);
    assert.match(result.error?.message ?? '', /over the limit of 1000/);
    assert.equal(chats.length + summaries.length, 0);
    assert.deepEqual(kinds(await store.list('s')).slice(-3), ['user', CTX_EVENTS.error, CTX_EVENTS.runEnded]);
  });

  test('压缩、裁剪都做了还放不下（指令本身就超）：以 context_overflow 结束，不调模型', async () => {
    const store = createMemoryStore();
    const { model, chats } = recorder();
    const harness = createHarness({ store, context: createContextBuilder({ store, model }) });
    const result = await harness.run({
      session: 's',
      agent: { ...agentWith(model, { maxTokens: 500 }), instructions: '规则。'.repeat(2_000) },
      input: '在吗',
    });
    assert.equal(result.stopReason, 'error');
    assert.equal(result.error?.type, 'context_overflow');
    assert.match(result.error?.message ?? '', /even after compaction and trimming/);
    assert.equal(chats.length, 0);
  });

  test('record: false 的运行不压缩（它一条都不写），直接裁剪', async () => {
    const store = createMemoryStore();
    const { model, chats, summaries } = recorder();
    const harness = createHarness({ store, context: createContextBuilder({ store, model }) });
    await store.append('s', chat(40, 400));
    const before = await store.list('s');
    const result = await harness.run({
      session: 's',
      agent: agentWith(model, { maxTokens: 1_000 }),
      prompt: '说一句碎碎念',
      record: false,
    });
    assert.equal(result.stopReason, 'end_turn', result.error?.message);
    assert.equal(summaries.length, 0);
    assert.ok(chats[0]!.messages.length < 12);
    assert.equal(chats[0]!.messages.at(-1), 'user: 说一句碎碎念');
    assert.deepEqual(await store.list('s'), before, '日志没动');
  });

  test('配置不对（maxTokens 不是正数、不认识的 strategy）：以 invalid_request 结束，不调模型', async () => {
    const store = createMemoryStore();
    const { model, chats } = recorder();
    const harness = createHarness({ store, context: createContextBuilder({ store, model }) });
    const bad = [{ maxTokens: 0 }, { maxTokens: '8000' }, { maxTokens: 8000, strategy: 'summarize' }];
    for (const overflow of bad) {
      const result = await harness.run({
        session: 's',
        agent: agentWith(model, overflow as unknown as OverflowSpec),
        input: '在吗',
      });
      assert.equal(result.error?.type, 'invalid_request', JSON.stringify(overflow));
    }
    assert.equal(chats.length, 0);
  });

  test('builder 不给 tokens 时 harness 自己估', async () => {
    const store = createMemoryStore();
    const { model, chats } = recorder();
    const inner = createContextBuilder({ store, model });
    const harness = createHarness({
      store,
      context: {
        build: async (request) => {
          const { tokens: _tokens, ...call } = await inner.build(request);
          return call;
        },
        view: (session, viewOptions) => inner.view(session, viewOptions),
      },
    });
    await store.append('s', chat(40, 400));
    const over = await harness.run({
      session: 's',
      agent: agentWith(model, { maxTokens: 1_000, strategy: 'error' }),
      input: '接着说',
    });
    assert.equal(over.error?.type, 'context_overflow');
    // 这个 builder 没有 compact：缺省的策略直接裁剪。
    const trimmed = await harness.run({ session: 's', agent: agentWith(model, { maxTokens: 1_000 }), input: '接着说' });
    assert.equal(trimmed.stopReason, 'end_turn');
    assert.ok(chats[0]!.messages.length < 12);
  });

  test('createContext({ overflow })：generate 走同一套兜底，每次调用可以单独给', async () => {
    const store = createMemoryStore();
    const { model, chats, summaries } = recorder();
    const context = createContext({ store, session: 's', model, overflow: { maxTokens: 2_000, compact: { keep: 4 } } });
    await context.append(...chat(40, 400));
    const result = await context.generate({ input: '接着说' });
    assert.equal(result.text, '好的');
    assert.equal(summaries.length, 1);
    assert.equal(chats[0]!.messages.length, 5);
    await context.append(...chat(40, 400));
    await assert.rejects(
      context.generate({ input: '再说', overflow: { maxTokens: 1_000, strategy: 'error' } }),
      (error: unknown) => isContextOverflow(error),
    );
  });
});
