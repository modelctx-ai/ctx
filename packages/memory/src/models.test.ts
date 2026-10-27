import assert from 'node:assert/strict';

import type { DecisionQuestion } from '@modelctx-ai/ctx-protocol';
import { describeDecisionModelContract, describeExtractionModelContract } from '@modelctx-ai/ctx-protocol/testing';
import { describe, test } from 'vite-plus/test';

import { createHeuristicDecisionModel } from './heuristic.ts';
import { decisionFromLanguageModel, extractionFromLanguageModel } from './language.ts';
import { textModel } from './test-model.ts';

const api = { describe, test };

const GATE: Record<string, DecisionQuestion> = {
  keep: { type: 'noul', instructions: '值得长期记住吗？' },
  kind: { type: 'choice', instructions: '哪一类？', criteria: { pref: '偏好', obs: '观察', fail: '失败', ok: '成功' } },
  topic: {
    type: 'choice',
    instructions: '哪个主题？',
    criteria: { work: '项目、数据库和工具链', user: '主人的饮食和作息', other: '以上都不是' },
  },
  salience: { type: 'score', instructions: '多重要？', criteria: ['无关', '顺带提到', '有用', '必须记住'] },
};

describeDecisionModelContract('heuristic', () => createHeuristicDecisionModel(), api);

describe('createHeuristicDecisionModel', () => {
  test('强调、改变、报错抬高 keep；寒暄打低分', async () => {
    const model = createHeuristicDecisionModel();
    const keep = async (state: string): Promise<number> => {
      const answer = (await model.decide({ state, questions: { keep: GATE['keep']! } }))['keep'];
      assert.equal(answer?.type, 'noul');
      return answer.type === 'noul' ? answer.noul : 0;
    };
    const chat = await keep('user：嗯\nassistant：嗯嗯');
    assert.ok(chat < 0.2, `寒暄 ${chat}`);
    assert.ok((await keep('user：以后回答都用中文，记住')) > 0.5);
    assert.ok((await keep('user：项目的数据库换成 PostgreSQL 了')) > chat);
    assert.ok((await keep('user：又报错了，构建失败')) > chat);
    assert.ok((await keep('user：Remember: always answer in English')) > 0.5, '英文的强调');
  });

  test('惊讶：和已有事实越像分越低；known 收到这段文字', async () => {
    const seen: string[] = [];
    const state = 'user：我每天下午都喝乌龙茶，配一点坚果';
    const fresh = createHeuristicDecisionModel();
    const knowing = createHeuristicDecisionModel({
      known: (text) => {
        seen.push(text);
        return ['我每天下午都喝乌龙茶'];
      },
    });
    const keepOf = async (model: ReturnType<typeof createHeuristicDecisionModel>): Promise<number> => {
      const answer = (await model.decide({ state, questions: { keep: GATE['keep']! } }))['keep'];
      return answer?.type === 'noul' ? answer.noul : -1;
    };
    assert.ok((await keepOf(knowing)) < (await keepOf(fresh)));
    assert.deepEqual(seen, [state]);
  });

  test('重复：recent 里说过的抬高 keep', async () => {
    const state = 'user：周报放在共享盘的 reports 目录';
    const once = createHeuristicDecisionModel();
    const again = createHeuristicDecisionModel({ recent: () => [state, state, state] });
    const keepOf = async (model: ReturnType<typeof createHeuristicDecisionModel>): Promise<number> => {
      const answer = (await model.decide({ state, questions: { keep: GATE['keep']! } }))['keep'];
      return answer?.type === 'noul' ? answer.noul : -1;
    };
    assert.ok((await keepOf(again)) > (await keepOf(once)));
  });

  test('kind 按信号选，topic 按说明的相似度选，都不像时选 other；salience 的期望档位就是 keep', async () => {
    const model = createHeuristicDecisionModel();
    const answers = await model.decide({ state: 'user：项目的数据库又报错了，连接失败', questions: GATE });
    assert.equal(answers['kind']?.type === 'choice' && answers['kind'].choice, 'fail');
    assert.equal(answers['topic']?.type === 'choice' && answers['topic'].choice, 'work');
    const keep = answers['keep']?.type === 'noul' ? answers['keep'].noul : -1;
    const score = answers['salience']?.type === 'score' ? answers['salience'].score : -2;
    assert.ok(Math.abs(keep - score) < 1e-9);
    const vague = await model.decide({ state: 'user：今天天气不错', questions: { topic: GATE['topic']! } });
    assert.equal(vague['topic']?.type === 'choice' && vague['topic'].choice, 'other');
    const pref = await model.decide({ state: 'user：我喜欢简短的回答，以后别写长段落', questions: GATE });
    assert.equal(pref['kind']?.type === 'choice' && pref['kind'].choice, 'pref');
  });

  test('不认识的问题返回均匀分布；similarity 可以注入', async () => {
    let calls = 0;
    const model = createHeuristicDecisionModel({
      similarity: () => {
        calls += 1;
        return 0;
      },
    });
    const answers = await model.decide({
      state: '随便',
      questions: {
        relation: { type: 'choice', instructions: '关系？', criteria: { new: '新', merge: '同', supersede: '取代' } },
        other: { type: 'noul', instructions: '？' },
        level: { type: 'score', instructions: '？', criteria: ['低', '中', '高'] },
      },
    });
    assert.deepEqual(answers, {
      relation: {
        type: 'choice',
        choice: 'new',
        probabilities: { new: 1 / 3, merge: 1 / 3, supersede: 1 / 3 },
        confidence: 1 / 3,
      },
      other: { type: 'noul', noul: 0.5 },
      level: { type: 'score', score: 0.5, probabilities: [1 / 3, 1 / 3, 1 / 3] },
    });
    assert.equal(calls, 0, '没有认识的问题就不算信号');
    await model.decide({ state: '随便', questions: { topic: GATE['topic']! } });
    assert.ok(calls > 0);
  });
});

// ---- LanguageModel 装成的 ----

/** 契约用到的全部问题都有答案：keep、kind、salience 和 q0..q63。 */
const DECISION_JSON = JSON.stringify({
  keep: 0.9,
  kind: { pref: 0.8, obs: 0.1, fail: 0.05, ok: 0.05 },
  salience: [0, 0.1, 0.3, 0.6],
  ...Object.fromEntries(Array.from({ length: 64 }, (_, i) => [`q${i}`, i % 2 === 0])),
});

describeDecisionModelContract('language model', () => decisionFromLanguageModel(textModel(() => DECISION_JSON)), api);
describeDecisionModelContract(
  'language model（回答不是 JSON）',
  () => decisionFromLanguageModel(textModel(() => '抱歉，我不能回答。')),
  api,
);

const EXTRACTION_JSON = JSON.stringify({
  place: { value: '台北', pNull: 0.01, confidence: 0.95 },
  budget: { value: '1200.54', pNull: 0.05, confidence: 0.8 },
  people: { value: 2.2, pNull: 0.05, confidence: 0.8 },
  day: { value: '2026-11-04', pNull: 0.05, confidence: 0.9 },
  start: { value: '2026-11-04T14:00', pNull: 0.1, confidence: 0.7 },
  length: { value: 5400, pNull: 0.05, confidence: 0.9 },
  names: { value: ['小明', '小红'], pNull: 0.05, confidence: 0.9 },
  amounts: { value: [1200.5, 'x'], pNull: 0.05, confidence: 0.6 },
});

describeExtractionModelContract(
  'language model',
  () => extractionFromLanguageModel(textModel(() => `\`\`\`json\n${EXTRACTION_JSON}\n\`\`\``)),
  api,
);
describeExtractionModelContract(
  'language model（回答不是 JSON）',
  () => extractionFromLanguageModel(textModel(() => '{ 坏的')),
  api,
);

describe('decisionFromLanguageModel', () => {
  test('提示词里有 state 和每个问题的选项、档位；名字来自模型', async () => {
    const model = textModel(
      () => '好的：{"keep": "0.7", "kind": "obs", "topic": {"work": 3, "user": 1}, "salience": 2}',
    );
    const decision = decisionFromLanguageModel(model);
    assert.equal(decision.name, 'lm:mock/json');
    const answers = await decision.decide({ state: { text: '项目换成 PostgreSQL' }, questions: GATE });
    const call = model.calls[0]!;
    assert.ok(call.user.includes('PostgreSQL') && !call.user.includes('supersede'));
    assert.ok(call.user.includes('- work：项目、数据库和工具链') && call.user.includes('3. 必须记住'));
    assert.ok(call.system.includes('JSON'));
    assert.deepEqual(answers['keep'], { type: 'noul', noul: 0.7 }, '数字字符串也认');
    assert.equal(answers['kind']?.type === 'choice' && answers['kind'].choice, 'obs', '只给选项名时认它');
    assert.deepEqual(answers['topic'], {
      type: 'choice',
      choice: 'work',
      probabilities: { work: 0.75, user: 0.25, other: 0 },
      confidence: 0.75,
    });
    assert.deepEqual(answers['salience'], { type: 'score', score: 2 / 3, probabilities: [0, 0, 1, 0] }, '整数当档位');
  });

  test('缺的、形状不对的问题给低置信度答案；signal 交给模型', async () => {
    const decision = decisionFromLanguageModel(textModel(() => '{"kind": "nope", "keep": [1]}'));
    const answers = await decision.decide({ state: 'x', questions: GATE });
    assert.deepEqual(answers['kind'], {
      type: 'choice',
      choice: 'pref',
      probabilities: { pref: 0.25, obs: 0.25, fail: 0.25, ok: 0.25 },
      confidence: 0,
    });
    assert.deepEqual(answers['keep'], { type: 'noul', noul: 1 }, '数组的第一个数');
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(decision.decide({ state: 'x', questions: GATE, signal: controller.signal }));
  });
});

describe('extractionFromLanguageModel', () => {
  test('按字段类型规整：数字字符串、取整、小数位、日期补全；空输入不调模型', async () => {
    const model = textModel(() => EXTRACTION_JSON);
    const extraction = extractionFromLanguageModel(model, { name: 'x' });
    const answers = await extraction.extract({
      state: '会议纪要',
      fields: {
        budget: { type: 'number', decimals: 1 },
        people: { type: 'number', integer: true },
        start: { type: 'datetime' },
        amounts: { type: 'list', items: 'number' },
        missing: { type: 'text' },
      },
    });
    assert.equal(answers['budget']?.value, 1200.5);
    assert.equal(answers['people']?.value, 2);
    assert.equal(answers['start']?.value, '2026-11-04T14:00');
    assert.deepEqual(answers['amounts']?.value, [1200.5]);
    assert.deepEqual(answers['missing'], { value: null, pNull: 0.9, confidence: 0.5 });
    assert.equal(model.calls.length, 1);
    await extraction.extract({ state: '  ', fields: { a: { type: 'text' } } });
    assert.equal(model.calls.length, 1, '空输入不调模型');
  });
});
