import assert from 'node:assert/strict';

import { MAX_DECISION_QUESTIONS, type DecisionAnswer, type DecisionModel, type DecisionQuestion } from '../memory.ts';

import type { ContractTestApi } from './api.ts';
import { inUnit, roundTrips } from './shared.ts';

/** 每个用例调一次。 */
export type DecisionModelFactory = () => DecisionModel | Promise<DecisionModel>;

/** 概率的和、期望档位允许的误差：服务商的概率可能四舍五入过。 */
const PROBABILITY_TOLERANCE = 0.01;

function sumsToOne(values: readonly number[]): boolean {
  return Math.abs(values.reduce((sum, value) => sum + value, 0) - 1) <= PROBABILITY_TOLERANCE;
}

function checkDecisionAnswer(question: DecisionQuestion, answer: DecisionAnswer | undefined, label: string): void {
  assert.ok(answer, `${label}：没有回答`);
  assert.equal(answer.type, question.type, `${label}：回答的 type 和问题一样`);
  if (question.type === 'noul' && answer.type === 'noul') {
    assert.ok(inUnit(answer.noul), `${label}：noul ${answer.noul} 在 0..1`);
  } else if (question.type === 'choice' && answer.type === 'choice') {
    const keys = Object.keys(question.criteria).toSorted();
    assert.deepEqual(Object.keys(answer.probabilities).toSorted(), keys, `${label}：概率覆盖所有选项`);
    const values = Object.values(answer.probabilities);
    assert.ok(values.every(inUnit) && sumsToOne(values), `${label}：概率在 0..1、和为 1`);
    assert.ok(keys.includes(answer.choice), `${label}：choice 是选项之一`);
    assert.ok(answer.probabilities[answer.choice]! >= Math.max(...values), `${label}：choice 是概率最大的`);
    assert.ok(inUnit(answer.confidence), `${label}：confidence 在 0..1`);
  } else if (question.type === 'score' && answer.type === 'score') {
    const n = question.criteria.length;
    assert.equal(answer.probabilities.length, n, `${label}：概率逐档`);
    assert.ok(answer.probabilities.every(inUnit) && sumsToOne(answer.probabilities), `${label}：概率在 0..1、和为 1`);
    assert.ok(inUnit(answer.score), `${label}：score 在 0..1`);
    const expected = answer.probabilities.reduce((sum, p, i) => sum + (p * i) / (n - 1), 0);
    assert.ok(Math.abs(answer.score - expected) <= PROBABILITY_TOLERANCE, `${label}：score 是期望档位 ${expected}`);
  }
}

const DECISION_STATE = '用户：以后回答都用中文，记住了吗？\n助手：记住了，以后都用中文回答。';

const DECISION_QUESTIONS: Readonly<Record<string, DecisionQuestion>> = {
  keep: { type: 'noul', instructions: '这段里有没有值得长期记住的信息：偏好、事实变化、决定、教训？' },
  kind: {
    type: 'choice',
    instructions: '主要属于哪一类？',
    criteria: { pref: '主人的偏好', obs: '观察到的事实', fail: '失败的经验', ok: '成功的经验' },
  },
  salience: {
    type: 'score',
    instructions: '对未来的任务有多重要？',
    criteria: ['无关', '顺带提到', '有用', '必须记住'],
  },
};

export function describeDecisionModelContract(
  name: string,
  factory: DecisionModelFactory,
  { describe, test }: ContractTestApi,
): void {
  describe(`DecisionModel contract: ${name}`, () => {
    test('有名字', async () => {
      const model = await factory();
      assert.equal(typeof model.name, 'string');
      assert.ok(model.name.length > 0);
    });

    for (const [key, question] of Object.entries(DECISION_QUESTIONS)) {
      test(`${question.type}：回答的形状、概率`, async () => {
        const model = await factory();
        const replies = await model.decide({ state: DECISION_STATE, questions: { [key]: question } });
        assert.deepEqual(Object.keys(replies), [key], '键和问题一样');
        checkDecisionAnswer(question, replies[key], key);
      });
    }

    test('三种问题一次问，state 是 JSON 也行；结果能序列化', async () => {
      const model = await factory();
      for (const state of [DECISION_STATE, { messages: [{ role: 'user', text: '以后回答都用中文' }] }]) {
        const replies = await model.decide({ state, questions: DECISION_QUESTIONS });
        assert.deepEqual(Object.keys(replies).toSorted(), Object.keys(DECISION_QUESTIONS).toSorted());
        for (const [key, question] of Object.entries(DECISION_QUESTIONS))
          checkDecisionAnswer(question, replies[key], key);
        assert.ok(roundTrips(replies), '回答能 JSON 往返');
      }
    });

    test(`一次 ${MAX_DECISION_QUESTIONS} 个问题都答`, async () => {
      const model = await factory();
      const questions: Record<string, DecisionQuestion> = Object.fromEntries(
        Array.from({ length: MAX_DECISION_QUESTIONS }, (_, i) => [
          `q${i}`,
          { type: 'noul', instructions: `这段里提到数字 ${i} 了吗？` },
        ]),
      );
      const replies = await model.decide({ state: DECISION_STATE, questions });
      assert.equal(Object.keys(replies).length, MAX_DECISION_QUESTIONS);
      for (const [key, question] of Object.entries(questions)) checkDecisionAnswer(question, replies[key], key);
    });

    test('signal 已中止时 reject', async () => {
      const model = await factory();
      await assert.rejects(
        model.decide({ state: DECISION_STATE, questions: DECISION_QUESTIONS, signal: AbortSignal.abort() }),
      );
    });
  });
}
