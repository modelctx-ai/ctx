// 记忆的评测：每段对话一份新的记忆，门控、巩固之后数该记住的记住了几条、不该记住的记住了几条、召回问得到几次。
//
//   node live/memory-eval.ts                      # 对配了密钥的模型各跑一遍，打印三个比例
//   node live/memory-eval.ts --min-recall 0.8 --max-false 0.1   # 低于、高于门槛时退出码是 1
//   node live/memory-eval.ts --json               # 结果按 JSON 打印
//
// 「记住了」只算会被召回的事实：仍然成立、没归档、置信度不低于召回的缺省门槛。被取代的旧说法、原文里没有支撑而被
// 降了置信度的，不算记住，也不算误记。
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import {
  assistantEntry,
  createMemoryStore as createSessionStore,
  isOpenFact,
  userEntry,
  type DecisionModel,
  type ExtractionModel,
  type LanguageModel,
  type MemoryFact,
} from '@modelctx-ai/ctx';
import { createMemory, createMemoryStore, MEMORY_DEFAULTS, type MemoryOptions } from '@modelctx-ai/ctx-memory';
import { createDecisionModel, createExtractionModel, createModel } from '@modelctx-ai/ctx-models';

import { targetsFromEnv } from './targets.ts';

export interface EvalCase {
  readonly id: string;
  readonly lang: 'zh' | 'en';
  readonly turns: readonly (readonly ['user' | 'assistant', string])[];
  /** 该记住的：`fact` 是标准说法（给剧本提取模型和人看），`all` 里的词都出现在某条事实里就算记住了。 */
  readonly remember: readonly { readonly fact: string; readonly all: readonly string[] }[];
  /** 不该记住的：`any` 里任何一个词出现在某条事实里就算误记。 */
  readonly notRemember: readonly { readonly about: string; readonly any: readonly string[] }[];
  /** 召回：问 `query`，召回的事实里有一条含有 `expect` 的全部词就算问到了。 */
  readonly queries: readonly { readonly query: string; readonly expect: readonly string[] }[];
}

/** 一种配置：记忆用哪些模型。 */
export interface EvalConfig {
  readonly name: string;
  readonly options: Pick<MemoryOptions, 'decision' | 'extraction' | 'model' | 'gate'>;
  /** 每段对话一个新的提取模型（剧本模型按段给答案）；不给就用 `options` 里的。 */
  readonly extractionFor?: (item: EvalCase) => ExtractionModel;
}

export interface CaseResult {
  readonly id: string;
  readonly lang: string;
  readonly missed: readonly string[];
  readonly falselyRemembered: readonly string[];
  readonly unanswered: readonly string[];
  readonly facts: readonly string[];
}

export interface Rates {
  /** 该记住的里记住了的比例。 */
  readonly recall: number;
  /** 不该记住的里被记住了的比例。 */
  readonly falseMemory: number;
  /** 召回问到了的比例。 */
  readonly answered: number;
}

export interface EvalReport {
  readonly config: string;
  readonly overall: Rates;
  readonly byLang: Readonly<Record<string, Rates>>;
  readonly cases: readonly CaseResult[];
}

const NOW = Date.UTC(2026, 10, 1, 12);

function normalized(text: string): string {
  return text.normalize('NFKC').toLowerCase();
}

function containsAll(text: string, words: readonly string[]): boolean {
  const haystack = normalized(text);
  return words.every((word) => haystack.includes(normalized(word)));
}

/** 会被召回的事实：仍然成立、没归档、置信度够。 */
function active(facts: readonly MemoryFact[]): MemoryFact[] {
  return facts.filter((fact) => isOpenFact(fact) && fact.confidence >= MEMORY_DEFAULTS.minConfidence);
}

export async function loadCases(): Promise<EvalCase[]> {
  const raw = JSON.parse(await readFile(new URL('memory-eval.json', import.meta.url), 'utf8')) as {
    cases: EvalCase[];
  };
  return raw.cases;
}

async function runCase(item: EvalCase, config: EvalConfig): Promise<CaseResult> {
  const sessions = createSessionStore({ now: () => NOW });
  const store = createMemoryStore();
  const memory = createMemory({
    store,
    sessions,
    now: () => NOW,
    ...config.options,
    ...(config.extractionFor ? { extraction: config.extractionFor(item) } : {}),
  });
  await sessions.append(
    item.id,
    item.turns.map(([role, text]) => (role === 'user' ? userEntry(text) : assistantEntry(text))),
  );
  await memory.gate(item.id);
  await memory.consolidate({ now: NOW });
  const facts = active(await store.facts.list()).map((fact) => fact.text);
  const unanswered: string[] = [];
  for (const { query, expect } of item.queries) {
    const recalled = await memory.recall(query);
    if (!recalled.facts.some((fact) => containsAll(fact.text, expect))) unanswered.push(query);
  }
  return {
    id: item.id,
    lang: item.lang,
    missed: item.remember.filter(({ all }) => !facts.some((text) => containsAll(text, all))).map(({ fact }) => fact),
    falselyRemembered: item.notRemember
      .filter(({ any }) => facts.some((text) => any.some((word) => containsAll(text, [word]))))
      .map(({ about }) => about),
    unanswered,
    facts,
  };
}

function ratesOf(cases: readonly EvalCase[], results: readonly CaseResult[]): Rates {
  const sum = (count: (item: EvalCase) => number): number => cases.reduce((total, item) => total + count(item), 0);
  const remembered = sum((item) => item.remember.length);
  const forbidden = sum((item) => item.notRemember.length);
  const asked = sum((item) => item.queries.length);
  const missed = results.reduce((total, result) => total + result.missed.length, 0);
  const wrong = results.reduce((total, result) => total + result.falselyRemembered.length, 0);
  const unanswered = results.reduce((total, result) => total + result.unanswered.length, 0);
  return {
    recall: remembered === 0 ? 1 : 1 - missed / remembered,
    falseMemory: forbidden === 0 ? 0 : wrong / forbidden,
    answered: asked === 0 ? 1 : 1 - unanswered / asked,
  };
}

export async function evaluateMemory(cases: readonly EvalCase[], config: EvalConfig): Promise<EvalReport> {
  const results: CaseResult[] = [];
  for (const item of cases) results.push(await runCase(item, config));
  const langs = [...new Set(cases.map((item) => item.lang))];
  return {
    config: config.name,
    overall: ratesOf(cases, results),
    byLang: Object.fromEntries(
      langs.map((lang) => [
        lang,
        ratesOf(
          cases.filter((item) => item.lang === lang),
          results.filter((result) => result.lang === lang),
        ),
      ]),
    ),
    cases: results,
  };
}

/** 配了密钥的模型各一种配置：`LanguageModel` 做提取，或者 System One 的提取模型（有决策模型时一起用）。 */
function configsFromEnv(env: NodeJS.ProcessEnv): { configs: EvalConfig[]; skipped: string[] } {
  const { targets, skipped } = targetsFromEnv(env);
  const decisions: DecisionModel[] = [];
  const configs: EvalConfig[] = [];
  for (const target of targets) {
    if (target.kind === 'decision') decisions.push(createDecisionModel(target.spec));
  }
  for (const target of targets) {
    if (target.kind === 'model') {
      const model: LanguageModel = createModel(target.spec);
      configs.push({ name: `${target.name}（LanguageModel 提取）`, options: { model } });
    } else if (target.kind === 'extraction') {
      configs.push({
        name: `${target.name}${decisions[0] ? ' + 决策模型' : ''}`,
        options: {
          extraction: createExtractionModel(target.spec),
          ...(decisions[0] ? { decision: decisions[0] } : {}),
        },
      });
    }
  }
  return { configs, skipped: skipped.map((group) => group.name) };
}

const percent = (value: number): string => `${(value * 100).toFixed(0)}%`;

function numberArg(args: readonly string[], name: string): number | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = Number(args[index + 1]);
  if (!Number.isFinite(value)) throw new Error(`${name} needs a number`);
  return value;
}

async function main(args: readonly string[]): Promise<number> {
  const minRecall = numberArg(args, '--min-recall');
  const maxFalse = numberArg(args, '--max-false');
  const { configs, skipped } = configsFromEnv(process.env);
  if (configs.length === 0) {
    console.log(`SKIP 记忆评测：没有配密钥的模型（${skipped.join('、') || '没有目标'}）`);
    return 0;
  }
  const cases = await loadCases();
  let failed = false;
  const reports: EvalReport[] = [];
  for (const config of configs) {
    const report = await evaluateMemory(cases, config);
    reports.push(report);
    const { recall, falseMemory, answered } = report.overall;
    const bad = (minRecall !== undefined && recall < minRecall) || (maxFalse !== undefined && falseMemory > maxFalse);
    failed ||= bad;
    if (args.includes('--json')) continue;
    console.log(
      `${bad ? 'FAIL' : 'OK  '} ${config.name}：召回率 ${percent(recall)}，误记率 ${percent(falseMemory)}，问到 ${percent(answered)}`,
    );
    for (const [lang, rates] of Object.entries(report.byLang)) {
      console.log(
        `     ${lang}：召回率 ${percent(rates.recall)}，误记率 ${percent(rates.falseMemory)}，问到 ${percent(rates.answered)}`,
      );
    }
    for (const result of report.cases) {
      const notes = [
        ...result.missed.map((fact) => `漏了「${fact}」`),
        ...result.falselyRemembered.map((about) => `误记了${about}`),
        ...result.unanswered.map((query) => `没问到「${query}」`),
      ];
      if (notes.length > 0) console.log(`     ${result.id}：${notes.join('；')}`);
    }
  }
  if (args.includes('--json')) console.log(JSON.stringify(reports, null, 2));
  return failed ? 1 : 0;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(await main(process.argv.slice(2)));
}
