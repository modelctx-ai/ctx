/**
 * 契约测试自己的测试：用最小的假实现跑一遍，确认用例本身能过、能跑完。
 * 这些假实现只在测试里，不随包发布；参考实现在 `@modelctx-ai/ctx`。
 */
import { describe, test } from 'vite-plus/test';

import { filterEntries, filterSessions, type Entry, type SessionStore } from './session.ts';
import { ENTRY_VERSION } from './version.ts';
import { describeExecutorContract, describeSessionStoreContract, describeToolRegistryContract } from './testing.ts';
import {
  errorOutput,
  isValidToolName,
  selectTools,
  type Executor,
  type ToolDefinition,
  type ToolRegistry,
} from './tools.ts';

function fakeStore(now: () => number): SessionStore {
  const sessions = new Map<string, Entry[]>();
  const ids = new Set<string>();
  const waiters = new Set<() => void>();
  let seq = 0;
  let nextId = 0;

  const store: SessionStore = {
    async append(session, drafts) {
      const list = sessions.get(session) ?? [];
      const keys = new Set(list.flatMap((entry) => (entry.key === undefined ? [] : [entry.key])));
      const written: Entry[] = [];
      for (const draft of drafts) {
        if (draft.key !== undefined && keys.has(draft.key)) continue;
        const id = draft.id ?? `e${(nextId += 1)}`;
        if (ids.has(id)) continue;
        seq += 1;
        const entry = { ...draft, id, session, seq, at: draft.at ?? now(), v: ENTRY_VERSION } as Entry;
        ids.add(id);
        if (entry.key !== undefined) keys.add(entry.key);
        written.push(entry);
      }
      if (written.length > 0) {
        sessions.set(session, [...list, ...written]);
        for (const wake of waiters) wake();
      }
      return written;
    },
    async list(session, options) {
      return filterEntries(sessions.get(session) ?? [], options);
    },
    async clear(session) {
      const list = sessions.get(session) ?? [];
      for (const entry of list) ids.delete(entry.id);
      sessions.delete(session);
      return list.length;
    },
    async sessions(options) {
      return filterSessions([...sessions.keys()], options);
    },
    async *watch(session, options = {}) {
      let after = options.after;
      const signal = options.signal;
      for (;;) {
        if (signal?.aborted) return;
        const fresh = filterEntries(sessions.get(session) ?? [], after ? { after } : {});
        for (const entry of fresh) {
          yield entry;
          after = entry.seq;
        }
        if (fresh.length > 0) continue;
        await new Promise<void>((resolve) => {
          const wake = (): void => {
            waiters.delete(wake);
            signal?.removeEventListener('abort', wake);
            resolve();
          };
          waiters.add(wake);
          signal?.addEventListener('abort', wake, { once: true });
        });
      }
    },
  };
  return store;
}

function fakeExecutor(): Executor {
  return {
    name: 'fake',
    async tools() {
      return [{ name: 'echo', inputSchema: { type: 'object' }, executor: 'fake' }];
    },
    async execute(call, context) {
      if (context.signal?.aborted) return errorOutput('Aborted before the tool ran.');
      if (call.name !== 'echo') return errorOutput(`Unknown tool "${call.name}". Available: echo.`);
      return { type: 'json', value: call.input };
    },
    async provision() {},
    async dispose() {},
  };
}

function fakeRegistry(): ToolRegistry {
  const tools = new Map<string, ToolDefinition>();
  const registry: ToolRegistry = {
    get size() {
      return tools.size;
    },
    add(definition, options) {
      if (!isValidToolName(definition.name)) throw new Error(`Invalid tool name "${definition.name}".`);
      if (tools.has(definition.name) && !options?.replace) throw new Error(`Tool "${definition.name}" exists.`);
      tools.set(definition.name, definition);
      return registry;
    },
    remove: (name) => tools.delete(name),
    removeSource(source) {
      let removed = 0;
      for (const [name, tool] of tools) if (tool.source === source && tools.delete(name)) removed += 1;
      return removed;
    },
    has: (name) => tools.has(name),
    get: (name) => tools.get(name),
    list: () => [...tools.values()],
    select: (filter) => selectTools([...tools.values()], filter),
  };
  return registry;
}

describeSessionStoreContract('fake', ({ now }) => fakeStore(now), { describe, test });
describeExecutorContract('fake', () => ({ executor: fakeExecutor(), echo: 'echo' }), { describe, test });
describeToolRegistryContract('fake', fakeRegistry, { describe, test });
