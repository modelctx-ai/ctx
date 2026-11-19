import type { Message, MessageContent } from './message.ts';
import type { StopReason, Usage } from './harness.ts';
import { definedFields, isJsonObject, usageFromJson } from './json.ts';
import { CtxError, type JsonObject, type JsonValue } from './types.ts';

interface EntryBase {
  /** 全局唯一。没给就由存储生成。 */
  readonly id: string;
  /** 所属会话，由存储填。 */
  readonly session: string;
  /**
   * 条目在会话里的位置：存储按写入顺序分配，会话内严格递增、从 1 开始，`(session, seq)` 唯一。不要求连续，
   * 不要求跨会话递增，`clear`、`truncate`、`remove` 之后不回退、不复用。0 表示会话开头。`list`、`watch`、`covers` 都按它。
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
  /**
   * 最多返回这么多条，取过滤之后 `seq` 最小的（最早的）。和 `after` 配合向前翻页：下一页的 `after` 是这一页
   * 最后一条的 `seq`，读到不满一页为止。小数向下取整，不是有限正数时返回空。和 `last` 同时给时先取 `last`。
   */
  readonly limit?: number;
  /** 只要这些类型。 */
  readonly types?: readonly EntryType[];
  /**
   * 只要事件，且 `kind` 在其中；消息和摘要不返回。与 `types` 取交集（`types` 里没有 `event` 就什么都不返回），
   * 空列表什么都不匹配。`last` 在过滤之后取。
   */
  readonly kinds?: readonly string[];
  /**
   * 只要 `at` 大于它的条目（不含）。和别的条件取交集，`last`、`limit` 在过滤之后取；`NaN` 不过滤。
   * 投影按 `at` 排：只读尾部的一方用它找写得早、`at` 却排在尾部之后的条目（把到期时间当 `at` 的提醒）。
   */
  readonly atAfter?: number;
}

/** `append` 的写入前提。 */
export interface AppendOptions {
  /**
   * 仅当会话当前最后一条的 `seq` 等于它才写（空会话是 0），否则整批不写，抛 `conflict`
   * （`CtxError`，`retryable: true`；HTTP 是 409）。前提的检查先于去重：重试一批已经成功的写入，
   * 如果其间别人又写了，仍然得到 `conflict`，调用方重读就能看到自己的条目已在。不给就不检查。
   */
  readonly expectSeq?: number;
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
 * 会话：只追加的事件日志，放在模型的上下文窗口之外。写进来的条目不再修改，压缩靠追加摘要条目完成；
 * 例外只有删除：`clear`、`truncate`、`remove` 真删，`redact` 把内容换成占位。
 * `list` 和 `watch` 都按 `seq` 升序返回，也就是写入顺序；模型看到的逻辑顺序是投影的事（`compareEntries`）。
 *
 * 擦除（`truncate`、`remove`、`redact`）的共同规则：
 * - 原子：要么都做，要么都不做，不和并发的 `append` 交错。
 * - 真的动了条目时，存储在同一次操作里追加一条 `ctx.erased`（`ErasedData`，`source: 'store'`）。所以会话的末尾
 *   一定往前走一格：拿着旧末尾当 `expectSeq` 的写入会 `conflict` 一次，重读就看得到这条记录；`watch` 的订阅方
 *   也收得到，照着它改自己手里的副本。什么都没动（返回 0）就不追加，末尾不变。
 * - `seq` 不回退、不复用；剩下的条目 `id`、`seq`、`at` 都不变。
 * - 摘要不跟着改：它的文字是从被盖住的条目算出来的，删掉条目不会把内容从摘要里拿掉。
 */
export interface SessionStore {
  /**
   * 追加一批条目，返回真正写入的那些（带 `id`、`session`、`seq`、`at`）。
   * 一批是原子的：不会只写一半，也不会和并发的另一批交错。`id` 重复（全局）或 `key` 重复（同一会话，
   * 含同一批里的）不算失败，那一条静默跳过，其余照写。给了 `options.expectSeq` 时前提不满足整批不写，抛 `conflict`。
   */
  append(session: string, entries: readonly NewEntry[], options?: AppendOptions): Promise<Entry[]>;
  list(session: string, options?: ListOptions): Promise<Entry[]>;
  /**
   * 清空一个会话，返回删掉的条数。不留擦除记录：会话回到空，末尾回到 0，`sessions` 不再列它。
   * `watch` 的订阅方收不到通知；要留痕迹就用 `truncate(session, 末尾)`。
   */
  clear(session: string): Promise<number>;
  /**
   * 删掉 `seq` 小于等于 `upTo` 的条目，返回删掉的条数。清理被摘要盖住的历史时 `upTo` 给摘要的 `covers`；
   * 比它小的摘要也一起删掉，生效的摘要（`seq` 大于自己的 `covers`）留着。`upTo` 小数向下取整，不是有限数时什么都不删。
   */
  truncate(session: string, upTo: number): Promise<number>;
  /**
   * 按 `id` 删掉这个会话里的条目，返回删掉的条数。认不得的、别的会话的 `id` 跳过，重复的只算一次。
   * 读不了的行（`unsupported_version` 之类）也删得掉。删掉之后它的 `id` 和 `key` 可以再用（和 `clear` 一样）。
   */
  remove(session: string, ids: readonly string[]): Promise<number>;
  /**
   * 按 `id` 涂改这个会话里的条目，返回涂改的条数：`id`、`session`、`seq`、`at`、`key`、`source` 留着，
   * 别的内容都去掉，条目变成一条 `ctx.redacted` 事件（`RedactedData`，见 `redactedEntry`）。位置还在，所以
   * `covers`、证据区间照常指得到；`key` 还在，同一个键的重试不会把内容写回来。已经涂改过的、认不得的 `id` 跳过。
   * 读不了的行也能涂改，涂改之后就读得了。
   */
  redact(session: string, ids: readonly string[]): Promise<number>;
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
    if (options?.atAfter !== undefined && entry.at <= options.atAfter) return false;
    if (options?.types && !options.types.includes(entry.type)) return false;
    if (options?.kinds && (entry.type !== 'event' || !options.kinds.includes(entry.kind))) return false;
    return true;
  });
  if (options?.last !== undefined) {
    const last = Number.isFinite(options.last) ? Math.floor(options.last) : 0;
    out = last > 0 ? out.slice(-last) : [];
  }
  if (options?.limit !== undefined) {
    const limit = Number.isFinite(options.limit) ? Math.floor(options.limit) : 0;
    out = limit > 0 ? out.slice(0, limit) : [];
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

// ---- 会话名 ----

/**
 * 会话名不能是空串、`.`、`..`：它们放不进 URL 的一段路径（空的一段没有了，`.` 和 `..` 被规范化折叠掉），
 * 经远端存储读不到也删不掉。存储的每个方法和远端的客户端、服务端都先调它，抛 `invalid_request`。
 * 别的名字（带 `/`、`%`、中文的）都行。
 */
export function checkSessionName(session: string): void {
  if (typeof session === 'string' && session !== '' && session !== '.' && session !== '..') return;
  throw new CtxError(
    'invalid_request',
    `Invalid session name ${JSON.stringify(session)}: it must be a non-empty string other than "." and "..".`,
  );
}

// ---- 写入前提 ----

/** 会话当前最后一条的 `seq`，空会话是 0。用 `list({ last: 1 })`，存储不必为它加方法。 */
export async function headSeq(store: Pick<SessionStore, 'list'>, session: string): Promise<number> {
  const [last] = await store.list(session, { last: 1 });
  return last?.seq ?? 0;
}

/** `append` 的前提不满足时抛的错：`type` 是 `conflict`，`retryable: true`。存储实现和远端客户端共用。 */
export function conflictError(expected: number, actual?: number): CtxError {
  const found = actual === undefined ? '' : `, but it ends at ${actual}`;
  return new CtxError('conflict', `Expected the session to end at seq ${expected}${found}.`, { retryable: true });
}

/** 是不是 `conflict`：本地的 `CtxError` 和远端客户端转出来的错误都认（只看 `type`）。 */
export function isConflict(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { type?: unknown }).type === 'conflict';
}

/** 存储在写入之前调：`options.expectSeq` 不等于当前最后一条的 `seq`（`head`）就抛 `conflict`。 */
export function checkExpectSeq(head: number, options?: AppendOptions): void {
  if (options?.expectSeq !== undefined && options.expectSeq !== head) throw conflictError(options.expectSeq, head);
}

// ---- 框架事件 ----

/** 框架写进会话的事件 `kind`。`ctx.` 前缀保留给框架，应用自定其余的 `{domain}.{action}`。 */
export const CTX_EVENTS = {
  runStarted: 'ctx.run.started',
  runEnded: 'ctx.run.ended',
  compacted: 'ctx.compacted',
  error: 'ctx.error',
  unreadable: 'ctx.unreadable',
  erased: 'ctx.erased',
  redacted: 'ctx.redacted',
} as const;

export type CtxEventKind = (typeof CTX_EVENTS)[keyof typeof CTX_EVENTS];

/**
 * 子运行的来处：父会话、父运行，和父会话里派它的那次工具调用。父会话那一侧，那次调用的结果是 `ChildRunResult`
 * （`childRunOutput`），两边各记一半，从哪边都找得到另一边。
 */
export interface RunParent {
  readonly session: string;
  readonly runId: string;
  readonly toolCallId?: string;
}

/** `parent` 的形状不对时说明哪里不对，对就是 `undefined`。harness 和 remote 服务端用它校验。 */
export function runParentProblem(parent: unknown): string | undefined {
  if (parent === undefined) return undefined;
  if (typeof parent !== 'object' || parent === null || Array.isArray(parent))
    return 'RunRequest.parent must be an object';
  const { session, runId, toolCallId } = parent as Record<string, unknown>;
  if (typeof session !== 'string' || session === '') return 'RunRequest.parent.session must be a non-empty string';
  if (typeof runId !== 'string' || runId === '') return 'RunRequest.parent.runId must be a non-empty string';
  if (toolCallId !== undefined && typeof toolCallId !== 'string')
    return 'RunRequest.parent.toolCallId must be a string';
  return undefined;
}

/** `ctx.run.started` 的 `data`。`agent` 是 `AgentSpec` 的可序列化部分（见 `agentSpecToJson`）。 */
export interface RunStartedData {
  readonly runId: string;
  readonly agent: JsonObject;
  /** 这一轮属于哪个编排器实例（`createOrchestrator({ owner })`）；`recover` 只收同一个 `owner` 的运行。 */
  readonly owner?: string;
  /** 这一轮是别的 agent 派来的（`RunRequest.parent`）。 */
  readonly parent?: RunParent;
  /** 跑这一轮的是外部 harness（自带循环的程序的适配器）时，它是谁、它自己的会话是哪个。参考实现不写。 */
  readonly harness?: HarnessInfo;
}

/**
 * 外部 harness 的身份：名字（`claude-code`、`pi`、`pydantic-ai`）、版本，和它自己的会话标识。自己存对话的程序（Claude
 * Code、pi）把 ctx 的一个会话对到它的一个会话上，下一轮从最近一次记下的 `session` 接着跑。
 */
export interface HarnessInfo {
  readonly name: string;
  readonly version?: string;
  readonly session?: string;
}

/** `ctx.run.ended` 的 `data`。崩溃恢复靠「有 started 没有 ended」找出断掉的运行。 */
export interface RunEndedData {
  readonly runId: string;
  readonly stopReason: StopReason;
  readonly usage?: Usage;
  /**
   * `requires_action` 时，留给外部执行环境的调用归谁执行：调用 `id` → 执行环境的名字（`ToolDefinition.executor`）。
   * 在 harness 里执行的调用（包括等确认的）不在里面。执行方据此按名字领工作（`ctx-remote` 的 `POST /work/:executor/claim`）。
   */
  readonly executors?: Readonly<Record<string, string>>;
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

/**
 * `ctx.unreadable` 的 `data`。这种事件不是写进去的：存储在宽松模式下读到解不了的一行（格式版本比自己认识的高、
 * 带不认识的部件、正文不是 JSON）时，用它占住那一行的位置（见 `readEntry`）。
 */
export interface UnreadableData {
  /** 那一行存着的格式版本；读不出来时没有。 */
  readonly v?: number;
  /** 那一行本来的类型（`message`、`event`、`summary`）；读不出来时没有。 */
  readonly type?: string;
  readonly error: { readonly type: string; readonly message: string };
}

/** 擦除的三种操作，和 `SessionStore` 的方法同名。 */
export type EraseOp = 'truncate' | 'remove' | 'redact';

/**
 * `ctx.erased` 的 `data`：`truncate`、`remove`、`redact` 真的动了条目之后，存储在同一次操作里追加的记录。
 * 只有位置，没有内容。
 */
export interface ErasedData {
  readonly op: EraseOp;
  /** `truncate`：被删掉的条目里最大的 `seq`，`seq` 小于等于它的都不在了。 */
  readonly upTo?: number;
  /** `remove`、`redact`：动了的条目的 `seq`，升序。 */
  readonly seqs?: readonly number[];
  /** 动了多少条。 */
  readonly count: number;
}

/**
 * `ctx.redacted` 的 `data`：被涂改的条目留下的占位。和 `ctx.unreadable` 不同，它是存进去的，`list({ kinds })` 筛得出。
 */
export interface RedactedData {
  /** 原来的类型（`message`、`event`、`summary`）；读不出来时没有。 */
  readonly type?: string;
  /** 原来是消息时它的角色，投影规则想在原位渲染一句「已删除」时用。 */
  readonly role?: string;
}

/** 框架事件的 `kind` 和它的 `data`：`runStartedEntry` 这些按它写，`ctxEventData(entry, kind)` 按它读。 */
export interface CtxEventData {
  readonly 'ctx.run.started': RunStartedData;
  readonly 'ctx.run.ended': RunEndedData;
  readonly 'ctx.compacted': CompactedData;
  readonly 'ctx.error': CtxErrorData;
  readonly 'ctx.unreadable': UnreadableData;
  readonly 'ctx.erased': ErasedData;
  readonly 'ctx.redacted': RedactedData;
}

export function isFrameworkKind(kind: string): boolean {
  return kind.startsWith('ctx.');
}

function ctxEvent<K extends CtxEventKind>(
  kind: K,
  data: CtxEventData[K],
  options: EntryOptions | undefined,
): NewEventEntry {
  return eventEntry(kind, { ...options, data: definedFields(data) });
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

/** 擦除记录，存储实现用；`source` 缺省是 `store`。 */
export function erasedEntry(data: ErasedData, options?: EntryOptions): NewEventEntry {
  return ctxEvent(CTX_EVENTS.erased, data, { source: 'store', ...options });
}

// ---- 读框架事件 ----

/** 是不是 `kind` 这种事件。只收窄到这个 `kind`：不是的那一支里别的事件照样在。 */
export function isEvent<K extends string>(
  entry: Entry | undefined,
  kind: K,
): entry is EventEntry & { readonly kind: K } {
  return entry?.type === 'event' && entry.kind === kind;
}

/**
 * 事件 `data` 里的 `runId`：`ctx.run.started`、`ctx.run.ended`、`ctx.error` 都带，认一条事件是哪一轮的用它。
 * 不是事件、没有或不是字符串时返回 `undefined`。
 */
export function runIdOf(entry: Entry | undefined): string | undefined {
  if (entry?.type !== 'event' || !isJsonObject(entry.data)) return undefined;
  const runId = entry.data['runId'];
  return typeof runId === 'string' ? runId : undefined;
}

function harnessInfoOf(value: JsonValue | undefined): HarnessInfo | undefined {
  if (!isJsonObject(value)) return undefined;
  const { name, version, session } = value;
  if (typeof name !== 'string') return undefined;
  return {
    name,
    ...(typeof version === 'string' ? { version } : {}),
    ...(typeof session === 'string' ? { session } : {}),
  };
}

function runParentOf(value: JsonValue | undefined): RunParent | undefined {
  if (!isJsonObject(value) || runParentProblem(value) !== undefined) return undefined;
  const { session, runId, toolCallId } = value;
  if (typeof session !== 'string' || typeof runId !== 'string') return undefined;
  return { session, runId, ...(typeof toolCallId === 'string' ? { toolCallId } : {}) };
}

/** 值是字符串的那些键；不是对象、一个都没有时 `undefined`。 */
function stringsOf(value: JsonValue | undefined): Record<string, string> | undefined {
  if (!isJsonObject(value)) return undefined;
  const kept = Object.entries(value).filter((pair): pair is [string, string] => typeof pair[1] === 'string');
  return kept.length > 0 ? Object.fromEntries(kept) : undefined;
}

function isEraseOp(value: JsonValue | undefined): value is EraseOp {
  return value === 'truncate' || value === 'remove' || value === 'redact';
}

/** 每种框架事件的 `data` 怎么读：必填字段不对返回 `undefined`，可选字段只留类型对的。 */
const READERS: { readonly [K in CtxEventKind]: (data: JsonObject) => CtxEventData[K] | undefined } = {
  [CTX_EVENTS.runStarted]: ({ runId, agent, owner, parent, harness }) => {
    if (typeof runId !== 'string') return undefined;
    const from = runParentOf(parent);
    const info = harnessInfoOf(harness);
    return {
      runId,
      // 旧日志、别的实现写的可能没有：和缺了一样当作空的。
      agent: isJsonObject(agent) ? agent : {},
      ...(typeof owner === 'string' ? { owner } : {}),
      ...(from ? { parent: from } : {}),
      ...(info ? { harness: info } : {}),
    };
  },
  [CTX_EVENTS.runEnded]: ({ runId, stopReason, usage, executors }) => {
    if (typeof runId !== 'string' || typeof stopReason !== 'string') return undefined;
    const bound = stringsOf(executors);
    return {
      runId,
      stopReason: stopReason as StopReason,
      ...(isJsonObject(usage) ? { usage: usageFromJson(usage) } : {}),
      ...(bound ? { executors: bound } : {}),
    };
  },
  [CTX_EVENTS.compacted]: ({ covers, summaryId }) =>
    typeof covers === 'number' && typeof summaryId === 'string' ? { covers, summaryId } : undefined,
  [CTX_EVENTS.error]: ({ runId, message, type }) =>
    typeof message === 'string'
      ? {
          ...(typeof runId === 'string' ? { runId } : {}),
          message,
          ...(typeof type === 'string' ? { type } : {}),
        }
      : undefined,
  [CTX_EVENTS.unreadable]: ({ v, type, error }) => {
    if (!isJsonObject(error)) return undefined;
    const { type: errorType, message } = error;
    if (typeof errorType !== 'string' || typeof message !== 'string') return undefined;
    return {
      ...(typeof v === 'number' ? { v } : {}),
      ...(typeof type === 'string' ? { type } : {}),
      error: { type: errorType, message },
    };
  },
  [CTX_EVENTS.erased]: ({ op, upTo, seqs, count }) => {
    if (!isEraseOp(op) || typeof count !== 'number') return undefined;
    return {
      op,
      ...(typeof upTo === 'number' ? { upTo } : {}),
      ...(Array.isArray(seqs) && seqs.every((seq): seq is number => typeof seq === 'number') ? { seqs } : {}),
      count,
    };
  },
  [CTX_EVENTS.redacted]: ({ type, role }) => ({
    ...(typeof type === 'string' ? { type } : {}),
    ...(typeof role === 'string' ? { role } : {}),
  }),
};

/**
 * 读一条框架事件的 `data`：`entry` 是 `kind` 这种事件、`data` 是对象、必填字段的类型对，就按 `CtxEventData[kind]` 给出，
 * 否则 `undefined`。可选字段只留类型对的（`parent` 按 `runParentProblem`），别的键不带；`ctx.run.started` 的 `agent`
 * 缺了或不是对象时给 `{}`；`stopReason` 只查是字符串，比这一版新的值原样给出。
 */
export function ctxEventData<K extends CtxEventKind>(entry: Entry | undefined, kind: K): CtxEventData[K] | undefined {
  if (!isEvent(entry, kind) || !isJsonObject(entry.data)) return undefined;
  return READERS[kind](entry.data);
}

/** 最近一轮由名叫 `name` 的外部 harness 跑的运行：它的 `ctx.run.started`、`ctx.run.ended`（还没结束就没有）和记下的 `harness.session`。 */
export interface HarnessRun {
  readonly started: EventEntry;
  readonly ended?: EventEntry;
  /** 外部 harness 自己的会话标识（`HarnessInfo.session`）。 */
  readonly session: string;
}

/**
 * 自己存对话的外部 harness（Claude Code、pi）从哪个会话接着跑：`lifecycle` 是一个会话的 `ctx.run.started`、`ctx.run.ended`，
 * 按 `seq` 排好；从后往前找第一条 `harness.name` 是 `name`、记下了 `harness.session` 的 `ctx.run.started`。没有返回 `undefined`。
 */
export function lastHarnessRun(lifecycle: readonly Entry[], name: string): HarnessRun | undefined {
  for (let index = lifecycle.length - 1; index >= 0; index -= 1) {
    const started = lifecycle[index];
    const data = ctxEventData(started, CTX_EVENTS.runStarted);
    const session = data?.harness?.name === name ? data.harness.session : undefined;
    if (!isEvent(started, CTX_EVENTS.runStarted) || data === undefined || session === undefined) continue;
    const ended = lifecycle
      .slice(index + 1)
      .find((entry): entry is EventEntry => isEvent(entry, CTX_EVENTS.runEnded) && runIdOf(entry) === data.runId);
    return { started, ...(ended ? { ended } : {}), session };
  }
  return undefined;
}
