import { createScriptedExtractionModel } from '@modelctx-ai/ctx-protocol/testing';
import { describe, expect, test } from 'vite-plus/test';

import { evaluateMemory, loadCases, type EvalCase } from './memory-eval.ts';

const cases = await loadCases();

function said(item: EvalCase): string {
  return item.turns
    .map(([, text]) => text)
    .join('\n')
    .normalize('NFKC')
    .toLowerCase();
}

describe('记忆评测集', () => {
  test('中英文各至少五段；id 不重复；该记住的词都在对话里，标准说法里也有', () => {
    for (const lang of ['zh', 'en'])
      expect(cases.filter((item) => item.lang === lang).length).toBeGreaterThanOrEqual(5);
    expect(new Set(cases.map((item) => item.id)).size).toBe(cases.length);
    for (const item of cases) {
      for (const { fact, all } of item.remember) {
        for (const word of all) {
          expect(said(item), `${item.id}：「${word}」不在对话里`).toContain(word.toLowerCase());
          expect(fact.toLowerCase(), `${item.id}：「${word}」不在「${fact}」里`).toContain(word.toLowerCase());
        }
      }
      for (const { any, about } of item.notRemember) {
        expect(any.length, `${item.id}：${about} 没有词`).toBeGreaterThan(0);
      }
    }
  });

  test('提取模型照标准答案回答时：召回率 100%、误记率 0、问得到（评测本身的检查）', async () => {
    const report = await evaluateMemory(cases, {
      name: 'oracle',
      // 门控全收：这里查的是巩固、召回和计分，不是门控。
      options: { gate: { theta: 0, auto: false } },
      extractionFor: (item) =>
        createScriptedExtractionModel({
          values: { facts: item.remember.map(({ fact }) => fact), decisions: null, lesson: null },
        }),
    });
    const notes = report.cases.filter(
      (result) => result.missed.length + result.falselyRemembered.length + result.unanswered.length > 0,
    );
    expect(notes).toEqual([]);
    expect(report.overall).toEqual({ recall: 1, falseMemory: 0, answered: 1 });
    expect(Object.keys(report.byLang).toSorted()).toEqual(['en', 'zh']);
  });

  test('什么都记的提取模型：误记率按「不该记住的」算出来', async () => {
    const report = await evaluateMemory(cases, {
      name: 'everything',
      options: { gate: { theta: 0, auto: false } },
      // 把对话里每一句都当成事实：说过的都有支撑，不该记的也会记下。
      extractionFor: (item) =>
        createScriptedExtractionModel({
          values: { facts: item.turns.map(([, text]) => text), decisions: null, lesson: null },
        }),
    });
    expect(report.overall.falseMemory).toBeGreaterThan(0.5);
  });
});
