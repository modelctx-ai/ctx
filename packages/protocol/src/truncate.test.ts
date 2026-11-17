import assert from 'node:assert/strict';

import { describe, test } from 'vite-plus/test';

import { project } from './context.ts';
import type { Message } from './message.ts';
import { assistantEntry, eventEntry, messageEntry, userEntry, type Entry, type NewEntry } from './session.ts';
import { estimateTextTokens, estimateTokens, truncateMessage, truncateText } from './tokens.ts';
import { CONTEXT_OVERFLOW, CtxError, isContextOverflow, isContextOverflowText } from './types.ts';
import { ENTRY_VERSION } from './version.ts';

/** 照存储的样子补上 id、session、seq、at：协议包里没有存储实现。 */
function seed(...drafts: NewEntry[]): Entry[] {
  return drafts.map((draft, i) => ({
    ...draft,
    id: draft.id ?? `e${i}`,
    session: 's',
    seq: i + 1,
    at: draft.at ?? i + 1,
    v: ENTRY_VERSION,
  }));
}

type ToolParts = Extract<Message, { role: 'tool' }>['content'];

/** 只有一条工具结果的工具消息。 */
function toolMessage(part: ToolParts[number]): Message {
  return { role: 'tool', content: [part] };
}

function outputOf(message: Message) {
  const [part] = message.content as ToolParts;
  return part?.type === 'tool-result' ? part.output : undefined;
}

/** 一条四万多字符的用户消息。 */
function big(label: string): NewEntry {
  return userEntry(`${label}${'w'.repeat(40_000)}`);
}

function base64(bytes: number): string {
  return Buffer.alloc(bytes, 7).toString('base64');
}

describe('truncateText', () => {
  test('没超的原样返回；超了留头尾，中间注明省略了多少字符', () => {
    assert.equal(truncateText('短短一句', 100), '短短一句');
    const text = `HEAD${'x'.repeat(10_000)}TAIL`;
    const cut = truncateText(text, 100);
    assert.ok(estimateTextTokens(cut) <= 100, `估算 ${estimateTextTokens(cut)}`);
    assert.ok(estimateTextTokens(cut) > 90, '尽量用满预算');
    assert.ok(cut.startsWith('HEADxxx') && cut.endsWith('xxxTAIL'));
    const omitted = /\[… (\d+) characters omitted to fit the context window …\]/.exec(cut);
    assert.ok(omitted, '有省略说明');
    assert.equal(cut.length - omitted[0].length - 2 + Number(omitted[1]), text.length, '省略的字符数对得上');
  });

  test('不把一对代理项切成两半；中文按一字一个 token 算', () => {
    const emoji = '😀'.repeat(2_000);
    const cut = truncateText(emoji, 101);
    assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(cut), '没有落单的代理项');
    const chinese = truncateText('字'.repeat(5_000), 200);
    assert.ok(estimateTextTokens(chinese) <= 200);
    assert.ok(chinese.startsWith('字字字') && chinese.endsWith('字字字'));
  });

  test('预算小到放不下说明时只剩说明', () => {
    assert.match(truncateText('x'.repeat(1_000), 1), /^\n\[… 1000 characters omitted to fit the context window …\]\n$/);
  });

  test('estimate 可以换：按「换上这段之后整体多大」来截', () => {
    const cut = truncateText('x'.repeat(4_000), 300, (text) => 250 + estimateTextTokens(text));
    assert.ok(estimateTextTokens(cut) <= 50);
  });
});

describe('truncateMessage', () => {
  test('没超的是同一个对象；纯文字的消息截文字', () => {
    const short: Message = { role: 'user', content: '在吗' };
    assert.equal(truncateMessage(short, 100), short);
    const long: Message = { role: 'user', content: `开头${'很长'.repeat(5_000)}结尾` };
    const cut = truncateMessage(long, 300);
    assert.ok(estimateTokens(cut) <= 300);
    assert.equal(cut.role, 'user');
    assert.ok(typeof cut.content === 'string' && cut.content.startsWith('开头') && cut.content.endsWith('结尾'));
  });

  test('分段的消息从最大的部件截起：内联文件换成说明，文字留头尾，小的部件不动', () => {
    const message: Message = {
      role: 'user',
      content: [
        { type: 'text', text: '看一下这份文件' },
        { type: 'file', mediaType: 'application/pdf', data: { type: 'data', data: base64(2_000_000) } },
        { type: 'file', mediaType: 'image', data: { type: 'url', url: 'https://example.com/a.png' } },
        { type: 'text', text: `正文${'x'.repeat(40_000)}完` },
      ],
    };
    const cut = truncateMessage(message, 1_000);
    assert.ok(estimateTokens(cut) <= 1_000, `估算 ${estimateTokens(cut)}`);
    assert.ok(Array.isArray(cut.content));
    const parts = cut.content as Exclude<Message['content'], string>;
    assert.deepEqual(parts[0], { type: 'text', text: '看一下这份文件' });
    assert.deepEqual(parts[1], {
      type: 'text',
      text: '[application/pdf file omitted: too large for the context window]',
    });
    assert.deepEqual(parts[2], message.content[2], '地址不占地方，不动');
    assert.ok(parts[3]?.type === 'text' && parts[3].text.startsWith('正文xxx') && parts[3].text.endsWith('x完'));
  });

  test('工具结果：文字截短，JSON 写成文字再截，错误只截信息，内容块先去掉内联文件', () => {
    const text = truncateMessage(
      toolMessage({ type: 'tool-result', id: 'c1', name: 't', output: { type: 'text', text: 'y'.repeat(40_000) } }),
      500,
    );
    assert.ok(estimateTokens(text) <= 500);
    assert.equal(outputOf(text)?.type, 'text');

    const json = truncateMessage(
      toolMessage({
        type: 'tool-result',
        id: 'c1',
        name: 't',
        output: { type: 'json', value: { rows: Array.from({ length: 5_000 }, (_, i) => `row ${i}`) } },
      }),
      500,
    );
    const jsonOutput = outputOf(json);
    assert.ok(estimateTokens(json) <= 500);
    assert.ok(jsonOutput?.type === 'text' && jsonOutput.text.startsWith('{"rows":["row 0"'));

    const error = truncateMessage(
      toolMessage({
        type: 'tool-result',
        id: 'c1',
        name: 't',
        output: { type: 'error', message: 'e'.repeat(40_000), retryable: true, data: { trace: 'z'.repeat(9_000) } },
      }),
      500,
    );
    const errorOutput = outputOf(error);
    assert.ok(estimateTokens(error) <= 500);
    assert.ok(errorOutput?.type === 'error' && errorOutput.retryable === true && errorOutput.data === undefined);

    const content = truncateMessage(
      toolMessage({
        type: 'tool-result',
        id: 'c1',
        name: 'screenshot',
        output: {
          type: 'content',
          parts: [
            { type: 'text', text: '截好了' },
            { type: 'file', mediaType: 'application/pdf', data: { type: 'data', data: base64(1_000_000) } },
          ],
        },
      }),
      500,
    );
    assert.deepEqual(outputOf(content), {
      type: 'content',
      parts: [
        { type: 'text', text: '截好了' },
        { type: 'text', text: '[application/pdf file omitted: too large for the context window]' },
      ],
    });
  });

  test('推理和工具调用的输入不动：截不下来就原样留着', () => {
    const message: Message = {
      role: 'assistant',
      content: [
        { type: 'reasoning', text: 'r'.repeat(8_000), providerOptions: { anthropic: { signature: 'sig' } } },
        { type: 'tool-call', id: 'c1', name: 'write', input: { body: 'b'.repeat(8_000) } },
      ],
    };
    const cut = truncateMessage(message, 100);
    assert.deepEqual(cut.content, message.content);
  });
});

describe('project：window.truncate', () => {
  test('单条消息超过预算的一半先封顶，别的历史不被它挤掉', () => {
    const entries = seed(
      userEntry('查一下'),
      messageEntry({
        role: 'assistant',
        content: [{ type: 'tool-call', id: 'c1', name: 'search', input: { q: 'x' } }],
      }),
      messageEntry({
        role: 'tool',
        content: [
          { type: 'tool-result', id: 'c1', name: 'search', output: { type: 'text', text: 'z'.repeat(80_000) } },
        ],
      }),
      assistantEntry('查到了'),
      userEntry('谢谢'),
    );
    const plain = project(entries, { window: { maxTokens: 1_000 } });
    assert.deepEqual(
      plain.messages.map((message) => message.role),
      ['user'],
      '不截的时候只剩最后一句',
    );
    assert.equal(plain.truncated, 0);

    const cut = project(entries, { window: { maxTokens: 1_000, truncate: true } });
    assert.deepEqual(
      cut.messages.map((message) => message.role),
      ['user', 'assistant', 'tool', 'assistant', 'user'],
    );
    assert.equal(cut.dropped, 0);
    assert.equal(cut.truncated, 1);
    assert.ok(cut.tokens <= 1_000, `估算 ${cut.tokens}`);
    assert.ok(cut.items[2]!.tokens <= 500, '工具结果封顶在预算的一半');
    assert.equal(
      cut.tokens,
      cut.items.reduce((sum, item) => sum + item.tokens, 0),
    );
  });

  test('封顶之后还放不下：照常从最旧的丢，只剩最后一组还超就接着截', () => {
    const cut = project(seed(big('一'), assistantEntry('好'), big('二'), assistantEntry('好'), big('三')), {
      window: { maxTokens: 600, truncate: true },
    });
    // 每条长消息封顶在 300，两条加上中间的回答就超了：留下最后一条。
    assert.deepEqual(
      cut.messages.map((message) => message.role),
      ['user'],
    );
    assert.ok(cut.tokens <= 600 && cut.tokens > 250, `估算 ${cut.tokens}`);
    assert.equal(cut.dropped, 4);
    assert.equal(cut.truncated, 1, '只数留下来的');

    const tiny = project(seed(big('一')), { window: { maxTokens: 40, truncate: true } });
    assert.equal(tiny.messages.length, 1);
    assert.equal(tiny.truncated, 1);
    assert.ok(tiny.tokens <= 40, `估算 ${tiny.tokens}`);
  });

  test('没给 maxTokens 时 truncate 不起作用；estimate 换了就按换的算', () => {
    const entries = seed(userEntry('a'.repeat(4_000)));
    assert.equal(project(entries, { window: { truncate: true } }).truncated, 0);
    const counted = project(entries, {
      window: { maxTokens: 100, truncate: true, estimate: (message) => JSON.stringify(message).length },
    });
    assert.ok(counted.tokens <= 100, `按字符数估 ${counted.tokens}`);
  });
});

describe('ProjectedMessage.at', () => {
  test('消息是条目的 at；合并的事件组取最晚的；摘要是摘要条目的 at', () => {
    const entries = seed(
      userEntry('甲', { at: 10 }),
      eventEntry('whisper', { text: '一', at: 20 }),
      eventEntry('whisper', { text: '二', at: 30 }),
    );
    const projection = project(
      [
        ...entries,
        { type: 'summary', id: 'sum', session: 's', seq: 4, at: 40, v: ENTRY_VERSION, text: '摘要', covers: 0 },
      ],
      {
        events: { whisper: { fold: true, render: (events) => ({ role: 'assistant', content: `${events.length}` }) } },
      },
    );
    assert.deepEqual(
      projection.items.map((item) => [item.pinned, item.from, item.upTo, item.at]),
      [
        [true, 0, 0, 40],
        [false, 1, 1, 10],
        [false, 2, 3, 30],
      ],
    );
  });
});

describe('isContextOverflow', () => {
  test('只看 type：CtxError、ErrorInfo、远端转出来的错误都认', () => {
    assert.equal(CONTEXT_OVERFLOW, 'context_overflow');
    assert.equal(isContextOverflow(new CtxError(CONTEXT_OVERFLOW, '放不下')), true);
    assert.equal(isContextOverflow({ message: '放不下', type: 'context_overflow', retryable: false }), true);
    assert.equal(
      isContextOverflow(Object.assign(new Error('放不下'), { type: 'context_overflow', status: 500 })),
      true,
    );
    assert.equal(isContextOverflow(new CtxError('conflict', '别的')), false);
    assert.equal(isContextOverflow(new Error('prompt is too long')), false);
    assert.equal(isContextOverflow(undefined), false);
  });
});

describe('isContextOverflowText', () => {
  test('各家的写法认得出；413 算，401、403、404、429 不算；别的错误不算', () => {
    for (const text of [
      "This model's maximum context length is 8192 tokens. However, your messages resulted in 9000 tokens.",
      'prompt is too long: 210000 tokens > 200000 maximum',
      'API Error: 400 {"error":{"code":"context_length_exceeded"}}',
      'The input token count (1200000) exceeds the maximum number of tokens allowed (1048576).',
      'Input is too long for requested model.',
    ]) {
      assert.equal(isContextOverflowText(text), true, text);
    }
    assert.equal(isContextOverflowText('Request Entity Too Large', 413), true);
    assert.equal(isContextOverflowText('too many tokens per minute', 429), false, '限流不是超窗');
    assert.equal(isContextOverflowText('prompt is too long', 401), false);
    assert.equal(isContextOverflowText('API Error: 500 network down', 500), false);
    assert.equal(isContextOverflowText(''), false);
  });
});
