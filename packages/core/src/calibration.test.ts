import assert from 'node:assert/strict';

import { assistantEntry, stepMetaOf, userEntry, type NewEntry } from '@modelctx-ai/ctx-protocol';
import { MockLanguageModelV4 } from 'ai/test';
import { describe, test } from 'vite-plus/test';

import { createContextBuilder, MAX_CALIBRATION } from './builder.ts';
import { createHarness } from './harness.ts';
import { createMemoryStore } from './store.ts';
import { createScriptedModel } from './testing.ts';

/** 上一轮第一步的助手消息：估算 `estimated`，服务商实际计了 `actual`。 */
function sample(estimated: number, actual: number, calibration?: number): NewEntry {
  return assistantEntry('上一轮的回答', {
    meta: {
      step: {
        runId: 'old',
        step: 0,
        usage: { inputTokens: actual },
        estimatedInputTokens: estimated,
        ...(calibration !== undefined ? { calibration } : {}),
      },
    },
  });
}

/** 40 条长消息，最后一条是校准样本。 */
async function history(...last: NewEntry[]) {
  const store = createMemoryStore();
  await store.append(
    's',
    Array.from({ length: 40 }, (_, i) => (i % 2 ? assistantEntry('答'.repeat(50)) : userEntry('问'.repeat(50)))),
  );
  await store.append('s', last);
  return store;
}

/** 每次都报 `inputTokens` 个输入 token 的模型。 */
function countingModel(inputTokens: number) {
  return new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ type: 'text', text: '好' }],
      finishReason: { unified: 'stop', raw: 'stop' },
      usage: {
        inputTokens: { total: inputTokens, noCache: inputTokens, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 1, text: 1, reasoning: 0 },
      },
      warnings: [],
    }),
  });
}

describe('按上一轮的实际用量校准估算', () => {
  test('第一步的 meta.step 记下这次请求的估算，之后几步不记；没有样本时不校准', async () => {
    const store = createMemoryStore();
    const harness = createHarness({ store, context: createContextBuilder({ store }) });
    await harness.run({
      session: 's',
      agent: { model: createScriptedModel([{ type: 'text', text: '好' }]) },
      input: '在吗',
    });
    const [first] = (await store.list('s')).flatMap((entry) => stepMetaOf(entry) ?? []);
    assert.equal(first?.step, 0);
    assert.ok(first.estimatedInputTokens !== undefined && first.estimatedInputTokens > 0);
    assert.equal(first.calibration, undefined);
  });

  test('实际是估算的两倍：maxTokens 收紧一半，PreparedCall 带 calibration，tokens 乘上它', async () => {
    const store = await history(sample(1_000, 2_000));
    const window = { maxTokens: 800 };
    const plain = await createContextBuilder({ store, calibrate: false }).build({ session: 's', window });
    const calibrated = await createContextBuilder({ store }).build({ session: 's', window });
    assert.equal(plain.calibration, undefined);
    assert.equal(calibrated.calibration, 2);
    assert.ok(calibrated.messages.length < plain.messages.length, '留下的历史更少');
    assert.ok(calibrated.tokens! <= 800 && calibrated.tokens! > plain.tokens! / 2, `tokens ${calibrated.tokens}`);
    const view = await createContextBuilder({ store }).view('s', { window });
    assert.equal(view.messages.length, calibrated.messages.length, 'view 也校准');
  });

  test('样本里记着当时乘上的倍数：换算回去再比，校准不会来回摆', async () => {
    // 上一轮已经乘了 2，估算 2000、实际 2000：没校准的估算是 1000，倍数还是 2。
    const store = await history(sample(2_000, 2_000, 2));
    assert.equal((await createContextBuilder({ store }).build({ session: 's' })).calibration, 2);
  });

  test('只往小里收，最多 MAX_CALIBRATION 倍；坏样本不算', async () => {
    const cases: [NewEntry, number | undefined][] = [
      [sample(1_000, 10_000), MAX_CALIBRATION],
      [sample(1_000, 500), undefined],
      [sample(0, 500), undefined],
      [sample(1_000, Number.NaN), undefined],
    ];
    for (const [entry, expected] of cases) {
      const store = await history(entry);
      assert.equal((await createContextBuilder({ store }).build({ session: 's' })).calibration, expected);
    }
  });

  test('calibrate: false、投影接了自己的 estimate、窗口没有 maxTokens 的 view：都不校准', async () => {
    const store = await history(sample(1_000, 3_000));
    const window = { maxTokens: 800 };
    assert.equal(
      (await createContextBuilder({ store, calibrate: false }).build({ session: 's', window })).calibration,
      undefined,
    );
    const custom = createContextBuilder({ store, projection: { window: { estimate: () => 10 } } });
    assert.equal((await custom.build({ session: 's', window })).calibration, undefined);
    const plain = await createContextBuilder({ store, calibrate: false }).view('s', { window: { maxMessages: 6 } });
    const view = await createContextBuilder({ store }).view('s', { window: { maxMessages: 6 } });
    assert.deepEqual(view.messages, plain.messages);
  });

  test('harness 的下一轮带上校准：第一步记下倍数，超窗检查用校准过的估算', async () => {
    const store = createMemoryStore();
    const harness = createHarness({ store, context: createContextBuilder({ store }) });
    // 服务商每次都说输入有 10 万 token，远多于估算。
    const model = countingModel(100_000);
    await harness.run({ session: 's', agent: { model }, input: '第一轮' });
    await harness.run({ session: 's', agent: { model }, input: '第二轮' });
    const steps = (await store.list('s')).flatMap((entry) => stepMetaOf(entry) ?? []);
    assert.equal(steps.length, 2);
    assert.equal(steps[0]?.calibration, undefined);
    assert.equal(steps[1]?.calibration, MAX_CALIBRATION);
    // 校准后估算还是放不下：超窗兜底照校准过的数字拦住，不调模型。
    const calls = model.doGenerateCalls.length;
    const estimated = steps[1]?.estimatedInputTokens;
    assert.ok(estimated !== undefined);
    const result = await harness.run({
      session: 's',
      agent: { model, context: { overflow: { maxTokens: estimated - 1, strategy: 'error' } } },
      input: '第三轮',
    });
    assert.equal(result.error?.type, 'context_overflow');
    assert.equal(model.doGenerateCalls.length, calls);
  });
});
