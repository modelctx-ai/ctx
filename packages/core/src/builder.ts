import {
  collectFacts,
  CtxError,
  compactedEntry,
  defaultSummaryMessage,
  latestSummary,
  project,
  renderFacts,
  summaryEntry,
  textOf,
  type BuildRequest,
  type CompactOptions,
  type ContextBuilder,
  type ContextSource,
  type FactsSpec,
  type Entry,
  type Fact,
  type Logger,
  type Message,
  type MessageContent,
  type ModelRef,
  type PreparedCall,
  type Projection,
  type ProjectionOptions,
  type ToolOutput,
  type SessionStore,
  type SummaryEntry,
  type ToolDefinition,
  type ViewOptions,
  silentLogger,
} from '@modelctx-ai/ctx-protocol';
import { generateText, type LanguageModel } from 'ai';
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
}

/** 参考实现另外给出事实收集，`createContext` 的 `facts()` 用它。 */
export interface LocalContextBuilder extends ContextBuilder {
  readonly store: SessionStore;
  /** 收集事实；`options.sources` 只用这些来源（按名字）。 */
  facts(session: string, signal?: AbortSignal, options?: { readonly sources?: readonly string[] }): Promise<Fact[]>;
  compact(session: string, options?: CompactOptions): Promise<SummaryEntry | null>;
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

function transcript(messages: readonly Message[]): string {
  const lines: string[] = [];
  for (const message of messages) {
    if (typeof message.content === 'string') {
      lines.push(`${message.role}: ${message.content}`);
      continue;
    }
    const attachments = message.content.filter((part) => part.type === 'file');
    const text = [textOf(message), ...attachments.map(placeholder)].filter(Boolean).join(' ');
    if (text) lines.push(`${message.role}: ${text}`);
    for (const part of message.content) {
      if (part.type === 'tool-call') lines.push(`${message.role} called ${part.name}(${JSON.stringify(part.input)})`);
      if (part.type === 'tool-result') lines.push(`${part.name} returned ${outputText(part.output)}`);
    }
  }
  return lines.join('\n');
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

/** 把模型的指代换成 AI SDK 的模型：对象原样，名字经 `models` 造。 */
export function resolveModel(model: ModelRef, models: ((name: string) => LanguageModel) | undefined): LanguageModel {
  if (typeof model !== 'string') return model;
  if (!models) throw new Error(`Model "${model}" is a name; pass \`models\` to resolve model names.`);
  return models(model);
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

  async function view(session: string, viewOptions: ViewOptions = {}): Promise<Projection> {
    const chosen = projectionNamed(viewOptions.projection);
    return project(await load(session), { ...chosen, window: viewOptions.window ?? chosen.window });
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
    const projected = await view(request.session, {
      ...(request.window ? { window: request.window } : {}),
      ...(request.projection !== undefined ? { projection: request.projection } : {}),
    });
    return assemble({
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
  }

  async function compact(session: string, compactOptions: CompactOptions = {}): Promise<SummaryEntry | null> {
    const ref = compactOptions.model ?? options.model;
    if (ref === undefined) {
      throw new Error('No language model: pass `model` to the context builder or to compact().');
    }
    const full = await view(session, { window: {} });
    const pinned = full.items.filter((item) => item.pinned);
    const rest = full.items.filter((item) => !item.pinned);
    let cut = rest.length - (compactOptions.keep ?? 12);
    // 不把工具结果和它的调用切到两边。
    while (cut > 0 && rest[cut]?.message.role === 'tool') cut -= 1;
    if (cut <= 0 || cut < (compactOptions.minimum ?? 8)) return null;

    // 切点按日志顺序定：被保留的条目里最小的 seq 减 1。补写的旧记录按 `at` 排在前面，但 seq 在后面，
    // 不在这次摘要里，压缩后仍然可见；seq 在 covers 之内的条目一定都进摘要。
    const kept = rest.slice(cut);
    let covers =
      kept.length > 0 ? Math.min(...kept.map((item) => item.from)) - 1 : Math.max(...rest.map((item) => item.upTo));
    // fold 合并的事件组可能混进补写的旧记录：组的 seq 范围横跨切点（from ≤ covers < upTo）时，
    // 整组进摘要会让 seq > covers 的成员留在视图里重复，整组留下又会让 seq ≤ covers 的成员被盖住。
    // 只能把 covers 退到这一组的第一条之前，让整组都留在视图里。退一次可能让别的组横跨，所以退到不再有为止。
    for (let moved = true; moved;) {
      moved = false;
      for (const item of rest.slice(0, cut)) {
        if (item.from <= covers && covers < item.upTo) {
          covers = item.from - 1;
          moved = true;
        }
      }
    }
    const older = rest.slice(0, cut).filter((item) => item.upTo <= covers);
    if (older.length === 0) return null;
    return write(
      session,
      covers,
      [...pinned, ...older].map((item) => item.message),
      ref,
      compactOptions,
    );
  }

  /** 让模型把一段记录压成摘要，追加一条 `summary` 和一条 `ctx.compacted`；被截断或没有内容时返回 null，不写。 */
  async function write(
    session: string,
    covers: number,
    messages: readonly Message[],
    ref: ModelRef,
    compactOptions: CompactOptions,
  ): Promise<SummaryEntry | null> {
    const maxOutputTokens = compactOptions.maxOutputTokens ?? 1024;
    const { text, finishReason } = await generateText({
      model: resolveModel(ref, options.models),
      instructions: compactOptions.instructions ?? DEFAULT_SUMMARY_INSTRUCTIONS,
      prompt: transcript(messages),
      temperature: 0,
      maxOutputTokens,
      ...(compactOptions.timeoutMs !== undefined ? { timeout: compactOptions.timeoutMs } : {}),
      ...(compactOptions.signal ? { abortSignal: compactOptions.signal } : {}),
    });
    // 被 maxOutputTokens 截断的摘要会丢事实，宁可这次不压缩。
    if (finishReason === 'length') {
      logger.warn('summary hit maxOutputTokens; history not compacted', { maxOutputTokens });
      return null;
    }
    const summary = text.trim();
    if (!summary) return null;
    const id = crypto.randomUUID();
    const [entry] = await store.append(session, [
      summaryEntry(summary, covers, { id, source: 'model' }),
      compactedEntry({ covers, summaryId: id }, { source: 'context' }),
    ]);
    return entry?.type === 'summary' ? entry : null;
  }

  async function recompact(finding: LossySummary, compactOptions: CompactOptions = {}): Promise<SummaryEntry | null> {
    const ref = compactOptions.model ?? options.model;
    if (ref === undefined) {
      throw new Error('No language model: pass `model` to the context builder or to recompactLossy().');
    }
    const { session } = finding;
    const old = (await store.list(session, { types: ['summary'] })).find((entry) => entry.id === finding.summaryId);
    if (old?.type !== 'summary' || finding.hidden.length === 0) return null;
    const hidden = new Set(finding.hidden);
    const entries = (await store.list(session, { after: Math.min(...finding.hidden) - 1 })).filter((entry) =>
      hidden.has(entry.seq),
    );
    // 输入是旧摘要的文字，加上被误盖住的条目（按投影规则渲染）。`covers` 不变，靠“相同时后写的生效”取代旧摘要。
    const rendered = project(entries, { ...projection, window: {} });
    const summary = (projection.summary ?? defaultSummaryMessage)(old);
    return write(session, old.covers, [summary, ...rendered.messages], ref, compactOptions);
  }

  return { store, build, view, facts, compact, recompact };
}
