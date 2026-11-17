import type { Message, MessageContent } from './message.ts';
import {
  compareEntries,
  type Entry,
  type EventEntry,
  type MessageEntry,
  type SessionStore,
  type SummaryEntry,
} from './session.ts';
import type { ModelRef } from './harness.ts';
import { estimateTokens, truncateMessage } from './tokens.ts';
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
  /**
   * 放不下时截短消息，不只是整条丢（`truncateMessage`：文字留头尾，工具结果截短，内联的文件换成说明）：
   * 先给单条消息封顶（超过历史预算一半的截到一半），再从最旧的丢起；丢到只剩最后一组还超，从最大的接着截，直到放得下。
   * 缺省不截：宁可超预算也原样交出最后一组。没给 `maxTokens` 时不起作用。
   */
  readonly truncate?: boolean;
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
  /**
   * 这条消息来自的条目里最晚的 `at`；摘要消息是摘要条目的 `at`。压缩用它认出 `at` 还在未来的条目
   * （把到期时间当 `at` 的提醒）：它们一直排在最后，但不算「最近的」。
   */
  readonly at: number;
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
  /** 因为 `window.truncate` 被截短的消息条数。 */
  readonly truncated: number;
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

/** 没有结果的工具调用补上的那条结果：模型看到的是「这次调用没有结果」，不是一段对不上的历史。 */
const MISSING_RESULT = 'No result was recorded for this tool call.';

/**
 * 一组里的工具调用和结果按 `id` 配对：
 * - 结果找不到同组里的调用（调用被裁掉、被摘要盖住，或者中间插进了别的消息）就去掉，整条消息空了就不要；
 * - 调用找不到结果（运行中断、结果没写进日志）就补一条错误结果。服务商自己执行的调用（`providerExecuted`）不补。
 * 不这样做的话，服务商会拒绝整段历史，而且每一轮都拒绝，直到这段被裁掉。
 */
function paired(group: readonly ProjectedMessage[], estimate: (message: Message) => number): ProjectedMessage[] {
  const [first, ...results] = group;
  if (!first) return [];
  const calls = new Map<string, string>();
  const answered = new Set<string>();
  if (first.message.role === 'assistant' && typeof first.message.content !== 'string') {
    for (const part of first.message.content) {
      if (part.type === 'tool-call' && part.providerExecuted !== true) calls.set(part.id, part.name);
      if (part.type === 'tool-result') answered.add(part.id);
    }
  }
  const out: ProjectedMessage[] = [first];
  for (const item of results) {
    const { message } = item;
    if (message.role !== 'tool' || typeof message.content === 'string') {
      out.push(item);
      continue;
    }
    const content = message.content.filter((part) => part.type !== 'tool-result' || calls.has(part.id));
    for (const part of content) if (part.type === 'tool-result') answered.add(part.id);
    if (content.length === message.content.length) out.push(item);
    else if (content.length > 0) {
      const trimmed = { ...message, content } as Message;
      out.push({ ...item, message: trimmed, tokens: estimate(trimmed) });
    }
  }
  const missing = [...calls].filter(([id]) => !answered.has(id));
  if (missing.length > 0) {
    const message: Message = {
      role: 'tool',
      content: missing.map(([id, name]) => ({
        type: 'tool-result',
        id,
        name,
        output: { type: 'error', message: MISSING_RESULT },
      })),
    };
    out.push({ message, from: first.from, upTo: first.upTo, at: first.at, pinned: false, tokens: estimate(message) });
  }
  // 整组只剩孤立的工具结果、又都被去掉了：这一组不要。
  return first.message.role === 'tool' ? out.filter((item) => item !== first) : out;
}

function startsWithUser(group: readonly ProjectedMessage[]): boolean {
  return group[0]?.message.role === 'user';
}

/**
 * `settled`：预算挤掉的组（不算开头孤立的工具结果、不算为了以用户消息开头多丢的）比含 `edge` 的开头几组多。
 * 这时结果只取决于后面完整的那些组，见 `projectSession`。
 */
function windowed(
  pinned: readonly ProjectedMessage[],
  rest: readonly ProjectedMessage[],
  window: ProjectionWindow | undefined,
  estimate: (message: Message) => number,
  edge: ReadonlySet<ProjectedMessage> = new Set(),
): { kept: ProjectedMessage[]; dropped: number; truncated: number; settled: boolean } {
  const maxMessages = window?.maxMessages;
  const maxTokens = window?.maxTokens;
  let dropped = 0;
  // 含 `edge` 的组里，最后一组是第几组（从 1 数）；0 是没有。
  let edgeGroups = 0;
  const groups: ProjectedMessage[][] = [];
  for (const group of blocks(rest)) {
    // 开头是工具结果的组：它的调用不在视图里（被摘要盖住了），整组不要。
    if (group[0]?.message.role === 'tool') {
      dropped += group.length;
      continue;
    }
    groups.push(paired(group, estimate));
    if (group.some((item) => edge.has(item))) edgeGroups = groups.length;
  }
  if (maxMessages === undefined && maxTokens === undefined) {
    return { kept: [...pinned, ...groups.flat()], dropped, truncated: 0, settled: false };
  }

  const pinnedTokens = pinned.reduce((sum, item) => sum + item.tokens, 0);
  // 要截短时先给单条消息封顶：一条巨大的工具结果或粘贴进来的长文不该把别的历史全挤掉。
  const cut = new Set<ProjectedMessage>();
  const truncating = window?.truncate === true && maxTokens !== undefined;
  if (truncating) capped(groups, maxTokens - pinnedTokens, estimate, cut);
  let count = groups.reduce((sum, group) => sum + group.length, 0);
  let tokens = pinnedTokens + groups.reduce((sum, group) => sum + group.reduce((s, item) => s + item.tokens, 0), 0);
  const over = (): boolean =>
    (maxMessages !== undefined && count > maxMessages) || (maxTokens !== undefined && tokens > maxTokens);
  // 从前往后丢，只挪下标：几十万组时 `shift()` 每次都要搬动整个数组。
  let start = 0;
  const drop = (): void => {
    const group = groups[start]!;
    start += 1;
    count -= group.length;
    tokens -= group.reduce((sum, item) => sum + item.tokens, 0);
    dropped += group.length;
  };
  const before = dropped;
  let budgetDrops = 0;
  // 至少留下最后一组，宁可超预算也不交一份空上下文。
  while (groups.length - start > 1 && over()) {
    drop();
    budgetDrops += 1;
  }
  // 裁过之后开头落在助手消息上、前面又没有摘要垫着：有的服务商要求第一条是用户消息，接着裁到下一条用户消息。
  // 后面一条用户消息都没有时不动，同样是不交空上下文。
  if (dropped > before && pinned.length === 0 && groups.slice(start).some(startsWithUser)) {
    while (!startsWithUser(groups[start]!)) drop();
  }
  const kept = [...pinned, ...groups.slice(start).flat()];
  if (truncating && tokens > maxTokens) fitted(kept, tokens - maxTokens, estimate, cut);
  return { kept, dropped, truncated: kept.filter((item) => cut.has(item)).length, settled: budgetDrops > edgeGroups };
}

/** 一条消息最少留这么多 token：再截就只剩说明了。 */
const MIN_TRUNCATED_TOKENS = 32;

/** 把 `item` 截到 `maxTokens` 以内；截不动（或没变小）就原样返回。截过的记进 `cut`。 */
function shortened(
  item: ProjectedMessage,
  maxTokens: number,
  estimate: (message: Message) => number,
  cut: Set<ProjectedMessage>,
): ProjectedMessage {
  const message = truncateMessage(item.message, maxTokens, estimate);
  const tokens = estimate(message);
  if (message === item.message || tokens >= item.tokens) return item;
  const next = { ...item, message, tokens };
  cut.delete(item);
  cut.add(next);
  return next;
}

/**
 * 单条消息封顶：超过历史预算一半的截到一半。从最新的一组往回做，累计超过预算就停：更早的反正要被裁掉，不用白截。
 * 就地改 `groups`。
 */
function capped(
  groups: ProjectedMessage[][],
  budget: number,
  estimate: (message: Message) => number,
  cut: Set<ProjectedMessage>,
): void {
  const cap = Math.max(MIN_TRUNCATED_TOKENS, Math.floor(budget / 2));
  let total = 0;
  for (let index = groups.length - 1; index >= 0 && total <= budget; index -= 1) {
    const group = groups[index]!;
    for (let i = 0; i < group.length; i += 1) {
      if (group[i]!.tokens > cap) group[i] = shortened(group[i]!, cap, estimate, cut);
      total += group[i]!.tokens;
    }
  }
}

/**
 * 裁到不能再裁还超 `excess` 个 token：从最大的消息截起，每条最多截掉还超出的那么多。摘要（`pinned`）最后才动。
 * 截不动的（推理、工具调用的输入）留着，所以结果仍可能超。就地改 `kept`。
 */
function fitted(
  kept: ProjectedMessage[],
  excess: number,
  estimate: (message: Message) => number,
  cut: Set<ProjectedMessage>,
): void {
  const order = kept
    .map((item, index) => ({ index, tokens: item.tokens, pinned: item.pinned }))
    .toSorted((a, b) => Number(a.pinned) - Number(b.pinned) || b.tokens - a.tokens);
  let left = excess;
  for (const { index } of order) {
    if (left <= 0) break;
    const item = kept[index]!;
    if (item.tokens <= MIN_TRUNCATED_TOKENS) continue;
    const next = shortened(item, Math.max(MIN_TRUNCATED_TOKENS, item.tokens - left), estimate, cut);
    left -= item.tokens - next.tokens;
    kept[index] = next;
  }
}

/**
 * 把条目渲染成模型消息：
 * 1. 摘要之前的条目由摘要代替，摘要固定放在最前；
 * 2. 消息条目原样带上；事件按规则渲染，`fold` 的同类事件连在一起时合成一组；
 * 3. 工具调用和结果按 `id` 配对：没有调用的结果去掉，没有结果的调用补一条错误结果；
 * 4. 有窗口时从最旧的消息开始裁，工具调用和结果成组进出；裁过之后开头不留助手消息（前面有摘要时除外）；
 *    `window.truncate` 时先给单条消息封顶，裁到只剩最后一组还超 `maxTokens` 就接着截短剩下的消息。
 */
export function project(entries: readonly Entry[], options: ProjectionOptions = {}): Projection {
  return projected(entries, options).projection;
}

function projected(
  entries: readonly Entry[],
  options: ProjectionOptions,
): { projection: Projection; settled: boolean } {
  const estimate = options.window?.estimate ?? estimateTokens;
  const sorted = entries.toSorted(compareEntries);
  const summary = latestSummary(sorted);
  const visible = sorted.filter((entry) => entry.type !== 'summary' && (!summary || entry.seq > summary.covers)) as (
    | MessageEntry
    | EventEntry
  )[];

  const make = (message: Message, from: number, upTo: number, at: number, pinned = false): ProjectedMessage => ({
    message,
    from,
    upTo,
    at,
    pinned,
    tokens: estimate(message),
  });

  const pinned: ProjectedMessage[] = [];
  if (summary)
    pinned.push(
      make((options.summary ?? defaultSummaryMessage)(summary), summary.covers, summary.covers, summary.at, true),
    );

  const rest: ProjectedMessage[] = [];
  // 第一条看得见的条目是要合并的事件时，它那一组在一段尾巴里可能不完整（前面还有同类的）：记下来给 `windowed`。
  const edge = new Set<ProjectedMessage>();
  const rules = options.events ?? {};
  // 没有规则的事件对模型不可见，也不打断前后同类事件的合并。
  const shown = visible.filter((entry) => entry.type === 'message' || rules[entry.kind] !== undefined);
  for (let i = 0; i < shown.length; i += 1) {
    const entry = shown[i]!;
    if (entry.type === 'message') {
      const message = options.message ? options.message(entry) : entry.message;
      if (message) rest.push(make(message, entry.seq, entry.seq, entry.at));
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
    // 不用 `Math.min(...数组)`：一组可以有几十万条（心跳、传感器读数），展开成参数会栈溢出。
    let from = entry.seq;
    let upTo = entry.seq;
    for (const member of group) {
      if (member.seq < from) from = member.seq;
      if (member.seq > upTo) upTo = member.seq;
    }
    // 一组按 `at` 排好了，最后一条的 `at` 最晚。
    const at = group.at(-1)!.at;
    for (const message of asList(rule.render(group))) {
      const item = make(message, from, upTo, at);
      rest.push(item);
      if (rule.fold && entry === shown[0]) edge.add(item);
    }
  }

  const { kept, dropped, truncated, settled } = windowed(pinned, rest, options.window, estimate, edge);
  const projection: Projection = {
    messages: kept.map((item) => item.message),
    items: kept,
    tokens: kept.reduce((sum, item) => sum + item.tokens, 0),
    dropped,
    truncated,
    ...(summary ? { summary } : {}),
  };
  return { projection, settled };
}

/** `projectSession` 第一次读多少条（再加窗口 `maxMessages` 的四倍）；不够就乘 4 再读。 */
const TAIL_PAGE = 256;

/**
 * 一个会话的投影：生效的摘要加它之后的条目，和读出来再 `project` 的结果一样。有窗口时只读够用的尾部，
 * 长会话不必整段读出来：
 * 1. 按 `seq` 读最后 N 条（`last`），再用 `atAfter` 把写得更早、`at` 却排在这 N 条里最早一条之后的条目补进来
 *    （把到期时间当 `at` 的提醒）。读到的是投影顺序里完整的一段尾巴。
 * 2. 投影这段尾巴。开头那组可能不完整：同类事件合成的一组被切开（它渲染出的几条消息都算），或者开头的工具结果
 *    的调用在更前面（这种组本来就不要）。预算把它们和后面至少一个完整的组都挤掉了时，结果和读整段的一样：
 *    更早的部分再长也只会被挤掉。
 * 3. 不够就读 4 倍那么多再来；读到的不满 N 条就是整段。
 *
 * 只读了尾部时，`dropped` 只数读到的那部分里被裁掉的。没有窗口（或者是 `{}`）时读整段。
 */
export async function projectSession(
  store: Pick<SessionStore, 'list'>,
  session: string,
  options: ProjectionOptions = {},
): Promise<Projection> {
  // 生效的摘要是 covers 最大的，不一定是最后写的（两个进程同时压缩时），所以读全部摘要再挑。
  const summary = latestSummary(await store.list(session, { types: ['summary'] }));
  const base = summary ? { after: summary.covers } : {};
  const withSummary = (entries: Entry[]): Entry[] =>
    !summary || entries.some((entry) => entry.id === summary.id) ? entries : [summary, ...entries];
  const window = options.window;
  if (window?.maxMessages === undefined && window?.maxTokens === undefined) {
    return project(withSummary(await store.list(session, base)), options);
  }
  for (let size = TAIL_PAGE + 4 * Math.max(0, Math.floor(window.maxMessages ?? 0)); ; size *= 4) {
    const tail = await store.list(session, { ...base, last: size });
    if (tail.length < size) return project(withSummary(tail), options);
    let first = tail[0]!;
    for (const entry of tail) if (compareEntries(entry, first) < 0) first = entry;
    const earlier = await laterEntries(store, session, summary?.covers, first.at, tail[0]!.seq);
    const { projection, settled } = projected(withSummary([...earlier, ...tail]), options);
    if (settled) return projection;
  }
}

/** `seq` 在 `(after, before)` 里、`at` 大于 `at` 的条目，按 `seq` 一页页读。 */
async function laterEntries(
  store: Pick<SessionStore, 'list'>,
  session: string,
  after: number | undefined,
  at: number,
  before: number,
): Promise<Entry[]> {
  const out: Entry[] = [];
  for (let cursor = after; ;) {
    const page = await store.list(session, {
      ...(cursor !== undefined ? { after: cursor } : {}),
      atAfter: at,
      limit: TAIL_PAGE,
    });
    for (const entry of page) {
      if (entry.seq >= before) return out;
      out.push(entry);
    }
    if (page.length < TAIL_PAGE) return out;
    cursor = page.at(-1)!.seq;
  }
}

// ---- 组装 ----

/** 事实怎么收、放哪。 */
export interface FactsSpec {
  /** 只用这些来源（按 `ContextSource.name`）；缺省全部。 */
  readonly sources?: readonly string[];
  /** 事实接在指令后面（`instructions`），还是放进最后一条临时用户消息（`prompt`）；缺省用 builder 的 `factsPlacement`。 */
  readonly placement?: 'instructions' | 'prompt';
  /** 事实前面的标题行。 */
  readonly heading?: string;
}

/**
 * 按一轮选择事实和投影。函数（来源的 `collect`、投影的 `render`）不能序列化，所以只按名字选：
 * 代码里向 builder 注册，`AgentSpec.context` 里引用名字，和 `ToolSelection` 同一个思路。
 */
export interface ContextSpec {
  /** `false` 不收事实；缺省收。 */
  readonly facts?: boolean | FactsSpec;
  /** builder 里注册的投影配置名；缺省 `default`。不认识的名字，`build`、`view` 以 `not_found` 失败，不回退。 */
  readonly projection?: string;
  /** 整次调用超过模型窗口时怎么办；缺省不检查。见 `OverflowSpec`。 */
  readonly overflow?: OverflowSpec;
  /** 把另一个会话（一般是父会话）的投影接在这个会话的历史前面。见 `InheritSpec`。 */
  readonly inherit?: InheritSpec;
}

/**
 * 子 agent 带着父会话的上下文：`build` 时先投影 `session` 里 `seq` 不超过 `upTo` 的条目，再接上本会话的历史。
 * 只读不写，父会话之后的变化不影响已经写进子会话的东西。上下文怎么给子 agent（全新、一段摘要、父的投影）是应用的决定：
 * 全新就是不给它，摘要就是写进子运行的输入。窗口先给本会话的历史，剩下的才给父会话，放不下时先丢父会话最旧的。
 */
export interface InheritSpec {
  readonly session: string;
  /** 只取到这个 `seq` 为止，缺省全部。派子 agent 时取那次工具调用之前，子 agent 不会看到一个没有结果的调用。 */
  readonly upTo?: number;
}

/** 超窗之后压缩用的参数：`CompactOptions` 里能序列化的那几项。摘要模型不在这里选（见 `OverflowSpec.compact`）。 */
export type OverflowCompactSpec = Pick<
  CompactOptions,
  'keep' | 'minimum' | 'instructions' | 'maxInputTokens' | 'maxOutputTokens' | 'timeoutMs'
>;

/**
 * 超窗兜底：harness 在 `build` 之后估算整次调用，超过 `maxTokens` 就按 `strategy` 处理，处理完还超，这一轮不调模型，
 * 以 `context_overflow` 结束。全是 JSON，随 `AgentSpec.context` 过线、记进 `ctx.run.started`。
 */
export interface OverflowSpec {
  /**
   * 整次调用（指令、事实、工具定义、历史、这一轮的输入和提示）估算 token 的上限。一般取模型的窗口减去留给输出的部分，
   * 再留些余量：估算不分词，会有出入。
   */
  readonly maxTokens: number;
  /**
   * 超了先做什么。`compact`（缺省）：先压缩（`ContextBuilder.compact`），压完还超、压缩没做成或 builder 没有
   * `compact`，再裁剪；`trim`：只裁剪，什么都不写；`error`：什么都不做，这一轮以 `context_overflow` 结束。
   * 裁剪是按 `window: { maxTokens, truncate: true }` 重新 `build`：从最旧的消息丢起，只剩最后一组还超就截短它。
   */
  readonly strategy?: 'compact' | 'trim' | 'error';
  /** 压缩的参数。摘要模型用 builder 配的；builder 没配时 harness 用这一轮的模型。 */
  readonly compact?: OverflowCompactSpec;
}

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
  /** 是否收集来源，缺省收集；给 `FactsSpec` 还能选来源、位置和标题（来自 `AgentSpec.context.facts`）。 */
  readonly facts?: boolean | FactsSpec;
  /** 投影配置名，缺省 `default`（来自 `AgentSpec.context.projection`）。不认识的名字以 `not_found` 失败。 */
  readonly projection?: string;
  /** 接在历史前面的另一个会话的投影（来自 `AgentSpec.context.inherit`）。 */
  readonly inherit?: InheritSpec;
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
  /**
   * 整次调用的估算 token：指令、事实、工具定义、消息（历史、`input`、`prompt`）合起来，按 builder 自己的估算，
   * 校准过的话乘上了 `calibration`。harness 的超窗检查（`OverflowSpec`）用它，也把它记进第一步的
   * `StepMeta.estimatedInputTokens`；builder 不给时 harness 用缺省的估算自己算。
   */
  readonly tokens?: number;
  /**
   * builder 按上一轮的实际用量校准过时乘上的倍数（大于 1）：服务商实际计的输入 token 比估算多这么多，窗口的
   * `maxTokens` 照它收紧过。没校准时不出现。
   */
  readonly calibration?: number;
}

export interface ViewOptions {
  readonly window?: WindowOptions;
  /** 投影配置名，缺省 `default`。不认识的名字以 `not_found` 失败。 */
  readonly projection?: string;
}

export interface CompactOptions {
  /** 写摘要用的模型。跨边界时只能是名字。 */
  readonly model?: ModelRef;
  /** 最近多少条消息原样保留。 */
  readonly keep?: number;
  /** 更早的消息少于这么多条就不压缩。 */
  readonly minimum?: number;
  readonly instructions?: string;
  /**
   * 一次交给摘要模型的输入（压缩指令、已有的摘要、这一段记录）估算 token 的上限，一般取摘要模型的窗口减去
   * `maxOutputTokens` 再留余量。要压的历史超过它就分段：一段一段滚动摘要，上一段的摘要带进下一段。
   * 缺省由实现定（参考实现 24000）。
   */
  readonly maxInputTokens?: number;
  /** 每次摘要输出的上限。 */
  readonly maxOutputTokens?: number;
  /** 整次压缩（分段时含每一段的模型调用）最多多久。 */
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

/**
 * 一次压缩怎么收场：
 * - `compacted`：该压的都进了摘要；
 * - `not_needed`：历史不够长（切点之前不到 `minimum` 条），没调模型，什么都没写；
 * - `truncated`：某一段的摘要被 `maxOutputTokens` 截断，那一段没写，停在那里。调大 `maxOutputTokens` 再来；
 * - `empty`：模型没给出文字，那一段没写，停在那里；
 * - `input_too_long`：分段之后还是放不下——已有的摘要加压缩指令就占满了 `maxInputTokens`，或者摘要模型自己报
 *   上下文过长、把一段减半到底也不行。调大 `maxInputTokens`、调小 `maxOutputTokens`，或者换窗口更大的摘要模型。
 *
 * 后三种停下之前落的检查点留着（`summary` 是最后一个），再调一次从那里接着压。
 */
export type CompactStatus = 'compacted' | 'not_needed' | 'truncated' | 'empty' | 'input_too_long';

/** `compactDetailed` 的结果。全是 JSON。 */
export interface CompactResult {
  readonly status: CompactStatus;
  /** 这次写下的最后一条摘要，也就是现在生效的那条；这次一条都没写时没有。 */
  readonly summary?: SummaryEntry;
  /** 调了几次摘要模型。 */
  readonly calls: number;
  /** 已经进了（写下的）摘要的消息条数。 */
  readonly compacted: number;
  /** 该进摘要、这次没进去的消息条数；`compacted` 时是 0。 */
  readonly remaining: number;
  /** 进摘要的输入之前被截短的消息条数：超长的工具输出，或者单条就超过一段预算的消息。 */
  readonly shortened: number;
}

/**
 * 上下文：把会话日志、来源取到的事实、这一轮的输入组装成一次调用。它持有一个 `SessionStore`，
 * 调用方只给会话名。每次重算，不改日志（压缩除外，它追加摘要）。
 */
export interface ContextBuilder {
  build(request: BuildRequest): Promise<PreparedCall>;
  /** 当前视图：摘要 + 之后的条目，按规则渲染。 */
  view(session: string, options?: ViewOptions): Promise<Projection>;
  /**
   * 把较早的历史压成摘要并追加，同时记 `ctx.compacted`；历史太长时分段滚动摘要（见 `CompactOptions.maxInputTokens`）。
   * 返回这次写下的、现在生效的摘要；一条都没写（历史不够长、摘要被截断、输入放不下）时返回 null，
   * 要分清是哪一种用 `compactDetailed`。
   */
  compact?(session: string, options?: CompactOptions): Promise<SummaryEntry | null>;
  /** 和 `compact` 做同一件事，返回怎么收场的（`CompactResult.status`），应用据此决定下一步。 */
  compactDetailed?(session: string, options?: CompactOptions): Promise<CompactResult>;
}
