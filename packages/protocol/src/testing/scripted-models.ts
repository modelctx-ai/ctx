import {
  MAX_DECISION_QUESTIONS,
  type DecisionAnswer,
  type DecisionModel,
  type DecisionQuestion,
  type DecisionRequest,
  type ExtractionAnswer,
  type ExtractionField,
  type ExtractionModel,
  type ExtractionRequest,
} from '../memory.ts';
import { CtxError, type JsonValue } from '../types.ts';

/**
 * 剧本式决策模型的回答规则。按问题名给了答案就原样返回；其余按题型：`noul` 回 `noul`，`score` 落在离 `score` 最近的档，
 * `choice` 按 `prefer` 的顺序选第一个在 `criteria` 里的选项，都不在就选第一个选项。
 */
export interface DecisionScript {
  readonly answers?: Readonly<Record<string, DecisionAnswer>>;
  /** `noul` 题的 P(是)，缺省 0.5。 */
  readonly noul?: number;
  /** `score` 题的分数（0..1），落到最近的档，缺省 0.5。 */
  readonly score?: number;
  readonly prefer?: readonly string[];
}

export interface ScriptedDecisionModel extends DecisionModel {
  /** 收到过的请求（不含 `signal`），按先后。 */
  readonly requests: readonly DecisionRequest[];
}

function scriptedDecision(question: DecisionQuestion, script: DecisionScript): DecisionAnswer {
  switch (question.type) {
    case 'noul':
      return { type: 'noul', noul: script.noul ?? 0.5 };
    case 'choice': {
      const keys = Object.keys(question.criteria);
      if (keys.length === 0) throw new CtxError('invalid_request', 'A choice question needs at least one option.');
      const choice = script.prefer?.find((key) => keys.includes(key)) ?? keys[0]!;
      const top = keys.length === 1 ? 1 : 0.9;
      const rest = keys.length === 1 ? 0 : 0.1 / (keys.length - 1);
      return {
        type: 'choice',
        choice,
        probabilities: Object.fromEntries(keys.map((key) => [key, key === choice ? top : rest])),
        confidence: top,
      };
    }
    default: {
      const n = question.criteria.length;
      if (n < 2) throw new CtxError('invalid_request', 'A score question needs at least two levels.');
      const level = Math.round(Math.min(1, Math.max(0, script.score ?? 0.5)) * (n - 1));
      return {
        type: 'score',
        score: level / (n - 1),
        probabilities: question.criteria.map((_, i) => (i === level ? 1 : 0)),
      };
    }
  }
}

/**
 * 按剧本回答的决策模型，给契约测试和 `Memory` 的测试用：不联网、确定。`signal` 已中止时 reject，
 * 问题超过 `MAX_DECISION_QUESTIONS` 个、`choice` 没有选项、`score` 少于两档时抛 `invalid_request`。
 */
export function createScriptedDecisionModel(
  script: DecisionScript = {},
  options: { readonly name?: string } = {},
): ScriptedDecisionModel {
  const requests: DecisionRequest[] = [];
  return {
    name: options.name ?? 'scripted-decision',
    requests,
    async decide(request) {
      request.signal?.throwIfAborted();
      requests.push({ state: request.state, questions: request.questions });
      const entries = Object.entries(request.questions);
      if (entries.length > MAX_DECISION_QUESTIONS)
        throw new CtxError('invalid_request', `At most ${MAX_DECISION_QUESTIONS} questions per call.`);
      return Object.fromEntries(
        entries.map(([key, question]) => [key, script.answers?.[key] ?? scriptedDecision(question, script)]),
      );
    },
  };
}

/**
 * 剧本式提取模型的回答规则。按字段名给了值就用它；其余按字段类型取 `byType`，再取缺省
 * （`text` 是 `scripted`，`number` 是 1，`date` 是 `2026-01-01`，`datetime` 是 `2026-01-01T00:00:00Z`，`duration` 是 60，
 * `list` 按 `items` 是 `['scripted']` 或 `[1]`）。输入是空的（null 或空白文字）时全部没找到。值是 null 表示没找到。
 */
export interface ExtractionScript {
  readonly values?: Readonly<Record<string, JsonValue>>;
  readonly byType?: Readonly<Partial<Record<ExtractionField['type'], JsonValue>>>;
}

export interface ScriptedExtractionModel extends ExtractionModel {
  /** 收到过的请求（不含 `signal`），按先后。 */
  readonly requests: readonly ExtractionRequest[];
}

function scriptedValue(field: ExtractionField): JsonValue {
  switch (field.type) {
    case 'text':
      return 'scripted';
    case 'number':
      return 1;
    case 'date':
      return '2026-01-01';
    case 'datetime':
      return '2026-01-01T00:00:00Z';
    case 'duration':
      return 60;
    default:
      return field.items === 'text' ? ['scripted'] : [1];
  }
}

function isEmptyState(state: JsonValue): boolean {
  return state === null || (typeof state === 'string' && state.trim() === '');
}

/** 按剧本回答的提取模型，给契约测试和 `Memory` 的测试用：不联网、确定。`signal` 已中止时 reject。 */
export function createScriptedExtractionModel(
  script: ExtractionScript = {},
  options: { readonly name?: string } = {},
): ScriptedExtractionModel {
  const requests: ExtractionRequest[] = [];
  return {
    name: options.name ?? 'scripted-extraction',
    requests,
    async extract(request) {
      request.signal?.throwIfAborted();
      requests.push({ state: request.state, fields: request.fields });
      const empty = isEmptyState(request.state);
      return Object.fromEntries(
        Object.entries(request.fields).map(([key, field]): [string, ExtractionAnswer] => {
          let value: JsonValue = null;
          if (!empty) {
            if (script.values && key in script.values) value = script.values[key]!;
            else if (script.byType && field.type in script.byType) value = script.byType[field.type]!;
            else value = scriptedValue(field);
          }
          return [key, { value, pNull: value === null ? 0.95 : 0.05, confidence: 0.9 }];
        }),
      );
    },
  };
}
