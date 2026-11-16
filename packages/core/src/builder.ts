import {
  collectFacts,
  CtxError,
  compactedEntry,
  defaultSummaryMessage,
  ENTRY_VERSION,
  estimateTextTokens,
  estimateTokens,
  latestSummary,
  project,
  renderFacts,
  summaryEntry,
  textOf,
  truncateText,
  type BuildRequest,
  type CompactOptions,
  type CompactResult,
  type ContextBuilder,
  type ContextSource,
  type FactsSpec,
  type Entry,
  type InheritSpec,
  type Fact,
  type Logger,
  type Message,
  type MessageContent,
  type ModelRef,
  type PreparedCall,
  type ProjectedMessage,
  type Projection,
  type ProjectionOptions,
  type ProjectionWindow,
  type ToolOutput,
  type SessionStore,
  type SummaryEntry,
  type ToolDefinition,
  type ViewOptions,
  type WindowOptions,
  silentLogger,
} from '@modelctx-ai/ctx-protocol';
import { generateText, type LanguageModel } from 'ai';
import { isContextOverflowError } from './errors.ts';
import type { LossySummary } from './migrate.ts';

/**
 * 事实放在哪：`instructions` 接在指令后面（缺省）；`prompt` 放进最后一条临时用户消息，
 * system 前缀因此每次都一样，服务商的提示缓存能命中。
 */
export type FactsPlacement = 'instructions' | 'prompt';

export interface ContextBuilderOptions {
  readonly store: SessionStore;
  readonly projection?: ProjectionOptions;
  /**
   * 按名字注册的其他投影配置，`AgentSpec.context.projection`、`BuildRequest.projection`、`ViewOptions.projection` 按名字选。
   * `default` 缺省取上面的 `projection`；这里给了 `default` 就以这里的为准。每套配置是完整的，不和 `default` 合并。
   */
  readonly projections?: Readonly<Record<string, ProjectionOptions>>;
  readonly sources?: readonly ContextSource[];
  /** 单个上下文来源最多等多久，缺省 2 秒。 */
  readonly sourceTimeoutMs?: number;
  readonly logger?: Logger;
  readonly factsPlacement?: FactsPlacement;
  /** `compact` 缺省用的模型。 */
  readonly model?: ModelRef;
  /** 模型是名字时怎么造出来。不给时名字没法用。 */
  readonly models?: (name: string) => LanguageModel;
  /**
   * 现在的时刻（毫秒），缺省 `Date.now`。压缩用它认出 `at` 还在未来的条目、算 `timeoutMs` 还剩多少；
   * 存储换了钟（测试）时这里给同一个。
   */
  readonly now?: () => number;
}

/** 参考实现另外给出事实收集，`createContext` 的 `facts()` 用它。 */
export interface LocalContextBuilder extends ContextBuilder {
  readonly store: SessionStore;
  /** 收集事实；`options.sources` 只用这些来源（按名字）。 */
  facts(session: string, signal?: AbortSignal, options?: { readonly sources?: readonly string[] }): Promise<Fact[]>;
  compact(session: string, options?: CompactOptions): Promise<SummaryEntry | null>;
  compactDetailed(session: string, options?: CompactOptions): Promise<CompactResult>;
  /** 对一条 `findLossySummaries` 的结果追加一条取代它的摘要，见 `recompactLossy`。 */
  recompact(finding: LossySummary, options?: CompactOptions): Promise<SummaryEntry | null>;
}

const DEFAULT_SUMMARY_INSTRUCTIONS =
  'You compress conversation history. Summarize the transcript you are given so the conversation can continue ' +
  'without it. Keep facts, decisions, commitments, open questions, preferences, names and numbers. ' +
  'Do not invent anything. Use the language of the conversation. Output only the summary.';

/** 图片、文件只写一个占位，例如 `[file image/png]`，数据不进摘要的输入。 */
function placeholder(part: { readonly type: string; readonly mediaType?: unknown }): string {
  const mediaType = typeof part.mediaType === 'string' ? part.mediaType : '';
  const kind = part.type.startsWith('image') || /^image(\/|$)/i.test(mediaType) ? 'image' : 'file';
  return mediaType ? `[${kind} ${mediaType}]` : `[${kind}]`;
}

/** `compact` 一次交给摘要模型的输入（指令、已有的摘要、一段记录）缺省最多这么多估算 token。 */
export const DEFAULT_COMPACT_INPUT_TOKENS = 24_000;
/** 一条工具调用的输入、一条工具结果进摘要的输入时最多留这么多估算 token：它们常常很长，对摘要的用处却不大。 */
const COMPACT_TOOL_TOKENS = 1_000;
/** 一段里留给记录的地方少于这么多估算 token 就算放不下：再分下去每段只有一两句，摘要没有意义。 */
const MIN_CHUNK_TOKENS = 200;

function outputText(output: ToolOutput): string {
  switch (output.type) {
    case 'text':
      return output.text;
    case 'json':
      return JSON.stringify(output.value);
    case 'error':
      return output.message;
    default:
      return output.parts.map((part) => (part.type === 'text' ? part.text : placeholder(part))).join(' ');
  }
}

/** 一条消息在记录里的写法，可能有几行；没有可写的是空串。`cut` 说工具的输入或输出有没有被截短。 */
interface Transcribed {
  readonly text: string;
  readonly cut: boolean;
}

/**
 * 把一条消息写成纯文本记录。工具调用的输入和工具结果超过 `toolTokens`（按 `tokensOf` 估）的截短：留头尾，
 * 中间注明省略了多少。
 */
function transcribe(message: Message, toolTokens: number, tokensOf: (text: string) => number): Transcribed {
  if (typeof message.content === 'string') return { text: `${message.role}: ${message.content}`, cut: false };
  const lines: string[] = [];
  let cut = false;
  const capped = (text: string): string => {
    const short = truncateText(text, toolTokens, tokensOf);
    if (short !== text) cut = true;
    return short;
  };
  const attachments = message.content.filter((part) => part.type === 'file');
  const text = [textOf(message), ...attachments.map(placeholder)].filter(Boolean).join(' ');
  if (text) lines.push(`${message.role}: ${text}`);
  for (const part of message.content) {
    if (part.type === 'tool-call') {
      lines.push(`${message.role} called ${part.name}(${capped(JSON.stringify(part.input))})`);
    }
    if (part.type === 'tool-result') lines.push(`${part.name} returned ${capped(outputText(part.output))}`);
  }
  return { text: lines.join('\n'), cut };
}

/** 一次滚动摘要要做的事：把 `messages` 一段一段并进摘要。 */
interface Rolling {
  readonly session: string;
  readonly ref: ModelRef;
  readonly options: CompactOptions;
  /** 已有的摘要，带进第一段。 */
  readonly carry: SummaryEntry | undefined;
  /** 要进摘要的消息，按投影顺序。 */
  readonly messages: readonly Message[];
  /**
   * 前 `count` 条进了摘要之后，这条摘要的 `covers`；这个位置不能落检查点时是 `undefined`。
   * `count` 等于 `messages.length` 时一定有。
   */
  covers(count: number): number | undefined;
}

function messageOf(error: unknown): unknown {
  return error instanceof Error ? error.message : error;
}

export function isEmptyContent(content: MessageContent | undefined): boolean {
  if (content === undefined) return true;
  return typeof content === 'string' ? content.trim() === '' : content.length === 0;
}

function joined(parts: readonly (string | undefined)[]): string | undefined {
  const text = parts.filter((part): part is string => part !== undefined && part.trim() !== '').join('\n\n');
  return text || undefined;
}

/** 事实放进临时用户消息：在原来的提示前面加一段文字。 */
function withFacts(prompt: MessageContent | undefined, facts: string): MessageContent {
  if (prompt === undefined || isEmptyContent(prompt)) return facts;
  if (typeof prompt === 'string') return `${facts}\n\n${prompt}`;
  return [{ type: 'text', text: facts }, ...prompt];
}

export interface AssembleInput {
  readonly projection: Projection;
  readonly facts: readonly Fact[];
  /** 是否把事实放进这次调用。`createContext` 的指令或提示是函数时，由函数自己安排，这里给 false。 */
  readonly placeFacts: boolean;
  readonly placement: FactsPlacement;
  /** 事实前面的标题行。 */
  readonly heading?: string | undefined;
  readonly instructions?: string | undefined;
  readonly input?: MessageContent | undefined;
  readonly prompt?: MessageContent | undefined;
  readonly tools?: readonly ToolDefinition[] | undefined;
}

/**
 * 组装一次调用：指令 + 事实 + 投影里的 system 文字；历史；这一轮的输入；最后的临时提示。
 * AI SDK 不收 messages 里的 system 消息，按出现的顺序把文字接到指令后面。
 */
export function assemble(input: AssembleInput): PreparedCall {
  const factText = input.placeFacts && input.facts.length > 0 ? renderFacts(input.facts, input.heading) : undefined;
  const system: string[] = [];
  const messages: Message[] = [];
  for (const message of input.projection.messages) {
    if (message.role === 'system') system.push(textOf(message));
    else messages.push(message);
  }
  const instructions = joined([
    input.instructions,
    input.placement === 'instructions' ? factText : undefined,
    ...system,
  ]);
  if (!isEmptyContent(input.input)) messages.push({ role: 'user', content: input.input! });
  const prompt =
    factText !== undefined && input.placement === 'prompt' ? withFacts(input.prompt, factText) : input.prompt;
  if (!isEmptyContent(prompt)) messages.push({ role: 'user', content: prompt! });
  return {
    ...(instructions !== undefined ? { instructions } : {}),
    messages,
    tools: (input.tools ?? []).map((tool) => tool.name),
    facts: input.facts,
    projection: input.projection,
  };
}

/** 只留投影配置里的 `estimate`：不裁剪，但 token 还按应用给的估。 */
function pickEstimate(options: ProjectionOptions): ProjectionWindow {
  return options.window?.estimate ? { estimate: options.window.estimate } : {};
}

/** 把模型的指代换成 AI SDK 的模型：对象原样，名字经 `models` 造。 */
export function resolveModel(model: ModelRef, models: ((name: string) => LanguageModel) | undefined): LanguageModel {
  if (typeof model !== 'string') return model;
  if (!models) throw new Error(`Model "${model}" is a name; pass \`models\` to resolve model names.`);
  return models(model);
}

/**
 * 请求带了窗口就整个换掉 builder 配的上限（`{}` 是不裁剪），但 `estimate` 始终用 builder 的：
 * 请求能过线、带不了函数，换上限不该顺手把应用接的分词器换回缺省估算。
 * `reserve` 是历史之外已经占掉的 token，从 `maxTokens` 里扣。
 */
function windowOf(chosen: ProjectionOptions, request: WindowOptions | undefined, reserve = 0): ProjectionWindow {
  const limits: WindowOptions = request ?? chosen.window ?? {};
  const maxTokens = limits.maxTokens === undefined ? undefined : Math.max(0, limits.maxTokens - reserve);
  return {
    ...(limits.maxMessages !== undefined ? { maxMessages: limits.maxMessages } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(limits.truncate !== undefined ? { truncate: limits.truncate } : {}),
    ...pickEstimate(chosen),
  };
}

/**
 * 分段压缩时哪里能落检查点。前 `count` 条进了摘要、后面的还没有：这时写一条 covers 在两者之间的摘要，
 * 要求前面的 seq 全在它之内、后面的全在它之外（补写的旧记录让投影顺序和 seq 顺序不一致时不一定成立），
 * 而且后面不以工具结果开头（它的调用会被盖住）。不成立就不落，摘要带在内存里进下一段。
 */
function checkpoints(older: readonly ProjectedMessage[], covers: number): (count: number) => number | undefined {
  const least: number[] = Array.from<number>({ length: older.length + 1 }).fill(Infinity);
  const most: number[] = Array.from<number>({ length: older.length + 1 }).fill(0);
  for (let i = older.length - 1; i >= 0; i -= 1) least[i] = Math.min(older[i]!.from, least[i + 1]!);
  for (let i = 0; i < older.length; i += 1) most[i + 1] = Math.max(older[i]!.upTo, most[i]!);
  return (count) => {
    if (count >= older.length) return covers;
    if (older[count]!.message.role === 'tool') return undefined;
    const boundary = least[count]! - 1;
    return most[count]! <= boundary ? boundary : undefined;
  };
}

/**
 * 上下文的参考实现：投影规则（事件渲染、摘要渲染、消息改写、窗口）+ 来源 + 压缩。
 * 每次从会话存储重算，不改日志；压缩追加一条摘要和一条 `ctx.compacted`。
 */
export function createContextBuilder(options: ContextBuilderOptions): LocalContextBuilder {
  const { store } = options;
  const logger = options.logger ?? silentLogger;
  const sources = options.sources ?? [];
  const projections: Record<string, ProjectionOptions> = {
    default: options.projection ?? {},
    ...options.projections,
  };
  const projection = projections['default']!;
  const placement = options.factsPlacement ?? 'instructions';

  /** 按名字取投影配置；缺省 `default`，不认识的名字报 `not_found`，不回退。 */
  function projectionNamed(name: string | undefined): ProjectionOptions {
    if (name === undefined) return projection;
    const found = Object.hasOwn(projections, name) ? projections[name] : undefined;
    if (!found) {
      throw new CtxError(
        'not_found',
        `Unknown projection "${name}". Registered: ${Object.keys(projections).join(', ')}.`,
      );
    }
    return found;
  }

  /** 只读最近一次摘要之后的部分，长历史不必整段读出来。 */
  async function load(session: string): Promise<Entry[]> {
    // 生效的摘要是 covers 最大的，不一定是最后写的（两个进程同时压缩时），所以读全部摘要再挑。
    const summary = latestSummary(await store.list(session, { types: ['summary'] }));
    if (!summary) return store.list(session);
    const after = await store.list(session, { after: summary.covers });
    return after.some((entry) => entry.id === summary.id) ? after : [summary, ...after];
  }

  /** 另一个会话里 `seq` 不超过 `upTo` 的部分。生效的摘要在 `upTo` 之后时它不算，退回读整段。 */
  async function inherited(spec: InheritSpec): Promise<Entry[]> {
    const { session, upTo } = spec;
    if (upTo === undefined) return load(session);
    let entries = await load(session);
    if (entries.some((entry) => entry.type === 'summary' && entry.seq > upTo)) entries = await store.list(session);
    return entries.filter((entry) => entry.seq <= upTo);
  }

  async function view(session: string, viewOptions: ViewOptions = {}): Promise<Projection> {
    const chosen = projectionNamed(viewOptions.projection);
    return project(await load(session), { ...chosen, window: windowOf(chosen, viewOptions.window) });
  }

  /** 不裁剪的整段视图：压缩要看到全部，builder 配的窗口不能挡着。 */
  async function whole(session: string): Promise<Projection> {
    return project(await load(session), { ...projection, window: { ...pickEstimate(projection) } });
  }

  function facts(session: string, signal?: AbortSignal, factsOptions: { readonly sources?: readonly string[] } = {}) {
    let chosen = sources;
    if (factsOptions.sources) {
      const names = new Set(factsOptions.sources);
      chosen = sources.filter((source) => names.has(source.name));
      for (const name of names) {
        if (!sources.some((source) => source.name === name)) logger.warn(`context source "${name}" is not registered`);
      }
    }
    if (chosen.length === 0) return Promise.resolve<Fact[]>([]);
    return collectFacts(chosen, {
      session,
      ...(signal ? { signal } : {}),
      ...(options.sourceTimeoutMs !== undefined ? { timeoutMs: options.sourceTimeoutMs } : {}),
      onError: (source, error) => logger.warn(`context source "${source}" failed`, { error: messageOf(error) }),
    });
  }

  async function build(request: BuildRequest): Promise<PreparedCall> {
    // 先认投影名：不认识就在收事实之前失败。
    projectionNamed(request.projection);
    const spec: FactsSpec = typeof request.facts === 'object' ? request.facts : {};
    const collected =
      request.facts === false
        ? []
        : await facts(request.session, request.signal, spec.sources ? { sources: spec.sources } : {});
    // 窗口的 `maxTokens` 是整次调用的预算：指令、事实、工具定义、这一轮的输入和提示先占掉一部分，剩下的才给历史。
    const chosen = projectionNamed(request.projection);
    const estimate = chosen.window?.estimate ?? estimateTokens;
    const sized = (content: MessageContent | undefined): number =>
      isEmptyContent(content) ? 0 : estimate({ role: 'user', content: content! });
    const reserve =
      estimateTextTokens(request.instructions ?? '') +
      (collected.length > 0 ? estimateTextTokens(renderFacts(collected, spec.heading)) : 0) +
      (request.tools?.length ? estimateTextTokens(JSON.stringify(request.tools)) : 0) +
      sized(request.input) +
      sized(request.prompt);
    const own = project(await load(request.session), {
      ...chosen,
      window: windowOf(chosen, request.window, reserve),
    });
    const projected = request.inherit
      ? withInherited(
          project(await inherited(request.inherit), {
            ...chosen,
            window: windowOf(chosen, request.window, reserve + own.tokens),
          }),
          own,
        )
      : own;
    const call = assemble({
      projection: projected,
      facts: collected,
      placeFacts: true,
      placement: spec.placement ?? placement,
      heading: spec.heading,
      instructions: request.instructions,
      input: request.input,
      prompt: request.prompt,
      tools: request.tools,
    });
    return { ...call, tokens: reserve + projected.tokens };
  }

  const now = options.now ?? Date.now;
  /** 一段文字的估算 token：应用换了估算就按它的（当成一条用户消息），否则按字数。 */
  const custom = projection.window?.estimate;
  const tokensOf = custom ? (text: string): number => custom({ role: 'user', content: text }) : estimateTextTokens;

  function modelFor(compactOptions: CompactOptions, method: string): ModelRef {
    const ref = compactOptions.model ?? options.model;
    if (ref === undefined) {
      throw new CtxError('no_model', `No language model: pass \`model\` to the context builder or to ${method}().`);
    }
    return ref;
  }

  async function compactDetailed(session: string, compactOptions: CompactOptions = {}): Promise<CompactResult> {
    const ref = modelFor(compactOptions, 'compact');
    const full = await whole(session);
    const rest = full.items.filter((item) => !item.pinned);
    // `at` 还在未来的条目（把到期时间当 `at` 的提醒）一直排在视图的最后。把它们算进「最近 keep 条」，
    // 它们的 seq 会把 covers 钉在自己前面，之后写的消息永远压不了。所以数「最近的」时不算它们：
    // 写在切点之前的进摘要，写在切点之后的照常留在视图里。
    const moment = now();
    const present = rest.filter((item) => item.at <= moment);
    let cut = present.length - Math.max(0, Math.floor(compactOptions.keep ?? 12));
    // 不把工具结果和它的调用切到两边。
    while (cut > 0 && present[cut]?.message.role === 'tool') cut -= 1;
    const nothing: CompactResult = { status: 'not_needed', calls: 0, compacted: 0, remaining: 0, shortened: 0 };
    if (cut <= 0 || cut < (compactOptions.minimum ?? 8)) return nothing;

    // 切点按日志顺序定：被保留的条目里最小的 seq 减 1。补写的旧记录按 `at` 排在前面，但 seq 在后面，
    // 不在这次摘要里，压缩后仍然可见；seq 在 covers 之内的条目一定都进摘要。
    const kept = new Set(present.slice(cut));
    const candidates = rest.filter((item) => !kept.has(item));
    // 用循环，不用 `Math.min(...数组)`：几十万条时展开成参数会栈溢出。
    let covers = kept.size > 0 ? Infinity : 0;
    if (kept.size > 0) for (const item of kept) covers = Math.min(covers, item.from - 1);
    else for (const item of rest) covers = Math.max(covers, item.upTo);
    // fold 合并的事件组可能混进补写的旧记录：组的 seq 范围横跨切点（from ≤ covers < upTo）时，
    // 整组进摘要会让 seq > covers 的成员留在视图里重复，整组留下又会让 seq ≤ covers 的成员被盖住。
    // 只能把 covers 退到这一组的第一条之前，让整组都留在视图里。退一次可能让别的组横跨，所以退到不再有为止。
    for (let moved = true; moved;) {
      moved = false;
      for (const item of candidates) {
        if (item.from <= covers && covers < item.upTo) {
          covers = item.from - 1;
          moved = true;
        }
      }
    }
    const older = candidates.filter((item) => item.upTo <= covers);
    if (older.length === 0) return nothing;
    return roll({
      session,
      ref,
      options: compactOptions,
      carry: full.summary,
      messages: older.map((item) => item.message),
      covers: checkpoints(older, covers),
    });
  }

  async function record(session: string, text: string, covers: number): Promise<SummaryEntry | undefined> {
    const id = crypto.randomUUID();
    const [entry] = await store.append(session, [
      summaryEntry(text, covers, { id, source: 'model' }),
      compactedEntry({ covers, summaryId: id }, { source: 'context' }),
    ]);
    return entry?.type === 'summary' ? entry : undefined;
  }

  /**
   * 滚动摘要：按 `maxInputTokens` 把记录分段，每段连同到目前为止的摘要交给模型，得到新的摘要，再带进下一段。
   * 能落检查点的地方每段写一条 `summary` 和一条 `ctx.compacted`：中途出错、超时或被截断，已经压好的不丢，
   * 下次从那里接着压。摘要被截断或没有内容的那一段不写。
   */
  async function roll(job: Rolling): Promise<CompactResult> {
    const { session, messages } = job;
    const compactOptions = job.options;
    const instructions = compactOptions.instructions ?? DEFAULT_SUMMARY_INSTRUCTIONS;
    const maxOutputTokens = compactOptions.maxOutputTokens ?? 1024;
    const deadline = compactOptions.timeoutMs !== undefined ? now() + compactOptions.timeoutMs : undefined;
    const overhead = tokensOf(instructions);
    const model = resolveModel(job.ref, options.models);
    const render = projection.summary ?? defaultSummaryMessage;
    /** 还没写下的摘要也要渲染成一行带进下一段：借已有摘要的壳，只换文字。 */
    const shell: SummaryEntry = job.carry ?? {
      type: 'summary',
      id: '',
      session,
      seq: 0,
      at: now(),
      v: ENTRY_VERSION,
      text: '',
      covers: 0,
    };

    let budget = Math.max(1, Math.floor(compactOptions.maxInputTokens ?? DEFAULT_COMPACT_INPUT_TOKENS));
    let carry: SummaryEntry | undefined = job.carry;
    let written: SummaryEntry | undefined;
    let done = 0;
    let saved = 0;
    let calls = 0;
    let shortened = 0;
    const result = (status: CompactResult['status']): CompactResult => ({
      status,
      ...(written ? { summary: written } : {}),
      calls,
      compacted: saved,
      remaining: messages.length - saved,
      shortened,
    });

    while (done < messages.length) {
      const before = carry ? transcribe(render(carry), Infinity, tokensOf).text : '';
      // 每行另算 1：行与行之间的换行，和各行分别取整的零头。
      const room = budget - overhead - (before ? tokensOf(before) + 1 : 0);
      if (room < MIN_CHUNK_TOKENS) return result('input_too_long');
      const toolTokens = Math.min(COMPACT_TOOL_TOKENS, Math.floor(room / 4));
      const lines: string[] = [];
      let used = 0;
      let next = done;
      let cuts = 0;
      for (; next < messages.length; next += 1) {
        let { text, cut } = transcribe(messages[next]!, toolTokens, tokensOf);
        if (!text) continue;
        let cost = tokensOf(text) + 1;
        if (used + cost > room) {
          if (lines.length > 0) break;
          // 单条就超过一段的预算：截短它，不然永远过不去。
          text = truncateText(text, room - 1, tokensOf);
          cost = tokensOf(text) + 1;
          cut = true;
        }
        lines.push(text);
        used += cost;
        if (cut) cuts += 1;
      }
      // 这一段的消息都没有可写的内容（空消息）：不用调模型。
      if (lines.length === 0) break;
      const remaining = deadline === undefined ? undefined : deadline - now();
      if (remaining !== undefined && remaining <= 0) {
        throw new CtxError('timeout', `compact() timed out after ${compactOptions.timeoutMs}ms.`, { retryable: true });
      }
      let text: string;
      let finishReason: string;
      try {
        calls += 1;
        ({ text, finishReason } = await generateText({
          model,
          instructions,
          prompt: (before ? [before, ...lines] : lines).join('\n'),
          temperature: 0,
          maxOutputTokens,
          ...(remaining !== undefined ? { timeout: remaining } : {}),
          ...(compactOptions.signal ? { abortSignal: compactOptions.signal } : {}),
        }));
      } catch (error) {
        // 摘要模型自己说放不下（上限配得比它的窗口大，或者估算偏小）：这一段减半再试。
        if (!isContextOverflowError(error) || compactOptions.signal?.aborted) throw error;
        budget = Math.floor(budget / 2);
        logger.warn('summary model rejected the input as too long; retrying with half the budget', {
          maxInputTokens: budget,
        });
        continue;
      }
      // 被 maxOutputTokens 截断的摘要会丢事实，宁可这一段不压。
      if (finishReason === 'length') {
        logger.warn('summary hit maxOutputTokens; history not compacted', { maxOutputTokens });
        return result('truncated');
      }
      const summary = text.trim();
      if (!summary) return result('empty');
      done = next;
      shortened += cuts;
      const covers = job.covers(done);
      const entry = covers === undefined ? undefined : await record(session, summary, covers);
      if (entry) {
        written = entry;
        saved = done;
      }
      carry = entry ?? { ...(carry ?? shell), text: summary };
    }
    return result(written ? 'compacted' : 'not_needed');
  }

  async function compact(session: string, compactOptions: CompactOptions = {}): Promise<SummaryEntry | null> {
    return (await compactDetailed(session, compactOptions)).summary ?? null;
  }

  async function recompact(finding: LossySummary, compactOptions: CompactOptions = {}): Promise<SummaryEntry | null> {
    const ref = modelFor(compactOptions, 'recompactLossy');
    const { session } = finding;
    const old = (await store.list(session, { types: ['summary'] })).find((entry) => entry.id === finding.summaryId);
    if (old?.type !== 'summary' || finding.hidden.length === 0) return null;
    const hidden = new Set(finding.hidden);
    const first = finding.hidden.reduce((least, seq) => Math.min(least, seq), Infinity);
    const entries = (await store.list(session, { after: first - 1 })).filter((entry) => hidden.has(entry.seq));
    // 输入是旧摘要的文字，加上被误盖住的条目（按投影规则渲染）。`covers` 不变，靠“相同时后写的生效”取代旧摘要：
    // 所以中途不落检查点（写一半的摘要会取代旧的），全部并完才写。
    const rendered = project(entries, { ...projection, window: { ...pickEstimate(projection) } });
    const result = await roll({
      session,
      ref,
      options: compactOptions,
      carry: old,
      messages: rendered.messages,
      covers: (count) => (count >= rendered.messages.length ? old.covers : undefined),
    });
    return result.summary ?? null;
  }

  return { store, build, view, facts, compact, compactDetailed, recompact };
}

/** 父会话的投影接在本会话的前面：消息、token、丢弃和截短的条数相加，生效的摘要取本会话的。 */
function withInherited(parent: Projection, own: Projection): Projection {
  return {
    messages: [...parent.messages, ...own.messages],
    items: [...parent.items, ...own.items],
    tokens: parent.tokens + own.tokens,
    dropped: parent.dropped + own.dropped,
    truncated: parent.truncated + own.truncated,
    ...(own.summary ? { summary: own.summary } : {}),
  };
}
