import type { Message, MessageContent } from './message.ts';
import { compareEntries, type Entry, type EventEntry, type MessageEntry, type SummaryEntry } from './session.ts';
import type { ModelRef } from './harness.ts';
import { estimateTokens } from './tokens.ts';
import type { ToolDefinition } from './tools.ts';
import type { Awaitable } from './types.ts';

// ---- 来源和事实 ----

export interface SourceContext {
  readonly session: string;
  readonly signal?: AbortSignal;
}

/**
 * 生成那一刻才去取的上下文，例如当前任务、粘贴板、天气。
 * 返回的文字只在这一次调用里出现，不写进日志。
 */
export interface ContextSource {
  readonly name: string;
  collect(context: SourceContext): Awaitable<string | null | undefined>;
}

export interface Fact {
  readonly source: string;
  readonly text: string;
}

export function defineSource(name: string, collect: ContextSource['collect']): ContextSource {
  return { name, collect };
}

export interface CollectOptions extends SourceContext {
  /** 单个来源最多等多久，超时就当它这次没有内容。 */
  readonly timeoutMs?: number;
  readonly onError?: (source: string, error: unknown) => void;
}

const DEFAULT_TIMEOUT_MS = 2_000;

function withTimeout<T>(work: Promise<T>, ms: number, name: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`context source "${name}" timed out after ${ms}ms`)), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

/** 并行收集。某个来源出错或超时只影响它自己，顺序按来源列表。 */
export async function collectFacts(sources: readonly ContextSource[], options: CollectOptions): Promise<Fact[]> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const context: SourceContext = options.signal
    ? { session: options.session, signal: options.signal }
    : { session: options.session };
  const results = await Promise.all(
    sources.map(async (source): Promise<Fact | null> => {
      try {
        const text = await withTimeout(Promise.resolve(source.collect(context)), timeoutMs, source.name);
        const trimmed = typeof text === 'string' ? text.trim() : '';
        return trimmed ? { source: source.name, text: trimmed } : null;
      } catch (error) {
        options.onError?.(source.name, error);
        return null;
      }
    }),
  );
  return results.filter((fact): fact is Fact => fact !== null);
}

export function renderFacts(facts: readonly Fact[], heading?: string): string {
  const lines = facts.map((fact) => fact.text);
  return (heading ? [heading, ...lines] : lines).join('\n');
}

// ---- 投影 ----

/** 一种事件怎么进入模型上下文。没有规则的事件不进上下文。 */
export interface EventRule {
  /** 连续出现的同类事件合成一组再渲染。 */
  readonly fold?: boolean;
  /** 把一条事件（或合并后的一组）渲染成消息。返回空就丢掉。 */
  render(events: readonly EventEntry[]): Message | readonly Message[] | null | undefined;
}

/** 窗口：这一次投影最多带多少。能序列化，`AgentSpec`、`BuildRequest` 直接带它。 */
export interface WindowOptions {
  /** 最多保留多少条消息（摘要不算）。 */
  readonly maxMessages?: number;
  /** 估算 token 的预算（摘要计入）。 */
  readonly maxTokens?: number;
}

/** 进程内投影另可换掉 token 估算。 */
export interface ProjectionWindow extends WindowOptions {
  readonly estimate?: (message: Message) => number;
}

export interface ProjectionOptions {
  readonly events?: Readonly<Record<string, EventRule>>;
  /** 摘要渲染成哪条消息。缺省是一条用户消息。 */
  readonly summary?: (entry: SummaryEntry) => Message;
  /** 改写或过滤消息条目，返回空就丢掉。 */
  readonly message?: (entry: MessageEntry) => Message | null | undefined;
  /** 不给就不裁剪：整段历史都带上。 */
  readonly window?: ProjectionWindow;
}

export interface ProjectedMessage {
  readonly message: Message;
  /**
   * 这条消息来自的条目里最小和最大的 `seq`，压缩时用来定切点（见 `covers`）。摘要消息两者都是它的 `covers`。
   * 补写的旧记录按 `at` 排在前面，但 `seq` 很大，所以投影里相邻的两项 `seq` 不一定相邻。
   */
  readonly from: number;
  readonly upTo: number;
  /** 摘要消息固定在最前面，不参与裁剪。 */
  readonly pinned: boolean;
  readonly tokens: number;
}

export interface Projection {
  readonly messages: Message[];
  readonly items: readonly ProjectedMessage[];
  readonly tokens: number;
  /** 被窗口裁掉的消息条数。 */
  readonly dropped: number;
  readonly summary?: SummaryEntry;
}

export function defaultSummaryMessage(entry: SummaryEntry): Message {
  return { role: 'user', content: `Summary of the earlier conversation:\n${entry.text}` };
}

/** 生效的摘要是 `covers` 最大的那一条；`covers` 相同时 `seq` 大的（后写的）生效。 */
export function latestSummary(entries: readonly Entry[]): SummaryEntry | undefined {
  let found: SummaryEntry | undefined;
  for (const entry of entries) {
    if (entry.type !== 'summary') continue;
    if (!found || entry.covers > found.covers || (entry.covers === found.covers && entry.seq > found.seq))
      found = entry;
  }
  return found;
}

function asList(rendered: Message | readonly Message[] | null | undefined): readonly Message[] {
  if (!rendered) return [];
  return Array.isArray(rendered) ? rendered : [rendered as Message];
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
export function project(entries: readonly Entry[], options: ProjectionOptions = {}): Projection {
  const estimate = options.window?.estimate ?? estimateTokens;
  const sorted = entries.toSorted(compareEntries);
  const summary = latestSummary(sorted);
  const visible = sorted.filter((entry) => entry.type !== 'summary' && (!summary || entry.seq > summary.covers)) as (
    | MessageEntry
    | EventEntry
  )[];

  const make = (message: Message, from: number, upTo: number, pinned = false): ProjectedMessage => ({
    message,
    from,
    upTo,
    pinned,
    tokens: estimate(message),
  });

  const pinned: ProjectedMessage[] = [];
  if (summary)
    pinned.push(make((options.summary ?? defaultSummaryMessage)(summary), summary.covers, summary.covers, true));

  const rest: ProjectedMessage[] = [];
  const rules = options.events ?? {};
  // 没有规则的事件对模型不可见，也不打断前后同类事件的合并。
  const shown = visible.filter((entry) => entry.type === 'message' || rules[entry.kind] !== undefined);
  for (let i = 0; i < shown.length; i += 1) {
    const entry = shown[i]!;
    if (entry.type === 'message') {
      const message = options.message ? options.message(entry) : entry.message;
      if (message) rest.push(make(message, entry.seq, entry.seq));
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
    const from = Math.min(...group.map((member) => member.seq));
    const upTo = Math.max(...group.map((member) => member.seq));
    for (const message of asList(rule.render(group))) rest.push(make(message, from, upTo));
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

// ---- 组装 ----

export interface BuildRequest {
  readonly session: string;
  /** 这一轮的输入，接在历史后面。已经写进日志时不传。 */
  readonly input?: MessageContent;
  /** `AgentSpec` 的指令。事实、投影里的 system 文字接在它后面。 */
  readonly instructions?: string;
  /** 最后一条临时用户消息，不写日志。 */
  readonly prompt?: MessageContent;
  /** 候选工具，builder 可以再筛。 */
  readonly tools?: readonly ToolDefinition[];
  /** 覆盖 builder 自己的窗口设置。 */
  readonly window?: WindowOptions;
  /** 是否收集来源，缺省收集。 */
  readonly facts?: boolean;
  readonly signal?: AbortSignal;
}

/** 一次模型调用的输入。能序列化：harness 可以把它交给别处的模型调用方。 */
export interface PreparedCall {
  /** 指令 + 事实 + 投影里的 system 文字；`messages` 里不再有 system 消息。 */
  readonly instructions?: string;
  readonly messages: Message[];
  /** 这次交给模型的工具名，是 `BuildRequest.tools` 的子集。 */
  readonly tools: readonly string[];
  readonly facts: readonly Fact[];
  readonly projection: Projection;
}

export interface ViewOptions {
  readonly window?: WindowOptions;
}

export interface CompactOptions {
  /** 写摘要用的模型。跨边界时只能是名字。 */
  readonly model?: ModelRef;
  /** 最近多少条消息原样保留。 */
  readonly keep?: number;
  /** 更早的消息少于这么多条就不压缩。 */
  readonly minimum?: number;
  readonly instructions?: string;
  readonly maxOutputTokens?: number;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

/**
 * 上下文：把会话日志、来源取到的事实、这一轮的输入组装成一次调用。它持有一个 `SessionStore`，
 * 调用方只给会话名。每次重算，不改日志（压缩除外，它追加摘要）。
 */
export interface ContextBuilder {
  build(request: BuildRequest): Promise<PreparedCall>;
  /** 当前视图：摘要 + 之后的条目，按规则渲染。 */
  view(session: string, options?: ViewOptions): Promise<Projection>;
  /** 把较早的历史压成一条摘要并追加，同时记一条 `ctx.compacted`。历史不够长时返回 null。 */
  compact?(session: string, options?: CompactOptions): Promise<SummaryEntry | null>;
}
