import assert from 'node:assert/strict';

import { APICallError } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { describe, test } from 'vite-plus/test';

import {
  assistantEntry,
  estimateTextTokens,
  eventEntry,
  messageEntry,
  summaryEntry,
  textOf,
  userEntry,
  type NewEntry,
  type ProjectionOptions,
} from '@modelctx-ai/ctx-protocol';

import { createContextBuilder, DEFAULT_COMPACT_INPUT_TOKENS } from './builder.ts';
import { createMemoryStore } from './store.ts';

type GenerateResult = Awaited<ReturnType<MockLanguageModelV4['doGenerate']>>;
type GenerateCall = Parameters<MockLanguageModelV4['doGenerate']>[0];

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

function textResult(text: string, finish: 'stop' | 'length' = 'stop'): GenerateResult {
  return {
    content: [{ type: 'text', text }],
    finishReason: { unified: finish, raw: finish },
    usage,
    warnings: [],
  };
}

/** 一次摘要调用收到的输入：指令和记录各是什么。 */
interface Seen {
  readonly system: string;
  readonly prompt: string;
  /** 两者合起来的估算 token，就是 `maxInputTokens` 管的那个数。 */
  readonly tokens: number;
}

function seenOf(call: GenerateCall): Seen {
  let system = '';
  let prompt = '';
  for (const message of call.prompt) {
    if (message.role === 'system') system += message.content;
    else if (message.role === 'user') {
      for (const part of message.content) if (part.type === 'text') prompt += part.text;
    }
  }
  return { system, prompt, tokens: estimateTextTokens(system) + estimateTextTokens(prompt) };
}

/** 记下每次调用的输入的摘要模型；`answer` 决定这一次回什么。 */
function summarizer(
  answer: (seen: Seen, index: number) => GenerateResult = (_, index) => textResult(`摘要 ${index + 1}`),
) {
  const seen: Seen[] = [];
  const model = new MockLanguageModelV4({
    doGenerate: async (call) => {
      const one = seenOf(call);
      seen.push(one);
      return answer(one, seen.length - 1);
    },
  });
  return { model, seen };
}

function fixture(model: MockLanguageModelV4, projection?: ProjectionOptions) {
  const store = createMemoryStore();
  const builder = createContextBuilder({ store, model, ...(projection ? { projection } : {}) });
  return { store, builder };
}

/** 一问一答交替的 `count` 条消息，每条正文 `chars` 个字符左右。 */
function chat(count: number, chars: number): NewEntry[] {
  const filler = 'lorem ipsum dolor sit amet '.repeat(Math.ceil(chars / 27)).slice(0, chars);
  return Array.from({ length: count }, (_, index) =>
    index % 2 === 0 ? userEntry(`问 ${index}：${filler}`) : assistantEntry(`答 ${index}：${filler}`),
  );
}

/** 摘要模型说输入太长时抛的错，照 OpenAI 兼容接口的样子。 */
function tooLong(): never {
  throw new APICallError({
    message: "This model's maximum context length is 2048 tokens. However, your messages resulted in 9000 tokens.",
    url: 'https://example.test/v1/chat/completions',
    requestBodyValues: {},
    statusCode: 400,
    responseBody: '{"error":{"code":"context_length_exceeded"}}',
    isRetryable: false,
  });
}

const reminders: ProjectionOptions = {
  events: {
    reminder: { render: ([event]) => ({ role: 'user', content: `提醒：${event?.text ?? ''}` }) },
  },
};

describe('compact：`at` 在未来的条目', () => {
  test('一条 `at` 在未来的可渲染事件不再把 covers 钉住：之后的消息照常压缩', async () => {
    const { model, seen } = summarizer();
    const { store, builder } = fixture(model, reminders);
    await store.append('s', [userEntry('先说一句'), assistantEntry('好')]);
    // 把到期时间当 `at` 的提醒：一直排在视图的最后。
    const [reminder] = await store.append('s', [
      eventEntry('reminder', { text: '明天九点开会', at: Date.now() + 86_400_000 }),
    ]);
    await store.append('s', chat(200, 20));
    assert.equal((await builder.view('s')).messages.at(-1)?.content, '提醒：明天九点开会', '提醒排在最后');

    const summary = await builder.compact('s', { keep: 12 });
    assert.ok(summary, '压缩了，不是 null');
    assert.ok(summary.covers > reminder!.seq, 'covers 越过了那条提醒');
    assert.equal(summary.covers, 203 - 12, '最近 12 条消息原样保留');
    assert.match(seen[0]!.prompt, /提醒：明天九点开会/, '提醒进了摘要的输入');
    const view = await builder.view('s');
    assert.equal(view.messages.length, 13, '摘要 + 最近 12 条');
    assert.ok(!view.messages.some((message) => textOf(message).startsWith('提醒')), '提醒由摘要代替');
  });

  test('切点之后才写的未来条目不进摘要，压缩后仍然可见；它不占 keep 的名额', async () => {
    const { model } = summarizer();
    const { store, builder } = fixture(model, reminders);
    await store.append('s', chat(20, 20));
    await store.append('s', [eventEntry('reminder', { text: '后天交报告', at: Date.now() + 2 * 86_400_000 })]);
    const summary = await builder.compact('s', { keep: 4, minimum: 4 });
    assert.equal(summary?.covers, 16, '最近 4 条是消息，不把提醒算进去');
    const view = await builder.view('s');
    assert.deepEqual(
      view.messages.map((message) => textOf(message).slice(0, 4)),
      ['Summ', '问 16', '答 17', '问 18', '答 19', '提醒：后'],
    );
  });
});

describe('compact：分段滚动摘要', () => {
  test('issue #33 的实测：2 万条消息、一千万字符，每次的输入都在上限内，最后只有一条生效的摘要', async () => {
    const { model, seen } = summarizer();
    const { store, builder } = fixture(model);
    const entries = chat(20_000, 495);
    const chars = entries.reduce(
      (sum, entry) => sum + (entry.type === 'message' ? textOf(entry.message).length : 0),
      0,
    );
    assert.ok(chars > 10_000_000, `历史有 ${chars} 个字符`);
    await store.append('s', entries);

    const maxInputTokens = 20_000;
    const result = await builder.compactDetailed('s', { maxInputTokens });
    assert.equal(result.status, 'compacted');
    assert.equal(result.compacted, 20_000 - 12);
    assert.equal(result.remaining, 0);
    assert.equal(result.calls, seen.length);
    assert.ok(seen.length > 100, `分了 ${seen.length} 段`);
    const largest = seen.reduce((most, one) => Math.max(most, one.tokens), 0);
    assert.ok(largest <= maxInputTokens, `最大的一次输入估算 ${largest}，上限 ${maxInputTokens}`);
    assert.ok(
      seen.every((one) => one.prompt.length < 100_000),
      '没有哪一次是整段历史',
    );
    // 上一段的摘要带进下一段。
    assert.ok(seen[1]!.prompt.startsWith('user: Summary of the earlier conversation:\n摘要 1\n'));
    assert.match(seen.at(-1)!.prompt, new RegExp(`摘要 ${seen.length - 1}\n`));

    const view = await builder.view('s');
    assert.equal(view.messages.length, 13, '一条摘要 + 最近 12 条');
    assert.equal(view.summary?.id, result.summary?.id);
    assert.equal(view.summary?.text, `摘要 ${seen.length}`);
    assert.equal(view.summary?.covers, 20_000 - 12);
    assert.equal(view.items.filter((item) => item.pinned).length, 1);
  }, 60_000);

  test('不给 maxInputTokens 时用缺省的上限；短历史还是一次调用，输入和以前一样', async () => {
    const { model, seen } = summarizer();
    const { store, builder } = fixture(model);
    await store.append('s', [userEntry('甲'), assistantEntry('乙'), userEntry('丙'), assistantEntry('丁')]);
    const summary = await builder.compact('s', { keep: 2, minimum: 1 });
    assert.equal(summary?.text, '摘要 1');
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.prompt, 'user: 甲\nassistant: 乙');

    await store.append('s', chat(600, 400));
    assert.ok(await builder.compact('s'));
    assert.ok(seen.length > 2, '长历史分了段');
    assert.ok(seen.every((one) => one.tokens <= DEFAULT_COMPACT_INPUT_TOKENS));
  });

  test('每段落一个检查点：中途模型出错，已经压好的留着，再调一次从那里接着压', async () => {
    let fail = true;
    const { model, seen } = summarizer((_, index) => {
      if (fail && index === 2) throw new Error('socket hang up');
      return textResult(`摘要 ${index + 1}`);
    });
    const { store, builder } = fixture(model);
    await store.append('s', chat(60, 400));
    await assert.rejects(builder.compact('s', { keep: 4, maxInputTokens: 2_000 }), /socket hang up/);
    const partial = await builder.view('s');
    assert.equal(partial.summary?.text, '摘要 2', '前两段的检查点已经生效');
    assert.ok(partial.messages.length < 61 && partial.messages.length > 5, `视图还剩 ${partial.messages.length} 条`);
    const compacted = (await store.list('s', { kinds: ['ctx.compacted'] })).length;
    assert.equal(compacted, 2, '每个检查点一条 ctx.compacted');

    fail = false;
    const before = seen.length;
    const result = await builder.compactDetailed('s', { keep: 4, maxInputTokens: 2_000 });
    assert.equal(result.status, 'compacted');
    assert.ok(
      seen[before]!.prompt.startsWith('user: Summary of the earlier conversation:\n摘要 2\n'),
      '接着上次的摘要',
    );
    assert.equal((await builder.view('s')).messages.length, 5);
  });

  test('工具调用和结果不被检查点切到两边', async () => {
    const { model } = summarizer();
    const { store, builder } = fixture(model);
    const filler = 'x'.repeat(2_000);
    const entries: NewEntry[] = [];
    for (let index = 0; index < 12; index += 1) {
      entries.push(
        userEntry(`问 ${index} ${filler}`),
        messageEntry({
          role: 'assistant',
          content: [{ type: 'tool-call', id: `call-${index}`, name: 'lookup', input: { q: filler } }],
        }),
        messageEntry({
          role: 'tool',
          content: [
            { type: 'tool-result', id: `call-${index}`, name: 'lookup', output: { type: 'text', text: filler } },
          ],
        }),
        assistantEntry(`答 ${index}`),
      );
    }
    await store.append('s', entries);
    const result = await builder.compactDetailed('s', { keep: 2, maxInputTokens: 1_400 });
    assert.equal(result.status, 'compacted');
    assert.ok(result.calls > 3);
    const log = await store.list('s');
    for (const entry of log) {
      if (entry.type !== 'summary') continue;
      const next = log.find((other) => other.seq === entry.covers + 1);
      assert.ok(
        !(next?.type === 'message' && next.message.role === 'tool'),
        `covers ${entry.covers} 之后紧跟的是工具结果`,
      );
    }
  });

  test('超长的工具输出进摘要的输入前截短；单条超过一段预算的消息也截短，并计入 shortened', async () => {
    const { model, seen } = summarizer();
    const { store, builder } = fixture(model);
    const output = `HEAD ${'工具输出'.repeat(50_000)} TAIL`;
    const essay = `开头 ${'很长的一段话'.repeat(30_000)} 结尾`;
    await store.append('s', [
      userEntry('查一下'),
      messageEntry({
        role: 'assistant',
        content: [{ type: 'tool-call', id: 'c1', name: 'search', input: { q: 'x' } }],
      }),
      messageEntry({
        role: 'tool',
        content: [{ type: 'tool-result', id: 'c1', name: 'search', output: { type: 'text', text: output } }],
      }),
      assistantEntry('查到了'),
      userEntry(essay),
      assistantEntry('收到'),
      userEntry('最后一句'),
    ]);
    const maxInputTokens = 4_000;
    const result = await builder.compactDetailed('s', { keep: 1, minimum: 1, maxInputTokens });
    assert.equal(result.status, 'compacted');
    assert.equal(result.shortened, 2);
    assert.ok(seen.every((one) => one.tokens <= maxInputTokens));
    const all = seen.map((one) => one.prompt).join('\n');
    assert.match(all, /search returned HEAD 工具输出/);
    assert.match(all, /characters omitted/);
    assert.match(all, /工具输出 TAIL/, '工具输出留了尾');
    assert.match(all, /user: 开头 很长的一段话/);
    assert.match(all, /很长的一段话 结尾/, '长消息留了尾');
    assert.ok(all.length < 40_000, `两段合起来 ${all.length} 个字符`);
    assert.equal((await builder.view('s')).messages.length, 2);
  });

  test('timeoutMs 管整次压缩：时间用完就停，已经落的检查点留着', async () => {
    let clock = 0;
    const { model } = summarizer((_, index) => {
      clock += 40;
      return textResult(`摘要 ${index + 1}`);
    });
    const store = createMemoryStore({ now: () => clock });
    const builder = createContextBuilder({ store, model, now: () => clock });
    await store.append('s', chat(60, 400));
    await assert.rejects(
      builder.compact('s', { keep: 4, maxInputTokens: 2_000, timeoutMs: 100 }),
      (error: unknown) => (error as { type?: string }).type === 'timeout',
    );
    assert.equal((await builder.view('s')).summary?.text, '摘要 3');
  });
});

describe('compactDetailed：怎么收场的', () => {
  test('not_needed：历史不够长，不调模型，compact 返回 null', async () => {
    const { model, seen } = summarizer();
    const { store, builder } = fixture(model);
    await store.append('s', chat(6, 20));
    assert.deepEqual(await builder.compactDetailed('s'), {
      status: 'not_needed',
      calls: 0,
      compacted: 0,
      remaining: 0,
      shortened: 0,
    });
    assert.equal(await builder.compact('s'), null);
    assert.equal(seen.length, 0);
  });

  test('truncated：摘要被 maxOutputTokens 截断，不写；和 not_needed 分得开', async () => {
    const { model } = summarizer(() => textResult('半截', 'length'));
    const { store, builder } = fixture(model);
    await store.append('s', chat(20, 20));
    const result = await builder.compactDetailed('s', { keep: 4 });
    assert.deepEqual(result, { status: 'truncated', calls: 1, compacted: 0, remaining: 16, shortened: 0 });
    assert.equal(await builder.compact('s', { keep: 4 }), null);
    assert.equal((await store.list('s', { types: ['summary'] })).length, 0);
  });

  test('truncated 出在后面的段：前面的检查点留着，summary 是最后落下的那条，compact 返回它', async () => {
    const { model } = summarizer((_, index) => (index === 1 ? textResult('半截', 'length') : textResult('第一段')));
    const { store, builder } = fixture(model);
    await store.append('s', chat(60, 400));
    const result = await builder.compactDetailed('s', { keep: 4, maxInputTokens: 2_000 });
    assert.equal(result.status, 'truncated');
    assert.equal(result.calls, 2);
    assert.equal(result.summary?.text, '第一段');
    assert.ok(result.compacted > 0 && result.remaining > 0);
    assert.equal(result.compacted + result.remaining, 56);
  });

  test('empty：模型没给出文字，不写', async () => {
    const { model } = summarizer(() => textResult('   '));
    const { store, builder } = fixture(model);
    await store.append('s', chat(20, 20));
    assert.equal((await builder.compactDetailed('s', { keep: 4 })).status, 'empty');
    assert.equal((await store.list('s', { types: ['summary'] })).length, 0);
  });

  test('input_too_long：已有的摘要加指令就占满了上限，不调模型', async () => {
    const { model, seen } = summarizer();
    const { store, builder } = fixture(model);
    await store.append('s', [summaryEntry('很长的旧摘要 '.repeat(2_000), 0), ...chat(20, 20)]);
    const result = await builder.compactDetailed('s', { keep: 4, maxInputTokens: 1_000 });
    assert.deepEqual(result, { status: 'input_too_long', calls: 0, compacted: 0, remaining: 16, shortened: 0 });
    assert.equal(seen.length, 0);
  });

  test('摘要模型自己报上下文过长：这一段减半再试；减到底还不行是 input_too_long', async () => {
    // 这个模型的窗口只有 1500：比它大的输入一律拒绝。
    const small = summarizer((one, index) => (one.tokens > 1_500 ? tooLong() : textResult(`摘要 ${index + 1}`)));
    const first = fixture(small.model);
    await first.store.append('s', chat(40, 400));
    const result = await first.builder.compactDetailed('s', { keep: 4, maxInputTokens: 8_000 });
    assert.equal(result.status, 'compacted');
    assert.ok(small.seen.filter((one) => one.tokens > 1_500).length >= 2, '8000、4000、2000 都被拒绝过');
    assert.equal((await first.builder.view('s')).messages.length, 5);

    const never = summarizer(() => tooLong());
    const second = fixture(never.model);
    await second.store.append('s', chat(40, 400));
    const stuck = await second.builder.compactDetailed('s', { keep: 4, maxInputTokens: 8_000 });
    assert.equal(stuck.status, 'input_too_long');
    assert.equal(stuck.compacted, 0);
    assert.equal((await second.store.list('s', { types: ['summary'] })).length, 0);
  });
});
