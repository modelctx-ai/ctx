import type { Message, MessageContent } from './message.ts';
import type { StopReason, Usage } from './harness.ts';
import type { JsonObject, JsonValue } from './types.ts';

interface EntryBase {
  /** 全局唯一。没给就由存储生成。 */
  readonly id: string;
  /** 所属会话，由存储填。 */
  readonly session: string;
  /**
   * 条目在会话里的位置：存储按写入顺序分配，会话内严格递增、从 1 开始，`(session, seq)` 唯一。不要求连续，
   * 不要求跨会话递增，`clear` 之后不回退、不复用。0 表示会话开头。`list`、`watch`、`covers` 都按它。
   */
  readonly seq: number;
  /** 逻辑时间（毫秒），只用于投影排序和展示。缺省是写入时刻；导入的旧记录保留原来的时间，所以可以早于已有的条目。 */
  readonly at: number;
  /**
   * 这一行写入时的格式版本（`ENTRY_VERSION`，当前是 1）。存储写入时填；读到的条目形状总是当前版本，`v` 是 0 的是
   * 旧版本写的行，读时已经升级过（见 `upgradeEntry`）。
   */
  readonly v: number;
  /** 幂等键。同一会话里键相同的第二条会被跳过。 */
  readonly key?: string;
  /** 谁写的，例如 `user`、`model`、`harness`、应用名。 */
  readonly source?: string;
  readonly meta?: JsonObject;
}

/** 一条模型消息，原样保存，投影时直接带上。 */
export interface MessageEntry extends EntryBase {
  readonly type: 'message';
  readonly message: Message;
}

/** 应用或框架的事件。缺省不进模型上下文，要在投影规则里声明怎么渲染。 */
export interface EventEntry extends EntryBase {
  readonly type: 'event';
  /** `{domain}.{action}`，`ctx.` 前缀留给框架。 */
  readonly kind: string;
  readonly text?: string;
  readonly data?: JsonValue;
}

/** 压缩点：`seq` 小于等于 `covers` 的条目由这段摘要代替。 */
export interface SummaryEntry extends EntryBase {
  readonly type: 'summary';
  readonly text: string;
  readonly covers: number;
}

export type Entry = MessageEntry | EventEntry | SummaryEntry;
export type EntryType = Entry['type'];

type Draft<T extends Entry> = Omit<T, 'id' | 'session' | 'seq' | 'at' | 'v'> & {
  readonly id?: string;
  readonly at?: number;
};

export type NewMessageEntry = Draft<MessageEntry>;
export type NewEventEntry = Draft<EventEntry>;
export type NewSummaryEntry = Draft<SummaryEntry>;
/** 追加时传入的条目：`id`、`at` 可选，`session`、`seq`、`v` 由存储填。 */
export type NewEntry = NewMessageEntry | NewEventEntry | NewSummaryEntry;

export interface ListOptions {
  /** 只要 `seq` 大于它的条目（不含）。0 是会话开头。 */
  readonly after?: number;
  /** 只要最后写入的 N 条（`seq` 最大的 N 条），仍按 `seq` 升序返回。小数向下取整，不是有限正数时返回空。 */
  readonly last?: number;
  /** 只要这些类型。 */
  readonly types?: readonly EntryType[];
  /**
   * 只要事件，且 `kind` 在其中；消息和摘要不返回。与 `types` 取交集（`types` 里没有 `event` 就什么都不返回），
   * 空列表什么都不匹配。`last` 在过滤之后取。
   */
  readonly kinds?: readonly string[];
}

/** `sessions` 的分页和前缀。 */
export interface SessionsOptions {
  /** 只要以它开头的名字，按字面匹配（`%`、`_`、`\` 都不是通配符或转义）。空串是全部。 */
  readonly prefix?: string;
  /** 从名字大于它的会话开始（不含），一般是上一页的最后一个名字。 */
  readonly after?: string;
  /** 最多返回多少个。小数向下取整，不是正数时返回空；不给就不限。 */
  readonly limit?: number;
}

export interface WatchOptions {
  /** 从 `seq` 大于它的条目开始；不给就从头。 */
  readonly after?: number;
  /** 中止后迭代正常结束，不抛错。 */
  readonly signal?: AbortSignal;
}

/**
 * 会话：只追加的事件日志，放在模型的上下文窗口之外。写进来的条目不再修改，压缩靠追加摘要条目完成。
 * `list` 和 `watch` 都按 `seq` 升序返回，也就是写入顺序；模型看到的逻辑顺序是投影的事（`compareEntries`）。
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
  /** 有内容的会话，按名字升序（码点序，也就是 UTF-8 字节序）。翻页：`after` 给上一页最后一个名字。 */
  sessions(options?: SessionsOptions): Promise<string[]>;
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

export function messageEntry(message: Message, options?: EntryOptions): NewMessageEntry {
  return { type: 'message', message, ...common(options) };
}

export function userEntry(content: MessageContent, options?: EntryOptions): NewMessageEntry {
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

export function summaryEntry(text: string, covers: number, options?: EntryOptions): NewSummaryEntry {
  return { type: 'summary', text, covers, ...common(options) };
}

// ---- 顺序和读取 ----

/** 投影里的逻辑顺序：先按 `at`，同一时刻再按 `seq`。日志顺序只看 `seq`。 */
export function compareEntries(a: Pick<Entry, 'at' | 'seq'>, b: Pick<Entry, 'at' | 'seq'>): number {
  return a.at - b.at || a.seq - b.seq;
}

/**
 * `ListOptions` 的语义写成纯函数：存储可以直接用它过滤，也可以在查询里做同样的事。
 * 输入应当已按 `seq` 升序排好。
 */
export function filterEntries(entries: readonly Entry[], options: ListOptions | undefined): Entry[] {
  let out = entries.filter((entry) => {
    if (options?.after !== undefined && entry.seq <= options.after) return false;
    if (options?.types && !options.types.includes(entry.type)) return false;
    if (options?.kinds && (entry.type !== 'event' || !options.kinds.includes(entry.kind))) return false;
    return true;
  });
  if (options?.last !== undefined) {
    const last = Number.isFinite(options.last) ? Math.floor(options.last) : 0;
    out = last > 0 ? out.slice(-last) : [];
  }
  return out;
}

/** 按码点比较，和 UTF-8 字节序一致（JavaScript 的 `<` 按 UTF-16 码元比，补充平面的字符会排错）。 */
function compareNames(a: string, b: string): number {
  const x = a[Symbol.iterator]();
  const y = b[Symbol.iterator]();
  for (;;) {
    const p = x.next();
    const q = y.next();
    if (p.done || q.done) return Number(!p.done) - Number(!q.done);
    const diff = p.value.codePointAt(0)! - q.value.codePointAt(0)!;
    if (diff !== 0) return diff;
  }
}

/**
 * `SessionsOptions` 的语义写成纯函数：内存里的存储可以直接用。输入不必排序，也不必去重。
 */
export function filterSessions(names: readonly string[], options: SessionsOptions | undefined): string[] {
  const out = names
    .filter(
      (name) =>
        (options?.prefix === undefined || name.startsWith(options.prefix)) &&
        (options?.after === undefined || compareNames(name, options.after) > 0),
    )
    .toSorted(compareNames);
  if (options?.limit === undefined) return out;
  const limit = Number.isNaN(options.limit) ? 0 : Math.floor(options.limit);
  return limit > 0 ? out.slice(0, limit) : [];
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
  readonly covers: number;
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
