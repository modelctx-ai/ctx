import {
  checkEvidence,
  checkSourceRef,
  CtxError,
  filterFacts,
  isOpenFact,
  sameSourceRef,
  type CoreVersion,
  type FactHit,
  type MemoryFact,
  type MemoryStore,
  type Note,
  type Procedure,
  type SourceRef,
} from '@modelctx-ai/ctx-protocol';

import { cosine, textSimilarity } from './text.ts';

export interface MemoryStoreOptions {
  /**
   * 给 `search` 用的嵌入。给了就是混合检索：相关度取全文分和余弦里大的那个，余弦不低于 `minCosine` 的也算命中。
   * 事实的文字不改，向量按 `id` 缓存。
   */
  readonly embed?: (text: string) => Promise<readonly number[]>;
  /** 只靠向量命中时余弦的下限，缺省 0.3。 */
  readonly minCosine?: number;
}

/** 小数向下取整，不是正数时是 0；不给就是不限。 */
function countOf(n: number | undefined): number {
  if (n === undefined) return Infinity;
  return n > 0 ? Math.floor(n) : 0;
}

function notFound(id: string): CtxError {
  return new CtxError('not_found', `No memory item "${id}".`);
}

function appendRefs(existing: readonly SourceRef[], refs: readonly SourceRef[]): SourceRef[] {
  const out = [...existing];
  for (const ref of refs) if (!out.some((other) => sameSourceRef(other, ref))) out.push({ ...ref });
  return out;
}

/**
 * 进程内的 `MemoryStore`：全部放在内存里，进程退出就没了；测试、单进程和原型用。`id` 是前缀加补零的序号，
 * 所以 `facts.list` 的 `id` 序就是写入顺序。`search` 是全文（子串命中记 1，否则按词重叠打分），给了 `embed` 再加余弦。
 */
export function createMemoryStore(options: MemoryStoreOptions = {}): MemoryStore {
  const notes: Note[] = [];
  const facts = new Map<string, MemoryFact>();
  const procedures: Procedure[] = [];
  const versions: CoreVersion[] = [];
  const vectors = new Map<string, Promise<readonly number[]>>();
  const minCosine = options.minCosine ?? 0.3;
  let next = 0;
  const newId = (prefix: string): string => `${prefix}${String((next += 1)).padStart(8, '0')}`;
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
  const vectorOf = (fact: MemoryFact, embed: (text: string) => Promise<readonly number[]>) => {
    let vector = vectors.get(fact.id);
    if (!vector) {
      vector = embed(fact.text);
      vectors.set(fact.id, vector);
      // 失败的不缓存，下次再算。
      vector.catch(() => vectors.delete(fact.id));
    }
    return vector;
  };

  return {
    notes: {
      async add(drafts) {
        for (const draft of drafts) checkSourceRef(draft);
        const written = drafts.map((draft): Note => ({ ...draft, id: newId('n') }));
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
        const wanted = new Set(ids);
        let count = 0;
        for (const [i, note] of notes.entries()) {
          if (!wanted.has(note.id) || note.settledAt !== undefined) continue;
          notes[i] = { ...note, settledAt: at };
          count += 1;
        }
        return count;
      },
      async head(session) {
        let head = 0;
        for (const note of notes) if (note.session === session) head = Math.max(head, note.upTo);
        return head;
      },
    },
    facts: {
      async add(draft) {
        checkEvidence(draft.sources);
        const written: MemoryFact = {
          ...draft,
          sources: draft.sources.map((ref) => ({ ...ref })),
          id: newId('f'),
          recalls: [],
        };
        facts.set(written.id, written);
        return written;
      },
      async close(id, at, closeOptions) {
        const found = factOf(id);
        if (closeOptions?.supersededBy !== undefined) factOf(closeOptions.supersededBy);
        if (found.validTo !== undefined) return;
        facts.set(id, {
          ...found,
          validTo: at,
          ...(closeOptions?.supersededBy !== undefined ? { supersededBy: closeOptions.supersededBy } : {}),
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
        for (const id of new Set(ids)) {
          if (!facts.delete(id)) continue;
          vectors.delete(id);
          count += 1;
        }
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
        const k = countOf(query.k ?? 10);
        if (k === 0) return [];
        const candidates = filterFacts([...facts.values()]).filter(
          (fact) =>
            (query.topic === undefined || fact.topic === query.topic) && (query.open === false || isOpenFact(fact)),
        );
        const { embed } = options;
        const target = embed && query.text.trim() ? await embed(query.text) : undefined;
        const hits: FactHit[] = [];
        for (const fact of candidates) {
          const text = textSimilarity(query.text, fact.text);
          const vector = target && embed ? cosine(target, await vectorOf(fact, embed)) : 0;
          if (text > 0 || vector >= minCosine) hits.push({ fact, score: Math.max(text, vector) });
        }
        return hits.toSorted((a, b) => b.score - a.score).slice(0, k);
      },
    },
    procedures: {
      async add(draft) {
        checkEvidence(draft.evidence);
        const written: Procedure = {
          ...draft,
          evidence: draft.evidence.map((ref) => ({ ...ref })),
          id: newId('p'),
          confirmations: 1,
        };
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
      async history(historyOptions) {
        if (historyOptions?.last === undefined) return [...versions];
        const last = countOf(historyOptions.last);
        return last > 0 ? versions.slice(-last) : [];
      },
    },
  };
}
