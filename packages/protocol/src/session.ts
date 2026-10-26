import type { ModelMessage, UserContent } from 'ai';

import type { StopReason, Usage } from './harness.ts';
import type { JsonObject, JsonValue } from './types.ts';

/** 条目在会话里的位置：先按 `at`，同一时刻再按存储分配的 `seq`。 */
export interface Cursor {
  readonly at: number;
  readonly seq: number;
}

interface EntryBase {
  /** 全局唯一。没给就由存储生成。 */
  readonly id: string;
  /** 所属会话，由存储填。 */
  readonly session: string;
  /** 存储分配的写入序号，只用来给同一时刻的条目排先后。 */
  readonly seq: number;
  /** 逻辑时间（毫秒）。缺省是写入时刻；导入的旧记录保留原来的时间。 */
  readonly at: number;
  /** 幂等键。同一会话里键相同的第二条会被跳过。 */
  readonly key?: string;
  /** 谁写的，例如 `user`、`model`、`harness`、应用名。 */
  readonly source?: string;
  readonly meta?: JsonObject;
}

/** 一条模型消息，原样保存，投影时直接带上。 */
export interface MessageEntry extends EntryBase {
  readonly type: 'message';
  readonly message: ModelMessage;
}

/** 应用或框架的事件。缺省不进模型上下文，要在投影规则里声明怎么渲染。 */
export interface EventEntry extends EntryBase {
  readonly type: 'event';
  /** `{domain}.{action}`，`ctx.` 前缀留给框架。 */
  readonly kind: string;
  readonly text?: string;
  readonly data?: JsonValue;
}

/** 压缩点：`covers` 之前（含）的条目由这段摘要代替。 */
export interface SummaryEntry extends EntryBase {
  readonly type: 'summary';
  readonly text: string;
  readonly covers: Cursor;
}

export type Entry = MessageEntry | EventEntry | SummaryEntry;
export type EntryType = Entry['type'];

type Draft<T extends Entry> = Omit<T, 'id' | 'session' | 'seq' | 'at'> & {
  readonly id?: string;
  readonly at?: number;
};

export type NewMessageEntry = Draft<MessageEntry>;
export type NewEventEntry = Draft<EventEntry>;
export type NewSummaryEntry = Draft<SummaryEntry>;
/** 追加时传入的条目：`id`、`at` 可选，`session`、`seq` 由存储填。 */
export type NewEntry = NewMessageEntry | NewEventEntry | NewSummaryEntry;

export interface ListOptions {
  /** 只要这个位置之后（不含）的条目。 */
  readonly after?: Cursor;
  /** 只要最后 N 条，仍按从旧到新返回。小数向下取整，不是有限正数时返回空。 */
  readonly last?: number;
  /** 只要这些类型。 */
  readonly types?: readonly EntryType[];
}

export interface WatchOptions {
  /** 从这个位置之后（不含）开始；不给就从头。 */
  readonly after?: Cursor;
  /** 中止后迭代正常结束，不抛错。 */
  readonly signal?: AbortSignal;
}

/**
 * 会话：只追加的事件日志，放在模型的上下文窗口之外。写进来的条目不再修改，压缩靠追加摘要条目完成。
 * 返回顺序统一是 `(at, seq)` 从旧到新。
 */
export interface SessionStore {
  /**
   * 追加一批条目，返回真正写入的那些（带 `id`、`session`、`seq`、`at`）。
   * 一批是原子的：不会只写一半，也不会和并发的另一批交错。`id` 重复（全局）或 `key` 重复（同一会话，
   * 含同一批里的）不算失败，那一条静默跳过，其余照写。
   */
  append(session: string, entries: readonly NewEntry[]): Promise<Entry[]>;
  list(session: string, options?: ListOptions): Promise<Entry[]>;
  /** 清空一个会话，返回删掉的条数。 */
  clear(session: string): Promise<number>;
  /** 有内容的会话。 */
  sessions(): Promise<string[]>;
  /** 先给出 `after` 之后已有的条目，再持续给出新写入的，直到 `signal` 中止。远端流式读用。 */
  watch?(session: string, options?: WatchOptions): AsyncIterable<Entry>;
}

// ---- 条目构造 ----

export interface EntryOptions {
  readonly id?: string;
  readonly at?: number;
  readonly key?: string;
  readonly source?: string;
  readonly meta?: JsonObject;
}

function common(options: EntryOptions | undefined): EntryOptions {
  const out: { -readonly [K in keyof EntryOptions]: EntryOptions[K] } = {};
  if (options?.id !== undefined) out.id = options.id;
  if (options?.at !== undefined) out.at = options.at;
  if (options?.key !== undefined) out.key = options.key;
  if (options?.source !== undefined) out.source = options.source;
  if (options?.meta !== undefined) out.meta = options.meta;
  return out;
}

export function messageEntry(message: ModelMessage, options?: EntryOptions): NewMessageEntry {
  return { type: 'message', message, ...common(options) };
}

export function userEntry(content: UserContent, options?: EntryOptions): NewMessageEntry {
  return messageEntry({ role: 'user', content }, options);
}

export function assistantEntry(text: string, options?: EntryOptions): NewMessageEntry {
  return messageEntry({ role: 'assistant', content: text }, options);
}

export interface EventInit extends EntryOptions {
  readonly text?: string;
  readonly data?: JsonValue;
}

export function eventEntry(kind: string, init?: EventInit): NewEventEntry {
  const entry: { -readonly [K in keyof NewEventEntry]: NewEventEntry[K] } = { type: 'event', kind, ...common(init) };
  if (init?.text !== undefined) entry.text = init.text;
  if (init?.data !== undefined) entry.data = init.data;
  return entry;
}

export function summaryEntry(text: string, covers: Cursor, options?: EntryOptions): NewSummaryEntry {
  return { type: 'summary', text, covers, ...common(options) };
}

// ---- 游标和读取 ----

export function compareCursor(a: Cursor, b: Cursor): number {
  return a.at - b.at || a.seq - b.seq;
}

export function cursorOf(entry: Entry): Cursor {
  return { at: entry.at, seq: entry.seq };
}

/**
 * `ListOptions` 的语义写成纯函数：存储可以直接用它过滤，也可以在查询里做同样的事。
 * 输入应当已按 `(at, seq)` 排好。
 */
export function filterEntries(entries: readonly Entry[], options: ListOptions | undefined): Entry[] {
  let out = entries.filter((entry) => {
    if (options?.after && compareCursor(entry, options.after) <= 0) return false;
    if (options?.types && !options.types.includes(entry.type)) return false;
    return true;
  });
  if (options?.last !== undefined) {
    const last = Number.isFinite(options.last) ? Math.floor(options.last) : 0;
    out = last > 0 ? out.slice(-last) : [];
  }
  return out;
}

/** 消息里能直接读出来的文字。工具调用、图片等非文字部分不算。 */
export function textOf(message: ModelMessage): string {
  const { content } = message;
  if (typeof content === 'string') return content;
  let text = '';
  for (const part of content) {
    if (part.type === 'text') text += part.text;
  }
  return text;
}

// ---- 框架事件 ----

/** 框架写进会话的事件 `kind`。`ctx.` 前缀保留给框架，应用自定其余的 `{domain}.{action}`。 */
export const CTX_EVENTS = {
  runStarted: 'ctx.run.started',
  runEnded: 'ctx.run.ended',
  compacted: 'ctx.compacted',
  error: 'ctx.error',
} as const;

export type CtxEventKind = (typeof CTX_EVENTS)[keyof typeof CTX_EVENTS];

/** `ctx.run.started` 的 `data`。`agent` 是 `AgentSpec` 的可序列化部分（见 `agentSpecToJson`）。 */
export interface RunStartedData {
  readonly runId: string;
  readonly agent: JsonObject;
}

/** `ctx.run.ended` 的 `data`。崩溃恢复靠「有 started 没有 ended」找出断掉的运行。 */
export interface RunEndedData {
  readonly runId: string;
  readonly stopReason: StopReason;
  readonly usage?: Usage;
}

/** `ctx.compacted` 的 `data`。 */
export interface CompactedData {
  readonly covers: Cursor;
  readonly summaryId: string;
}

/** `ctx.error` 的 `data`。 */
export interface CtxErrorData {
  readonly runId?: string;
  readonly message: string;
  readonly type?: string;
}

export function isFrameworkKind(kind: string): boolean {
  return kind.startsWith('ctx.');
}

/** 去掉值为 `undefined` 的字段：可选字段不给时不出现在 JSON 里。 */
function defined(data: object): JsonValue {
  return Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined));
}

function ctxEvent(kind: CtxEventKind, data: object, options: EntryOptions | undefined): NewEventEntry {
  return eventEntry(kind, { ...options, data: defined(data) });
}

export function runStartedEntry(data: RunStartedData, options?: EntryOptions): NewEventEntry {
  return ctxEvent(CTX_EVENTS.runStarted, data, options);
}

export function runEndedEntry(data: RunEndedData, options?: EntryOptions): NewEventEntry {
  return ctxEvent(CTX_EVENTS.runEnded, data, options);
}

export function compactedEntry(data: CompactedData, options?: EntryOptions): NewEventEntry {
  return ctxEvent(CTX_EVENTS.compacted, data, options);
}

export function ctxErrorEntry(data: CtxErrorData, options?: EntryOptions): NewEventEntry {
  return ctxEvent(CTX_EVENTS.error, data, options);
}
