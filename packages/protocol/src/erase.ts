import { CTX_EVENTS, type Entry, type ErasedData, type EventEntry, type RedactedData } from './session.ts';
import type { JsonValue } from './types.ts';
import { ENTRY_VERSION } from './version.ts';

/** 一条擦除记录动没动 `seq` 这一条：`truncate` 看 `upTo`，`remove`、`redact` 看 `seqs`。 */
export function isErased(data: ErasedData, seq: number): boolean {
  if (data.op === 'truncate') return data.upTo !== undefined && seq <= data.upTo;
  return data.seqs?.includes(seq) ?? false;
}

/** 一次擦除：`truncate` 给 `upTo`，`remove`、`redact` 给 `ids`。 */
export type Erasure =
  | { readonly op: 'truncate'; readonly upTo: number }
  | { readonly op: 'remove' | 'redact'; readonly ids: readonly string[] };

/** `eraseEntries` 的结果。 */
export interface ErasedEntries {
  /** 操作之后会话里的条目，`seq` 升序；`redact` 的占位在原位。还没有擦除记录，存储自己追加。 */
  readonly entries: Entry[];
  /** 被删掉或被涂改的条目（操作之前的样子），`seq` 升序。 */
  readonly touched: Entry[];
  /** 要追加的擦除记录的 `data`；什么都没动时没有，存储不追加。 */
  readonly erased?: ErasedData;
}

/**
 * `truncate`、`remove`、`redact` 的语义写成纯函数：内存里的存储可以直接用，也可以在查询里做同样的事。
 * 输入是一个会话的全部条目，按 `seq` 升序。
 */
export function eraseEntries(entries: readonly Entry[], erasure: Erasure): ErasedEntries {
  let hit: (entry: Entry) => boolean;
  if (erasure.op === 'truncate') {
    const upTo = Number.isFinite(erasure.upTo) ? Math.floor(erasure.upTo) : 0;
    hit = (entry) => entry.seq <= upTo;
  } else {
    const ids = new Set(erasure.ids);
    const redacting = erasure.op === 'redact';
    hit = (entry) => ids.has(entry.id) && !(redacting && entry.type === 'event' && entry.kind === CTX_EVENTS.redacted);
  }
  const touched = entries.filter(hit);
  if (touched.length === 0) return { entries: [...entries], touched };
  const count = touched.length;
  if (erasure.op === 'redact') {
    return {
      entries: entries.map((entry) => (hit(entry) ? redactedEntry(entry) : entry)),
      touched,
      erased: { op: 'redact', seqs: touched.map((entry) => entry.seq), count },
    };
  }
  const erased: ErasedData =
    erasure.op === 'truncate'
      ? { op: 'truncate', upTo: touched.at(-1)!.seq, count }
      : { op: 'remove', seqs: touched.map((entry) => entry.seq), count };
  return { entries: entries.filter((entry) => !hit(entry)), touched, erased };
}

/**
 * 涂改之后的占位条目：`id`、`session`、`seq`、`at`、`key`、`source` 是原来那一条的，`v` 是当前版本，
 * `data` 是 `RedactedData`；消息、文字、数据、`meta` 都不带。`raw` 可以是条目，也可以是存储里解不了的原始行
 * （只要这几个字段在）。它是事件，缺省不进模型上下文。
 */
export function redactedEntry(raw: unknown): EventEntry {
  const row = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const text = (key: string): string | undefined => (typeof row[key] === 'string' ? row[key] : undefined);
  const count = (key: string): number => (typeof row[key] === 'number' ? row[key] : 0);
  const message = row['message'];
  const role = typeof message === 'object' && message !== null ? (message as { role?: unknown }).role : undefined;
  const type = text('type');
  const key = text('key');
  const source = text('source');
  const data: RedactedData = {
    ...(type !== undefined ? { type } : {}),
    ...(typeof role === 'string' ? { role } : {}),
  };
  return {
    type: 'event',
    kind: CTX_EVENTS.redacted,
    id: text('id') ?? '',
    session: text('session') ?? '',
    seq: count('seq'),
    at: count('at'),
    v: ENTRY_VERSION,
    ...(key !== undefined ? { key } : {}),
    ...(source !== undefined ? { source } : {}),
    data: data as unknown as JsonValue,
  };
}
