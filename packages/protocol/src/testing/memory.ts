import assert from 'node:assert/strict';

import { eraseEntries, type Erasure } from '../erase.ts';
import {
  checkSourceRef,
  inSourceRef,
  MEMORY_RECALL_TOOL,
  sourceRef,
  type DecisionModel,
  type ExtractionModel,
  type Memory,
  type MemoryFact,
  type MemoryStore,
  type NewMemoryFact,
  type SourceRef,
} from '../memory.ts';
import {
  assistantEntry,
  erasedEntry,
  filterEntries,
  filterSessions,
  userEntry,
  type Entry,
  type SessionStore,
} from '../session.ts';
import { ENTRY_VERSION } from '../version.ts';

import type { ContractTestApi } from './api.ts';
import {
  createScriptedDecisionModel,
  createScriptedExtractionModel,
  type DecisionScript,
  type ExtractionScript,
  type ScriptedDecisionModel,
} from './scripted-models.ts';
import { factById, ids, inUnit, MEMORY_NOW, newFact, roundTrips } from './shared.ts';

/** 契约测试交给 `Memory` 工厂的东西。 */
export interface MemorySetup {
  /** 会话日志：用例往里写，memory 只读它。是契约测试自带的最小内存实现。 */
  readonly sessions: SessionStore;
  /** 剧本式决策模型（`createScriptedDecisionModel`），门控和并入都用它。 */
  readonly decision: DecisionModel;
  /** 剧本式提取模型（`createScriptedExtractionModel`）。 */
  readonly extraction: ExtractionModel;
  /** 时钟：门控的 `at`、召回的 `touch` 都用它。 */
  readonly now: () => number;
}

export interface MemoryFixture {
  readonly memory: Memory;
  /** memory 用的存储，开始时是空的；用例直接读写它。 */
  readonly store: MemoryStore;
}

/**
 * 每个用例调一次。memory 要读 `setup.sessions`、用 `setup.decision` 和 `setup.extraction`、按 `setup.now` 取时刻；
 * 门控阈值要固定（0.1..0.9 之间：剧本里该记的打 0.95 分左右，不该记的 0.02 左右），`LanguageModel` 可以不给。
 * 用例开始时调 `provision`（有的话），结束时调 `dispose`（有的话）。
 */
export type MemoryFactory = (setup: MemorySetup) => MemoryFixture | Promise<MemoryFixture>;

interface MemoryScript {
  readonly decision?: DecisionScript;
  readonly extraction?: ExtractionScript;
}

interface MemoryCase extends MemoryFixture {
  readonly sessions: SessionStore;
  readonly decision: ScriptedDecisionModel;
  readonly now: number;
}

/** 契约测试自带的会话日志：只够这些用例（不去重、不检查 expectSeq、没有 watch）。 */
function contractSessionStore(now: () => number): SessionStore {
  const logs = new Map<string, Entry[]>();
  let seq = 0;
  let id = 0;
  const erase = (session: string, erasure: Erasure): number => {
    const { entries, erased } = eraseEntries(logs.get(session) ?? [], erasure);
    if (!erased) return 0;
    const record = {
      ...erasedEntry(erased),
      id: `e${(id += 1)}`,
      session,
      seq: (seq += 1),
      at: now(),
      v: ENTRY_VERSION,
    };
    logs.set(session, [...entries, record]);
    return erased.count;
  };
  return {
    async append(session, drafts) {
      const written = drafts.map((draft) => ({
        ...draft,
        id: draft.id ?? `e${(id += 1)}`,
        session,
        seq: (seq += 1),
        at: draft.at ?? now(),
        v: ENTRY_VERSION,
      }));
      logs.set(session, [...(logs.get(session) ?? []), ...written]);
      return written;
    },
    async list(session, options) {
      return filterEntries(logs.get(session) ?? [], options);
    },
    async clear(session) {
      const count = logs.get(session)?.length ?? 0;
      logs.delete(session);
      return count;
    },
    truncate: async (session, upTo) => erase(session, { op: 'truncate', upTo }),
    remove: async (session, entryIds) => erase(session, { op: 'remove', ids: entryIds }),
    redact: async (session, entryIds) => erase(session, { op: 'redact', ids: entryIds }),
    async sessions(options) {
      return filterSessions([...logs.keys()], options);
    },
  };
}

async function withMemory(
  factory: MemoryFactory,
  script: MemoryScript,
  fn: (fixture: MemoryCase) => Promise<void>,
): Promise<void> {
  const now = MEMORY_NOW;
  const sessions = contractSessionStore(() => now);
  const decision = createScriptedDecisionModel(script.decision);
  const extraction = createScriptedExtractionModel(script.extraction);
  const fixture = await factory({ sessions, decision, extraction, now: () => now });
  try {
    await fixture.memory.provision?.();
    await fn({ ...fixture, sessions, decision, now });
  } finally {
    await fixture.memory.dispose?.();
  }
}

/** 该记：`keep` 和 `score` 都打满。 */
const KEEP: DecisionScript = { noul: 0.95, score: 1 };

/** 不该记。 */
const SKIP: DecisionScript = { noul: 0.02, score: 0 };

const EXTRACTED = '主人的项目改用 PostgreSQL';

/** 文字字段都提取出同一句话，日期、数字都当没找到（`validFrom` 回到这段的第一条 `at`）。 */
const EXTRACT: ExtractionScript = {
  byType: { text: EXTRACTED, list: [EXTRACTED], number: null, date: null, datetime: null, duration: null },
};

/** 每段证据都合法，并且日志里真有这一段。 */
async function assertEvidence(sessions: SessionStore, refs: readonly SourceRef[], label: string): Promise<void> {
  assert.ok(refs.length > 0, `${label}：证据不能为空`);
  for (const source of refs) {
    assert.doesNotThrow(() => checkSourceRef(source), `${label}：证据区间 ${JSON.stringify(source)}`);
    const entries = await sessions.list(source.session);
    assert.ok(
      entries.some((entry) => inSourceRef(entry, source)),
      `${label}：证据 ${JSON.stringify(source)} 在日志里找不到`,
    );
  }
}

async function seedFact(
  { sessions, store, now }: MemoryCase,
  text: string,
  extra: Partial<NewMemoryFact> = {},
): Promise<MemoryFact> {
  const written = await sessions.append('s', [userEntry(text)]);
  return store.facts.add(newFact(text, { validFrom: now, sources: [sourceRef('s', written)], ...extra }));
}

function checkReport(report: Awaited<ReturnType<Memory['consolidate']>>): void {
  const counts = [
    report.notes,
    report.facts.added,
    report.facts.merged,
    report.facts.superseded,
    report.facts.archived,
    report.procedures.added,
    report.procedures.confirmed,
    report.escalated,
  ];
  assert.ok(
    counts.every((count) => Number.isInteger(count) && count >= 0),
    `报告的计数是非负整数：${JSON.stringify(report)}`,
  );
  assert.equal(typeof report.core, 'boolean');
  assert.ok(roundTrips(report), '报告能 JSON 往返');
}

export function describeMemoryContract(
  name: string,
  factory: MemoryFactory,
  { describe, test }: ContractTestApi,
): void {
  describe(`Memory contract: ${name}`, () => {
    test('gate：笔记指向新条目的 seq 区间，不改日志；同一段不重复打分，下一次从 head 之后读', async () => {
      await withMemory(factory, { decision: KEEP }, async ({ memory, store, sessions, decision }) => {
        const first = await sessions.append('s', [
          userEntry('以后回答都用中文，记住'),
          assistantEntry('好的，以后都用中文'),
        ]);
        const log = await sessions.list('s');
        const notes = await memory.gate('s');
        assert.deepEqual(await sessions.list('s'), log, 'gate 不改日志');
        assert.ok(decision.requests.length > 0, '给了决策模型就用它打分');
        assert.ok(notes.length > 0, '该记的写了笔记');
        for (const note of notes) {
          assert.equal(note.session, 's');
          assert.ok(
            note.from <= note.upTo && note.from >= first[0]!.seq && note.upTo <= first[1]!.seq,
            JSON.stringify(note),
          );
          assert.equal(note.settledAt, undefined, '该记的是待处理');
          assert.ok(inUnit(note.salience));
        }
        assert.equal(Math.min(...notes.map((note) => note.from)), first[0]!.seq, '从第一条新条目开始');
        assert.equal(Math.max(...notes.map((note) => note.upTo)), first[1]!.seq, '到最后一条新条目');
        assert.deepEqual(ids(await store.notes.list({ session: 's' })), ids(notes), '返回的就是写进存储的');
        assert.ok(roundTrips(notes));
        assert.equal(await store.notes.head('s'), first[1]!.seq);
        assert.deepEqual(await memory.gate('s'), [], '没有新条目时什么都不写');
        assert.equal((await store.notes.list()).length, notes.length);

        const second = await sessions.append('s', [userEntry('我换到台北住了'), assistantEntry('记下了')]);
        const more = await memory.gate('s');
        assert.ok(more.length > 0);
        assert.equal(Math.min(...more.map((note) => note.from)), second[0]!.seq, '只读 head 之后的');
        assert.equal(await store.notes.head('s'), second[1]!.seq);
      });
    });

    test('gate：没过阈值的那段也记下（已处理），head 照样前进，不留待处理的笔记', async () => {
      await withMemory(factory, { decision: SKIP }, async ({ memory, store, sessions }) => {
        const written = await sessions.append('s', [userEntry('嗯'), assistantEntry('嗯嗯')]);
        const notes = await memory.gate('s');
        assert.ok(
          notes.every((note) => note.settledAt !== undefined),
          '没过阈值的笔记是处理过的',
        );
        assert.deepEqual(await store.notes.list({ pending: true }), []);
        assert.equal(await store.notes.head('s'), written[1]!.seq, 'head 前进到读过的最后一条');
        assert.deepEqual(await memory.gate('s'), [], '同一段不再打分');
      });
    });

    test('gate：空会话返回空，什么都不写', async () => {
      await withMemory(factory, { decision: KEEP }, async ({ memory, store }) => {
        assert.deepEqual(await memory.gate('empty'), []);
        assert.deepEqual(await store.notes.list(), []);
        assert.equal(await store.notes.head('empty'), 0);
      });
    });

    test('consolidate：处理待处理的笔记；写下的事实和程序都有指回日志的证据；不改日志', async () => {
      await withMemory(factory, { decision: KEEP, extraction: EXTRACT }, async ({ memory, store, sessions, now }) => {
        await sessions.append('s', [userEntry('项目的数据库换成 PostgreSQL 了，记住'), assistantEntry('记下了')]);
        await memory.gate('s');
        const pending = await store.notes.list({ pending: true });
        assert.ok(pending.length > 0);
        const log = await sessions.list('s');
        const report = await memory.consolidate({ now });
        checkReport(report);
        assert.deepEqual(await sessions.list('s'), log, 'consolidate 不改日志');
        assert.equal(report.notes, pending.length, '处理了全部待处理的笔记');
        assert.deepEqual(await store.notes.list({ pending: true }), []);
        const facts = await store.facts.list();
        assert.ok(facts.length > 0 && report.facts.added > 0, '提取出的事实写进去了');
        for (const fact of facts) await assertEvidence(sessions, fact.sources, `事实 ${fact.text}`);
        for (const procedure of await store.procedures.list())
          await assertEvidence(sessions, procedure.evidence, `程序 ${procedure.when}`);
      });
    });

    test('consolidate：写下的事实记着写入的时刻（这次的 now），不是原文的时刻', async () => {
      await withMemory(factory, { decision: KEEP, extraction: EXTRACT }, async ({ memory, store, sessions, now }) => {
        await sessions.append('s', [userEntry('项目的数据库换成 PostgreSQL 了，记住'), assistantEntry('记下了')]);
        await memory.gate('s');
        // 十天后才整理：事实十天前就成立了，可它是现在才记下的。
        const later = now + 10 * 86_400_000;
        checkReport(await memory.consolidate({ now: later }));
        const facts = await store.facts.list();
        assert.ok(facts.length > 0, '提取出的事实写进去了');
        for (const fact of facts) {
          assert.equal(fact.at, later, `事实 ${fact.text} 的 at 是整理的时刻`);
          assert.ok(fact.validFrom <= fact.at, `事实 ${fact.text} 在记下之前就成立了`);
        }
      });
    });

    test('consolidate 幂等：再跑一次不再处理笔记，事实和程序都不变', async () => {
      await withMemory(factory, { decision: KEEP, extraction: EXTRACT }, async ({ memory, store, sessions, now }) => {
        await sessions.append('s', [userEntry('项目的数据库换成 PostgreSQL 了，记住'), assistantEntry('记下了')]);
        await memory.gate('s');
        await memory.consolidate({ now });
        const facts = await store.facts.list();
        const procedures = await store.procedures.list();
        const again = await memory.consolidate({ now });
        checkReport(again);
        assert.equal(again.notes, 0);
        assert.deepEqual(
          [
            again.facts.added,
            again.facts.merged,
            again.facts.superseded,
            again.procedures.added,
            again.procedures.confirmed,
          ],
          [0, 0, 0, 0, 0],
        );
        assert.deepEqual(await store.facts.list(), facts);
        assert.deepEqual(await store.procedures.list(), procedures);
      });
    });

    test('consolidate：取代不覆盖，旧事实的文字和证据不变，关闭了就指向一条存在的事实', async () => {
      const script = { decision: { ...KEEP, prefer: ['supersede'] }, extraction: EXTRACT };
      await withMemory(factory, script, async (fixture) => {
        const { memory, store, sessions, now } = fixture;
        const old = await seedFact(fixture, '主人的项目用 MySQL', { topic: 'work' });
        await sessions.append('s', [userEntry('项目从 MySQL 换成 PostgreSQL 了，记住'), assistantEntry('记下了')]);
        await memory.gate('s');
        checkReport(await memory.consolidate({ now }));
        const facts = await store.facts.list();
        const kept = facts.find((fact) => fact.id === old.id);
        assert.ok(kept, '旧事实还在：取代是 close + add，不删');
        const { validTo, supersededBy, recalls, archivedAt, ...rest } = kept;
        const { recalls: oldRecalls, ...oldRest } = old;
        assert.deepEqual(rest, oldRest, '文字、主语、证据、validFrom 都没改');
        assert.ok(recalls.length >= oldRecalls.length && validTo !== null && archivedAt !== null);
        for (const fact of facts) {
          await assertEvidence(sessions, fact.sources, `事实 ${fact.text}`);
          if (fact.supersededBy === undefined) continue;
          assert.notEqual(fact.validTo, undefined, '被取代的事实是关闭的');
          assert.ok(
            facts.some((other) => other.id === fact.supersededBy),
            `supersededBy ${fact.supersededBy} 指向一条存在的事实`,
          );
        }
        if (supersededBy !== undefined) assert.ok(facts.length >= 2);
      });
    });

    test('recall：按文字找回仍然成立的事实，每条的 recalls 多一个（时刻取 now）；不改日志；evidence 只在要时带', async () => {
      await withMemory(factory, {}, async (fixture) => {
        const { memory, store, sessions, now } = fixture;
        const pg = await seedFact(fixture, '主人的项目用 PostgreSQL 存数据', { topic: 'work' });
        const closed = await seedFact(fixture, '主人以前的项目用 PostgreSQL 9', { topic: 'work' });
        await store.facts.close(closed.id, now);
        const log = await sessions.list('s');
        const recalled = await memory.recall('PostgreSQL');
        assert.deepEqual(await sessions.list('s'), log, 'recall 不改日志');
        assert.ok(ids(recalled.facts).includes(pg.id), '找回了仍然成立的事实');
        assert.ok(!ids(recalled.facts).includes(closed.id), '关闭的不召回');
        assert.equal(recalled.evidence, undefined, '没要证据就不带');
        assert.ok(roundTrips(recalled));
        assert.deepEqual((await factById(store, pg.id))?.recalls, [now], '记了一次 touch');
        assert.deepEqual((await factById(store, closed.id))?.recalls, [], '没召回的不 touch');

        const withEvidence = await memory.recall('PostgreSQL', { evidence: true });
        assert.equal((await factById(store, pg.id))?.recalls.length, 2, '每次召回多一个');
        const evidence = withEvidence.evidence ?? [];
        assert.ok(
          evidence.some((entry) => pg.sources.some((source) => inSourceRef(entry, source))),
          '证据里有这条事实指向的原文',
        );
        assert.ok(roundTrips(withEvidence));
      });
    });

    test('recall：归档的事实也找得回来，被召回的恢复成没归档的', async () => {
      await withMemory(factory, {}, async (fixture) => {
        const { memory, store, now } = fixture;
        const archived = await seedFact(fixture, '主人的项目用 PostgreSQL 存数据');
        assert.equal(await store.facts.archive([archived.id], now), 1);
        const recalled = await memory.recall('PostgreSQL');
        const found = recalled.facts.find((fact) => fact.id === archived.id);
        assert.ok(found, '归档的事实也召回');
        assert.equal(found.archivedAt, undefined, '返回的已经不带 archivedAt');
        assert.ok(roundTrips(recalled));
        const after = await factById(store, archived.id);
        assert.equal(after?.archivedAt, undefined, '被召回就恢复');
        assert.deepEqual(after?.recalls, [now], '恢复的同时记了一次召回');
        assert.deepEqual(ids(await store.facts.list({ open: true })), [archived.id]);
      });
    });

    test('recall：minConfidence 筛掉置信度低的事实，给 0 就不筛', async () => {
      await withMemory(factory, {}, async (fixture) => {
        const { memory, store } = fixture;
        const sure = await seedFact(fixture, '主人的项目用 PostgreSQL 存数据', { confidence: 0.9 });
        const unsure = await seedFact(fixture, '主人的项目好像要换掉 PostgreSQL', { confidence: 0.2 });
        const strict = await memory.recall('PostgreSQL', { minConfidence: 0.5 });
        assert.ok(ids(strict.facts).includes(sure.id));
        assert.ok(!ids(strict.facts).includes(unsure.id), '置信度低于门槛的不召回');
        assert.deepEqual((await factById(store, unsure.id))?.recalls, [], '没召回的不 touch');
        const loose = await memory.recall('PostgreSQL', { minConfidence: 0 });
        assert.ok(ids(loose.facts).includes(sure.id) && ids(loose.facts).includes(unsure.id), '给 0 就不筛');
      });
    });

    test('source：名字缺省 memory；collect 带出 core 和按最近一条用户消息召回的事实；什么都没有时是空', async () => {
      await withMemory(factory, {}, async (fixture) => {
        const { memory, store, sessions, now } = fixture;
        const empty = memory.source();
        assert.equal(empty.name, 'memory');
        const nothing = await empty.collect({ session: 'nobody' });
        assert.ok(!nothing || nothing.trim() === '', `没有记忆时是空：${JSON.stringify(nothing)}`);

        const pg = await seedFact(fixture, '主人的项目用 PostgreSQL 存数据');
        await store.core.set('主人叫小明，住在台北', now);
        await sessions.append('chat', [userEntry('PostgreSQL')]);
        const text = await memory.source().collect({ session: 'chat' });
        assert.equal(typeof text, 'string');
        assert.ok(text!.includes('小明'), `带出 core：${text}`);
        assert.ok(text!.includes(pg.text), `带出召回的事实：${text}`);

        const named = memory.source({ name: 'memory2', query: async () => 'PostgreSQL', k: 1 });
        assert.equal(named.name, 'memory2');
        assert.ok((await named.collect({ session: 'nobody' }))?.includes(pg.text), '用给的 query 召回');
      });
    });

    test('source：同一条事实连着带出几轮，recalls 不跟着涨；主动的 recall 照常记', async () => {
      await withMemory(factory, {}, async (fixture) => {
        const { memory, store, sessions } = fixture;
        const pg = await seedFact(fixture, '主人的项目用 PostgreSQL 存数据');
        await sessions.append('chat', [userEntry('PostgreSQL')]);
        const source = memory.source();
        for (let round = 0; round < 4; round += 1) {
          assert.ok((await source.collect({ session: 'chat' }))?.includes(pg.text), `第 ${round + 1} 轮照样带出`);
        }
        const auto = (await factById(store, pg.id))?.recalls.length ?? 0;
        assert.ok(auto <= 1, `来源每一轮都跑，不能每轮都记一次召回：记了 ${auto} 次`);
        await memory.recall('PostgreSQL');
        assert.equal((await factById(store, pg.id))?.recalls.length, auto + 1, '主动召回记一次');
      });
    });

    test('tools 和 execute：recall 工具绑定到自己、能序列化；结果带事实；不认识的工具、坏输入、已中止都返回 error', async () => {
      await withMemory(factory, {}, async (fixture) => {
        const { memory } = fixture;
        assert.ok(typeof memory.name === 'string' && memory.name.length > 0);
        const tools = await memory.tools();
        const recall = tools.find((tool) => tool.name === MEMORY_RECALL_TOOL);
        assert.ok(recall, `tools() 里没有 ${MEMORY_RECALL_TOOL}`);
        assert.equal(recall.executor, memory.name);
        const properties = recall.inputSchema['properties'] as Record<string, unknown> | undefined;
        assert.ok(properties && 'query' in properties, '输入里有 query');
        assert.ok(roundTrips(tools), 'tools() 能 JSON 往返');

        const pg = await seedFact(fixture, '主人的项目用 PostgreSQL 存数据');
        const context = { session: 's', runId: 'run-memory' };
        const output = await memory.execute(
          { id: 'c1', name: MEMORY_RECALL_TOOL, input: { query: 'PostgreSQL' } },
          context,
        );
        assert.notEqual(output.type, 'error', JSON.stringify(output));
        assert.ok(JSON.stringify(output).includes(pg.text), `结果里有事实：${JSON.stringify(output)}`);
        assert.ok(roundTrips(output));
        const unknown = await memory.execute({ id: 'c2', name: 'no_such_tool_for_contract', input: {} }, context);
        assert.equal(unknown.type, 'error');
        const bad = await memory.execute({ id: 'c3', name: MEMORY_RECALL_TOOL, input: { nope: 1 } }, context);
        assert.equal(bad.type, 'error', '没有 query 是错误');
        const aborted = await memory.execute(
          { id: 'c4', name: MEMORY_RECALL_TOOL, input: { query: 'PostgreSQL' } },
          { ...context, signal: AbortSignal.abort() },
        );
        assert.equal(aborted.type, 'error');
      });
    });
  });
}
