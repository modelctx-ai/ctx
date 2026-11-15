// 录制和重放这套机制自己的测试。这里的「上游」是按 OpenAI 兼容接口的文档手写的假响应，不是录下来的：
// 它只证明机制能用（录得下来、密钥去得掉、重放出来结果一样），不证明对真实服务的映射是对的。
import assert from 'node:assert/strict';

import { describe, test } from 'vite-plus/test';

import { recordingFetch, replayFetch, scrub, withFetch, type Fixture } from './exchange.ts';
import { scenarioNamed } from './scenarios.ts';
import { runScenario } from './smoke.ts';
import { redactTarget, secretsOf, targetsFromEnv, type Target } from './targets.ts';

const API_KEY = 'sk-live-secret-123456';
const TARGET: Target = {
  kind: 'model',
  name: 'fake',
  spec: { provider: 'openai-compatible', baseUrl: 'https://llm.invalid/v1', model: 'fake-1', apiKey: API_KEY },
};

function chunk(delta: object, finish: string | null = null): string {
  const data = { id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'fake-1' };
  return `data: ${JSON.stringify({ ...data, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
}

function sse(chunks: readonly string[], usage: object): Response {
  const tail = `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', choices: [], usage })}\n\ndata: [DONE]\n\n`;
  return new Response([...chunks, tail].join(''), { headers: { 'content-type': 'text/event-stream' } });
}

function call(fn: object, id?: string): object {
  return { tool_calls: [{ index: 0, ...(id ? { id, type: 'function' } : {}), function: fn }] };
}

/** 假的 OpenAI 兼容上游。本机地址（场景自己起的网关）交给真的 `fetch`。 */
function fakeUpstream(seen: { url: string; auth: string | null; body: string }[] = []): typeof fetch {
  const real = globalThis.fetch;
  return async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (new URL(url).hostname === '127.0.0.1') return real(input, init);
    const text = typeof init?.body === 'string' ? init.body : Buffer.from(init?.body as Uint8Array).toString('utf8');
    seen.push({ url, auth: new Headers(init?.headers).get('authorization'), body: text });
    const body = JSON.parse(text) as { stream?: boolean; messages: { role: string }[] };
    if (!body.stream) {
      return Response.json({
        id: 'c2',
        object: 'chat.completion',
        choices: [{ index: 0, message: { role: 'assistant', content: 'It is 42.' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 30, completion_tokens: 5, total_tokens: 35 },
      });
    }
    if (body.messages.some((message) => message.role === 'tool')) {
      return sse([chunk({ role: 'assistant', content: '17 + 25 ' }), chunk({ content: 'is 42.' }), chunk({}, 'stop')], {
        prompt_tokens: 80,
        completion_tokens: 9,
        total_tokens: 89,
      });
    }
    return sse(
      [
        chunk({ role: 'assistant', content: null, ...call({ name: 'add', arguments: '' }, 'call_1') }),
        chunk(call({ arguments: '{"a":17,' })),
        chunk(call({ arguments: '"b":25}' })),
        chunk({}, 'tool_calls'),
      ],
      { prompt_tokens: 60, completion_tokens: 14, total_tokens: 74 },
    );
  };
}

/** 上游的响应里工具参数成了字符串、用量没了。 */
const broken: typeof fetch = async (input, init) => {
  const response = await fakeUpstream()(input, init);
  const text = (await response.text())
    .replace('{\\"a\\":17,', '{\\"a\\":\\"17\\",')
    .replaceAll(/"usage":\{[^}]*\}/g, '"usage":null');
  return new Response(text, { headers: response.headers });
};

const down: typeof fetch = () => Promise.reject(new TypeError('fetch failed'));

describe('录制和重放', () => {
  test('一轮带工具的流式运行：录下来，密钥不在里面，重放出来结果一样', async () => {
    const seen: { url: string; auth: string | null; body: string }[] = [];
    const result = await withFetch(fakeUpstream(seen), () => runScenario(TARGET, scenarioNamed('tool-stream')!));
    assert.deepEqual(result.problems, []);
    assert.equal(seen[0]?.auth, `Bearer ${API_KEY}`, '真的请求带着密钥');
    const fixture = JSON.parse(JSON.stringify(result.fixture)) as Fixture;
    assert.equal(fixture.exchanges.length, 2);
    assert.ok(!JSON.stringify(fixture).includes(API_KEY), '夹具里没有密钥');
    assert.equal(fixture.exchanges[0]!.request.url, 'https://llm.invalid/v1/chat/completions');
    assert.match(fixture.exchanges[0]!.response.contentType, /event-stream/);
    assert.deepEqual(fixture.observation, {
      events: [
        'run.started',
        'model.started',
        'tool.called',
        'tool.returned',
        'model.ended',
        'model.started',
        'text.delta',
        'model.ended',
        'run.ended',
      ],
      toolCalls: [{ name: 'add', input: { a: 17, b: 25 } }],
      toolOutputs: [{ type: 'text', text: '42' }],
      text: '17 + 25 is 42.',
      stopReason: 'end_turn',
      usage: { inputTokens: 140, outputTokens: 23, totalTokens: 163 },
    });

    // 重放：不碰网络，目标用夹具里去掉密钥的那一份。
    const replay = replayFetch(fixture.exchanges, () => Promise.reject(new Error('重放不该联网')));
    const outcome = await withFetch(replay, () =>
      scenarioNamed(fixture.scenario)!.run(fixture.target as unknown as Target, replay),
    );
    assert.deepEqual(outcome.problems, []);
    assert.deepEqual(outcome.observation, fixture.observation);
  });

  test('重放时请求的地址变了、请求比录的多，都报错', async () => {
    const exchange = {
      request: { method: 'POST', url: 'https://llm.invalid/v1/chat/completions' },
      response: { status: 200, contentType: 'application/json', body: '{}' },
    };
    const replay = replayFetch([exchange]);
    await assert.rejects(replay('https://llm.invalid/v2/chat/completions', { method: 'POST' }), /was recorded/);
    const again = replayFetch([exchange]);
    assert.equal((await again('https://llm.invalid/v1/chat/completions', { method: 'POST' })).status, 200);
    await assert.rejects(again('https://llm.invalid/v1/chat/completions', { method: 'POST' }), /unexpected request/);
  });

  test('场景看出映射不对：工具参数成了字符串、用量没了', async () => {
    const result = await withFetch(broken, () => runScenario(TARGET, scenarioNamed('tool-stream')!));
    assert.ok(result.problems.length > 0);
    assert.match(result.problems.join('\n'), /usage\.inputTokens is missing/);
  });

  test('场景抛错算一个问题，不让整次冒烟停下', async () => {
    const result = await withFetch(down, () => runScenario(TARGET, scenarioNamed('tool-stream')!));
    assert.ok(result.problems.length > 0);
  });

  test('网关改写过的请求：没配对的工具调用补上了结果，同一句话只有一遍', async () => {
    const seen: { url: string; auth: string | null; body: string }[] = [];
    const result = await withFetch(fakeUpstream(seen), () => runScenario(TARGET, scenarioNamed('gateway-rewrite')!));
    assert.deepEqual(result.problems, []);
    assert.equal(seen.length, 1);
    const sent = JSON.parse(seen[0]!.body) as {
      messages: { role: string; tool_calls?: { id: string }[]; tool_call_id?: string }[];
    };
    assert.deepEqual(
      sent.messages.map((message) => message.role),
      ['user', 'assistant', 'assistant', 'tool', 'user'],
    );
    assert.equal(sent.messages[3]!.tool_call_id, sent.messages[2]!.tool_calls?.[0]?.id);
    assert.ok(!JSON.stringify(result.fixture).includes(API_KEY));
  });

  test('scrub 换掉密钥，太短的值不动', () => {
    assert.equal(scrub('Bearer abcdef123 and ab', ['abcdef123', 'ab']), 'Bearer REDACTED and ab');
  });

  test('recordingFetch 不录本机地址', async () => {
    const recorder = recordingFetch(async () => new Response('ok'), []);
    await recorder.fetch('http://127.0.0.1:9/x');
    await recorder.fetch('https://llm.invalid/x', { method: 'post', body: 'hello' });
    assert.deepEqual(await recorder.finish(), [
      {
        request: { method: 'POST', url: 'https://llm.invalid/x', body: 'hello' },
        response: { status: 200, contentType: 'text/plain;charset=UTF-8', body: 'ok' },
      },
    ]);
  });
});

describe('目标', () => {
  test('变量齐了才有目标，不齐的组列出缺什么', () => {
    const { targets, skipped } = targetsFromEnv({
      CTX_LIVE_OPENAI_BASE_URL: 'https://llm.invalid/v1',
      CTX_LIVE_OPENAI_MODEL: 'fake-1',
      CTX_LIVE_CLOUDFLARE_ACCOUNT_ID: 'acct-123456',
      CTX_LIVE_CLOUDFLARE_API_TOKEN: 'cf-token-123456',
      CTX_LIVE_ANTHROPIC_MODEL: 'some-model',
      CTX_LIVE_MCP_URL: 'https://mcp.invalid/mcp',
      CTX_LIVE_MCP_TOOL: 'echo',
      CTX_LIVE_MCP_INPUT: '{"text":"hi"}',
    });
    assert.deepEqual(
      targets.map((target) => target.name),
      ['openai-compatible', 'cloudflare-decision', 'cloudflare-extraction', 'mcp'],
    );
    assert.deepEqual(skipped, [
      { name: 'anthropic', missing: ['CTX_LIVE_ANTHROPIC_API_KEY'] },
      { name: 'typesafe', missing: ['CTX_LIVE_TYPESAFE_API_KEY'] },
    ]);
    const cloudflare = targets[1]!;
    assert.deepEqual(secretsOf(cloudflare), ['cf-token-123456', 'acct-123456']);
    assert.ok(!JSON.stringify(redactTarget(cloudflare)).includes('123456'));
    assert.deepEqual(targets[3], {
      kind: 'mcp',
      name: 'mcp',
      url: 'https://mcp.invalid/mcp',
      tool: 'echo',
      input: { text: 'hi' },
    });
  });
});
