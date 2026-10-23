import {
  generateText,
  stepCountIs,
  streamText,
  type LanguageModel,
  type ModelMessage,
  type ToolResultPart,
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
  /** 这一轮用户新说的话。`generate`、`stream` 记录时会先写进日志。 */
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
  /** 投影里的 system 消息不放进 `messages`，文字按顺序接在这里的最后。 */
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
  /**
   * 用户这句（`input`）的幂等键。记录时这句在调用模型之前就写进日志，模型调用失败它也留着；
   * 失败后用同一个键重试，就不会再记一遍。
   */
  readonly inputKey?: string;
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
  /** 流出错时调用。不给、上下文也没有 logger 时，沿用 AI SDK 的缺省处理（console.error）。 */
  readonly onError?: (error: unknown) => void;
}

export interface ContextStream {
  readonly result: StreamTextResult;
  /**
   * 回复写进日志以后，给出这次写入的全部条目（含先写的用户这句）：流出错或中止时只有用户这句，
   * `record: false` 时是 []。只在写日志失败时 reject。和 `result.text` 一样，读它会让流跑完。
   */
  readonly recorded: Promise<readonly ContextEntry[]>;
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
  stream(options?: StreamOptions): Promise<ContextStream>;
  /** 把较早的历史压成一条摘要。历史不够长时返回 null。 */
  compact(options?: CompactOptions): Promise<SummaryEntry | null>;
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

function isEmptyContent(content: UserContent): boolean {
  return typeof content === 'string' ? content.trim() === '' : content.length === 0;
}

function settings(model: LanguageModel, call: GenerateOptions, prepared: PreparedCall) {
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
    ...(call.signal ? { abortSignal: call.signal } : {}),
  };
}

function responseEntries(messages: readonly ModelMessage[]): NewEntry[] {
  return messages.map((message) => messageEntry(message, { source: 'model' }));
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
      onError: (source, error) => logger.warn(`context source "${source}" failed`, { error: messageOf(error) }),
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

    // AI SDK 不收 messages 里的 system 消息：按出现的顺序把文字接到指令后面。
    const messages: ModelMessage[] = [];
    const system: string[] = [];
    for (const message of projected.messages) {
      if (message.role === 'system') system.push(textOf(message));
      else messages.push(message);
    }
    if (system.length > 0) {
      instructions = [instructions, ...system].filter((part) => part && part.trim()).join('\n\n');
    }

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

  function modelFor(call: CallSettings): LanguageModel {
    const model = call.model ?? options.model;
    if (!model) throw new Error('No language model: pass `model` to createContext() or to the call.');
    return model;
  }

  /** 记录时先把用户这句写进日志，再组装（组装读到的历史里已经有它）。调用方先确认有模型再来。 */
  async function begin(call: GenerateOptions): Promise<{ prepared: PreparedCall; recorded: ContextEntry[] }> {
    const record = call.record !== false;
    const recorded: ContextEntry[] = [];
    if (record && call.input !== undefined && !isEmptyContent(call.input)) {
      const keyed = call.inputKey !== undefined ? { key: call.inputKey } : undefined;
      recorded.push(...(await append(userEntry(call.input, keyed))));
    }
    const prepared = await prepare(record ? { ...call, input: undefined } : call);
    return { prepared, recorded };
  }

  async function generate(call: GenerateOptions = {}): Promise<GenerateResult> {
    const model = modelFor(call);
    const { prepared, recorded } = await begin(call);
    const raw = await generateText(settings(model, call, prepared));
    const messages: ModelMessage[] = [...raw.responseMessages];
    if (call.record !== false && messages.length > 0) recorded.push(...(await append(...responseEntries(messages))));
    return { text: raw.text, messages, recorded, raw };
  }

  async function stream(call: StreamOptions = {}): Promise<ContextStream> {
    const model = modelFor(call);
    const { prepared, recorded: input } = await begin(call);
    // 只有调用方给了 onError、或上下文配了 logger 才接管，否则保留 AI SDK 的缺省（console.error）。
    const report =
      call.onError ??
      (options.logger ? (error: unknown) => logger.warn('stream failed', { error: messageOf(error) }) : undefined);
    const onError = report ? { onError: ({ error }: { error: unknown }) => report(error) } : {};
    if (call.record === false) {
      return { result: streamText({ ...settings(model, call, prepared), ...onError }), recorded: Promise.resolve([]) };
    }

    const recorded = Promise.withResolvers<readonly ContextEntry[]>();
    // 没人等 recorded 时，写日志失败也不能变成未处理的 rejection。
    recorded.promise.catch(() => {});
    let ending = false;
    const result = streamText({
      ...settings(model, call, prepared),
      ...onError,
      onEnd: async (event) => {
        ending = true;
        try {
          const messages = event.responseMessages;
          const written = messages.length > 0 ? await append(...responseEntries(messages)) : [];
          recorded.resolve([...input, ...written]);
        } catch (error) {
          logger.warn('failed to record streamed response', { error: messageOf(error) });
          recorded.reject(error);
        }
      },
      onAbort: () => {
        if (!ending) recorded.resolve(input);
      },
    });
    let watched = false;
    return {
      result,
      get recorded() {
        if (!watched) {
          watched = true;
          // 出错或没有输出时 AI SDK 不调 onEnd，只让结果的 promise reject；读它也会让流跑完。
          result.finishReason.then(undefined, () => {
            if (!ending) recorded.resolve(input);
          });
        }
        return recorded.promise;
      },
    };
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
    if (cut <= 0 || cut < (compactOptions.minimum ?? 8)) return null;

    const older = rest.slice(0, cut);
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
