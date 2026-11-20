import assert from 'node:assert/strict';

import { describe, test } from 'vite-plus/test';

import {
  ACTIVATION_DEFAULTS,
  MEMORY_RECALL_TOOL,
  activation,
  checkEvidence,
  checkMemoryScope,
  DEFAULT_MEMORY_SCOPE,
  checkSourceRef,
  filterFacts,
  inSearchScope,
  inSourceRef,
  isOpenFact,
  MAX_FACT_RECALLS,
  MAX_SEARCH_TERMS,
  rankFacts,
  renderCore,
  retrievability,
  searchTerms,
  termOverlap,
  sameSourceRef,
  sourceRef,
  type ConsolidateReport,
  type CoreVersion,
  type DecisionModel,
  type ExtractionModel,
  type Memory,
  type MemoryFact,
  type MemoryStore,
  type NewMemoryFact,
  type Note,
  type Procedure,
  type Recalled,
  type SourceRef,
} from './memory.ts';
import { textOf } from './message.ts';
import type { Entry, SessionStore } from './session.ts';
import {
  createScriptedDecisionModel,
  createScriptedExtractionModel,
  describeDecisionModelContract,
  describeExtractionModelContract,
  describeMemoryContract,
  describeMemoryStoreContract,
} from './testing.ts';
import { estimateTextTokens } from './tokens.ts';
import { errorOutput } from './tools.ts';
import { CtxError, type JsonValue } from './types.ts';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 27);

/** `at`、`validFrom` 只给一个时，另一个和它一样：那时写下、那时成立。 */
function fact(id: string, extra: Partial<MemoryFact> = {}): MemoryFact {
  return {
    id,
    subject: 'user',
    text: `事实 ${id}`,
    at: extra.at ?? extra.validFrom ?? NOW,
    validFrom: extra.validFrom ?? extra.at ?? NOW,
    confidence: 0.9,
    salience: 0.6,
    sources: [{ session: 's', from: 1, upTo: 1 }],
    recalls: [],
    ...extra,
  };
}

function isInvalid(error: unknown): boolean {
  return error instanceof CtxError && error.type === 'invalid_request';
}

describe('activation', () => {
  test('A = ln Σ (Δt + ε)^(−d) + s，Δt 以天计，t 取写入的时刻和每次召回', () => {
    const fresh = activation(fact('a'), NOW);
    assert.ok(Math.abs(fresh - (Math.log(0.02 ** -0.5) + 0.6)) < 1e-12);
    const dayOld = activation(fact('a', { at: NOW - DAY }), NOW);
    assert.ok(Math.abs(dayOld - (Math.log(1.02 ** -0.5) + 0.6)) < 1e-12);
    const recalled = activation(fact('a', { at: NOW - 3 * DAY, recalls: [NOW - DAY / 2] }), NOW);
    assert.ok(Math.abs(recalled - (Math.log(3.02 ** -0.5 + 0.52 ** -0.5) + 0.6)) < 1e-12);
  });

  test('从写入算起：早就成立的事实刚写进来也是新的，validFrom 早于写入的不算', () => {
    for (const days of [1, 30, 3650]) {
      assert.equal(
        activation(fact('a', { at: NOW, validFrom: NOW - days * DAY }), NOW),
        activation(fact('a'), NOW),
        `${days} 天前成立、刚写进来的和刚成立的一样新`,
      );
    }
    const learned = fact('a', { at: NOW - DAY, validFrom: NOW - 400 * DAY });
    assert.ok(activation(learned, NOW) > ACTIVATION_DEFAULTS.archiveAt, '写进来第二天还在阈值之上');
    assert.equal(activation(learned, NOW), activation(fact('a', { at: NOW - DAY }), NOW));
  });

  test('越久越低，召回一次就抬高；显著性是常数偏置', () => {
    const old = fact('a', { at: NOW - 5 * DAY });
    assert.ok(activation(old, NOW) < activation(fact('a', { at: NOW - DAY }), NOW));
    assert.ok(activation({ ...old, recalls: [NOW - DAY] }, NOW) > activation(old, NOW));
    const diff = activation({ ...old, salience: 0.9 }, NOW) - activation({ ...old, salience: 0.1 }, NOW);
    assert.ok(Math.abs(diff - 0.8) < 1e-12);
  });

  test('d、epsilon 可调', () => {
    const f = fact('a', { at: NOW - 2 * DAY });
    assert.ok(Math.abs(activation(f, NOW, { d: 1 }) - (Math.log(1 / 2.02) + 0.6)) < 1e-12);
    assert.ok(Math.abs(activation(f, NOW, { epsilon: 0 }) - (Math.log(2 ** -0.5) + 0.6)) < 1e-12);
  });

  test('写的时候还没成立的，成立那天也算一次：晚于 now 的按离 now 多远算，临近时回升，成立以后再衰减', () => {
    const at = NOW - 10 * DAY;
    for (const days of [0.5, 1, 10, 400]) {
      assert.equal(
        activation(fact('a', { at, validFrom: NOW + days * DAY }), NOW),
        activation(fact('a', { at, recalls: [NOW - days * DAY] }), NOW),
        `${days} 天后成立的和 ${days} 天前召回过一次的一样`,
      );
    }
    const far = fact('a', { at: NOW, validFrom: NOW + 365 * DAY });
    assert.ok(activation(far, NOW) > ACTIVATION_DEFAULTS.archiveAt, '刚写下的远期事实是新的');
    assert.ok(activation(far, NOW + 100 * DAY) < ACTIVATION_DEFAULTS.archiveAt, '不会一直顶着最高的激活度');
    assert.ok(activation(far, NOW + 364 * DAY) > activation(far, NOW + 300 * DAY), '越临近越高');
    assert.ok(activation(far, NOW + 400 * DAY) < activation(far, NOW + 366 * DAY), '成立以后再衰减');
    assert.ok(
      activation(fact('a', { at: NOW - 3 * DAY, recalls: [NOW + DAY] }), NOW) ===
        activation(fact('a', { at: NOW - 3 * DAY, recalls: [NOW - DAY] }), NOW),
      '召回时刻也一样',
    );
  });

  test(`只看最近 ${MAX_FACT_RECALLS} 次召回，所以有上界：ln((N + 2) · ε^(−d)) + s`, () => {
    const many = Array.from({ length: 20_000 }, () => NOW);
    const flooded = activation(fact('a', { recalls: many }), NOW);
    const once = Math.log((MAX_FACT_RECALLS + 1) * 0.02 ** -0.5) + 0.6;
    assert.ok(Math.abs(flooded - once) < 1e-9, `两万次刚发生的召回也只到 ${once}，实际 ${flooded}`);
    // 写入和成立各算一次，都刚发生时最高。
    const bound = Math.log((MAX_FACT_RECALLS + 2) * 0.02 ** -0.5) + 0.6;
    const both = activation(fact('a', { at: NOW - 1, validFrom: NOW, recalls: many }), NOW);
    assert.ok(both < bound && bound - both < 1e-6, `上界 ${bound}，实际 ${both}`);
    assert.ok(bound < 6.09);
    const old = Array.from({ length: 1000 }, () => NOW - 300 * DAY);
    const recent = Array.from({ length: MAX_FACT_RECALLS }, (_, i) => NOW - i * DAY);
    assert.equal(
      activation(fact('a', { at: NOW - 400 * DAY, recalls: [...old, ...recent.toReversed()] }), NOW),
      activation(fact('a', { at: NOW - 400 * DAY, recalls: recent.toReversed() }), NOW),
      '更早的召回不算',
    );
  });

  test('缺省参数：s = 0.6、从未召回的事实写入约一天后低于归档阈值', () => {
    assert.deepEqual(ACTIVATION_DEFAULTS, { d: 0.5, epsilon: 0.02, archiveAt: 0.55 });
    assert.ok(activation(fact('a', { at: NOW - DAY }), NOW) > ACTIVATION_DEFAULTS.archiveAt);
    assert.ok(activation(fact('a', { at: NOW - 1.2 * DAY }), NOW) < ACTIVATION_DEFAULTS.archiveAt);
  });
});

describe('retrievability', () => {
  test('1 / (1 + e^(−(A − archiveAt)))：在 0..1 里，阈值上是 0.5，随激活度单调', () => {
    const fresh = retrievability(fact('a'), NOW);
    assert.ok(Math.abs(fresh - 1 / (1 + Math.exp(0.55 - activation(fact('a'), NOW)))) < 1e-12);
    assert.ok(fresh > 0.88 && fresh < 0.89, `刚写的事实约 0.88：${fresh}`);
    const month = retrievability(fact('a', { at: NOW - 30 * DAY }), NOW);
    assert.ok(month > 0.15 && month < 0.17, `一个月没动的约 0.16：${month}`);
    // 取一个激活度正好等于阈值的事实：ln((Δt + ε)^(−d)) + s = archiveAt。
    const edge = fact('a', { at: NOW - (Math.exp((0.6 - 0.55) / 0.5) - 0.02) * DAY });
    assert.ok(Math.abs(retrievability(edge, NOW) - 0.5) < 1e-9);
    assert.ok(
      Math.abs(retrievability(edge, NOW, { archiveAt: 0 }) - 1 / (1 + Math.exp(-0.55))) < 1e-9,
      'archiveAt 可调',
    );
    const flooded = retrievability(fact('a', { recalls: Array.from({ length: 20_000 }, () => NOW) }), NOW);
    assert.ok(flooded > fresh && flooded < 1, `召回再多也到不了 1：${flooded}`);
    const ancient = retrievability(fact('a', { at: NOW - 3650 * DAY, salience: 0 }), NOW);
    assert.ok(ancient > 0 && ancient < 0.02);
  });
});

describe('rankFacts', () => {
  test('0.6 × 相似度 + 0.4 × retrievability，从高到低', () => {
    const a = fact('a', { validFrom: NOW - 2 * DAY });
    const b = fact('b', { validFrom: NOW - 3 * DAY });
    assert.deepEqual(
      rankFacts([b, a], {}, { now: NOW }).map((f) => f.id),
      ['a', 'b'],
      '没有相似度时按激活度',
    );
    assert.deepEqual(
      rankFacts([a, b], { a: 0.5, b: 0.5 }, { now: NOW }).map((f) => f.id),
      ['a', 'b'],
      '相似度一样时按激活度',
    );
    assert.deepEqual(
      rankFacts([a, b], { b: 0.2 }, { now: NOW }).map((f) => f.id),
      ['b', 'a'],
      '相似度差 0.2 抵得过一天的衰减',
    );
  });

  test('激活度最多贡献 0.4：相似度高出 0.67 的，对方召回再多、再新也排在前面', () => {
    const relevant = fact('relevant', { validFrom: NOW - 3650 * DAY, salience: 0 });
    const flooded = fact('flooded', { recalls: Array.from({ length: 20_000 }, () => NOW), salience: 1 });
    assert.deepEqual(
      rankFacts([flooded, relevant], { relevant: 0.9, flooded: 0.2 }, { now: NOW }).map((f) => f.id),
      ['relevant', 'flooded'],
    );
    // 刚写的事实不再盖过相似度：以前激活度直接加权（约 2.56 × 0.4），相似度 1 都补不回来。
    const similar = fact('similar', { validFrom: NOW - 10 * DAY });
    const fresh = fact('fresh');
    assert.deepEqual(
      rankFacts([fresh, similar], { similar: 1, fresh: 0.2 }, { now: NOW }).map((f) => f.id),
      ['similar', 'fresh'],
    );
    // 差得不多时，激活度仍然说了算。
    assert.deepEqual(
      rankFacts([similar, fresh], { similar: 0.5, fresh: 0.4 }, { now: NOW }).map((f) => f.id),
      ['fresh', 'similar'],
    );
  });

  test('分数相同时保持输入顺序；权重可调；不改输入', () => {
    const list = [fact('x'), fact('y'), fact('z')];
    assert.deepEqual(
      rankFacts(list, {}, { now: NOW }).map((f) => f.id),
      ['x', 'y', 'z'],
    );
    const old = fact('old', { validFrom: NOW - 30 * DAY });
    const weights = { similarity: 1, activation: 0 };
    assert.deepEqual(
      rankFacts([list[0]!, old], { old: 0.5 }, { now: NOW, weights }).map((f) => f.id),
      ['old', 'x'],
    );
    assert.deepEqual(
      list.map((f) => f.id),
      ['x', 'y', 'z'],
    );
  });
});

describe('searchTerms', () => {
  test('字母数字连成的一串是一个词，转小写；标点和空白只是分隔', () => {
    assert.deepEqual(searchTerms('The project uses PostgreSQL 16, not MySQL-8.'), [
      'the',
      'project',
      'uses',
      'postgresql',
      '16',
      'not',
      'mysql',
      '8',
    ]);
    assert.deepEqual(searchTerms('  \n\t '), []);
    assert.deepEqual(searchTerms('，。？！…… %_'), []);
    assert.deepEqual(searchTerms(''), []);
  });

  test('中日韩文字按相邻两个字切，落单的一个字自成一个；和字母数字混排时各切各的', () => {
    assert.deepEqual(searchTerms('乌龙茶'), ['乌龙', '龙茶']);
    assert.deepEqual(searchTerms('茶'), ['茶']);
    assert.deepEqual(searchTerms('主人的项目用PostgreSQL存数据'), [
      '主人',
      '人的',
      '的项',
      '项目',
      '目用',
      'postgresql',
      '存数',
      '数据',
    ]);
    assert.deepEqual(searchTerms('喝茶，看书'), ['喝茶', '看书'], '标点隔开的不连成词');
    assert.deepEqual(searchTerms('ひらがなとカタカナ'), [
      'ひら',
      'らが',
      'がな',
      'なと',
      'とカ',
      'カタ',
      'タカ',
      'カナ',
    ]);
    assert.deepEqual(searchTerms('한국어 3급'), ['한국', '국어', '3', '급']);
    assert.deepEqual(searchTerms('𠮷野家'), ['𠮷野', '野家'], '按码点切，不拆代理对');
  });

  test('去重，按第一次出现的先后；NFKC 归一把全角和半角并到一起', () => {
    assert.deepEqual(searchTerms('茶 tea 茶 TEA Tea'), ['茶', 'tea']);
    assert.deepEqual(searchTerms('数据库的数据'), ['数据', '据库', '库的', '的数']);
    assert.deepEqual(searchTerms('ＰｏｓｔｇｒｅＳＱＬ　１６'), ['postgresql', '16']);
    assert.deepEqual(searchTerms('ｶﾀｶﾅ'), searchTerms('カタカナ'));
  });

  test('max：词比它多时取开头的一半和结尾的一半；不多时全要', () => {
    const words = Array.from({ length: 10 }, (_, i) => `w${i}`);
    const text = words.join(' ');
    assert.deepEqual(searchTerms(text, 10), words);
    assert.deepEqual(searchTerms(text, 100), words);
    assert.deepEqual(searchTerms(text, 4), ['w0', 'w1', 'w8', 'w9']);
    assert.deepEqual(searchTerms(text, 5), ['w0', 'w1', 'w2', 'w8', 'w9']);
    assert.deepEqual(searchTerms(text, 1), ['w0']);
    assert.deepEqual(searchTerms(text, 0), []);
    assert.deepEqual(searchTerms(text, 2.9), ['w0', 'w9']);
    const long = Array.from({ length: 5000 }, (_, i) => `w${i}`).join(' ');
    const capped = searchTerms(long, MAX_SEARCH_TERMS);
    assert.equal(capped.length, MAX_SEARCH_TERMS);
    assert.equal(capped[0], 'w0');
    assert.equal(capped.at(-1), 'w4999');
    assert.equal(new Set(capped).size, MAX_SEARCH_TERMS);
  });
});

/** 按 `searchTerms` 切词、`termOverlap` 打分：查询和一段文字的相似度。 */
function overlapOf(query: string, text: string): number {
  const wanted = searchTerms(query);
  const own = new Set(searchTerms(text));
  return termOverlap(wanted.filter((term) => own.has(term)).length, wanted.length, own.size);
}

describe('termOverlap', () => {
  test('共同的词数除以较小的那一边：一边全在另一边里就是 1', () => {
    assert.equal(termOverlap(2, 2, 10), 1, '短的查询全在长的事实里');
    assert.equal(termOverlap(5, 300, 5), 1, '短的事实全在长的一段话里');
    assert.equal(termOverlap(1, 4, 8), 0.25);
    assert.equal(termOverlap(3, 6, 4), 0.75);
    assert.equal(termOverlap(0, 4, 8), 0);
  });

  test('任何一边没有词是 0；不超过 1', () => {
    assert.equal(termOverlap(0, 0, 8), 0);
    assert.equal(termOverlap(0, 4, 0), 0);
    assert.equal(termOverlap(9, 4, 8), 1);
  });

  test('和 searchTerms 一起：问句和事实的相似度', () => {
    assert.equal(overlapOf('乌龙茶', '主人喜欢喝乌龙茶，不喝咖啡'), 1);
    assert.equal(overlapOf('我平时喜欢喝什么茶？', '主人喜欢喝乌龙茶，不喝咖啡'), 0.25);
    assert.equal(overlapOf('今天天气怎么样', '主人喜欢喝乌龙茶，不喝咖啡'), 0);
    assert.equal(overlapOf('POSTGRESQL', '项目用 PostgreSQL'), 1);
  });
});

describe('renderCore', () => {
  test('仍然成立的事实按激活度排，一行一条', () => {
    const facts = [
      fact('old', { text: '旧的', validFrom: NOW - 5 * DAY }),
      fact('new', { text: '新的' }),
      fact('closed', { text: '关掉的', validTo: NOW }),
      fact('archived', { text: '归档的', archivedAt: NOW }),
    ];
    assert.equal(renderCore(facts, 1000, { now: NOW }), '新的\n旧的');
  });

  test('按 token 预算截断，不超过预算', () => {
    const facts = ['一二三四五', '六七八九十', '甲乙丙丁戊'].map((text, i) =>
      fact(`f${i}`, { text, validFrom: NOW - i * DAY }),
    );
    const two = renderCore(facts, 11, { now: NOW });
    assert.equal(two, '一二三四五\n六七八九十');
    assert.ok(estimateTextTokens(two) <= 11);
    assert.equal(renderCore(facts, 4, { now: NOW }), '', '第一条就放不下时是空串');
    assert.equal(renderCore(facts, 0, { now: NOW }), '');
    assert.equal(renderCore(facts, Number.NaN, { now: NOW }), '');
    assert.equal(renderCore([], 100, { now: NOW }), '');
  });
});

describe('sourceRef', () => {
  test('from 是最小 seq，upTo 是最大 seq，输入不必排序', () => {
    const entries = [
      { session: 's', seq: 7 },
      { session: 's', seq: 3 },
      { session: 's', seq: 5 },
    ];
    assert.deepEqual(sourceRef('s', entries), { session: 's', from: 3, upTo: 7 });
    assert.deepEqual(sourceRef('s', [{ session: 's', seq: 4 }]), { session: 's', from: 4, upTo: 4 });
  });

  test('没有条目、或条目属于别的会话时抛 invalid_request', () => {
    assert.throws(() => sourceRef('s', []), isInvalid);
    assert.throws(
      () =>
        sourceRef('s', [
          { session: 's', seq: 1 },
          { session: 't', seq: 2 },
        ]),
      isInvalid,
    );
  });

  test('inSourceRef：同一会话、两端都含', () => {
    const ref = { session: 's', from: 2, upTo: 4 };
    assert.deepEqual(
      [1, 2, 3, 4, 5].map((seq) => inSourceRef({ session: 's', seq }, ref)),
      [false, true, true, true, false],
    );
    assert.equal(inSourceRef({ session: 't', seq: 3 }, ref), false);
  });
});

describe('checkSourceRef、checkEvidence', () => {
  test('合法的区间通过', () => {
    assert.doesNotThrow(() => checkSourceRef({ session: 's', from: 1, upTo: 1 }));
    assert.doesNotThrow(() =>
      checkEvidence([
        { session: 's', from: 1, upTo: 3 },
        { session: 't', from: 2, upTo: 9 },
      ]),
    );
  });

  test('空证据、from > upTo、seq 不是正整数、会话名为空都抛 invalid_request', () => {
    assert.throws(() => checkEvidence([]), isInvalid);
    for (const ref of [
      { session: 's', from: 3, upTo: 2 },
      { session: 's', from: 0, upTo: 2 },
      { session: 's', from: 1.5, upTo: 2 },
      { session: 's', from: 1, upTo: Number.NaN },
      { session: '', from: 1, upTo: 1 },
    ]) {
      assert.throws(() => checkSourceRef(ref), isInvalid, JSON.stringify(ref));
      assert.throws(() => checkEvidence([{ session: 's', from: 1, upTo: 1 }, ref]), isInvalid);
    }
  });
});

describe('filterFacts、isOpenFact', () => {
  const facts = [
    fact('b', { topic: 'work' }),
    fact('a', { subject: 'project:x', topic: 'work' }),
    fact('c', { validTo: NOW }),
    fact('😀'),
    fact('Ａ', { archivedAt: NOW }),
    fact('aa', { topic: 'user' }),
  ];

  test('open 是没有 validTo 且没归档', () => {
    assert.deepEqual(facts.map(isOpenFact), [true, true, false, true, false, true]);
  });

  const scope = (query: Parameters<typeof inSearchScope>[1]): string[] =>
    facts.filter((found) => inSearchScope(found, query)).map((found) => found.id);

  test('inSearchScope：缺省只看 open 的；archived 连归档的一起看，关闭的不看；open: false 不限；topic 按字面', () => {
    assert.deepEqual(scope({}), ['b', 'a', '😀', 'aa']);
    assert.deepEqual(scope({ open: true }), ['b', 'a', '😀', 'aa']);
    assert.deepEqual(scope({ archived: true }), ['b', 'a', '😀', 'Ａ', 'aa']);
    assert.deepEqual(scope({ open: false }), ['b', 'a', 'c', '😀', 'Ａ', 'aa']);
    assert.deepEqual(scope({ open: false, archived: false }), ['b', 'a', 'c', '😀', 'Ａ', 'aa']);
    assert.deepEqual(scope({ topic: 'work' }), ['b', 'a']);
    assert.deepEqual(scope({ topic: 'work', open: false }), ['b', 'a']);
    const both = fact('x', { validTo: NOW, archivedAt: NOW });
    assert.equal(inSearchScope(both, { archived: true }), false, '关闭的归档了也不看');
    assert.equal(inSearchScope(both, { open: false }), true);
  });

  const ids = (query?: Parameters<typeof filterFacts>[1]): string[] => filterFacts(facts, query).map((f) => f.id);

  test('按 id 码点序；subject、topic、open 筛选；open: false 不限', () => {
    assert.deepEqual(ids(), ['a', 'aa', 'b', 'c', 'Ａ', '😀']);
    assert.deepEqual(ids({ subject: 'user' }), ['aa', 'b', 'c', 'Ａ', '😀']);
    assert.deepEqual(ids({ topic: 'work' }), ['a', 'b']);
    assert.deepEqual(ids({ open: true }), ['a', 'aa', 'b', '😀']);
    assert.deepEqual(ids({ open: false }), ids());
  });

  test('after、limit 翻页不重不漏，limit 的取整和 SessionsOptions 一样', () => {
    const pages: string[][] = [];
    for (let after: string | undefined; ;) {
      const page = filterFacts(facts, { limit: 4, ...(after !== undefined ? { after } : {}) }).map((f) => f.id);
      if (page.length === 0) break;
      pages.push(page);
      after = page.at(-1)!;
    }
    assert.deepEqual(pages, [
      ['a', 'aa', 'b', 'c'],
      ['Ａ', '😀'],
    ]);
    assert.deepEqual(
      filterFacts(facts, { after: 'ab' }).map((f) => f.id),
      ['b', 'c', 'Ａ', '😀'],
      'after 不必存在',
    );
    assert.equal(filterFacts(facts, { limit: 2.9 }).length, 2);
    assert.deepEqual(filterFacts(facts, { limit: 0 }), []);
    assert.deepEqual(filterFacts(facts, { limit: Number.NaN }), []);
  });
});

describe('sameSourceRef', () => {
  test('会话和两端都相同才是同一段', () => {
    const ref = { session: 's', from: 1, upTo: 3 };
    assert.equal(sameSourceRef(ref, { ...ref }), true);
    assert.equal(sameSourceRef(ref, { ...ref, upTo: 4 }), false);
    assert.equal(sameSourceRef(ref, { ...ref, session: 't' }), false);
  });
});

// ---- 契约测试的夹具：只在这里，不导出。正式的内存实现在 ctx-memory。 ----

function countOf(n: number | undefined): number {
  if (n === undefined) return Infinity;
  return n > 0 ? Math.floor(n) : 0;
}

function notFound(id: string): CtxError {
  return new CtxError('not_found', `No memory item "${id}".`);
}

function appendRefs(existing: readonly SourceRef[], refs: readonly SourceRef[]): SourceRef[] {
  const out = [...existing];
  for (const ref of refs) if (!out.some((other) => sameSourceRef(other, ref))) out.push(ref);
  return out;
}

function isPendingNote(note: Note): boolean {
  return note.settledAt === undefined && note.failedAt === undefined;
}

function fakeMemoryStore(): MemoryStore {
  const scopes = new Map<string, MemoryStore>();
  const counter = { next: 0 };
  const scopeOf = (name: string): MemoryStore => {
    checkMemoryScope(name);
    let store = scopes.get(name);
    if (!store) {
      store = fakeScope(scopeOf, counter);
      scopes.set(name, store);
    }
    return store;
  };
  return scopeOf(DEFAULT_MEMORY_SCOPE);
}

function fakeScope(scopeOf: (name: string) => MemoryStore, counter: { next: number }): MemoryStore {
  const notes: Note[] = [];
  const facts = new Map<string, MemoryFact>();
  const procedures: Procedure[] = [];
  const versions: CoreVersion[] = [];
  const newId = (prefix: string): string => `${prefix}${(counter.next += 1)}`;
  const factOf = (id: string): MemoryFact => {
    const found = facts.get(id);
    if (!found) throw notFound(id);
    return found;
  };
  const procedureIndex = (id: string): number => {
    const index = procedures.findIndex((procedure) => procedure.id === id);
    if (index < 0) throw notFound(id);
    return index;
  };
  const keyed = (key: string | undefined): MemoryFact | undefined =>
    key === undefined ? undefined : [...facts.values()].find((found) => found.key === key);
  const write = (draft: NewMemoryFact): MemoryFact => {
    const written: MemoryFact = { ...draft, at: draft.at ?? draft.validFrom, id: newId('f'), recalls: [] };
    facts.set(written.id, written);
    return written;
  };

  return {
    scope: scopeOf,
    notes: {
      async add(drafts) {
        for (const draft of drafts) checkSourceRef(draft);
        return drafts.map((draft) => {
          const same = notes.find(
            (note) => note.session === draft.session && note.from === draft.from && note.upTo === draft.upTo,
          );
          if (same) return same;
          const written = { ...draft, id: newId('n') };
          notes.push(written);
          return written;
        });
      },
      async list(query) {
        return notes
          .filter(
            (note) =>
              (query?.session === undefined || note.session === query.session) &&
              (query?.pending === undefined || (query.pending ? isPendingNote(note) : note.settledAt !== undefined)) &&
              (query?.failed === undefined || (note.failedAt !== undefined) === query.failed) &&
              (query?.since === undefined || note.at >= query.since),
          )
          .slice(0, countOf(query?.limit));
      },
      async settle(ids, at) {
        let count = 0;
        for (const [i, note] of notes.entries()) {
          if (!ids.includes(note.id) || !isPendingNote(note)) continue;
          notes[i] = { ...note, settledAt: at };
          count += 1;
        }
        return count;
      },
      async fail(ids, at, options) {
        const out: Note[] = [];
        for (const [i, note] of notes.entries()) {
          if (!ids.includes(note.id) || !isPendingNote(note)) continue;
          const attempts = (note.attempts ?? 0) + 1;
          notes[i] = {
            ...note,
            attempts,
            error: options.error,
            ...(attempts >= options.maxAttempts ? { failedAt: at } : {}),
          };
          out.push(notes[i]);
        }
        return out;
      },
      async retry(ids) {
        let count = 0;
        for (const [i, note] of notes.entries()) {
          if (!ids.includes(note.id) || note.failedAt === undefined) continue;
          const { failedAt: _f, attempts: _a, error: _e, ...rest } = note;
          notes[i] = rest;
          count += 1;
        }
        return count;
      },
      async forget(session) {
        const kept = notes.filter((note) => session !== undefined && note.session !== session);
        const count = notes.length - kept.length;
        notes.splice(0, notes.length, ...kept);
        return count;
      },
      async head(session) {
        return Math.max(0, ...notes.filter((note) => note.session === session).map((note) => note.upTo));
      },
    },
    facts: {
      async add(draft) {
        checkEvidence(draft.sources);
        return keyed(draft.key) ?? write(draft);
      },
      async supersede(id, draft, at) {
        checkEvidence(draft.sources);
        const found = factOf(id);
        const existing = keyed(draft.key);
        if (existing) return existing;
        const written = write(draft);
        if (found.validTo === undefined) facts.set(id, { ...found, validTo: at, supersededBy: written.id });
        return written;
      },
      async reopen(ids) {
        let count = 0;
        for (const id of new Set(ids)) {
          const found = facts.get(id);
          if (!found || found.validTo === undefined) continue;
          const { validTo: _to, supersededBy: _by, ...rest } = found;
          facts.set(id, rest);
          count += 1;
        }
        return count;
      },
      async close(id, at, options) {
        const found = factOf(id);
        if (options?.supersededBy !== undefined) factOf(options.supersededBy);
        if (found.validTo !== undefined) return;
        facts.set(id, {
          ...found,
          validTo: at,
          ...(options?.supersededBy !== undefined ? { supersededBy: options.supersededBy } : {}),
        });
      },
      async cite(id, sources) {
        checkEvidence(sources);
        const found = factOf(id);
        const updated = { ...found, sources: appendRefs(found.sources, sources) };
        facts.set(id, updated);
        return updated;
      },
      async touch(ids, at) {
        for (const id of ids) {
          const found = facts.get(id);
          if (found) facts.set(id, { ...found, recalls: [...found.recalls, at].slice(-MAX_FACT_RECALLS) });
        }
      },
      async archive(ids, at) {
        let count = 0;
        for (const id of new Set(ids)) {
          const found = facts.get(id);
          if (!found || found.archivedAt !== undefined) continue;
          facts.set(id, { ...found, archivedAt: at });
          count += 1;
        }
        return count;
      },
      async restore(ids) {
        let count = 0;
        for (const id of new Set(ids)) {
          const found = facts.get(id);
          if (!found || found.archivedAt === undefined) continue;
          const { archivedAt: _gone, ...rest } = found;
          facts.set(id, rest);
          count += 1;
        }
        return count;
      },
      async forget(ids) {
        let count = 0;
        for (const id of new Set(ids)) if (facts.delete(id)) count += 1;
        for (const [id, found] of facts) {
          if (found.supersededBy === undefined || facts.has(found.supersededBy)) continue;
          const { supersededBy: _gone, ...rest } = found;
          facts.set(id, rest);
        }
        return count;
      },
      async list(query) {
        return filterFacts([...facts.values()], query);
      },
      async search(query) {
        const wanted = searchTerms(query.text, MAX_SEARCH_TERMS);
        return [...facts.values()]
          .filter((found) => inSearchScope(found, query))
          .map((found) => {
            const own = new Set(searchTerms(found.text));
            return {
              fact: found,
              score: termOverlap(wanted.filter((term) => own.has(term)).length, wanted.length, own.size),
            };
          })
          .filter((hit) => hit.score > 0)
          .toSorted((a, b) => b.score - a.score)
          .slice(0, countOf(query.k ?? 10));
      },
    },
    procedures: {
      async add(draft) {
        checkEvidence(draft.evidence);
        const written: Procedure = { ...draft, id: newId('p'), confirmations: 1 };
        procedures.push(written);
        return written;
      },
      async confirm(id, evidence) {
        checkEvidence(evidence);
        const index = procedureIndex(id);
        const found = procedures[index]!;
        const merged = appendRefs(found.evidence, evidence);
        if (merged.length === found.evidence.length) return found;
        const updated = { ...found, evidence: merged, confirmations: found.confirmations + 1 };
        procedures[index] = updated;
        return updated;
      },
      async retire(id, at) {
        const index = procedureIndex(id);
        const found = procedures[index]!;
        if (found.retiredAt === undefined) procedures[index] = { ...found, retiredAt: at };
      },
      async forget(ids) {
        const kept = procedures.filter((procedure) => !ids.includes(procedure.id));
        const count = procedures.length - kept.length;
        procedures.splice(0, procedures.length, ...kept);
        return count;
      },
      async list(query) {
        return procedures.filter(
          (procedure) =>
            (query?.topic === undefined || procedure.topic === query.topic) &&
            (query?.active !== true || procedure.retiredAt === undefined),
        );
      },
    },
    core: {
      async get() {
        return versions.at(-1) ?? null;
      },
      async set(text, at) {
        versions.push({ text, at });
      },
      async history(options) {
        if (options?.last === undefined) return [...versions];
        const last = countOf(options.last);
        return last > 0 ? versions.slice(-last) : [];
      },
      async clear() {
        return versions.splice(0).length;
      },
    },
  };
}

function render(entries: readonly Entry[]): string {
  return entries
    .map((entry) => (entry.type === 'message' ? `${entry.message.role}：${textOf(entry.message)}` : ''))
    .join('\n');
}

async function readSource(sessions: SessionStore, ref: SourceRef): Promise<Entry[]> {
  const entries = await sessions.list(ref.session, { after: ref.from - 1 });
  return entries.filter((entry) => inSourceRef(entry, ref));
}

/** 最小的 Memory：够跑契约测试，不是参考实现。 */
function fakeMemory(options: {
  store: MemoryStore;
  sessions: SessionStore;
  decision: DecisionModel;
  extraction: ExtractionModel;
  now: () => number;
}): Memory {
  const { store, sessions, decision, extraction, now } = options;
  const theta = 0.5;
  const name = 'memory';

  /** `auto`：来源自动带出的召回，同一条事实一天只记一次 `touch`。 */
  async function recallWith(
    query: string,
    recallOptions: Parameters<Memory['recall']>[1],
    auto: boolean,
  ): Promise<Recalled> {
    const base = {
      text: query,
      k: recallOptions?.k ?? 5,
      ...(recallOptions?.topic !== undefined ? { topic: recallOptions.topic } : {}),
    };
    const minConfidence = recallOptions?.minConfidence ?? 0.5;
    const hits = [
      ...(await store.facts.search(base)),
      // 归档的也找，分数打对折。
      ...(await store.facts.search({ ...base, archived: true }))
        .filter((hit) => hit.fact.archivedAt !== undefined)
        .map((hit) => ({ fact: hit.fact, score: hit.score * 0.5 })),
    ].filter((hit) => hit.fact.confidence >= minConfidence);
    const at = now();
    const ranked = rankFacts(
      hits.map((hit) => hit.fact),
      Object.fromEntries(hits.map((hit) => [hit.fact.id, hit.score])),
      { now: at },
    ).slice(0, base.k);
    await store.facts.restore(ranked.filter((found) => found.archivedAt !== undefined).map((found) => found.id));
    await store.facts.touch(
      ranked
        .filter((found) => !auto || found.recalls.every((recalledAt) => Math.abs(at - recalledAt) >= DAY))
        .map((found) => found.id),
      at,
    );
    const facts = ranked.map(({ archivedAt: _restored, ...found }) => found);
    const procedures =
      recallOptions?.topic === undefined
        ? []
        : await store.procedures.list({ topic: recallOptions.topic, active: true });
    const recalled: Recalled = { facts, procedures };
    if (!recallOptions?.evidence) return recalled;
    const evidence: Entry[] = [];
    for (const found of facts) for (const ref of found.sources) evidence.push(...(await readSource(sessions, ref)));
    return { ...recalled, evidence };
  }

  const memory: Memory = {
    name,
    async gate(session, gateOptions) {
      const head = await store.notes.head(session);
      const entries = await sessions.list(session, { after: head, types: ['message'] });
      if (entries.length === 0) return [];
      const answers = await decision.decide({
        state: render(entries),
        questions: {
          keep: { type: 'noul', instructions: '值得长期记住吗？' },
          kind: { type: 'choice', instructions: '哪一类？', criteria: { pref: '偏好', obs: '事实' } },
          salience: { type: 'score', instructions: '多重要？', criteria: ['无关', '有用', '必须记住'] },
        },
        ...(gateOptions?.signal ? { signal: gateOptions.signal } : {}),
      });
      const keep = answers['keep']?.type === 'noul' ? answers['keep'].noul : 0;
      const score = answers['salience']?.type === 'score' ? answers['salience'].score : 0;
      const kind = answers['kind']?.type === 'choice' ? answers['kind'].choice : 'obs';
      const salience = 0.6 * keep + 0.4 * score;
      const at = now();
      return store.notes.add([
        { ...sourceRef(session, entries), at, salience, kind, ...(salience < theta ? { settledAt: at } : {}) },
      ]);
    },

    async recall(query, recallOptions) {
      return recallWith(query, recallOptions, false);
    },
    async consolidate(consolidateOptions) {
      const at = consolidateOptions?.now ?? now();
      const report = { added: 0, merged: 0, superseded: 0, archived: 0 };
      const pending = await store.notes.list({ pending: true });
      for (const note of pending) {
        const entries = await readSource(sessions, note);
        const extracted = await extraction.extract({ state: render(entries), fields: { fact: { type: 'text' } } });
        const text = extracted['fact'];
        if (text && typeof text.value === 'string' && text.pNull <= 0.3) {
          const sources = [sourceRef(note.session, entries)];
          const [existing] = await store.facts.list({ open: true });
          let relation = 'new';
          if (existing) {
            const answer = (
              await decision.decide({
                state: { old: existing.text, new: text.value },
                questions: {
                  relation: {
                    type: 'choice',
                    instructions: '新旧事实的关系？',
                    criteria: { new: '无关', merge: '同一件事', supersede: '新的取代旧的' },
                  },
                },
              })
            )['relation'];
            if (answer?.type === 'choice') relation = answer.choice;
          }
          if (existing && relation === 'merge') {
            await store.facts.cite(existing.id, sources);
            report.merged += 1;
          } else {
            const added = await store.facts.add({
              subject: 'user',
              text: text.value,
              at,
              validFrom: entries[0]?.at ?? at,
              confidence: text.confidence,
              salience: note.salience,
              sources,
            });
            report.added += 1;
            if (existing && relation === 'supersede') {
              await store.facts.close(existing.id, at, { supersededBy: added.id });
              report.superseded += 1;
            }
          }
        }
        await store.notes.settle([note.id], at);
      }
      const open = await store.facts.list({ open: true });
      report.archived = await store.facts.archive(
        open.filter((found) => activation(found, at) < ACTIVATION_DEFAULTS.archiveAt).map((found) => found.id),
        at,
      );
      const core = renderCore(await store.facts.list({ open: true }), 2000, { now: at });
      const current = await store.core.get();
      const rewrite = core !== (current?.text ?? '');
      if (rewrite) await store.core.set(core, at);
      const result: ConsolidateReport = {
        notes: pending.length,
        failed: 0,
        dead: 0,
        facts: report,
        procedures: { added: 0, confirmed: 0 },
        escalated: 0,
        core: rewrite,
      };
      return result;
    },

    async forget(request) {
      const facts = new Set(request.facts ?? []);
      const procedures = new Set(request.procedures ?? []);
      const fromSession = (refs: readonly SourceRef[]): boolean =>
        request.all === true || refs.some((ref) => ref.session === request.session);
      if (request.session !== undefined || request.all === true) {
        for (const found of await store.facts.list()) if (fromSession(found.sources)) facts.add(found.id);
        for (const found of await store.procedures.list()) if (fromSession(found.evidence)) procedures.add(found.id);
      }
      const notes =
        request.all === true
          ? await store.notes.forget()
          : request.session !== undefined
            ? await store.notes.forget(request.session)
            : 0;
      const report = {
        notes,
        facts: await store.facts.forget([...facts]),
        procedures: await store.procedures.forget([...procedures]),
        core: await store.core.clear(),
      };
      const core = renderCore(await store.facts.list({ open: true }), 2000, { now: now() });
      if (core) await store.core.set(core, now());
      return report;
    },

    source(sourceOptions) {
      return {
        name: sourceOptions?.name ?? 'memory',
        async collect({ session }) {
          let query = '';
          if (sourceOptions?.query) query = await sourceOptions.query(session);
          else {
            const messages = await sessions.list(session, { types: ['message'] });
            const last = messages.findLast((entry) => entry.type === 'message' && entry.message.role === 'user');
            if (last?.type === 'message') query = textOf(last.message);
          }
          const core = await store.core.get();
          const facts = query ? (await recallWith(query, { k: sourceOptions?.k ?? 5 }, true)).facts : [];
          const lines = [...(core?.text ? [core.text] : []), ...facts.map((found) => found.text)];
          return lines.length > 0 ? lines.join('\n') : null;
        },
      };
    },

    async tools() {
      return [
        {
          name: MEMORY_RECALL_TOOL,
          description: '按文字召回记忆里仍然成立的事实。',
          inputSchema: {
            type: 'object',
            properties: { query: { type: 'string' }, since_days: { type: 'number' } },
            required: ['query'],
          },
          executor: name,
        },
      ];
    },

    async execute(call, context) {
      if (context.signal?.aborted) return errorOutput('Aborted before the tool ran.');
      if (call.name !== MEMORY_RECALL_TOOL) return errorOutput(`Unknown tool "${call.name}". Available: recall.`);
      const query = (call.input as { query?: unknown } | null)?.query;
      if (typeof query !== 'string') return errorOutput('recall needs a "query" string.');
      const recalled = await memory.recall(query, { evidence: true });
      return { type: 'json', value: recalled as unknown as JsonValue };
    },
  };
  return memory;
}

describeMemoryStoreContract('fake', () => fakeMemoryStore(), { describe, test });
describeDecisionModelContract('scripted', () => createScriptedDecisionModel({ noul: 0.7, score: 0.6 }), {
  describe,
  test,
});
describeExtractionModelContract('scripted', () => createScriptedExtractionModel(), { describe, test });
describeMemoryContract(
  'fake',
  (setup) => {
    const store = fakeMemoryStore();
    return { memory: fakeMemory({ ...setup, store }), store };
  },
  { describe, test },
);
