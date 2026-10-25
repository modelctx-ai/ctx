import type {
  AgentSpec,
  CallSettings,
  CompactOptions,
  ContextSource,
  Entry,
  Executor,
  Fact,
  Harness,
  Hooks,
  ListOptions,
  Logger,
  NewEntry,
  PreparedCall,
  Projection,
  ProjectionOptions,
  RunEvent,
  RunRequest,
  SessionStore,
  StopReason,
  SummaryEntry,
  ToolFilter,
  ToolRegistry,
  WindowOptions,
} from '@modelctx-ai/ctx-protocol';
import type { generateText, LanguageModel, ModelMessage, ToolSet, UserContent } from 'ai';

import { assemble, createContextBuilder, type FactsPlacement, type LocalContextBuilder } from './builder.ts';
import { createFunctionExecutor, type FunctionExecutor } from './executor.ts';
import { createHarnessRuntime, type GenerateTextResult, type StreamTextResult } from './harness.ts';
import { executorMap, toToolSet, type LocalToolRegistry } from './tools.ts';

export type { GenerateTextResult, StreamTextResult } from './harness.ts';
export type ProviderOptions = NonNullable<Parameters<typeof generateText>[0]['providerOptions']>;

interface ContextBaseOptions {
  readonly store: SessionStore;
  readonly projection?: ProjectionOptions;
  readonly sources?: readonly ContextSource[];
  /** 工具目录。`createToolRegistry()` 建的注册表自带函数执行环境，`addTool` 加的工具不用另给执行环境。 */
  readonly tools?: ToolRegistry;
  /** 其余工具绑定的执行环境，例如 `ctx-mcp` 的 hub。 */
  readonly executors?: readonly Executor[];
  /** harness 的钩子：权限确认、输入改写、输出截断。 */
  readonly hooks?: Hooks;
  /** 缺省模型。每次调用也可以单独指定。 */
  readonly model?: LanguageModel;
  /** 经这个上下文追加、又没写 `source` 的条目，记成谁写的。 */
  readonly source?: string;
  readonly logger?: Logger;
  /** 单个上下文来源最多等多久，缺省 2 秒。 */
  readonly sourceTimeoutMs?: number;
  /** 事实放在指令后面（缺省）还是最后一条临时用户消息里，见 `FactsPlacement`。 */
  readonly factsPlacement?: FactsPlacement;
}

export type ContextOptions = ContextBaseOptions &
  (
    | { readonly session: string; readonly thread?: never }
    | {
        /** @deprecated 改名为 `session`，下一个 minor 删掉。 */
        readonly thread: string;
        readonly session?: never;
      }
  );

/** 可以直接给值，也可以给一个拿到本次上下文事实再决定的函数。 */
export type FactAware<T> = T | ((facts: readonly Fact[]) => T | undefined);

export interface PrepareOptions {
  /** 系统指令。给字符串时，本次收集到的事实按 `factsPlacement` 放进去；给函数就由函数自己安排。 */
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

/** `prepare()` 的结果：协议的 `PreparedCall`，工具另外包成了 AI SDK 的 `ToolSet`。 */
export interface PreparedContext extends Omit<PreparedCall, 'tools'> {
  readonly tools?: ToolSet;
  /** 交给模型的工具名。 */
  readonly toolNames: readonly string[];
}

/** 每次调用的模型参数。 */
export interface GenerateSettings {
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

export interface GenerateOptions extends PrepareOptions, GenerateSettings {
  /** 把 `input`、模型回复和 `ctx.run.*` 写进日志，缺省写。 */
  readonly record?: boolean;
  /**
   * 用户这句（`input`）的幂等键。记录时这句在调用模型之前就写进日志，模型调用失败它也留着；
   * 失败后用同一个键重试，就不会再记一遍。
   */
  readonly inputKey?: string;
}

export interface GenerateResult {
  readonly runId: string;
  readonly stopReason: StopReason;
  readonly text: string;
  /** 模型这次产出的消息（含工具调用和结果）。 */
  readonly messages: ModelMessage[];
  /** 实际写进日志的条目，含 `ctx.run.started` / `ctx.run.ended`。 */
  readonly recorded: readonly Entry[];
  readonly raw: GenerateTextResult;
}

export interface StreamOptions extends GenerateOptions {
  /** 流出错时调用。不给、上下文也没有 logger 时，沿用 AI SDK 的缺省处理（console.error）。 */
  readonly onError?: (error: unknown) => void;
}

export interface ContextStream {
  readonly runId: string;
  readonly result: StreamTextResult;
  /**
   * 回复写进日志以后，给出这次写入的全部条目（含先写的 `ctx.run.started` 和用户这句）：流出错或中止时没有回复，
   * `record: false` 时是 []。只在写日志失败时 reject。和 `result.text` 一样，读它会让流跑完。
   */
  readonly recorded: Promise<readonly Entry[]>;
}

export interface Context {
  readonly session: string;
  /** @deprecated 改名为 `session`。 */
  readonly thread: string;
  readonly store: SessionStore;
  readonly tools: ToolRegistry | undefined;
  /** 组装上下文的 builder，`view`、`prepare`、`compact` 走它。 */
  readonly builder: LocalContextBuilder;
  /** 进程内函数执行环境：注册表自带的那个，没有注册表时是新建的。 */
  readonly executor: FunctionExecutor;
  /** `generate` 走的 harness。直接用它就是协议的 `run` / `stream`：出错不抛，`stopReason` 说明原因。 */
  readonly harness: Harness & { stream(request: RunRequest): AsyncIterable<RunEvent> };
  append(...entries: NewEntry[]): Promise<Entry[]>;
  entries(options?: ListOptions): Promise<Entry[]>;
  /** 当前交给模型的历史：摘要 + 之后的条目，按投影规则渲染。 */
  view(options?: { readonly window?: WindowOptions }): Promise<Projection>;
  facts(signal?: AbortSignal): Promise<Fact[]>;
  /** 组装一次调用需要的指令、消息和工具，不调用模型。 */
  prepare(options?: PrepareOptions): Promise<PreparedContext>;
  /** 经 harness 跑一轮。模型出错或被取消时抛出原来的错误（`harness.run` 不抛）。 */
  generate(options?: GenerateOptions): Promise<GenerateResult>;
  stream(options?: StreamOptions): Promise<ContextStream>;
  /** 把较早的历史压成一条摘要。历史不够长时返回 null。 */
  compact(options?: CompactOptions): Promise<SummaryEntry | null>;
}

function hasExecutor(tools: ToolRegistry | undefined): tools is LocalToolRegistry {
  return typeof (tools as Partial<LocalToolRegistry> | undefined)?.executor?.register === 'function';
}

function settingsOf(call: GenerateSettings): CallSettings {
  return {
    ...(call.temperature !== undefined ? { temperature: call.temperature } : {}),
    ...(call.maxOutputTokens !== undefined ? { maxOutputTokens: call.maxOutputTokens } : {}),
    ...(call.topP !== undefined ? { topP: call.topP } : {}),
    ...(call.seed !== undefined ? { seed: call.seed } : {}),
    ...(call.stopSequences !== undefined ? { stopSequences: call.stopSequences } : {}),
    ...(call.maxRetries !== undefined ? { maxRetries: call.maxRetries } : {}),
    ...(call.timeoutMs !== undefined ? { timeoutMs: call.timeoutMs } : {}),
    ...(call.headers !== undefined ? { headers: call.headers } : {}),
    ...(call.providerOptions !== undefined
      ? { providerOptions: call.providerOptions as NonNullable<CallSettings['providerOptions']> }
      : {}),
  };
}

/**
 * 在一个会话上把会话存储、上下文组装、工具、执行环境和 harness 组合成一个进程内对象。它是糖，不是协议：
 * 内部是 `createContextBuilder`、传入的工具注册表、函数执行环境和 `createHarness`。
 */
export function createContext(options: ContextOptions): Context {
  const given = options.session ?? options.thread;
  if (typeof given !== 'string') throw new Error('Pass `session` to createContext().');
  const session: string = given;
  const { store, tools } = options;
  const builder = createContextBuilder({
    store,
    ...(options.projection ? { projection: options.projection } : {}),
    ...(options.sources ? { sources: options.sources } : {}),
    ...(options.sourceTimeoutMs !== undefined ? { sourceTimeoutMs: options.sourceTimeoutMs } : {}),
    ...(options.logger ? { logger: options.logger } : {}),
    ...(options.factsPlacement ? { factsPlacement: options.factsPlacement } : {}),
    ...(options.model ? { model: options.model } : {}),
    // 模型名原样交给 AI SDK（它把字符串当网关的模型名），和 0.1 一样。
    models: (name) => name,
  });
  const executor = hasExecutor(tools) ? tools.executor : createFunctionExecutor();
  const executors = [executor, ...(options.executors ?? [])];
  const runtime = createHarnessRuntime({
    store,
    context: builder,
    ...(tools ? { tools } : {}),
    executors,
    models: (name) => name,
    ...(options.hooks ? { hooks: options.hooks } : {}),
    ...(options.logger ? { logger: options.logger } : {}),
    ...(options.source !== undefined ? { source: options.source } : {}),
  });

  function stamp(entry: NewEntry): NewEntry {
    return entry.source === undefined && options.source !== undefined ? { ...entry, source: options.source } : entry;
  }

  async function append(...entries: NewEntry[]): Promise<Entry[]> {
    if (entries.length === 0) return [];
    return store.append(session, entries.map(stamp));
  }

  function facts(signal?: AbortSignal): Promise<Fact[]> {
    return builder.facts(session, signal);
  }

  /** 指令和提示是函数时先收集事实交给它们，事实就不再自动放进去。 */
  async function resolve(call: PrepareOptions): Promise<{
    instructions: string | undefined;
    prompt: UserContent | undefined;
    collected: readonly Fact[] | undefined;
  }> {
    const consumed = typeof call.instructions === 'function' || typeof call.prompt === 'function';
    if (!consumed) {
      return {
        instructions: call.instructions,
        prompt: call.prompt as UserContent,
        collected: undefined,
      };
    }
    const collected = call.facts === false ? [] : await facts(call.signal);
    const instructions = typeof call.instructions === 'function' ? call.instructions(collected) : call.instructions;
    const prompt = typeof call.prompt === 'function' ? call.prompt(collected) : call.prompt;
    return { instructions, prompt, collected };
  }

  async function prepare(call: PrepareOptions = {}): Promise<PreparedContext> {
    const resolved = await resolve(call);
    const collected = resolved.collected ?? (call.facts === false ? [] : await facts(call.signal));
    const projection = await builder.view(session, call.window ? { window: call.window } : {});
    const selected = tools && call.tools !== false ? tools.select(call.tools ?? true) : [];
    const prepared = assemble({
      projection,
      facts: collected,
      placeFacts: resolved.collected === undefined,
      placement: options.factsPlacement ?? 'instructions',
      instructions: resolved.instructions,
      input: call.input,
      prompt: resolved.prompt,
      tools: selected,
    });
    const { tools: names, ...rest } = prepared;
    const set = toToolSet(selected, [...executorMap(executors).values()], { session: session });
    return { ...rest, toolNames: names, ...(selected.length > 0 ? { tools: set } : {}) };
  }

  function modelFor(call: GenerateSettings): LanguageModel {
    const model = call.model ?? options.model;
    if (!model) throw new Error('No language model: pass `model` to createContext() or to the call.');
    return model;
  }

  async function request(call: GenerateOptions): Promise<{ run: RunRequest; facts: boolean | undefined }> {
    const model = modelFor(call);
    const resolved = await resolve(call);
    const toolNames = tools && call.tools !== false ? tools.select(call.tools ?? true).map((tool) => tool.name) : [];
    const agent: AgentSpec = {
      model,
      ...(resolved.instructions !== undefined ? { instructions: resolved.instructions } : {}),
      tools: toolNames,
      ...(call.maxSteps !== undefined ? { maxSteps: call.maxSteps } : {}),
      ...(call.window ? { window: call.window } : {}),
      settings: settingsOf(call),
    };
    const run: RunRequest = {
      session: session,
      agent,
      ...(call.input !== undefined ? { input: call.input } : {}),
      ...(call.inputKey !== undefined ? { inputKey: call.inputKey } : {}),
      ...(resolved.prompt !== undefined ? { prompt: resolved.prompt } : {}),
      ...(call.record === false ? { record: false } : {}),
      ...(call.signal ? { signal: call.signal } : {}),
    };
    // 函数已经拿到事实，builder 就不再收集、不再放。
    return { run, facts: resolved.collected !== undefined ? false : call.facts };
  }

  async function generate(call: GenerateOptions = {}): Promise<GenerateResult> {
    const { run, facts: collect } = await request(call);
    const outcome = await runtime.run(run, collect !== undefined ? { facts: collect } : {});
    const { result } = outcome;
    // 兼容 0.1：模型出错或被取消时抛出原来的错误。
    if (!outcome.raw) throw outcome.cause ?? new Error(result.error?.message ?? `Run ended: ${result.stopReason}`);
    return {
      runId: result.runId,
      stopReason: result.stopReason,
      text: result.text,
      messages: result.messages,
      recorded: result.recorded,
      raw: outcome.raw,
    };
  }

  async function stream(call: StreamOptions = {}): Promise<ContextStream> {
    const { run, facts: collect } = await request(call);
    const logger = options.logger;
    // 只有调用方给了 onError、或上下文配了 logger 才接管，否则保留 AI SDK 的缺省（console.error）。
    const onError =
      call.onError ??
      (logger
        ? (error: unknown) => logger.warn('stream failed', { error: error instanceof Error ? error.message : error })
        : (error: unknown) => console.error(error));
    const started = await runtime.startStream(run, { onError, ...(collect !== undefined ? { facts: collect } : {}) });
    if (!started.result) {
      const { cause, result } = await started.done();
      throw cause ?? new Error(result.error?.message ?? 'Run failed before the model was called.');
    }
    return {
      runId: started.runId,
      result: started.result,
      get recorded() {
        return started.done().then((outcome) => outcome.result.recorded);
      },
    };
  }

  return {
    session,
    thread: session,
    store,
    tools,
    builder,
    executor,
    harness: runtime.harness,
    append,
    entries: (listOptions) => store.list(session, listOptions),
    view: (viewOptions = {}) => builder.view(session, viewOptions),
    facts,
    prepare,
    generate,
    stream,
    compact: (compactOptions) => builder.compact(session, compactOptions),
  };
}
