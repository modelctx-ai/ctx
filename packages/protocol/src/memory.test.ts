import assert from 'node:assert/strict';

import { describe, test } from 'vite-plus/test';

import {
  ACTIVATION_DEFAULTS,
  MEMORY_RECALL_TOOL,
  activation,
  checkEvidence,
  checkSourceRef,
  filterFacts,
  inSourceRef,
  isOpenFact,
  rankFacts,
  renderCore,
  sameSourceRef,
  sourceRef,
  type ConsolidateReport,
  type CoreVersion,
  type DecisionModel,
  type ExtractionModel,
  type Memory,
  type MemoryFact,
  type MemoryStore,
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

function fact(id: string, extra: Partial<MemoryFact> = {}): MemoryFact {
  return {
    id,
    subject: 'user',
    text: `事实 ${id}`,
    validFrom: NOW,
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
  test('A = ln Σ (Δt + ε)^(−d) + s，Δt 以天计，t 取 validFrom 和每次召回', () => {
    const fresh = activation(fact('a'), NOW);
    assert.ok(Math.abs(fresh - (Math.log(0.02 ** -0.5) + 0.6)) < 1e-12);
    const dayOld = activation(fact('a', { validFrom: NOW - DAY }), NOW);
    assert.ok(Math.abs(dayOld - (Math.log(1.02 ** -0.5) + 0.6)) < 1e-12);
    const recalled = activation(fact('a', { validFrom: NOW - 3 * DAY, recalls: [NOW - DAY / 2] }), NOW);
    assert.ok(Math.abs(recalled - (Math.log(3.02 ** -0.5 + 0.52 ** -0.5) + 0.6)) < 1e-12);
  });

  test('越久越低，召回一次就抬高；显著性是常数偏置', () => {
    const old = fact('a', { validFrom: NOW - 5 * DAY });
    assert.ok(activation(old, NOW) < activation(fact('a', { validFrom: NOW - DAY }), NOW));
    assert.ok(activation({ ...old, recalls: [NOW - DAY] }, NOW) > activation(old, NOW));
    const diff = activation({ ...old, salience: 0.9 }, NOW) - activation({ ...old, salience: 0.1 }, NOW);
    assert.ok(Math.abs(diff - 0.8) < 1e-12);
  });

  test('d、epsilon 可调；晚于 now 的时刻按 Δt = 0 算', () => {
    const f = fact('a', { validFrom: NOW - 2 * DAY });
    assert.ok(Math.abs(activation(f, NOW, { d: 1 }) - (Math.log(1 / 2.02) + 0.6)) < 1e-12);
    assert.ok(Math.abs(activation(f, NOW, { epsilon: 0 }) - (Math.log(2 ** -0.5) + 0.6)) < 1e-12);
    assert.equal(activation(fact('a', { validFrom: NOW + DAY }), NOW), activation(fact('a'), NOW));
  });

  test('缺省参数：s = 0.6、从未召回的事实约一天后低于归档阈值', () => {
    assert.deepEqual(ACTIVATION_DEFAULTS, { d: 0.5, epsilon: 0.02, archiveAt: 0.55 });
    assert.ok(activation(fact('a', { validFrom: NOW - DAY }), NOW) > ACTIVATION_DEFAULTS.archiveAt);
    assert.ok(activation(fact('a', { validFrom: NOW - 1.2 * DAY }), NOW) < ACTIVATION_DEFAULTS.archiveAt);
  });
});

describe('rankFacts', () => {
  test('0.6 × 相似度 + 0.4 × 激活度，从高到低', () => {
    const similar = fact('similar', { validFrom: NOW - 10 * DAY });
    const fresh = fact('fresh');
    assert.deepEqual(
      rankFacts([similar, fresh], { similar: 1, fresh: 0 }, { now: NOW }).map((f) => f.id),
      ['fresh', 'similar'],
      '刚写的事实激活度高（约 2.56），相似度 1 补不回来',
    );
    const a = fact('a', { validFrom: NOW - 2 * DAY });
    const b = fact('b', { validFrom: NOW - 3 * DAY });
    assert.deepEqual(
      rankFacts([b, a], {}, { now: NOW }).map((f) => f.id),
      ['a', 'b'],
      '没有相似度时按激活度',
    );
    assert.deepEqual(
      rankFacts([a, b], { b: 1 }, { now: NOW }).map((f) => f.id),
      ['b', 'a'],
      '相似度差 1 抵得过一天的衰减',
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

function fakeMemoryStore(): MemoryStore {
  const notes: Note[] = [];
  const facts = new Map<string, MemoryFact>();
  const procedures: Procedure[] = [];
  const versions: CoreVersion[] = [];
  let next = 0;
  const newId = (prefix: string): string => `${prefix}${(next += 1)}`;
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

  return {
    notes: {
      async add(drafts) {
        for (const draft of drafts) checkSourceRef(draft);
        const written = drafts.map((draft) => ({ ...draft, id: newId('n') }));
        notes.push(...written);
        return written;
      },
      async list(query) {
        return notes
          .filter(
            (note) =>
              (query?.session === undefined || note.session === query.session) &&
              (query?.pending === undefined || (note.settledAt === undefined) === query.pending),
          )
          .slice(0, countOf(query?.limit));
      },
      async settle(ids, at) {
        let count = 0;
        for (const [i, note] of notes.entries()) {
          if (!ids.includes(note.id) || note.settledAt !== undefined) continue;
          notes[i] = { ...note, settledAt: at };
          count += 1;
        }
        return count;
      },
      async head(session) {
        return Math.max(0, ...notes.filter((note) => note.session === session).map((note) => note.upTo));
      },
    },
    facts: {
      async add(draft) {
        checkEvidence(draft.sources);
        const written: MemoryFact = { ...draft, id: newId('f'), recalls: [] };
        facts.set(written.id, written);
        return written;
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
          if (found) facts.set(id, { ...found, recalls: [...found.recalls, at] });
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
        const hits = [...facts.values()].filter(
          (found) =>
            found.text.includes(query.text) &&
            (query.topic === undefined || found.topic === query.topic) &&
            (query.open === false || isOpenFact(found)),
        );
        return hits.slice(0, countOf(query.k ?? 10)).map((found) => ({ fact: found, score: 1 }));
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
      const hits = await store.facts.search({
        text: query,
        k: recallOptions?.k ?? 5,
        ...(recallOptions?.topic !== undefined ? { topic: recallOptions.topic } : {}),
      });
      const at = now();
      const facts = rankFacts(
        hits.map((hit) => hit.fact),
        Object.fromEntries(hits.map((hit) => [hit.fact.id, hit.score])),
        { now: at },
      );
      await store.facts.touch(
        facts.map((found) => found.id),
        at,
      );
      const procedures =
        recallOptions?.topic === undefined
          ? []
          : await store.procedures.list({ topic: recallOptions.topic, active: true });
      const recalled: Recalled = { facts, procedures };
      if (!recallOptions?.evidence) return recalled;
      const evidence: Entry[] = [];
      for (const found of facts) for (const ref of found.sources) evidence.push(...(await readSource(sessions, ref)));
      return { ...recalled, evidence };
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
        facts: report,
        procedures: { added: 0, confirmed: 0 },
        escalated: 0,
        core: rewrite,
      };
      return result;
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
          const facts = query ? (await memory.recall(query, { k: sourceOptions?.k ?? 5 })).facts : [];
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
