import {
  collectFacts,
  compactedEntry,
  latestSummary,
  project,
  renderFacts,
  summaryEntry,
  textOf,
  type BuildRequest,
  type CompactOptions,
  type ContextBuilder,
  type ContextSource,
  type Entry,
  type Fact,
  type Logger,
  type ModelRef,
  type PreparedCall,
  type Projection,
  type ProjectionOptions,
  type SessionStore,
  type SummaryEntry,
  type ToolDefinition,
  type ViewOptions,
  silentLogger,
} from '@modelctx-ai/ctx-protocol';
import { generateText, type LanguageModel, type ModelMessage, type ToolResultPart, type UserContent } from 'ai';

/**
 * 事实放在哪：`instructions` 接在指令后面（缺省）；`prompt` 放进最后一条临时用户消息，
 * system 前缀因此每次都一样，服务商的提示缓存能命中。
 */
export type FactsPlacement = 'instructions' | 'prompt';

export interface ContextBuilderOptions {
  readonly store: SessionStore;
  readonly projection?: ProjectionOptions;
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
  facts(session: string, signal?: AbortSignal): Promise<Fact[]>;
  compact(session: string, options?: CompactOptions): Promise<SummaryEntry | null>;
}

const DEFAULT_SUMMARY_INSTRUCTIONS =
  'You compress conversation history. Summarize the transcript you are given so the conversation can continue ' +
  'without it. Keep facts, decisions, commitments, open questions, preferences, names and numbers. ' +
  'Do not invent anything. Use the language of the conversation. Output only the summary.';

/** 图片、文件只写一个占位，例如 `[file image/png]`，数据不进摘要的输入。 */
function placeholder(part: { readonly type: string; readonly mediaType?: unknown }): string {
  const kind = part.type.startsWith('image') ? 'image' : 'file';
  return typeof part.mediaType === 'string' && part.mediaType ? `[${kind} ${part.mediaType}]` : `[${kind}]`;
}

function outputText(output: ToolResultPart['output']): string {
  if (output.type !== 'content' || !Array.isArray(output.value)) return JSON.stringify(output);
  return output.value
    .map((part) => (part.type === 'text' ? part.text : part.type === 'custom' ? '' : placeholder(part)))
    .filter(Boolean)
    .join(' ');
}

function transcript(messages: readonly ModelMessage[]): string {
  const lines: string[] = [];
  for (const message of messages) {
    if (typeof message.content === 'string') {
      lines.push(`${message.role}: ${message.content}`);
      continue;
    }
    const attachments = message.content.filter((part) => part.type === 'image' || part.type === 'file');
    const text = [textOf(message), ...attachments.map(placeholder)].filter(Boolean).join(' ');
    if (text) lines.push(`${message.role}: ${text}`);
    for (const part of message.content) {
      if (part.type === 'tool-call')
        lines.push(`${message.role} called ${part.toolName}(${JSON.stringify(part.input)})`);
      if (part.type === 'tool-result') lines.push(`${part.toolName} returned ${outputText(part.output)}`);
    }
  }
  return lines.join('\n');
}

function messageOf(error: unknown): unknown {
  return error instanceof Error ? error.message : error;
}

export function isEmptyContent(content: UserContent | undefined): boolean {
  if (content === undefined) return true;
  return typeof content === 'string' ? content.trim() === '' : content.length === 0;
}

function joined(parts: readonly (string | undefined)[]): string | undefined {
  const text = parts.filter((part): part is string => part !== undefined && part.trim() !== '').join('\n\n');
  return text || undefined;
}

/** 事实放进临时用户消息：在原来的提示前面加一段文字。 */
function withFacts(prompt: UserContent | undefined, facts: string): UserContent {
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
  readonly instructions?: string | undefined;
  readonly input?: UserContent | undefined;
  readonly prompt?: UserContent | undefined;
  readonly tools?: readonly ToolDefinition[] | undefined;
}

/**
 * 组装一次调用：指令 + 事实 + 投影里的 system 文字；历史；这一轮的输入；最后的临时提示。
 * AI SDK 不收 messages 里的 system 消息，按出现的顺序把文字接到指令后面。
 */
export function assemble(input: AssembleInput): PreparedCall {
  const factText = input.placeFacts && input.facts.length > 0 ? renderFacts(input.facts) : undefined;
  const system: string[] = [];
  const messages: ModelMessage[] = [];
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
  const projection = options.projection ?? {};
  const placement = options.factsPlacement ?? 'instructions';

  /** 只读最近一次摘要之后的部分，长历史不必整段读出来。 */
  async function load(session: string): Promise<Entry[]> {
    // 生效的摘要是 covers 最大的，不一定是最后写的（两个进程同时压缩时），所以读全部摘要再挑。
    const summary = latestSummary(await store.list(session, { types: ['summary'] }));
    if (!summary) return store.list(session);
    const after = await store.list(session, { after: summary.covers });
    return after.some((entry) => entry.id === summary.id) ? after : [summary, ...after];
  }

  async function view(session: string, viewOptions: ViewOptions = {}): Promise<Projection> {
    return project(await load(session), { ...projection, window: viewOptions.window ?? projection.window });
  }

  function facts(session: string, signal?: AbortSignal): Promise<Fact[]> {
    if (sources.length === 0) return Promise.resolve([]);
    return collectFacts(sources, {
      session,
      ...(signal ? { signal } : {}),
      ...(options.sourceTimeoutMs !== undefined ? { timeoutMs: options.sourceTimeoutMs } : {}),
      onError: (source, error) => logger.warn(`context source "${source}" failed`, { error: messageOf(error) }),
    });
  }

  async function build(request: BuildRequest): Promise<PreparedCall> {
    const collected = request.facts === false ? [] : await facts(request.session, request.signal);
    const projected = await view(request.session, request.window ? { window: request.window } : {});
    return assemble({
      projection: projected,
      facts: collected,
      placeFacts: true,
      placement,
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
    const model = resolveModel(ref, options.models);
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
    const maxOutputTokens = compactOptions.maxOutputTokens ?? 1024;
    const { text, finishReason } = await generateText({
      model,
      instructions: compactOptions.instructions ?? DEFAULT_SUMMARY_INSTRUCTIONS,
      prompt: transcript([...pinned, ...older].map((item) => item.message)),
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

  return { build, view, facts, compact };
}
