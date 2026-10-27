import {
  CtxError,
  MAX_DECISION_QUESTIONS,
  type Awaitable,
  type DecisionAnswer,
  type DecisionModel,
  type DecisionQuestion,
  type JsonValue,
} from '@modelctx-ai/ctx-protocol';

import { clamp01, textSimilarity, tokens } from './text.ts';

/** 四项信号的权重，和为 1 时 `keep` 落在 0..1；不是 1 也行，结果会截到 0..1。 */
export interface HeuristicWeights {
  /** 惊讶：1 − 与已有事实的最大相似度，再乘这段的信息量。 */
  readonly surprise: number;
  /** 强调：「记住」「以后」「别再」、改变（「换成」）、偏好（「喜欢」）。 */
  readonly emphasis: number;
  /** 重复：这段里用户反复说的、最近几段里说过的。 */
  readonly repetition: number;
  /** 情绪：报错、失败、纠正。 */
  readonly emotion: number;
}

export const HEURISTIC_WEIGHTS: HeuristicWeights = { surprise: 0.3, emphasis: 0.4, repetition: 0.1, emotion: 0.2 };

export interface HeuristicDecisionOptions {
  /** 缺省 `heuristic`。 */
  readonly name?: string;
  /** 两段文字的相似度，0..1；缺省是 `textSimilarity`（子串或词重叠）。 */
  readonly similarity?: (a: string, b: string) => number;
  /** 和这段相关的已有事实的文字，算惊讶用；不给就当没有已有事实。`createMemory` 用存储的 `search` 接上。 */
  readonly known?: (text: string) => Awaitable<readonly string[]>;
  /** 最近（例如 7 天内）门控过的段落的文字，算重复用；不给就只看这段内部。 */
  readonly recent?: (text: string) => Awaitable<readonly string[]>;
  readonly weights?: Partial<HeuristicWeights>;
}

/** 中文按子串，英文按整词。 */
function cues(chinese: string, english: string): RegExp {
  return new RegExp(`${chinese}|\\b(?:${english})\\b`, 'giu');
}

const STRONG = cues(
  '记住|记得|以后|往后|今后|别再|不要再|下次|永远|总是|一定要|务必',
  "remember|always|never|from now on|don't forget|do not forget",
);
const CHANGE = cues('换成|换到|改成|改用|改为|搬到|搬去|现在用|不再', 'switched|moved to|changed|now use|no longer');
const PREFERENCE = cues('喜欢|讨厌|偏好|偏爱|习惯|受不了', 'prefer|prefers|like|likes|hate|hates|dislike');
const EMOTION = cues(
  '错误|报错|出错|失败|崩溃|不对|错了|搞错|不是这样|纠正|应该是|别这样|太慢',
  'error|errors|failed|failure|wrong|exception|crash|crashed|broken|bug',
);
const SUCCESS = cues('成功|搞定|解决了|修好|好了|通过', 'works|worked|fixed|solved|passed');

function count(pattern: RegExp, text: string): number {
  return [...text.matchAll(pattern)].length;
}

/** 出现一次就够强，再多一点点加分。 */
function cue(n: number, first: number): number {
  return n === 0 ? 0 : Math.min(1, first + 0.1 * (n - 1));
}

function stateText(state: JsonValue): string {
  return typeof state === 'string' ? state : JSON.stringify(state);
}

/** 用户说的那几行：`user：…` 开头的；没有这样的行就是整段。 */
function userLines(text: string): string[] {
  const lines = text.split('\n').filter((line) => /^user[:：]/u.test(line));
  return lines.length > 0 ? lines.map((line) => line.replace(/^user[:：]\s*/u, '')) : [text];
}

interface Signals {
  readonly surprise: number;
  readonly emphasis: number;
  readonly repetition: number;
  readonly emotion: number;
  readonly preference: number;
  readonly success: number;
}

/** 选项按分数分配概率：每项先加一点底数，归一；`choice` 是概率最大的第一个。 */
function choiceFrom(scores: Readonly<Record<string, number>>): DecisionAnswer {
  const keys = Object.keys(scores);
  if (keys.length === 0) throw new CtxError('invalid_request', 'A choice question needs at least one option.');
  const raw = keys.map((key) => 0.05 + Math.max(0, scores[key] ?? 0));
  const total = raw.reduce((sum, value) => sum + value, 0);
  const probabilities = Object.fromEntries(keys.map((key, i) => [key, raw[i]! / total]));
  let choice = keys[0]!;
  for (const key of keys) if (probabilities[key]! > probabilities[choice]!) choice = key;
  return { type: 'choice', choice, probabilities, confidence: probabilities[choice]! };
}

/** 期望档位正好是 `target`：概率放在相邻的两档上。 */
export function scoreAnswer(target: number, levels: number): DecisionAnswer {
  if (levels < 2) throw new CtxError('invalid_request', 'A score question needs at least two levels.');
  const x = clamp01(target) * (levels - 1);
  const lo = Math.floor(x);
  const hi = Math.min(levels - 1, lo + 1);
  const probabilities = Array.from({ length: levels }, () => 0);
  probabilities[lo] = hi === lo ? 1 : 1 - (x - lo);
  if (hi !== lo) probabilities[hi] = x - lo;
  return { type: 'score', score: x / (levels - 1), probabilities };
}

/** 不认识的问题：均匀分布。 */
export function uniformAnswer(question: DecisionQuestion): DecisionAnswer {
  switch (question.type) {
    case 'noul':
      return { type: 'noul', noul: 0.5 };
    case 'choice': {
      const keys = Object.keys(question.criteria);
      if (keys.length === 0) throw new CtxError('invalid_request', 'A choice question needs at least one option.');
      return {
        type: 'choice',
        choice: keys[0]!,
        probabilities: Object.fromEntries(keys.map((key) => [key, 1 / keys.length])),
        confidence: 1 / keys.length,
      };
    }
    default: {
      const n = question.criteria.length;
      if (n < 2) throw new CtxError('invalid_request', 'A score question needs at least two levels.');
      return { type: 'score', score: 0.5, probabilities: question.criteria.map(() => 1 / n) };
    }
  }
}

/**
 * 不联网的决策模型：只认门控的四个问题（`keep` 是 `noul`、`kind` 和 `topic` 是 `choice`、`salience` 是 `score`），
 * 按惊讶、强调、重复、情绪四项加权打分；别的问题返回均匀分布（`choice` 的 `confidence` 因此很低，调用方会升级）。
 * 确定、快，够用就不上模型。
 */
export function createHeuristicDecisionModel(options: HeuristicDecisionOptions = {}): DecisionModel {
  const similarity = options.similarity ?? textSimilarity;
  const weights = { ...HEURISTIC_WEIGHTS, ...options.weights };

  async function signals(text: string, signal: AbortSignal | undefined): Promise<Signals> {
    const known = options.known ? await options.known(text) : [];
    signal?.throwIfAborted();
    const recent = options.recent ? await options.recent(text) : [];
    signal?.throwIfAborted();
    const information = Math.min(1, tokens(text).size / 12);
    const closest = Math.max(0, ...known.map((fact) => clamp01(similarity(text, fact))));
    const lines = userLines(text);
    let repeats = 0;
    for (const [i, line] of lines.entries()) {
      if (lines.slice(0, i).some((earlier) => similarity(line, earlier) >= 0.5)) repeats += 1;
    }
    repeats += recent.filter((before) => similarity(text, before) >= 0.3).length;
    return {
      surprise: (1 - closest) * information,
      emphasis: Math.max(
        cue(count(STRONG, text), 0.8),
        cue(count(CHANGE, text), 0.6),
        cue(count(PREFERENCE, text), 0.5),
      ),
      repetition: Math.min(1, repeats / 3),
      emotion: cue(count(EMOTION, text), 0.7),
      preference: cue(count(PREFERENCE, text) + count(STRONG, text), 0.6),
      success: cue(count(SUCCESS, text), 0.6),
    };
  }

  function weighted(s: Signals): number {
    return clamp01(
      weights.surprise * s.surprise +
        weights.emphasis * s.emphasis +
        weights.repetition * s.repetition +
        weights.emotion * s.emotion,
    );
  }

  function kindScores(text: string, criteria: Readonly<Record<string, string>>, s: Signals): Record<string, number> {
    const known: Record<string, number> = { pref: s.preference, fail: s.emotion, ok: s.success, obs: 0.3 };
    return Object.fromEntries(
      Object.entries(criteria).map(([key, description]) => [
        key,
        known[key] ?? similarity(text, `${key} ${description}`),
      ]),
    );
  }

  function topicScores(text: string, criteria: Readonly<Record<string, string>>): Record<string, number> {
    return Object.fromEntries(
      Object.entries(criteria).map(([key, description]) => [
        key,
        key === 'other' ? 0.15 : similarity(text, `${key} ${description}`),
      ]),
    );
  }

  return {
    name: options.name ?? 'heuristic',
    async decide(request) {
      request.signal?.throwIfAborted();
      const entries = Object.entries(request.questions);
      if (entries.length > MAX_DECISION_QUESTIONS)
        throw new CtxError('invalid_request', `At most ${MAX_DECISION_QUESTIONS} questions per call.`);
      const text = stateText(request.state);
      const known = entries.some(([key, question]) => recognized(key, question));
      const s = known ? await signals(text, request.signal) : undefined;
      return Object.fromEntries(
        entries.map(([key, question]): [string, DecisionAnswer] => {
          if (!s || !recognized(key, question)) return [key, uniformAnswer(question)];
          if (question.type === 'noul') return [key, { type: 'noul', noul: weighted(s) }];
          if (question.type === 'score') return [key, scoreAnswer(weighted(s), question.criteria.length)];
          const scores = key === 'kind' ? kindScores(text, question.criteria, s) : topicScores(text, question.criteria);
          return [key, choiceFrom(scores)];
        }),
      );
    },
  };
}

function recognized(key: string, question: DecisionQuestion): boolean {
  return (
    (key === 'keep' && question.type === 'noul') ||
    (key === 'kind' && question.type === 'choice') ||
    (key === 'topic' && question.type === 'choice') ||
    (key === 'salience' && question.type === 'score')
  );
}
