import { compareCursor, type ContextEntry, type Cursor, type EntryType, type NewEntry } from './entry.ts';

export interface ListOptions {
  /** 只要这个位置之后（不含）的条目。 */
  readonly after?: Cursor;
  /** 只要最后 N 条，仍按从旧到新返回。 */
  readonly last?: number;
  /** 只要这些类型。 */
  readonly types?: readonly EntryType[];
}

/**
 * 上下文的持久化边界。只追加：写进来的条目不再修改，压缩靠追加摘要条目完成。
 * 返回顺序统一是 `(at, seq)` 从旧到新。
 */
export interface ContextStore {
  /** 追加条目，返回真正写入的那些。幂等键或 id 重复的条目静默跳过。 */
  append(thread: string, entries: readonly NewEntry[]): Promise<ContextEntry[]>;
  list(thread: string, options?: ListOptions): Promise<ContextEntry[]>;
  /** 清空一个线程，返回删掉的条数。 */
  clear(thread: string): Promise<number>;
  threads(): Promise<string[]>;
}

export interface MemoryStoreOptions {
  readonly now?: () => number;
  readonly id?: () => string;
}

/** 按 `(at, seq)` 有序插入；新条目的 seq 最大，所以只需找到第一个 at 更大的位置。 */
function insertSorted(list: ContextEntry[], entry: ContextEntry): void {
  let low = 0;
  let high = list.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (compareCursor(list[mid]!, entry) <= 0) low = mid + 1;
    else high = mid;
  }
  list.splice(low, 0, entry);
}

export function filterEntries(entries: readonly ContextEntry[], options: ListOptions | undefined): ContextEntry[] {
  let out = entries.filter((entry) => {
    if (options?.after && compareCursor(entry, options.after) <= 0) return false;
    if (options?.types && !options.types.includes(entry.type)) return false;
    return true;
  });
  if (options?.last !== undefined) out = options.last > 0 ? out.slice(-options.last) : [];
  return out;
}

/** 进程内存储。测试、短会话和不需要落盘的场景用。 */
export function createMemoryStore(options: MemoryStoreOptions = {}): ContextStore {
  const now = options.now ?? Date.now;
  const id = options.id ?? (() => crypto.randomUUID());
  const threads = new Map<string, { entries: ContextEntry[]; keys: Set<string> }>();
  const ids = new Set<string>();
  let seq = 0;

  function thread(name: string): { entries: ContextEntry[]; keys: Set<string> } {
    let found = threads.get(name);
    if (!found) {
      found = { entries: [], keys: new Set() };
      threads.set(name, found);
    }
    return found;
  }

  return {
    async append(name, drafts) {
      const target = thread(name);
      const written: ContextEntry[] = [];
      for (const draft of drafts) {
        if (draft.key !== undefined && target.keys.has(draft.key)) continue;
        const entryId = draft.id ?? id();
        if (ids.has(entryId)) continue;
        seq += 1;
        const entry = { ...draft, id: entryId, thread: name, seq, at: draft.at ?? now() } as ContextEntry;
        ids.add(entryId);
        if (entry.key !== undefined) target.keys.add(entry.key);
        insertSorted(target.entries, entry);
        written.push(entry);
      }
      return written;
    },
    async list(name, listOptions) {
      return filterEntries(threads.get(name)?.entries ?? [], listOptions);
    },
    async clear(name) {
      const found = threads.get(name);
      if (!found) return 0;
      for (const entry of found.entries) ids.delete(entry.id);
      threads.delete(name);
      return found.entries.length;
    },
    async threads() {
      return [...threads.keys()].filter((name) => (threads.get(name)?.entries.length ?? 0) > 0);
    },
  };
}
