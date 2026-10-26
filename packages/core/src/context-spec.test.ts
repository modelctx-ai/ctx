import assert from 'node:assert/strict';

import {
  assistantEntry,
  CTX_EVENTS,
  defineSource,
  eventEntry,
  userEntry,
  type AgentSpec,
  type ProjectionOptions,
} from '@modelctx-ai/ctx-protocol';
import { MockLanguageModelV4 } from 'ai/test';
import { describe, test } from 'vite-plus/test';

import { createContextBuilder } from './builder.ts';
import { createHarness } from './harness.ts';
import { createMemoryStore } from './store.ts';

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

function answerModel() {
  return new MockLanguageModelV4({
    doGenerate: {
      content: [{ type: 'text', text: '好' }],
      finishReason: { unified: 'stop', raw: 'stop' },
      usage,
      warnings: [],
    },
  });
}

/** 两个来源（天气、时钟）、两套投影（默认带事件规则，brief 只留最近一条消息）。 */
function setup(extra: { collected?: string[] } = {}) {
  const store = createMemoryStore();
  const collected = extra.collected ?? [];
  const sources = [
    defineSource('weather', () => {
      collected.push('weather');
      return '天气：晴';
    }),
    defineSource('clock', () => {
      collected.push('clock');
      return '现在：三点';
    }),
  ];
  const note = {
    render: ([event]: readonly { text?: string }[]) => ({ role: 'user' as const, content: `note: ${event?.text}` }),
  };
  const projection: ProjectionOptions = { events: { 'app.note': note } };
  const brief: ProjectionOptions = { window: { maxMessages: 1 } };
  const builder = createContextBuilder({ store, sources, projection, projections: { brief } });
  return { store, builder, collected };
}

async function seed(store: ReturnType<typeof setup>['store']) {
  await store.append('s', [
    userEntry('一'),
    assistantEntry('二'),
    eventEntry('app.note', { text: '记一笔' }),
    userEntry('三'),
  ]);
}

function notFound(error: Error): boolean {
  return error.name === 'not_found' && /nope/.test(error.message) && /default, brief/.test(error.message);
}

describe('AgentSpec.context：同一个 builder，按一轮选事实和投影', () => {
  test('build：来源、位置、标题按 FactsSpec 选；facts: false 不收；缺省全收放在指令后', async () => {
    const { store, builder, collected } = setup();
    await seed(store);
    const all = await builder.build({ session: 's', instructions: '你是助手' });
    assert.equal(all.instructions, '你是助手\n\n天气：晴\n现在：三点');
    assert.deepEqual(
      all.facts.map((fact) => fact.source),
      ['weather', 'clock'],
    );

    collected.length = 0;
    const only = await builder.build({
      session: 's',
      instructions: '你是助手',
      prompt: '现在呢',
      facts: { sources: ['clock'], placement: 'prompt', heading: '【环境】' },
    });
    assert.deepEqual(collected, ['clock'], '没选的来源不调用');
    assert.equal(only.instructions, '你是助手', '事实不进指令');
    assert.deepEqual(only.messages.at(-1), { role: 'user', content: '【环境】\n现在：三点\n\n现在呢' });
    assert.deepEqual(
      only.facts.map((fact) => fact.source),
      ['clock'],
    );

    collected.length = 0;
    const none = await builder.build({ session: 's', instructions: '你是助手', facts: false });
    assert.deepEqual(collected, []);
    assert.equal(none.instructions, '你是助手');
    assert.deepEqual(none.facts, []);
  });

  test('FactsSpec.placement 覆盖 builder 的 factsPlacement；没写就用 builder 的', async () => {
    const store = createMemoryStore();
    const sources = [defineSource('clock', () => '现在：三点')];
    const builder = createContextBuilder({ store, sources, factsPlacement: 'prompt' });
    const byDefault = await builder.build({ session: 's', instructions: 'x', prompt: 'p' });
    assert.equal(byDefault.instructions, 'x');
    assert.match(JSON.stringify(byDefault.messages.at(-1)), /现在：三点/);
    const overridden = await builder.build({ session: 's', instructions: 'x', facts: { placement: 'instructions' } });
    assert.equal(overridden.instructions, 'x\n\n现在：三点');
  });

  test('没注册的来源名：忽略并告警一次，不抛', async () => {
    const warned: string[] = [];
    const store = createMemoryStore();
    const builder = createContextBuilder({
      store,
      sources: [defineSource('clock', () => '现在：三点')],
      logger: { warn: (message) => warned.push(message) },
    });
    const prepared = await builder.build({ session: 's', facts: { sources: ['clock', 'typo'] } });
    assert.deepEqual(
      prepared.facts.map((fact) => fact.source),
      ['clock'],
    );
    assert.deepEqual(warned, ['context source "typo" is not registered']);
  });

  test('投影按名字选：default 是原来的 projection，brief 用自己的窗口；view 和 build 一致', async () => {
    const { store, builder } = setup();
    await seed(store);
    const byDefault = await builder.build({ session: 's', facts: false });
    assert.deepEqual(
      byDefault.messages.map((message) => message.content),
      ['一', '二', 'note: 记一笔', '三'],
    );
    const brief = await builder.build({ session: 's', facts: false, projection: 'brief' });
    assert.deepEqual(
      brief.messages.map((message) => message.content),
      ['三'],
      'brief 没有事件规则，窗口只留最近一条',
    );
    const named = await builder.view('s', { projection: 'default' });
    assert.deepEqual(named.messages, byDefault.messages);
    assert.deepEqual((await builder.view('s', { projection: 'brief' })).messages, brief.messages);
  });

  test('projections.default 优先于 projection 选项；没有 default 时取 projection', async () => {
    const store = createMemoryStore();
    await seed(store);
    const loud: ProjectionOptions = { message: () => ({ role: 'user', content: 'X' }) };
    const builder = createContextBuilder({ store, projection: {}, projections: { default: loud } });
    assert.deepEqual(
      (await builder.build({ session: 's' })).messages.map((message) => message.content),
      ['X', 'X', 'X'],
    );
  });

  test('不认识的投影名：build、view 以 not_found 失败，不回退，也不先去收事实', async () => {
    const { store, builder, collected } = setup();
    await seed(store);
    await assert.rejects(builder.build({ session: 's', projection: 'nope' }), notFound);
    await assert.rejects(builder.view('s', { projection: 'nope' }), notFound);
    await assert.rejects(builder.view('s', { projection: 'toString' }), (error: Error) => error.name === 'not_found');
    assert.deepEqual(collected, []);
  });
});

function run(agent: AgentSpec, model = answerModel()) {
  const { store, builder } = setup();
  const harness = createHarness({ store, context: builder });
  return {
    store,
    model,
    done: seed(store).then(() => harness.run({ session: 's', agent: { ...agent, model }, input: '四' })),
  };
}

describe('AgentSpec.context 经 harness 到 builder', () => {
  test('两个 context 得到不同的事实、位置和投影；agentSpecToJson 把 context 记进 ctx.run.started', async () => {
    const a = run({ model: 'm', instructions: '你是助手', context: { facts: { sources: ['weather'] } } });
    assert.equal((await a.done).stopReason, 'end_turn');
    const first = a.model.doGenerateCalls[0]!.prompt;
    assert.match(JSON.stringify(first[0]), /天气：晴/);
    assert.ok(!JSON.stringify(first[0]).includes('三点'));
    assert.match(JSON.stringify(first), /note: 记一笔/);

    const b = run({
      model: 'm',
      instructions: '你是助手',
      context: { facts: { sources: ['clock'], placement: 'prompt', heading: '【环境】' }, projection: 'brief' },
    });
    assert.equal((await b.done).stopReason, 'end_turn');
    const second = b.model.doGenerateCalls[0]!.prompt;
    assert.ok(!JSON.stringify(second[0]).includes('三点'), '事实没有进指令');
    assert.ok(!JSON.stringify(second).includes('note: 记一笔'), 'brief 投影没有事件规则');
    assert.match(JSON.stringify(second.at(-1)), /【环境】.*现在：三点/);

    const started = (await b.store.list('s')).find(
      (entry) => entry.type === 'event' && entry.kind === CTX_EVENTS.runStarted,
    );
    assert.deepEqual(started?.type === 'event' && (started.data as { agent: { context?: unknown } }).agent.context, {
      facts: { sources: ['clock'], placement: 'prompt', heading: '【环境】' },
      projection: 'brief',
    });
  });

  test('context.facts: false 不收事实', async () => {
    const collected: string[] = [];
    const { store, builder } = setup({ collected });
    const harness = createHarness({ store, context: builder });
    const model = answerModel();
    await harness.run({ session: 's', agent: { model, instructions: 'x', context: { facts: false } }, input: '一' });
    assert.deepEqual(collected, []);
    assert.equal(model.doGenerateCalls[0]!.prompt[0]?.content, 'x');
  });

  test('未知的投影名：这一轮以 error 结束（not_found），日志里有 ctx.error 和 ctx.run.ended', async () => {
    const { done, store, model } = run({ model: 'm', context: { projection: 'nope' } });
    const result = await done;
    assert.equal(result.stopReason, 'error');
    assert.equal(result.error?.type, 'not_found');
    assert.equal(model.doGenerateCalls.length, 0, '没调模型');
    const kinds = (await store.list('s')).flatMap((entry) => (entry.type === 'event' ? [entry.kind] : []));
    assert.deepEqual(kinds.slice(-2), [CTX_EVENTS.error, CTX_EVENTS.runEnded]);
  });
});
