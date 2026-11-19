import {
  checkEvidence,
  checkMemoryScope,
  checkSourceRef,
  DEFAULT_MEMORY_SCOPE,
  CtxError,
  filterFacts,
  inSearchScope,
  MAX_FACT_RECALLS,
  MAX_SEARCH_TERMS,
  sameSourceRef,
  searchTerms,
  termOverlap,
  type CoreVersion,
  type FactHit,
  type MemoryFact,
  type MemoryStore,
  type NewMemoryFact,
  type Note,
  type Procedure,
  type SourceRef,
} from '@modelctx-ai/ctx-protocol';

import { cosine } from './text.ts';

export interface MemoryStoreOptions {
  /**
   * 给 `search` 用的嵌入。给了就是混合检索：相关度取词重叠的分和余弦里大的那个，余弦不低于 `minCosine` 的也算命中。
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

/** 待处理：没处理过，也没进死信。 */
function isPending(note: Note): boolean {
  return note.settledAt === undefined && note.failedAt === undefined;
}

function appendRefs(existing: readonly SourceRef[], refs: readonly SourceRef[]): SourceRef[] {
  const out = [...existing];
  for (const ref of refs) if (!out.some((other) => sameSourceRef(other, ref))) out.push({ ...ref });
  return out;
}

/**
 * 进程内的 `MemoryStore`：全部放在内存里，进程退出就没了；测试、单进程和原型用。`id` 是前缀加补零的序号，
 * 所以 `facts.list` 的 `id` 序就是写入顺序。`search` 按共同的词打分（`searchTerms` 切词、`termOverlap` 打分，
 * 和 SQLite 存储同一套），给了 `embed` 再加余弦。每条事实的词只切一次，按 `id` 记着。
 */
export function createMemoryStore(options: MemoryStoreOptions = {}): MemoryStore {
  return scopeOf({ next: 0, scopes: new Map() }, options, DEFAULT_MEMORY_SCOPE);
}

/** 各作用域共用的东西：`id` 的序号（所以 `id` 在整份存储里不重复）和已经建出来的作用域。 */
interface Shared {
  next: number;
  readonly scopes: Map<string, MemoryStore>;
}

function scopeOf(shared: Shared, options: MemoryStoreOptions, scope: string): MemoryStore {
  checkMemoryScope(scope);
  let store = shared.scopes.get(scope);
  if (!store) {
    store = createScope(shared, options);
    shared.scopes.set(scope, store);
  }
  return store;
}

/** 一个作用域：四个集合各自一份，别的作用域碰不到。 */
function createScope(shared: Shared, options: MemoryStoreOptions): MemoryStore {
  const notes: Note[] = [];
  const facts = new Map<string, MemoryFact>();
  const procedures: Procedure[] = [];
  const versions: CoreVersion[] = [];
  const vectors = new Map<string, Promise<readonly number[]>>();
  /** 事实 `id` → 它的词。事实的文字不改，切一次就够。 */
  const terms = new Map<string, ReadonlySet<string>>();
  const termsOf = (fact: MemoryFact): ReadonlySet<string> => {
    let found = terms.get(fact.id);
    if (!found) {
      found = new Set(searchTerms(fact.text));
      terms.set(fact.id, found);
    }
    return found;
  };
  const minCosine = options.minCosine ?? 0.3;
  const newId = (prefix: string): string => `${prefix}${String((shared.next += 1)).padStart(8, '0')}`;
  const factOf = (id: string): MemoryFact => {
    const found = facts.get(id);
    if (!found) throw notFound(id);
    return found;
  };
  const keyed = (key: string | undefined): MemoryFact | undefined =>
    key === undefined ? undefined : [...facts.values()].find((fact) => fact.key === key);
  const write = (draft: NewMemoryFact): MemoryFact => {
    const written: MemoryFact = {
      ...draft,
      at: draft.at ?? draft.validFrom,
      sources: draft.sources.map((ref) => ({ ...ref })),
      id: newId('f'),
      recalls: [],
    };
    facts.set(written.id, written);
    return written;
  };
  const closeFact = (found: MemoryFact, at: number, supersededBy: string | undefined): void => {
    if (found.validTo !== undefined) return;
    facts.set(found.id, { ...found, validTo: at, ...(supersededBy !== undefined ? { supersededBy } : {}) });
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
    scope: (scope) => scopeOf(shared, options, scope),
    notes: {
      async add(drafts) {
        for (const draft of drafts) checkSourceRef(draft);
        return drafts.map((draft): Note => {
          const same = notes.find(
            (note) => note.session === draft.session && note.from === draft.from && note.upTo === draft.upTo,
          );
          if (same) return same;
          const { attempts: _a, error: _e, failedAt: _f, ...clean } = draft as Note;
          const written: Note = { ...clean, id: newId('n') };
          notes.push(written);
          return written;
        });
      },
      async list(query) {
        return notes
          .filter(
            (note) =>
              (query?.session === undefined || note.session === query.session) &&
              (query?.pending === undefined || (query.pending ? isPending(note) : note.settledAt !== undefined)) &&
              (query?.failed === undefined || (note.failedAt !== undefined) === query.failed) &&
              (query?.since === undefined || note.at >= query.since),
          )
          .slice(0, countOf(query?.limit));
      },
      async settle(ids, at) {
        const wanted = new Set(ids);
        let count = 0;
        for (const [i, note] of notes.entries()) {
          if (!wanted.has(note.id) || !isPending(note)) continue;
          notes[i] = { ...note, settledAt: at };
          count += 1;
        }
        return count;
      },
      async fail(ids, at, failOptions) {
        const wanted = new Set(ids);
        const out: Note[] = [];
        for (const [i, note] of notes.entries()) {
          if (!wanted.has(note.id) || !isPending(note)) continue;
          const attempts = (note.attempts ?? 0) + 1;
          const updated: Note = {
            ...note,
            attempts,
            error: failOptions.error,
            ...(attempts >= failOptions.maxAttempts ? { failedAt: at } : {}),
          };
          notes[i] = updated;
          out.push(updated);
        }
        return out;
      },
      async retry(ids) {
        const wanted = new Set(ids);
        let count = 0;
        for (const [i, note] of notes.entries()) {
          if (!wanted.has(note.id) || note.failedAt === undefined) continue;
          const { failedAt: _f, attempts: _a, error: _e, ...rest } = note;
          notes[i] = rest;
          count += 1;
        }
        return count;
      },
      async forget(session) {
        const before = notes.length;
        const kept = notes.filter((note) => session !== undefined && note.session !== session);
        notes.splice(0, notes.length, ...kept);
        return before - kept.length;
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
        return keyed(draft.key) ?? write(draft);
      },
      async supersede(id, draft, at) {
        checkEvidence(draft.sources);
        const found = factOf(id);
        const existing = keyed(draft.key);
        if (existing) return existing;
        const written = write(draft);
        closeFact(found, at, written.id);
        return written;
      },
      async close(id, at, closeOptions) {
        const found = factOf(id);
        if (closeOptions?.supersededBy !== undefined) factOf(closeOptions.supersededBy);
        closeFact(found, at, closeOptions?.supersededBy);
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
      async forget(ids) {
        let count = 0;
        for (const id of new Set(ids)) {
          if (!facts.delete(id)) continue;
          vectors.delete(id);
          terms.delete(id);
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
        if (typeof query?.text !== 'string') throw new CtxError('invalid_request', 'Search text must be a string.');
        const k = countOf(query.k ?? 10);
        if (k === 0) return [];
        const candidates = filterFacts([...facts.values()]).filter((fact) => inSearchScope(fact, query));
        const wanted = searchTerms(query.text, MAX_SEARCH_TERMS);
        const { embed } = options;
        const target = embed && query.text.trim() ? await embed(query.text) : undefined;
        const hits: (FactHit & { readonly common: number })[] = [];
        for (const fact of candidates) {
          const own = termsOf(fact);
          let common = 0;
          for (const term of wanted) if (own.has(term)) common += 1;
          const text = termOverlap(common, wanted.length, own.size);
          const vector = target && embed ? cosine(target, await vectorOf(fact, embed)) : 0;
          if (text > 0 || vector >= minCosine) hits.push({ fact, score: Math.max(text, vector), common });
        }
        // 分数相同时共同的词多的在前，再相同保持 `id` 序。
        return hits
          .toSorted((a, b) => b.score - a.score || b.common - a.common)
          .slice(0, k)
          .map(({ fact, score }) => ({ fact, score }));
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
      async forget(ids) {
        const wanted = new Set(ids);
        const before = procedures.length;
        const kept = procedures.filter((procedure) => !wanted.has(procedure.id));
        procedures.splice(0, procedures.length, ...kept);
        return before - kept.length;
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
      async clear() {
        return versions.splice(0).length;
      },
    },
  };
}
