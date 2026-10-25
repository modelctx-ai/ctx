import {
  compareCursor,
  filterEntries,
  type Entry,
  type SessionStore,
  type WatchOptions,
} from '@modelctx-ai/ctx-protocol';

/** @deprecated 改名为 `SessionStore`，下一个 minor 删掉。 */
export type ContextStore = SessionStore;

/** @deprecated 改名为 `Entry`，下一个 minor 删掉。 */
export type ContextEntry = Entry;

export interface MemoryStoreOptions {
  readonly now?: () => number;
  readonly id?: () => string;
}

/** 按 `(at, seq)` 有序插入；新条目的 seq 最大，所以只需找到第一个 at 更大的位置。 */
function insertSorted(list: Entry[], entry: Entry): void {
  let low = 0;
  let high = list.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (compareCursor(list[mid]!, entry) <= 0) low = mid + 1;
    else high = mid;
  }
  list.splice(low, 0, entry);
}

/** 进程内存储。测试、短会话和不需要落盘的场景用。`watch` 靠内存里的订阅，写入后立刻唤醒。 */
export function createMemoryStore(options: MemoryStoreOptions = {}): SessionStore {
  const now = options.now ?? Date.now;
  const id = options.id ?? (() => crypto.randomUUID());
  const sessions = new Map<string, { entries: Entry[]; keys: Set<string> }>();
  const ids = new Set<string>();
  /** 每个会话上等新条目的 `watch`。 */
  const waiters = new Map<string, Set<() => void>>();
  let seq = 0;

  function session(name: string): { entries: Entry[]; keys: Set<string> } {
    let found = sessions.get(name);
    if (!found) {
      found = { entries: [], keys: new Set() };
      sessions.set(name, found);
    }
    return found;
  }

  function wake(name: string): void {
    const set = waiters.get(name);
    if (!set) return;
    waiters.delete(name);
    for (const resolve of set) resolve();
  }

  /** 等到这个会话有新写入或 `signal` 中止。 */
  function waitFor(name: string, signal: AbortSignal | undefined): Promise<void> {
    return new Promise((resolve) => {
      let set = waiters.get(name);
      if (!set) {
        set = new Set();
        waiters.set(name, set);
      }
      const done = (): void => {
        waiters.get(name)?.delete(done);
        signal?.removeEventListener('abort', done);
        resolve();
      };
      set.add(done);
      signal?.addEventListener('abort', done, { once: true });
    });
  }

  return {
    async append(name, drafts) {
      const target = session(name);
      const written: Entry[] = [];
      for (const draft of drafts) {
        if (draft.key !== undefined && target.keys.has(draft.key)) continue;
        const entryId = draft.id ?? id();
        if (ids.has(entryId)) continue;
        seq += 1;
        const entry = { ...draft, id: entryId, session: name, seq, at: draft.at ?? now() } as Entry;
        ids.add(entryId);
        if (entry.key !== undefined) target.keys.add(entry.key);
        insertSorted(target.entries, entry);
        written.push(entry);
      }
      if (written.length > 0) wake(name);
      return written;
    },
    async list(name, listOptions) {
      return filterEntries(sessions.get(name)?.entries ?? [], listOptions);
    },
    async clear(name) {
      const found = sessions.get(name);
      if (!found) return 0;
      for (const entry of found.entries) ids.delete(entry.id);
      sessions.delete(name);
      return found.entries.length;
    },
    async sessions() {
      return [...sessions.keys()].filter((name) => (sessions.get(name)?.entries.length ?? 0) > 0);
    },
    async *watch(name: string, watchOptions: WatchOptions = {}) {
      const { signal } = watchOptions;
      let after = watchOptions.after;
      for (;;) {
        if (signal?.aborted) return;
        const fresh = filterEntries(sessions.get(name)?.entries ?? [], after ? { after } : undefined);
        for (const entry of fresh) {
          if (signal?.aborted) return;
          yield entry;
          after = entry;
        }
        if (fresh.length === 0) await waitFor(name, signal);
      }
    },
  };
}
