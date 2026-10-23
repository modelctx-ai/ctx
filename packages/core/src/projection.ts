import type { ModelMessage } from 'ai';

import {
  compareCursor,
  cursorOf,
  type ContextEntry,
  type Cursor,
  type EventEntry,
  type MessageEntry,
  type SummaryEntry,
} from './entry.ts';
import { estimateTokens } from './tokens.ts';

/** 一种事件怎么进入模型上下文。没有规则的事件不进上下文。 */
export interface EventRule {
  /** 连续出现的同类事件合成一组再渲染。 */
  readonly fold?: boolean;
  /** 把一条事件（或合并后的一组）渲染成消息。返回空就丢掉。 */
  render(events: readonly EventEntry[]): ModelMessage | readonly ModelMessage[] | null | undefined;
}

export interface WindowOptions {
  /** 最多保留多少条消息（摘要不算）。 */
  readonly maxMessages?: number;
  /** 估算 token 的预算（摘要计入）。 */
  readonly maxTokens?: number;
  readonly estimate?: (message: ModelMessage) => number;
}

export interface ProjectionOptions {
  readonly events?: Readonly<Record<string, EventRule>>;
  /** 摘要渲染成哪条消息。缺省是一条用户消息。 */
  readonly summary?: (entry: SummaryEntry) => ModelMessage;
  /** 改写或过滤消息条目，返回空就丢掉。 */
  readonly message?: (entry: MessageEntry) => ModelMessage | null | undefined;
  /** 不给就不裁剪：整段历史都带上。 */
  readonly window?: WindowOptions;
}

export interface ProjectedMessage {
  readonly message: ModelMessage;
  /** 这条消息覆盖到的最后一个条目的位置，压缩时用来定切点。 */
  readonly upTo: Cursor;
  /** 摘要消息固定在最前面，不参与裁剪。 */
  readonly pinned: boolean;
  readonly tokens: number;
}

export interface Projection {
  readonly messages: ModelMessage[];
  readonly items: readonly ProjectedMessage[];
  readonly tokens: number;
  /** 被窗口裁掉的消息条数。 */
  readonly dropped: number;
  readonly summary?: SummaryEntry;
}

export function defaultSummaryMessage(entry: SummaryEntry): ModelMessage {
  return { role: 'user', content: `Summary of the earlier conversation:\n${entry.text}` };
}

/** 生效的摘要是覆盖范围最大的那一条。 */
export function latestSummary(entries: readonly ContextEntry[]): SummaryEntry | undefined {
  let found: SummaryEntry | undefined;
  for (const entry of entries) {
    if (entry.type !== 'summary') continue;
    if (!found || compareCursor(entry.covers, found.covers) > 0) found = entry;
  }
  return found;
}

function asList(rendered: ModelMessage | readonly ModelMessage[] | null | undefined): readonly ModelMessage[] {
  if (!rendered) return [];
  return Array.isArray(rendered) ? rendered : [rendered as ModelMessage];
}

/** 带工具调用的助手消息和紧跟的工具结果是一个整体，裁剪时一起留或一起丢。 */
function blocks(items: readonly ProjectedMessage[]): ProjectedMessage[][] {
  const out: ProjectedMessage[][] = [];
  for (const item of items) {
    const last = out.at(-1);
    if (item.message.role === 'tool' && last) last.push(item);
    else out.push([item]);
  }
  return out;
}

function windowed(
  pinned: readonly ProjectedMessage[],
  rest: readonly ProjectedMessage[],
  window: WindowOptions | undefined,
): { kept: ProjectedMessage[]; dropped: number } {
  const maxMessages = window?.maxMessages;
  const maxTokens = window?.maxTokens;
  const groups = blocks(rest);
  // 开头不能是孤立的工具结果（它的调用已经被摘要盖住了）。
  let dropped = 0;
  while (groups[0]?.[0]?.message.role === 'tool') dropped += groups.shift()!.length;
  if (maxMessages === undefined && maxTokens === undefined) return { kept: [...pinned, ...groups.flat()], dropped };

  const pinnedTokens = pinned.reduce((sum, item) => sum + item.tokens, 0);
  let count = groups.reduce((sum, group) => sum + group.length, 0);
  let tokens = pinnedTokens + groups.reduce((sum, group) => sum + group.reduce((s, item) => s + item.tokens, 0), 0);
  const over = (): boolean =>
    (maxMessages !== undefined && count > maxMessages) || (maxTokens !== undefined && tokens > maxTokens);
  // 至少留下最后一组，宁可超预算也不交一份空上下文。
  while (groups.length > 1 && over()) {
    const group = groups.shift()!;
    count -= group.length;
    tokens -= group.reduce((sum, item) => sum + item.tokens, 0);
    dropped += group.length;
  }
  return { kept: [...pinned, ...groups.flat()], dropped };
}

/**
 * 把条目渲染成模型消息：
 * 1. 摘要之前的条目由摘要代替，摘要固定放在最前；
 * 2. 消息条目原样带上；事件按规则渲染，`fold` 的同类事件连在一起时合成一组；
 * 3. 有窗口时从最旧的消息开始裁，工具调用和结果成组进出。
 */
export function project(entries: readonly ContextEntry[], options: ProjectionOptions = {}): Projection {
  const estimate = options.window?.estimate ?? estimateTokens;
  const sorted = [...entries].sort(compareCursor);
  const summary = latestSummary(sorted);
  const visible = sorted.filter(
    (entry) => entry.type !== 'summary' && (!summary || compareCursor(entry, summary.covers) > 0),
  ) as (MessageEntry | EventEntry)[];

  const make = (message: ModelMessage, upTo: Cursor, pinned = false): ProjectedMessage => ({
    message,
    upTo,
    pinned,
    tokens: estimate(message),
  });

  const pinned: ProjectedMessage[] = [];
  if (summary) pinned.push(make((options.summary ?? defaultSummaryMessage)(summary), summary.covers, true));

  const rest: ProjectedMessage[] = [];
  const rules = options.events ?? {};
  // 没有规则的事件对模型不可见，也不打断前后同类事件的合并。
  const shown = visible.filter((entry) => entry.type === 'message' || rules[entry.kind] !== undefined);
  for (let i = 0; i < shown.length; i += 1) {
    const entry = shown[i]!;
    if (entry.type === 'message') {
      const message = options.message ? options.message(entry) : entry.message;
      if (message) rest.push(make(message, cursorOf(entry)));
      continue;
    }
    const rule = rules[entry.kind]!;
    const group: EventEntry[] = [entry];
    if (rule.fold) {
      while (i + 1 < shown.length) {
        const next = shown[i + 1]!;
        if (next.type !== 'event' || next.kind !== entry.kind) break;
        group.push(next);
        i += 1;
      }
    }
    const upTo = cursorOf(group.at(-1)!);
    for (const message of asList(rule.render(group))) rest.push(make(message, upTo));
  }

  const { kept, dropped } = windowed(pinned, rest, options.window);
  const result: Projection = {
    messages: kept.map((item) => item.message),
    items: kept,
    tokens: kept.reduce((sum, item) => sum + item.tokens, 0),
    dropped,
    ...(summary ? { summary } : {}),
  };
  return result;
}
