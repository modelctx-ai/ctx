import {
  generateText,
  stepCountIs,
  streamText,
  type LanguageModel,
  type ModelMessage,
  type ToolSet,
  type UserContent,
} from 'ai';

import { messageEntry, textOf, userEntry, type ContextEntry, type NewEntry, type SummaryEntry } from './entry.ts';
import { project, type Projection, type ProjectionOptions, type WindowOptions } from './projection.ts';
import { collectFacts, renderFacts, type ContextSource, type Fact } from './sources.ts';
import type { ContextStore, ListOptions } from './store.ts';
import type { ToolFilter, ToolRegistry } from './tools.ts';
import { silentLogger, type Logger } from './types.ts';

export type ProviderOptions = NonNullable<Parameters<typeof generateText>[0]['providerOptions']>;
export type GenerateTextResult = Awaited<ReturnType<typeof generateText>>;
export type StreamTextResult = ReturnType<typeof streamText>;

export interface ContextOptions {
  readonly store: ContextStore;
  readonly thread: string;
  readonly projection?: ProjectionOptions;
  readonly sources?: readonly ContextSource[];
  readonly tools?: ToolRegistry;
  /** 缺省模型。每次调用也可以单独指定。 */
  readonly model?: LanguageModel;
  /** 经这个上下文追加、又没写 `source` 的条目，记成谁写的。 */
  readonly source?: string;
  readonly logger?: Logger;
  /** 单个上下文来源最多等多久，缺省 2 秒。 */
  readonly sourceTimeoutMs?: number;
}

/** 可以直接给值，也可以给一个拿到本次上下文事实再决定的函数。 */
export type FactAware<T> = T | ((facts: readonly Fact[]) => T | undefined);

export interface PrepareOptions {
  /** 系统指令。给字符串时，本次收集到的事实追加在后面；给函数就由函数自己安排。 */
  readonly instructions?: FactAware<string>;
  /** 放在最后的临时用户消息，不写进日志。 */
  readonly prompt?: FactAware<UserContent>;
  /** 这一轮用户新说的话。`generate` 记录时会先写进日志。 */
  readonly input?: UserContent;
  /** 从工具注册表里挑哪些交给模型。缺省：注册表里的全部。 */
  readonly tools?: ToolFilter;
  /** 是否收集上下文来源，缺省收集。 */
  readonly facts?: boolean;
  /** 覆盖投影里的窗口设置。 */
  readonly window?: WindowOptions;
  readonly signal?: AbortSignal;
}

export interface PreparedCall {
  readonly instructions?: string;
  readonly messages: ModelMessage[];
  readonly tools?: ToolSet;
  readonly facts: readonly Fact[];
  readonly projection: Projection;
}

export interface CallSettings {
  readonly model?: LanguageModel;
  readonly temperature?: number;
  readonly maxOutputTokens?: number;
  readonly topP?: number;
  readonly seed?: number;
  readonly stopSequences?: string[];
  readonly maxRetries?: number;
  /** 整次调用（含工具步骤）的超时。 */
  readonly timeoutMs?: number;
  readonly headers?: Record<string, string>;
  readonly providerOptions?: ProviderOptions;
  /** 工具调用最多走几步。缺省：有工具 5 步，没有工具 1 步。 */
  readonly maxSteps?: number;
}

export interface GenerateOptions extends PrepareOptions, CallSettings {
  /** 把 `input` 和模型回复写进日志，缺省写。 */
  readonly record?: boolean;
}

export interface GenerateResult {
  readonly text: string;
  /** 模型这次产出的消息（含工具调用和结果）。 */
  readonly messages: ModelMessage[];
  /** 实际写进日志的条目。 */
  readonly recorded: readonly ContextEntry[];
  readonly raw: GenerateTextResult;
}

export interface StreamOptions extends GenerateOptions {
  readonly onRecorded?: (entries: readonly ContextEntry[]) => void;
  readonly onError?: (error: unknown) => void;
}

export interface CompactOptions {
  readonly model?: LanguageModel;
  /** 最近多少条消息原样保留，缺省 12。 */
  readonly keep?: number;
  /** 更早的消息少于这么多条就不压缩，缺省 8。 */
  readonly minimum?: number;
  readonly instructions?: string;
  readonly maxOutputTokens?: number;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface Context {
  readonly thread: string;
  readonly store: ContextStore;
  readonly tools: ToolRegistry | undefined;
  append(...entries: NewEntry[]): Promise<ContextEntry[]>;
  entries(options?: ListOptions): Promise<ContextEntry[]>;
  /** 当前交给模型的历史：摘要 + 之后的条目，按投影规则渲染。 */
  view(options?: { readonly window?: WindowOptions }): Promise<Projection>;
  facts(signal?: AbortSignal): Promise<Fact[]>;
  /** 组装一次调用需要的指令、消息和工具，不调用模型。 */
  prepare(options?: PrepareOptions): Promise<PreparedCall>;
  generate(options?: GenerateOptions): Promise<GenerateResult>;
  stream(options?: StreamOptions): Promise<StreamTextResult>;
  /** 把较早的历史压成一条摘要。历史不够长时返回 null。 */
  compact(options?: CompactOptions): Promise<SummaryEntry | null>;
}

const DEFAULT_SUMMARY_INSTRUCTIONS =
  'You compress conversation history. Summarize the transcript you are given so the conversation can continue ' +
  'without it. Keep facts, decisions, commitments, open questions, preferences, names and numbers. ' +
  'Do not invent anything. Use the language of the conversation. Output only the summary.';

function transcript(messages: readonly ModelMessage[]): string {
  const lines: string[] = [];
  for (const message of messages) {
    if (typeof message.content === 'string') {
      lines.push(`${message.role}: ${message.content}`);
      continue;
    }
    const text = textOf(message);
    if (text) lines.push(`${message.role}: ${text}`);
    for (const part of message.content) {
      if (part.type === 'tool-call')
        lines.push(`${message.role} called ${part.toolName}(${JSON.stringify(part.input)})`);
      if (part.type === 'tool-result') lines.push(`${part.toolName} returned ${JSON.stringify(part.output)}`);
    }
  }
  return lines.join('\n');
}

function isEmptyContent(content: UserContent): boolean {
  return typeof content === 'string' ? content.trim() === '' : content.length === 0;
}

export function createContext(options: ContextOptions): Context {
  const { store, thread } = options;
  const logger = options.logger ?? silentLogger;
  const sources = options.sources ?? [];
  const projection = options.projection ?? {};

  function stamp(entry: NewEntry): NewEntry {
    return entry.source === undefined && options.source !== undefined ? { ...entry, source: options.source } : entry;
  }

  async function append(...entries: NewEntry[]): Promise<ContextEntry[]> {
    if (entries.length === 0) return [];
    return store.append(thread, entries.map(stamp));
  }

  /** 只读最近一次摘要之后的部分，长历史不必整段读出来。 */
  async function load(): Promise<ContextEntry[]> {
    const [summary] = await store.list(thread, { types: ['summary'], last: 1 });
    if (summary?.type !== 'summary') return store.list(thread);
    const after = await store.list(thread, { after: summary.covers });
    return after.some((entry) => entry.id === summary.id) ? after : [summary, ...after];
  }

  async function view(viewOptions: { readonly window?: WindowOptions } = {}): Promise<Projection> {
    return project(await load(), { ...projection, window: viewOptions.window ?? projection.window });
  }

  function facts(signal?: AbortSignal): Promise<Fact[]> {
    if (sources.length === 0) return Promise.resolve([]);
    return collectFacts(sources, {
      thread,
      ...(signal ? { signal } : {}),
      ...(options.sourceTimeoutMs !== undefined ? { timeoutMs: options.sourceTimeoutMs } : {}),
      onError: (source, error) =>
        logger.warn(`context source "${source}" failed`, { error: error instanceof Error ? error.message : error }),
    });
  }

  async function prepare(call: PrepareOptions = {}): Promise<PreparedCall> {
    const collected = call.facts === false ? [] : await facts(call.signal);
    const projected = await view(call.window ? { window: call.window } : {});
    const consumed = typeof call.instructions === 'function' || typeof call.prompt === 'function';

    let instructions = typeof call.instructions === 'function' ? call.instructions(collected) : call.instructions;
    if (!consumed && collected.length > 0) {
      instructions = [instructions, renderFacts(collected)].filter((part) => part && part.trim()).join('\n\n');
    }

    const messages = [...projected.messages];
    if (call.input !== undefined && !isEmptyContent(call.input)) messages.push({ role: 'user', content: call.input });
    const prompt = typeof call.prompt === 'function' ? call.prompt(collected) : call.prompt;
    if (prompt !== undefined && !isEmptyContent(prompt)) messages.push({ role: 'user', content: prompt });

    const selected = options.tools && call.tools !== false ? options.tools.select(call.tools ?? true) : {};
    return {
      ...(instructions ? { instructions } : {}),
      messages,
      ...(Object.keys(selected).length > 0 ? { tools: selected } : {}),
      facts: collected,
      projection: projected,
    };
  }

  function settings(call: CallSettings, prepared: PreparedCall, signal: AbortSignal | undefined) {
    const model = call.model ?? options.model;
    if (!model) throw new Error('No language model: pass `model` to createContext() or to the call.');
    return {
      model,
      ...(prepared.instructions ? { instructions: prepared.instructions } : {}),
      messages: prepared.messages,
      ...(prepared.tools ? { tools: prepared.tools } : {}),
      stopWhen: stepCountIs(call.maxSteps ?? (prepared.tools ? 5 : 1)),
      ...(call.temperature !== undefined ? { temperature: call.temperature } : {}),
      ...(call.maxOutputTokens !== undefined ? { maxOutputTokens: call.maxOutputTokens } : {}),
      ...(call.topP !== undefined ? { topP: call.topP } : {}),
      ...(call.seed !== undefined ? { seed: call.seed } : {}),
      ...(call.stopSequences !== undefined ? { stopSequences: call.stopSequences } : {}),
      ...(call.maxRetries !== undefined ? { maxRetries: call.maxRetries } : {}),
      ...(call.timeoutMs !== undefined ? { timeout: call.timeoutMs } : {}),
      ...(call.headers !== undefined ? { headers: call.headers } : {}),
      ...(call.providerOptions !== undefined ? { providerOptions: call.providerOptions } : {}),
      ...(signal ? { abortSignal: signal } : {}),
    };
  }

  /** 记录时先把用户这句写进日志，再组装（组装读到的历史里已经有它）。 */
  async function begin(call: GenerateOptions): Promise<{ prepared: PreparedCall; recorded: ContextEntry[] }> {
    const record = call.record !== false;
    const recorded: ContextEntry[] = [];
    if (record && call.input !== undefined && !isEmptyContent(call.input)) {
      recorded.push(...(await append(userEntry(call.input))));
    }
    const prepared = await prepare(record ? { ...call, input: undefined } : call);
    return { prepared, recorded };
  }

  function responseEntries(messages: readonly ModelMessage[]): NewEntry[] {
    return messages.map((message) => messageEntry(message, { source: 'model' }));
  }

  async function generate(call: GenerateOptions = {}): Promise<GenerateResult> {
    const { prepared, recorded } = await begin(call);
    const raw = await generateText(settings(call, prepared, call.signal));
    const messages: ModelMessage[] = [...raw.responseMessages];
    if (call.record !== false && messages.length > 0) recorded.push(...(await append(...responseEntries(messages))));
    return { text: raw.text, messages, recorded, raw };
  }

  async function stream(call: StreamOptions = {}): Promise<StreamTextResult> {
    const { prepared } = await begin(call);
    return streamText({
      ...settings(call, prepared, call.signal),
      onEnd: async (event) => {
        if (call.record === false || event.responseMessages.length === 0) return;
        try {
          const written = await append(...responseEntries(event.responseMessages));
          call.onRecorded?.(written);
        } catch (error) {
          logger.warn('failed to record streamed response', { error: error instanceof Error ? error.message : error });
        }
      },
      onError: ({ error }) => {
        if (call.onError) call.onError(error);
        else logger.warn('stream failed', { error: error instanceof Error ? error.message : error });
      },
    });
  }

  async function compact(compactOptions: CompactOptions = {}): Promise<SummaryEntry | null> {
    const model = compactOptions.model ?? options.model;
    if (!model) throw new Error('No language model: pass `model` to createContext() or to compact().');
    const full = await view({ window: {} });
    const pinned = full.items.filter((item) => item.pinned);
    const rest = full.items.filter((item) => !item.pinned);
    let cut = rest.length - (compactOptions.keep ?? 12);
    // 不把工具结果和它的调用切到两边。
    while (cut > 0 && rest[cut]?.message.role === 'tool') cut -= 1;
    if (cut < (compactOptions.minimum ?? 8)) return null;

    const older = rest.slice(0, cut);
    const { text } = await generateText({
      model,
      instructions: compactOptions.instructions ?? DEFAULT_SUMMARY_INSTRUCTIONS,
      prompt: transcript([...pinned, ...older].map((item) => item.message)),
      temperature: 0,
      maxOutputTokens: compactOptions.maxOutputTokens ?? 1024,
      ...(compactOptions.timeoutMs !== undefined ? { timeout: compactOptions.timeoutMs } : {}),
      ...(compactOptions.signal ? { abortSignal: compactOptions.signal } : {}),
    });
    const summary = text.trim();
    if (!summary) return null;
    const [entry] = await append({ type: 'summary', text: summary, covers: older.at(-1)!.upTo, source: 'model' });
    return entry?.type === 'summary' ? entry : null;
  }

  return {
    thread,
    store,
    tools: options.tools,
    append,
    entries: (listOptions) => store.list(thread, listOptions),
    view,
    facts,
    prepare,
    generate,
    stream,
    compact,
  };
}
