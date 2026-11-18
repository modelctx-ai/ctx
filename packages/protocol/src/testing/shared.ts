// 契约测试里几个套件共用的小工具；不从 `@modelctx-ai/ctx-protocol/testing` 导出。
import assert from 'node:assert/strict';

import type { MemoryFact, MemoryStore, NewMemoryFact, SourceRef } from '../memory.ts';
import { assistantEntry, eventEntry, userEntry, type Entry, type NewEntry } from '../session.ts';
import type { ToolDefinition } from '../tools.ts';

export function roundTrips(value: unknown): boolean {
  try {
    assert.deepEqual(JSON.parse(JSON.stringify(value)), value);
    return true;
  } catch {
    return false;
  }
}

export function definition(name: string, extra: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name,
    description: `${name} 的说明`,
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    executor: 'local',
    ...extra,
  };
}

export function kinds(entries: readonly Entry[]): string[] {
  return entries.map((entry) => {
    if (entry.type === 'event') return entry.kind;
    if (entry.type === 'message') return entry.message.role;
    return entry.type;
  });
}

/** 一条 `ctx.run.*` 事件，`data` 只带 `runId` 和最小的 `agent`。 */
export function lifecycle(kind: string, runId: string): NewEntry {
  return eventEntry(kind, { data: { runId, agent: { model: 'm' } } });
}

export function eventData(entries: readonly Entry[], kind: string): Record<string, unknown>[] {
  return entries.flatMap((entry) =>
    entry.type === 'event' && entry.kind === kind ? [(entry.data ?? {}) as Record<string, unknown>] : [],
  );
}

/** 一问一答交替的 `count` 条消息，每条 `chars` 个字符左右。 */
export function dialogue(count: number, chars = 2): NewEntry[] {
  const filler = 'lorem ipsum dolor sit amet '.repeat(Math.ceil(chars / 27)).slice(0, Math.max(0, chars - 2));
  return Array.from({ length: count }, (_, index) =>
    index % 2 === 0 ? userEntry(`问${index}${filler}`) : assistantEntry(`答${index}${filler}`),
  );
}

/** 错误的 `type` 是它：本地的 `CtxError` 和远端客户端转出来的错误都认。 */
export function hasType(type: string): (error: unknown) => boolean {
  return (error) => typeof error === 'object' && error !== null && (error as { type?: unknown }).type === type;
}

export function inUnit(value: unknown): boolean {
  return typeof value === 'number' && value >= 0 && value <= 1;
}

export const MEMORY_NOW = Date.UTC(2026, 9, 27);

export function ref(from: number, upTo: number = from, session = 's'): SourceRef {
  return { session, from, upTo };
}

export function newFact(text: string, extra: Partial<NewMemoryFact> = {}): NewMemoryFact {
  return {
    subject: 'user',
    text,
    validFrom: MEMORY_NOW,
    confidence: 0.9,
    salience: 0.6,
    sources: [ref(1)],
    ...extra,
  };
}

export function ids(items: readonly { readonly id: string }[]): string[] {
  return items.map((item) => item.id);
}

export async function factById(store: MemoryStore, id: string): Promise<MemoryFact | undefined> {
  return (await store.facts.list()).find((fact) => fact.id === id);
}
