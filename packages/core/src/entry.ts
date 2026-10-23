import type { ModelMessage, UserContent } from 'ai';

import type { JsonObject, JsonValue } from './types.ts';

/** 条目在线程里的位置：先按 `at`，同一时刻再按存储分配的 `seq`。 */
export interface Cursor {
  readonly at: number;
  readonly seq: number;
}

interface EntryBase {
  /** 全局唯一。没给就由存储生成。 */
  readonly id: string;
  readonly thread: string;
  /** 存储分配的写入序号，只用来给同一时刻的条目排先后。 */
  readonly seq: number;
  /** 逻辑时间（毫秒）。导入的旧记录保留原来的时间。 */
  readonly at: number;
  /** 幂等键。同一线程里键相同的第二条会被忽略。 */
  readonly key?: string;
  /** 谁写的，例如 `user`、`model`、`dsh-pet`。 */
  readonly source?: string;
  readonly meta?: JsonObject;
}

/** 一条模型消息，原样保存，投影时直接带上。 */
export interface MessageEntry extends EntryBase {
  readonly type: 'message';
  readonly message: ModelMessage;
}

/** 应用自己的事件。默认不进模型上下文，要在投影规则里声明怎么渲染。 */
export interface EventEntry extends EntryBase {
  readonly type: 'event';
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

export type ContextEntry = MessageEntry | EventEntry | SummaryEntry;
export type EntryType = ContextEntry['type'];

type Draft<T extends ContextEntry> = Omit<T, 'id' | 'thread' | 'seq' | 'at'> & {
  readonly id?: string;
  readonly at?: number;
};

export type NewMessageEntry = Draft<MessageEntry>;
export type NewEventEntry = Draft<EventEntry>;
export type NewSummaryEntry = Draft<SummaryEntry>;
/** 追加时传入的条目：`id`、`at` 可选，`thread`、`seq` 由存储填。 */
export type NewEntry = NewMessageEntry | NewEventEntry | NewSummaryEntry;

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

export function compareCursor(a: Cursor, b: Cursor): number {
  return a.at - b.at || a.seq - b.seq;
}

export function cursorOf(entry: ContextEntry): Cursor {
  return { at: entry.at, seq: entry.seq };
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
