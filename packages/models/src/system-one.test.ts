import assert from 'node:assert/strict';

import {
  CtxError,
  MAX_DECISION_QUESTIONS,
  type DecisionQuestion,
  type ExtractionField,
} from '@modelctx-ai/ctx-protocol';
import { describeDecisionModelContract, describeExtractionModelContract } from '@modelctx-ai/ctx-protocol/testing';
import { describe, test } from 'vite-plus/test';

import {
  createDecisionModel,
  createDecisionModelRegistry,
  createExtractionModel,
  createExtractionModelRegistry,
  SystemOneError,
  type SystemOneSpec,
} from './index.ts';

type Json = Record<string, unknown>;

interface Seen {
  readonly url: string;
  readonly headers: Headers;
  readonly body: Json;
  readonly signal: AbortSignal | undefined;
}

type Reply = (body: Json) => Response | Promise<Response>;

/** 假 fetch：记下请求，交给 `reply` 造响应；不联网。 */
function fakeFetch(reply: Reply): { fetch: typeof fetch; seen: Seen[] } {
  const seen: Seen[] = [];
  const fake = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(init?.body as string) as Json;
    seen.push({
      url: input instanceof Request ? input.url : input.toString(),
      headers: new Headers(init?.headers),
      body,
      signal: init?.signal ?? undefined,
    });
    init?.signal?.throwIfAborted();
    return reply(body);
  };
  return { fetch: fake, seen };
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

/** Cloudflare REST 的外壳。 */
function envelope(result: unknown): Response {
  return json({ result, success: true, errors: [], messages: [] });
}

/** 照 Clef / Jev 文档里的响应造回答：choice 偏第一个选项，score 偏最高档、`score` 是 0..n−1 档位刻度。 */
function decisionReply(body: Json): Json {
  const questions = body['questions'] as Record<string, DecisionQuestion>;
  const answers = Object.fromEntries(
    Object.entries(questions).map(([key, question]) => {
      if (question.type === 'noul') return [key, { type: 'noul', noul: 0.8 }];
      if (question.type === 'choice') {
        const options = Object.keys(question.criteria);
        const probabilities = Object.fromEntries(
          options.map((option, i) => [option, i === 0 ? 0.6 : 0.4 / (options.length - 1)]),
        );
        return [key, { type: 'choice', choice: options[0], confidence: 0.5, probabilities }];
      }
      const n = question.criteria.length;
      const levels = question.criteria.map((_, i) => (i === n - 1 ? 0.7 : 0.3 / (n - 1)));
      return [
        key,
        {
          type: 'score',
          score: levels.reduce((sum, p, i) => sum + p * i, 0),
          confidence: 0.6,
          legend: Object.fromEntries(question.criteria.map((text, i) => [String(i), text])),
          probabilities: Object.fromEntries(levels.map((p, i) => [String(i), p])),
        },
      ];
    }),
  );
  return { model: body['model'], answers, usage: { input_tokens: 10, output_tokens: 0 } };
}

function fakeValue(field: ExtractionField): unknown {
  switch (field.type) {
    case 'text':
      return '台北';
    case 'number':
      return field.integer ? 2 : 1200.5;
    case 'date':
      return '2026-11-04';
    case 'datetime':
      return '2026-11-04T14:00:00+08:00';
    case 'duration':
      return 5400;
    default:
      return field.items === 'text' ? ['小明', '小红'] : [1200.5];
  }
}

/** 照 Clairic 文档里的响应造回答；`list` 没有 `p_null`，和文档的例子一样。 */
function extractionReply(body: Json): Json {
  const fields = body['fields'] as Record<string, ExtractionField>;
  const answers = Object.fromEntries(
    Object.entries(fields).map(([key, field]) => [
      key,
      field.type === 'list'
        ? { type: 'list', value: fakeValue(field), confidence: 0.9 }
        : { type: field.type, p_null: 0.01, guess: fakeValue(field), confidence: 0.95, value: fakeValue(field) },
    ]),
  );
  return { model: body['model'], answers, truncated: false, usage: { input_tokens: 10, output_tokens: 0 } };
}

const CLOUDFLARE: SystemOneSpec = { provider: 'cloudflare', model: 'clef-flash', accountId: 'acc', apiKey: 'cf-token' };
const TYPESAFE: SystemOneSpec = { provider: 'typesafe', model: 'jev-latest', apiKey: 'ts-key' };
const CLAIRIC: SystemOneSpec = { provider: 'cloudflare', model: 'clairic', accountId: 'acc', apiKey: 'cf-token' };

describeDecisionModelContract(
  'cloudflare',
  () => createDecisionModel(CLOUDFLARE, { fetch: fakeFetch((body) => envelope(decisionReply(body))).fetch }),
  { describe, test },
);
describeDecisionModelContract(
  'typesafe',
  () => createDecisionModel(TYPESAFE, { fetch: fakeFetch((body) => json(decisionReply(body))).fetch }),
  { describe, test },
);
describeExtractionModelContract(
  'cloudflare',
  () => createExtractionModel(CLAIRIC, { fetch: fakeFetch((body) => envelope(extractionReply(body))).fetch }),
  { describe, test },
);

function isInvalidRequest(error: unknown): boolean {
  return error instanceof CtxError && error.type === 'invalid_request';
}

const ASK: Record<string, DecisionQuestion> = { keep: { type: 'noul', instructions: '值得记吗？' } };

describe('System One 决策模型', () => {
  test('cloudflare：POST 到 accounts/{id}/ai/run/@cf/cloudflare/<model>，带 Bearer 和额外请求头，拆掉 result 外壳', async () => {
    const { fetch, seen } = fakeFetch((body) => envelope(decisionReply(body)));
    const model = createDecisionModel({ ...CLOUDFLARE, headers: { 'cf-aig-metadata': '{}' } }, { fetch });
    assert.equal(model.name, 'cloudflare:clef-flash');
    const replies = await model.decide({ state: { text: '以后用中文' }, questions: ASK });
    assert.deepEqual(replies, { keep: { type: 'noul', noul: 0.8 } });
    assert.equal(seen[0]?.url, 'https://api.cloudflare.com/client/v4/accounts/acc/ai/run/@cf/cloudflare/clef-flash');
    assert.equal(seen[0]?.headers.get('authorization'), 'Bearer cf-token');
    assert.equal(seen[0]?.headers.get('content-type'), 'application/json');
    assert.equal(seen[0]?.headers.get('cf-aig-metadata'), '{}');
    assert.deepEqual(seen[0]?.body, { model: 'clef-flash', state: { text: '以后用中文' }, questions: ASK });
  });

  test('typesafe：POST 到 <baseUrl>/v1/systemone，baseUrl 已经以 /v1 结尾不再补；name 可以自定', async () => {
    const { fetch, seen } = fakeFetch((body) => json(decisionReply(body)));
    for (const baseUrl of [undefined, 'https://proxy.example/', 'https://proxy.example/v1']) {
      const spec = baseUrl === undefined ? TYPESAFE : { ...TYPESAFE, baseUrl, name: 'jev' };
      const model = createDecisionModel(spec, { fetch });
      await model.decide({ state: '在吗', questions: ASK });
      assert.equal(model.name, baseUrl === undefined ? 'typesafe:jev-latest' : 'jev');
    }
    assert.deepEqual(
      seen.map((request) => request.url),
      [
        'https://api.typesafe.ai/v1/systemone',
        'https://proxy.example/v1/systemone',
        'https://proxy.example/v1/systemone',
      ],
    );
    assert.equal(seen[0]?.headers.get('authorization'), 'Bearer ts-key');
    assert.equal(seen[0]?.body['model'], 'jev-latest');
  });

  test('回答收紧到契约：概率归一、choice 取最大、score 按归一后的概率重算到 0..1、noul 夹到 0..1', async () => {
    const { fetch } = fakeFetch(() =>
      json({
        model: 'jev-latest',
        answers: {
          yes: { type: 'noul', noul: 1.3 },
          kind: { type: 'choice', choice: 'a', probabilities: { a: 2, b: 6, extra: 9 } },
          level: { type: 'score', score: 2.8, probabilities: { '0': 0.2, '1': 0.2, '2': 0.6 } },
          list: { type: 'score', score: 0, probabilities: [0, 0] },
        },
      }),
    );
    const replies = await createDecisionModel(TYPESAFE, { fetch }).decide({
      state: 's',
      questions: {
        yes: { type: 'noul', instructions: '?' },
        kind: { type: 'choice', instructions: '?', criteria: { a: 'A', b: 'B' } },
        level: { type: 'score', instructions: '?', criteria: ['低', '中', '高'] },
        list: { type: 'score', instructions: '?', criteria: ['低', '高'] },
      },
    });
    assert.deepEqual(replies['yes'], { type: 'noul', noul: 1 });
    assert.deepEqual(replies['kind'], {
      type: 'choice',
      choice: 'b',
      probabilities: { a: 0.25, b: 0.75 },
      confidence: 0.75,
    });
    assert.equal(replies['level']?.type, 'score');
    if (replies['level']?.type === 'score') {
      assert.deepEqual(replies['level'].probabilities, [0.2, 0.2, 0.6]);
      assert.ok(Math.abs(replies['level'].score - 0.7) < 1e-9);
    }
    assert.deepEqual(replies['list'], { type: 'score', score: 0.5, probabilities: [0.5, 0.5] }, '全是 0 时均匀分布');
  });

  test('服务不收的问题名换成别名发，回来换回原名；只有一个选项的 choice 本地答', async () => {
    const { fetch, seen } = fakeFetch((body) => json(decisionReply(body)));
    const model = createDecisionModel(TYPESAFE, { fetch });
    const replies = await model.decide({
      state: 's',
      questions: {
        保留: { type: 'noul', instructions: '?' },
        q0: { type: 'noul', instructions: '?' },
        only: { type: 'choice', instructions: '?', criteria: { solo: '唯一' } },
      },
    });
    const sent = Object.keys(seen[0]?.body['questions'] as Json);
    assert.equal(sent.length, 2);
    assert.ok(sent.includes('q0'));
    assert.ok(sent.every((key) => /^[A-Za-z0-9_.-]{1,100}$/.test(key)));
    assert.deepEqual(Object.keys(replies), ['保留', 'q0', 'only']);
    assert.deepEqual(replies['保留'], { type: 'noul', noul: 0.8 });
    assert.deepEqual(replies['only'], { type: 'choice', choice: 'solo', probabilities: { solo: 1 }, confidence: 1 });

    await model.decide({ state: 's', questions: { only: { type: 'choice', instructions: '?', criteria: { x: '' } } } });
    assert.equal(seen.length, 1, '全是本地答的题时不发请求');
  });

  test(`超过 ${MAX_DECISION_QUESTIONS} 个问题、choice 没有选项、score 少于两档：invalid_request，不发请求`, async () => {
    const { fetch, seen } = fakeFetch((body) => json(decisionReply(body)));
    const model = createDecisionModel(TYPESAFE, { fetch });
    const many = Object.fromEntries(
      Array.from({ length: MAX_DECISION_QUESTIONS + 1 }, (_, i) => [`q${i}`, { type: 'noul', instructions: '?' }]),
    ) as Record<string, DecisionQuestion>;
    await assert.rejects(model.decide({ state: 's', questions: many }), isInvalidRequest);
    await assert.rejects(
      model.decide({ state: 's', questions: { c: { type: 'choice', instructions: '?', criteria: {} } } }),
      isInvalidRequest,
    );
    await assert.rejects(
      model.decide({ state: 's', questions: { s: { type: 'score', instructions: '?', criteria: ['只有一档'] } } }),
      isInvalidRequest,
    );
    assert.equal(seen.length, 0);
  });

  test('非 2xx 抛 SystemOneError：api_call、statusCode、responseBody 原文，429 / 5xx 可重试', async () => {
    for (const [status, retryable] of [
      [429, true],
      [529, true],
      [401, false],
      [422, false],
    ] as const) {
      const body = JSON.stringify({ detail: [{ loc: ['body', 'state'], msg: 'Field required' }] });
      const { fetch } = fakeFetch(() => new Response(body, { status }));
      const error = await createDecisionModel(TYPESAFE, { fetch })
        .decide({ state: 's', questions: ASK })
        .then(
          () => assert.fail('应当 reject'),
          (reason: unknown) => reason,
        );
      assert.ok(error instanceof SystemOneError);
      assert.ok(error instanceof CtxError);
      assert.equal(error.type, 'api_call');
      assert.equal(error.name, 'api_call');
      assert.equal(error.statusCode, status);
      assert.equal(error.responseBody, body);
      assert.equal(error.retryable, retryable);
      assert.match(error.message, new RegExp(`typesafe:jev-latest: HTTP ${status}`));
    }
  });

  test('Cloudflare 外壳 success: false 也是 SystemOneError；不是 JSON、缺回答、回答类型不对是 invalid_response', async () => {
    const failed = JSON.stringify({ result: null, success: false, errors: [{ code: 5006, message: 'bad' }] });
    const cases: [Response, (error: unknown) => boolean][] = [
      [new Response(failed), (error) => error instanceof SystemOneError && error.responseBody === failed],
      [new Response('<html>'), (error) => error instanceof CtxError && error.type === 'invalid_response'],
      [envelope({ answers: {} }), (error) => error instanceof CtxError && /"keep" is missing/.test(error.message)],
      [
        envelope({ answers: { keep: { type: 'choice', choice: 'x', probabilities: {} } } }),
        (error) => error instanceof CtxError && /expected "noul"/.test(error.message),
      ],
      [envelope({ model: 'clef' }), (error) => error instanceof CtxError && error.type === 'invalid_response'],
    ];
    for (const [response, check] of cases) {
      const { fetch } = fakeFetch(() => response);
      await assert.rejects(createDecisionModel(CLOUDFLARE, { fetch }).decide({ state: 's', questions: ASK }), check);
    }
  });

  test('signal：已中止时不发请求就 reject；请求途中中止，signal 传给 fetch，decide reject', async () => {
    const { fetch, seen } = fakeFetch((body) => json(decisionReply(body)));
    const model = createDecisionModel(TYPESAFE, { fetch });
    await assert.rejects(model.decide({ state: 's', questions: ASK, signal: AbortSignal.abort() }), {
      name: 'AbortError',
    });
    assert.equal(seen.length, 0);

    const controller = new AbortController();
    const hanging = fakeFetch(
      () =>
        new Promise<Response>((_, reject) => {
          const signal = controller.signal;
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
    );
    const pending = createDecisionModel(TYPESAFE, { fetch: hanging.fetch }).decide({
      state: 's',
      questions: ASK,
      signal: controller.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    assert.equal(hanging.seen[0]?.signal, controller.signal);
  });
});

describe('System One 提取模型', () => {
  test('cloudflare：发 { model, state, fields }，JSON 的 state 先序列化，duration 要秒，字段名不合规的换别名', async () => {
    const { fetch, seen } = fakeFetch((body) => envelope(extractionReply(body)));
    const model = createExtractionModel(CLAIRIC, { fetch });
    assert.equal(model.name, 'cloudflare:clairic');
    const fields: Record<string, ExtractionField> = {
      place: { type: 'text', instructions: '地点' },
      时长: { type: 'duration' },
      people: { type: 'number', integer: true },
    };
    const replies = await model.extract({ state: { note: '台北，90 分钟，2 人' }, fields });
    assert.equal(seen[0]?.url, 'https://api.cloudflare.com/client/v4/accounts/acc/ai/run/@cf/cloudflare/clairic');
    assert.equal(seen[0]?.headers.get('authorization'), 'Bearer cf-token');
    assert.equal(seen[0]?.body['model'], 'clairic');
    assert.equal(seen[0]?.body['state'], JSON.stringify({ note: '台北，90 分钟，2 人' }));
    const sent = seen[0]?.body['fields'] as Record<string, Json>;
    assert.deepEqual(sent['place'], { type: 'text', instructions: '地点' });
    assert.deepEqual(sent['people'], { type: 'number', integer: true });
    const alias = Object.keys(sent).find((key) => key !== 'place' && key !== 'people')!;
    assert.match(alias, /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/);
    assert.deepEqual(sent[alias], { type: 'duration', unit: 'seconds' });
    assert.deepEqual(replies, {
      place: { value: '台北', pNull: 0.01, confidence: 0.95 },
      时长: { value: 5400, pNull: 0.01, confidence: 0.95 },
      people: { value: 2, pNull: 0.01, confidence: 0.95 },
    });
  });

  test('值收紧到协议的形状，收不成的是 null；缺 p_null、confidence 时按 value 推', async () => {
    const { fetch } = fakeFetch(() =>
      envelope({
        model: 'clairic',
        answers: {
          n: { type: 'number', value: 2.6, p_null: 0.1, confidence: 0.8 },
          d: { type: 'number', value: 1.23456, p_null: 0.1, confidence: 0.8 },
          day: { type: 'date', value: '2026-11-04T14:00:00Z', p_null: 0.1, confidence: 0.8 },
          at: { type: 'datetime', value: 'Wed, 04 Nov 2026 06:00:00 GMT', p_null: 0.1, confidence: 0.8 },
          bad: { type: 'text', value: 42, p_null: 0.2, confidence: 0.7 },
          gone: { type: 'text', value: null, p_null: 1, guess: 'INV-2291', confidence: 0.9995 },
          names: { type: 'list', value: ['小明', 3, '小红'] },
          none: { type: 'duration', value: -5 },
        },
      }),
    );
    const replies = await createExtractionModel(CLAIRIC, { fetch }).extract({
      state: 's',
      fields: {
        n: { type: 'number', integer: true },
        d: { type: 'number', decimals: 2 },
        day: { type: 'date' },
        at: { type: 'datetime' },
        bad: { type: 'text' },
        gone: { type: 'text' },
        names: { type: 'list', items: 'text' },
        none: { type: 'duration' },
      },
    });
    assert.deepEqual(replies, {
      n: { value: 3, pNull: 0.1, confidence: 0.8 },
      d: { value: 1.23, pNull: 0.1, confidence: 0.8 },
      day: { value: '2026-11-04', pNull: 0.1, confidence: 0.8 },
      at: { value: '2026-11-04T06:00:00.000Z', pNull: 0.1, confidence: 0.8 },
      bad: { value: null, pNull: 0.2, confidence: 0.7 },
      gone: { value: null, pNull: 1, confidence: 0.9995 },
      names: { value: ['小明', '小红'], pNull: 0, confidence: 1 },
      none: { value: null, pNull: 1, confidence: 1 },
    });
  });

  test('空输入、没有字段时不发请求；非 2xx 抛 SystemOneError；signal 已中止时 reject', async () => {
    const { fetch, seen } = fakeFetch(() => new Response('{"errors":[{"message":"rate limited"}]}', { status: 429 }));
    const model = createExtractionModel(CLAIRIC, { fetch });
    assert.deepEqual(await model.extract({ state: '  ', fields: { a: { type: 'text' } } }), {
      a: { value: null, pNull: 1, confidence: 1 },
    });
    assert.deepEqual(await model.extract({ state: 's', fields: {} }), {});
    assert.equal(seen.length, 0);
    await assert.rejects(
      model.extract({ state: 's', fields: { a: { type: 'text' } } }),
      (error) => error instanceof SystemOneError && error.statusCode === 429 && error.retryable === true,
    );
    await assert.rejects(model.extract({ state: 's', fields: { a: { type: 'text' } }, signal: AbortSignal.abort() }), {
      name: 'AbortError',
    });
    assert.equal(seen.length, 1);
  });
});

describe('System One 注册表', () => {
  test('内置服务商；可以注册、覆盖；provider 必填，未知服务商、缺 model、cloudflare 缺 accountId 报清楚的错', async () => {
    const decisions = createDecisionModelRegistry();
    assert.deepEqual(decisions.providers(), ['cloudflare', 'typesafe']);
    const custom = { name: 'mock', decide: async () => ({}) };
    assert.equal(decisions.register('mock', () => custom).create({ provider: 'mock', model: 'x' }), custom);
    assert.deepEqual(decisions.providers(), ['cloudflare', 'typesafe', 'mock']);
    assert.throws(() => decisions.create({ provider: 'nope', model: 'x' }), /Unknown System One provider "nope"/);
    assert.throws(() => decisions.create({ provider: '', model: 'x' }), /needs `provider`/);
    assert.throws(() => decisions.create({ provider: 'typesafe', model: ' ' }), /needs `model`/);
    assert.throws(() => decisions.create({ provider: 'cloudflare', model: 'clef' }), /need `accountId`/);

    const extractions = createExtractionModelRegistry({
      typesafe: (spec) => ({ name: spec.model, extract: async () => ({}) }),
    });
    assert.deepEqual(extractions.providers(), ['cloudflare', 'typesafe']);
    assert.equal(extractions.create({ provider: 'typesafe', model: 'mine' }).name, 'mine');
    assert.deepEqual(createExtractionModelRegistry().providers(), ['cloudflare'], 'TypeSafe 没有提取接口，不内置');
    assert.throws(() => createExtractionModel({ provider: 'typesafe', model: 'jev' }), /Unknown System One provider/);
  });

  test('不注入 fetch 时用全局 fetch', async () => {
    const original = globalThis.fetch;
    const { fetch, seen } = fakeFetch((body) => json(decisionReply(body)));
    globalThis.fetch = fetch;
    try {
      await createDecisionModel(TYPESAFE).decide({ state: 's', questions: ASK });
      assert.equal(seen.length, 1);
    } finally {
      globalThis.fetch = original;
    }
  });
});
