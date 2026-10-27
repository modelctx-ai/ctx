import {
  CtxError,
  MAX_DECISION_QUESTIONS,
  type DecisionAnswer,
  type DecisionModel,
  type DecisionQuestion,
  type ExtractionAnswer,
  type ExtractionField,
  type ExtractionModel,
  type JsonValue,
} from '@modelctx-ai/ctx-protocol';

import type { ModelSpec } from './index.ts';

// System One 模型（决策 Clef、Jev，提取 Clairic）的适配器。请求、响应的形状依据：
// - Cloudflare Workers AI：developers.cloudflare.com/workers-ai/models/{clef,clairic}/ 和同目录的 schema-input.json、
//   schema-output.json（2026-10）；REST 的 `{ result, success, errors }` 外壳见 workers-ai/get-started/rest-api/。
// - TypeSafe：docs.typesafe.ai/api/system-one 的 OpenAPI（`POST /v1/systemone`，版本 0.2.0）和 docs.typesafe.ai/api/errors。
// 都只对照文档写成，没有打过真实服务。

/** 一份可以写进配置文件的 System One 模型描述，字段和 `ModelSpec` 一样，`provider` 必填。 */
export interface SystemOneSpec extends Omit<ModelSpec, 'provider'> {
  /** 决策：`cloudflare`、`typesafe`；提取：`cloudflare`；或者注册过的别的服务商。没有缺省。 */
  readonly provider: string;
  /** Cloudflare 的账号 ID，`cloudflare` 必填。 */
  readonly accountId?: string;
}

/** 不进配置文件的选项。 */
export interface SystemOneOptions {
  /** 缺省是全局 `fetch`。测试里注入假的。 */
  readonly fetch?: typeof fetch;
}

export type DecisionFactory = (spec: SystemOneSpec, options: SystemOneOptions) => DecisionModel;
export type ExtractionFactory = (spec: SystemOneSpec, options: SystemOneOptions) => ExtractionModel;

export interface DecisionModelRegistry {
  register(provider: string, factory: DecisionFactory): DecisionModelRegistry;
  create(spec: SystemOneSpec, options?: SystemOneOptions): DecisionModel;
  providers(): string[];
}

export interface ExtractionModelRegistry {
  register(provider: string, factory: ExtractionFactory): ExtractionModelRegistry;
  create(spec: SystemOneSpec, options?: SystemOneOptions): ExtractionModel;
  providers(): string[];
}

/**
 * System One 服务返回非 2xx（或 Cloudflare 外壳里 `success: false`）。`type` 是 `api_call`，和 harness 对上游接口错误的
 * `ErrorInfo.type` 一样；`statusCode`、`responseBody` 对应 `ErrorInfo` 的同名字段。429、5xx（含 TypeSafe 的 529）可以重试。
 */
export class SystemOneError extends CtxError {
  readonly statusCode: number;
  readonly responseBody: string;

  constructor(message: string, statusCode: number, responseBody: string) {
    super('api_call', message, { retryable: statusCode === 408 || statusCode === 429 || statusCode >= 500 });
    this.statusCode = statusCode;
    this.responseBody = responseBody;
  }
}

// ---- 传输 ----

interface Endpoint {
  readonly name: string;
  readonly url: string;
  readonly headers: Record<string, string>;
  /** 请求体里的 `model` 选择器。 */
  readonly model: string;
  readonly fetch: typeof fetch;
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function trimBase(url: string | undefined): string | undefined {
  const trimmed = url?.trim().replace(/\/+$/, '');
  return trimmed ? trimmed : undefined;
}

function endpointHeaders(spec: SystemOneSpec): Record<string, string> {
  return {
    'content-type': 'application/json',
    ...(spec.apiKey ? { authorization: `Bearer ${spec.apiKey}` } : {}),
    ...spec.headers,
  };
}

const CLOUDFLARE_DEFAULT_BASE = 'https://api.cloudflare.com/client/v4';

/** `<baseUrl>/accounts/{accountId}/ai/run/@cf/cloudflare/<model>`，`baseUrl` 缺省 `https://api.cloudflare.com/client/v4`。 */
function cloudflareEndpoint(spec: SystemOneSpec, options: SystemOneOptions): Endpoint {
  const accountId = spec.accountId?.trim();
  if (!accountId) throw new Error('cloudflare System One models need `accountId`.');
  const base = trimBase(spec.baseUrl) ?? CLOUDFLARE_DEFAULT_BASE;
  return {
    name: spec.name ?? `cloudflare:${spec.model}`,
    url: `${base}/accounts/${encodeURIComponent(accountId)}/ai/run/@cf/cloudflare/${spec.model}`,
    headers: endpointHeaders(spec),
    model: spec.model,
    fetch: options.fetch ?? globalThis.fetch,
  };
}

const TYPESAFE_DEFAULT_BASE = 'https://api.typesafe.ai';

/** `<baseUrl>/v1/systemone`；`baseUrl` 是服务根，已经以 `/v1` 结尾时不再补。缺省 `https://api.typesafe.ai`。 */
function typesafeEndpoint(spec: SystemOneSpec, options: SystemOneOptions): Endpoint {
  const base = trimBase(spec.baseUrl) ?? TYPESAFE_DEFAULT_BASE;
  return {
    name: spec.name ?? `typesafe:${spec.model}`,
    url: `${base.endsWith('/v1') ? base : `${base}/v1`}/systemone`,
    headers: endpointHeaders(spec),
    model: spec.model,
    fetch: options.fetch ?? globalThis.fetch,
  };
}

/** 发请求，非 2xx 抛 `SystemOneError`；Cloudflare 的 `{ result, success }` 外壳拆掉，没有外壳（TypeSafe）原样返回。 */
async function post(endpoint: Endpoint, body: Json, signal: AbortSignal | undefined): Promise<Json> {
  signal?.throwIfAborted();
  // 不当方法调：浏览器里 fetch 的 this 不是 window 会报 Illegal invocation。
  const send = endpoint.fetch;
  const response = await send(endpoint.url, {
    method: 'POST',
    headers: endpoint.headers,
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
  const text = await response.text();
  if (!response.ok)
    throw new SystemOneError(
      `${endpoint.name}: HTTP ${response.status} ${response.statusText}`.trim(),
      response.status,
      text,
    );
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new CtxError('invalid_response', `${endpoint.name}: response is not JSON.`);
  }
  if (isObject(parsed) && typeof parsed['success'] === 'boolean') {
    if (!parsed['success']) throw new SystemOneError(`${endpoint.name}: success is false`, response.status, text);
    parsed = parsed['result'];
  }
  if (!isObject(parsed) || !isObject(parsed['answers']))
    throw new CtxError('invalid_response', `${endpoint.name}: response has no \`answers\` object.`);
  return parsed['answers'];
}

/**
 * 协议里的键是任意字符串，服务对 id 有字符限制（Clef：`[A-Za-z0-9_.-]{1,100}`；Clairic：`[A-Za-z_][A-Za-z0-9_.-]{0,63}`）。
 * 合规的键原样发（Clairic 会把字段名当提示），不合规的换成 `<prefix><i>`，回来再换回去。
 */
function wireKeys(keys: readonly string[], valid: RegExp, prefix: string): Map<string, string> {
  const used = new Set(keys.filter((key) => valid.test(key)));
  const out = new Map<string, string>();
  keys.forEach((key, i) => {
    if (valid.test(key)) {
      out.set(key, key);
      return;
    }
    let alias = `${prefix}${i}`;
    while (used.has(alias)) alias = `${alias}_`;
    used.add(alias);
    out.set(key, alias);
  });
  return out;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** 取非负有限数，归一到和为 1；全是 0 时均匀分布。 */
function normalize(values: readonly unknown[]): number[] {
  const clean = values.map((value) => (finite(value) && value > 0 ? value : 0));
  const sum = clean.reduce((total, value) => total + value, 0);
  return sum > 0 ? clean.map((value) => value / sum) : clean.map(() => 1 / clean.length);
}

// ---- 决策 ----

const DECISION_KEY = /^[A-Za-z0-9_.-]{1,100}$/;

function invalidAnswer(name: string, key: string, what: string): CtxError {
  return new CtxError('invalid_response', `${name}: answer "${key}" ${what}.`);
}

/**
 * 服务的回答映射到协议：`noul` 夹到 0..1；`choice` 的概率按选项取、归一，`choice` 取概率最大的（并列时信服务给的），
 * `confidence` 缺了用最大概率；`score` 的概率按档位键 `"0"…"n-1"`（也收数组）取、归一，`score` 按归一后的概率重算成
 * `Σ pᵢ · i / (n − 1)`（服务的 `score` 是 0..n−1 档位刻度，不用）。服务的 score `confidence` 协议里没有，丢掉。
 */
function decisionAnswer(name: string, key: string, question: DecisionQuestion, raw: unknown): DecisionAnswer {
  if (!isObject(raw)) throw invalidAnswer(name, key, 'is missing');
  if (raw['type'] !== undefined && raw['type'] !== question.type)
    throw invalidAnswer(name, key, `has type ${JSON.stringify(raw['type'])}, expected "${question.type}"`);
  switch (question.type) {
    case 'noul': {
      if (!finite(raw['noul'])) throw invalidAnswer(name, key, 'has no numeric `noul`');
      return { type: 'noul', noul: clamp01(raw['noul']) };
    }
    case 'choice': {
      const probs = raw['probabilities'];
      if (!isObject(probs)) throw invalidAnswer(name, key, 'has no `probabilities`');
      const options = Object.keys(question.criteria);
      const values = normalize(options.map((option) => probs[option]));
      const claimed = typeof raw['choice'] === 'string' ? options.indexOf(raw['choice']) : -1;
      let best = claimed >= 0 ? claimed : 0;
      values.forEach((value, i) => {
        if (value > values[best]!) best = i;
      });
      return {
        type: 'choice',
        choice: options[best]!,
        probabilities: Object.fromEntries(options.map((option, i) => [option, values[i]!])),
        confidence: finite(raw['confidence']) ? clamp01(raw['confidence']) : values[best]!,
      };
    }
    default: {
      const probs = raw['probabilities'];
      const n = question.criteria.length;
      let picked: unknown[];
      if (Array.isArray(probs)) picked = probs.slice(0, n);
      else if (isObject(probs)) picked = question.criteria.map((_, i) => probs[String(i)]);
      else throw invalidAnswer(name, key, 'has no `probabilities`');
      const values = normalize(question.criteria.map((_, i) => picked[i]));
      return {
        type: 'score',
        score: clamp01(values.reduce((sum, p, i) => sum + (p * i) / (n - 1), 0)),
        probabilities: values,
      };
    }
  }
}

function checkQuestion(key: string, question: DecisionQuestion): void {
  if (question.type === 'choice' && Object.keys(question.criteria).length === 0)
    throw new CtxError('invalid_request', `Question "${key}": a choice question needs at least one option.`);
  if (question.type === 'score' && question.criteria.length < 2)
    throw new CtxError('invalid_request', `Question "${key}": a score question needs at least two levels.`);
}

/** 只有一个选项的 choice 不必问（Clef 要 2 到 255 个选项），本地答。 */
function singleOption(question: DecisionQuestion): question is Extract<DecisionQuestion, { type: 'choice' }> {
  return question.type === 'choice' && Object.keys(question.criteria).length === 1;
}

/** 按 System One API 发 `{ model, state, questions }`、收 `{ answers }` 的决策模型。`cloudflare`、`typesafe` 都是它。 */
function systemOneDecision(endpoint: Endpoint): DecisionModel {
  return {
    name: endpoint.name,
    async decide(request) {
      request.signal?.throwIfAborted();
      const entries = Object.entries(request.questions);
      if (entries.length > MAX_DECISION_QUESTIONS)
        throw new CtxError('invalid_request', `At most ${MAX_DECISION_QUESTIONS} questions per call.`);
      for (const [key, question] of entries) checkQuestion(key, question);
      const remote = entries.filter(([, question]) => !singleOption(question));
      const keys = wireKeys(
        remote.map(([key]) => key),
        DECISION_KEY,
        'q',
      );
      const answers =
        remote.length === 0
          ? {}
          : await post(
              endpoint,
              {
                model: endpoint.model,
                state: request.state,
                questions: Object.fromEntries(remote.map(([key, question]) => [keys.get(key)!, question])),
              },
              request.signal,
            );
      return Object.fromEntries(
        entries.map(([key, question]): [string, DecisionAnswer] => {
          if (singleOption(question)) {
            const only = Object.keys(question.criteria)[0]!;
            return [key, { type: 'choice', choice: only, probabilities: { [only]: 1 }, confidence: 1 }];
          }
          return [key, decisionAnswer(endpoint.name, key, question, answers[keys.get(key)!])];
        }),
      );
    },
  };
}

// ---- 提取 ----

const FIELD_KEY = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/;

/** 协议的字段是 Clairic 字段的子集，字段名一样；`duration` 显式要秒（Clairic 的缺省也是秒）。 */
function wireField(field: ExtractionField): ExtractionField & { readonly unit?: string } {
  return field.type === 'duration' ? { ...field, unit: 'seconds' } : field;
}

function roundTo(value: number, decimals: number): number {
  const scale = 10 ** decimals;
  return Math.round(value * scale) / scale;
}

/** 值按字段类型收紧到协议的形状，收不成的当作没找到（null）。 */
function extractionValue(field: ExtractionField, value: unknown): JsonValue {
  switch (field.type) {
    case 'text':
      return typeof value === 'string' ? value : null;
    case 'number': {
      if (!finite(value)) return null;
      if (field.integer) return Math.round(value);
      return field.decimals === undefined ? value : roundTo(value, field.decimals);
    }
    case 'date': {
      if (typeof value !== 'string') return null;
      const day = value.slice(0, 10);
      return DATE.test(day) && !Number.isNaN(Date.parse(day)) ? day : null;
    }
    case 'datetime': {
      if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) return null;
      return DATETIME.test(value) ? value : new Date(value).toISOString();
    }
    case 'duration':
      return finite(value) && value >= 0 ? value : null;
    default:
      if (!Array.isArray(value)) return null;
      return field.items === 'text'
        ? value.filter((item): item is string => typeof item === 'string')
        : value.filter((item): item is number => finite(item));
  }
}

/**
 * Clairic 的回答映射到协议：`value` 按类型收紧；`pNull` 取 `p_null`，没有（`list` 就没有）时 `value` 是 null 记 1、否则 0；
 * `confidence` 取服务的，没有时按 `pNull` 推（null 时是 `pNull`，否则 `1 − pNull`）。
 */
function extractionAnswer(name: string, key: string, field: ExtractionField, raw: unknown): ExtractionAnswer {
  if (!isObject(raw)) throw invalidAnswer(name, key, 'is missing');
  const value = extractionValue(field, raw['value']);
  const pNull = finite(raw['p_null']) ? clamp01(raw['p_null']) : value === null ? 1 : 0;
  const confidence = finite(raw['confidence']) ? clamp01(raw['confidence']) : value === null ? pNull : 1 - pNull;
  return { value, pNull, confidence };
}

function isEmptyState(state: JsonValue): boolean {
  return state === null || (typeof state === 'string' && state.trim() === '');
}

/**
 * Clairic 风格的提取模型：发 `{ model, state, fields }`、收 `{ answers }`。Clairic 的 `state` 只收字符串，JSON 先序列化；
 * 空输入（null 或空白文字）Clairic 不收，本地直接答「都没找到」（`value: null`、`pNull: 1`、`confidence: 1`）。
 */
function systemOneExtraction(endpoint: Endpoint): ExtractionModel {
  return {
    name: endpoint.name,
    async extract(request) {
      request.signal?.throwIfAborted();
      const entries = Object.entries(request.fields);
      if (entries.length === 0) return {};
      if (isEmptyState(request.state))
        return Object.fromEntries(entries.map(([key]) => [key, { value: null, pNull: 1, confidence: 1 }]));
      const keys = wireKeys(
        entries.map(([key]) => key),
        FIELD_KEY,
        'f',
      );
      const answers = await post(
        endpoint,
        {
          model: endpoint.model,
          state: typeof request.state === 'string' ? request.state : JSON.stringify(request.state),
          fields: Object.fromEntries(entries.map(([key, field]) => [keys.get(key)!, wireField(field)])),
        },
        request.signal,
      );
      return Object.fromEntries(
        entries.map(([key, field]) => [key, extractionAnswer(endpoint.name, key, field, answers[keys.get(key)!])]),
      );
    },
  };
}

// ---- 工厂、注册表 ----

/** Cloudflare Workers AI 的决策模型：`clef`、`clef-flash`。 */
export const cloudflareDecision: DecisionFactory = (spec, options) =>
  systemOneDecision(cloudflareEndpoint(spec, options));

/** TypeSafe 的决策模型：`jev-latest`、`jev-1.14.0`…… */
export const typesafeDecision: DecisionFactory = (spec, options) => systemOneDecision(typesafeEndpoint(spec, options));

/** Cloudflare Workers AI 的提取模型：`clairic`。 */
export const cloudflareExtraction: ExtractionFactory = (spec, options) =>
  systemOneExtraction(cloudflareEndpoint(spec, options));

function checkSpec(spec: SystemOneSpec, known: Iterable<string>, has: (provider: string) => boolean): void {
  if (!spec.model?.trim()) throw new Error('System One model spec needs `model`.');
  if (!spec.provider?.trim())
    throw new Error(`System One model spec needs \`provider\`. Known: ${[...known].join(', ')}.`);
  if (!has(spec.provider))
    throw new Error(`Unknown System One provider "${spec.provider}". Known: ${[...known].join(', ')}.`);
}

/** 带内置服务商（`cloudflare`、`typesafe`）的决策模型注册表；传入的工厂可以覆盖内置的。 */
export function createDecisionModelRegistry(
  factories: Readonly<Record<string, DecisionFactory>> = {},
): DecisionModelRegistry {
  const table = new Map<string, DecisionFactory>([
    ['cloudflare', cloudflareDecision],
    ['typesafe', typesafeDecision],
    ...Object.entries(factories),
  ]);
  const registry: DecisionModelRegistry = {
    register(provider, factory) {
      table.set(provider, factory);
      return registry;
    },
    create(spec, options = {}) {
      checkSpec(spec, table.keys(), (provider) => table.has(provider));
      return table.get(spec.provider)!(spec, options);
    },
    providers() {
      return [...table.keys()];
    },
  };
  return registry;
}

/**
 * 带内置服务商（`cloudflare`）的提取模型注册表；传入的工厂可以覆盖内置的。TypeSafe 的公开 API（OpenAPI 0.2.0 只有
 * `/v1/models`、`/v1/systemone`，请求必须带 `questions`）没有提取接口，所以不内置 `typesafe`。
 */
export function createExtractionModelRegistry(
  factories: Readonly<Record<string, ExtractionFactory>> = {},
): ExtractionModelRegistry {
  const table = new Map<string, ExtractionFactory>([
    ['cloudflare', cloudflareExtraction],
    ...Object.entries(factories),
  ]);
  const registry: ExtractionModelRegistry = {
    register(provider, factory) {
      table.set(provider, factory);
      return registry;
    },
    create(spec, options = {}) {
      checkSpec(spec, table.keys(), (provider) => table.has(provider));
      return table.get(spec.provider)!(spec, options);
    },
    providers() {
      return [...table.keys()];
    },
  };
  return registry;
}

const decisionDefaults: DecisionModelRegistry = createDecisionModelRegistry();
const extractionDefaults: ExtractionModelRegistry = createExtractionModelRegistry();

export function createDecisionModel(spec: SystemOneSpec, options?: SystemOneOptions): DecisionModel {
  return decisionDefaults.create(spec, options);
}

export function createExtractionModel(spec: SystemOneSpec, options?: SystemOneOptions): ExtractionModel {
  return extractionDefaults.create(spec, options);
}
