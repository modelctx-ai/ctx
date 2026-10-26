import {
  agentSpecToJson,
  CTX_EVENTS,
  CtxError,
  ctxErrorEntry,
  headSeq,
  isConflict,
  errorOutput,
  messageEntry,
  runEndedEntry,
  runStartedEntry,
  silentLogger,
  userEntry,
  type ContextBuilder,
  type Entry,
  type ErrorInfo,
  type Executor,
  type Harness,
  type Hooks,
  type Logger,
  type Message,
  type ModelHookContext,
  type NewEntry,
  type PreparedCall,
  type RunEvent,
  type RunRequest,
  type RunResult,
  type SessionStore,
  type StopReason,
  type ToolCall,
  type ToolDefinition,
  type ToolOutput,
  type ToolRegistry,
  type Usage,
} from '@modelctx-ai/ctx-protocol';
import {
  APICallError,
  generateText,
  RetryError,
  stepCountIs,
  streamText,
  type FinishReason,
  type LanguageModel,
  type LanguageModelUsage,
  type ModelMessage,
  type ToolSet,
} from 'ai';

import { isEmptyContent, resolveModel } from './builder.ts';
import { fromModelMessages, toModelMessages } from './messages.ts';
import { dispatchTo, executorMap, toToolSet, type Executors, type ToolDispatch } from './tools.ts';

export type GenerateTextResult = Awaited<ReturnType<typeof generateText>>;
export type StreamTextResult = ReturnType<typeof streamText>;

export interface HarnessOptions {
  readonly store: SessionStore;
  readonly context: ContextBuilder;
  readonly tools?: ToolRegistry;
  /**
   * 工具绑定的执行环境。`tools` 是 `createToolRegistry()` 建的注册表时，它自带的函数执行环境会自动加进来
   * （同名的以这里给的为准）。
   */
  readonly executors?: Executors;
  /** `AgentSpec.model` 是名字时怎么造模型。不给时名字没法用，这一轮以 `error` 结束。 */
  readonly models?: (name: string) => LanguageModel;
  readonly hooks?: Hooks;
  readonly logger?: Logger;
  /** 用户输入写进日志、又没写 `source` 时记成谁写的。 */
  readonly source?: string;
}

/** `createContext` 用的额外开关，不在协议里。 */
export interface RunExtras {
  /** 是否收集来源，透传给 `BuildRequest.facts`。 */
  readonly facts?: boolean;
  /** 流式出错时怎么报。不给就记一条 `logger.warn`。 */
  readonly onError?: (error: unknown) => void;
}

export interface RunOutcome {
  readonly result: RunResult;
  /** 正常结束时 AI SDK 的原始结果（只有 `run`）。 */
  readonly raw?: GenerateTextResult;
  /** `stopReason` 是 `error` 或 `aborted` 时的原始错误。 */
  readonly cause?: unknown;
}

export interface StartedStream {
  readonly runId: string;
  /** 组装失败时没有流，`done()` 直接给出结果。 */
  readonly result?: StreamTextResult;
  /** 产出写进日志以后给出结果；第一次调用时才开始等（等的时候会让流跑完）。只在写日志失败时 reject。 */
  done(): Promise<RunOutcome>;
}

/** harness 的进程内入口：`createContext` 要拿到 AI SDK 的原始结果和流，用它；协议只看 `harness`。 */
export interface HarnessRuntime {
  readonly harness: Harness & { stream(request: RunRequest): AsyncIterable<RunEvent> };
  run(request: RunRequest, extras?: RunExtras): Promise<RunOutcome>;
  startStream(request: RunRequest, extras?: RunExtras): Promise<StartedStream>;
}

interface RunState {
  readonly runId: string;
  readonly request: RunRequest;
  readonly record: boolean;
  readonly recorded: Entry[];
  /** 本轮最后一次写入之后会话的末尾 `seq`，下一次写入拿它当 `expectSeq`；还没写过时是 `undefined`。 */
  head: number | undefined;
  /** 写日志失败过：这时 run 要 reject，不能当成模型出错。 */
  logFailed: boolean;
}

interface Setup {
  readonly model: LanguageModel;
  readonly prepared: PreparedCall;
  readonly tools: ToolSet;
  readonly toolCount: number;
  readonly maxSteps: number;
}

interface Produced {
  readonly text: string;
  readonly messages: readonly Message[];
  readonly finishReason: FinishReason;
  readonly steps: number;
  readonly usage: LanguageModelUsage | undefined;
}

function usageOf(usage: LanguageModelUsage | undefined): Usage | undefined {
  if (!usage) return undefined;
  const out: { inputTokens?: number; outputTokens?: number; totalTokens?: number } = {};
  if (usage.inputTokens !== undefined) out.inputTokens = usage.inputTokens;
  if (usage.outputTokens !== undefined) out.outputTokens = usage.outputTokens;
  if (usage.totalTokens !== undefined) out.totalTokens = usage.totalTokens;
  return Object.keys(out).length > 0 ? out : undefined;
}

function stopReasonOf(finishReason: FinishReason, steps: number, maxSteps: number): StopReason {
  if (finishReason === 'length') return 'max_tokens';
  if (finishReason === 'tool-calls' && steps >= maxSteps) return 'max_steps';
  if (finishReason === 'error') return 'error';
  return 'end_turn';
}

/** 给 `RunResult.error` 和 `ctx.error` 用：重试错误取最后一次，接口错误标出能不能重试。 */
export function errorInfo(error: unknown): ErrorInfo {
  const root = RetryError.isInstance(error) ? error.lastError : error;
  if (APICallError.isInstance(root)) {
    return {
      message: root.message,
      type: 'api_call',
      retryable: root.isRetryable,
      ...(root.statusCode !== undefined ? { statusCode: root.statusCode } : {}),
      ...(root.responseBody !== undefined ? { responseBody: root.responseBody } : {}),
    };
  }
  if (root instanceof Error) {
    const retryable = (root as { retryable?: unknown }).retryable;
    return {
      message: root.message,
      ...(root.name && root.name !== 'Error' ? { type: root.name } : {}),
      ...(typeof retryable === 'boolean' ? { retryable } : {}),
    };
  }
  return { message: String(root) };
}

function hasExecutor(tools: ToolRegistry | undefined): tools is ToolRegistry & { readonly executor: Executor } {
  const candidate = (tools as { executor?: unknown } | undefined)?.executor;
  return typeof candidate === 'object' && candidate !== null && typeof (candidate as Executor).execute === 'function';
}

/**
 * 把调用方的 `signal` 接到一个自己的控制器上：调用方中止或自己提前结束都能取消模型调用。
 * 用 `AbortSignal.any` 合并，不在调用方的 signal 上留监听器，长期复用同一个 signal 也不泄漏。
 */
function linked(signal: AbortSignal | undefined): { readonly signal: AbortSignal; abort(reason?: unknown): void } {
  const controller = new AbortController();
  return {
    signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
    abort: (reason) => controller.abort(reason),
  };
}

function begin(request: RunRequest): RunState {
  return {
    runId: request.runId ?? crypto.randomUUID(),
    request,
    record: request.record !== false,
    recorded: [],
    head: undefined,
    logFailed: false,
  };
}

/** 前提冲突时别人已经给这一轮写了 `ctx.run.ended`（被 `recover` 当作断掉的运行收走了）：这一轮停下，不再写。 */
class Fenced extends Error {
  constructor() {
    super('This run was ended by another process (fenced).');
    this.name = 'Fenced';
  }
}

/** 写入冲突后最多重试几次；超过就当写日志失败。冲突只来自应用事件，几次之内必然追上。 */
const MAX_CONFLICTS = 20;

/** 会话里已有未结束的运行：什么都没写，这一轮以 `error` 结束，稍后重试。 */
function busy(state: RunState): RunResult {
  const info = errorInfo(
    new CtxError('session_busy', `Session "${state.request.session}" already has a run in progress.`, {
      retryable: true,
    }),
  );
  return { runId: state.runId, text: '', messages: [], recorded: [], stopReason: 'error', error: info };
}

/** 被围栏：别人已经结束了这一轮，不再写 ended。 */
function fenced(state: RunState): RunResult {
  return { runId: state.runId, text: '', messages: [], recorded: state.recorded, stopReason: 'aborted' };
}

export function createHarnessRuntime(options: HarnessOptions): HarnessRuntime {
  const { store, context, tools, hooks = {} } = options;
  const logger = options.logger ?? silentLogger;
  const executors = executorMap(options.executors);
  if (hasExecutor(tools) && !executors.has(tools.executor.name)) executors.set(tools.executor.name, tools.executor);
  const base = dispatchTo([...executors.values()]);
  /** 已经告警过的执行环境名：同一个缺口每个 harness 只说一次。 */
  const warned = new Set<string>();

  /**
   * 工具绑定的执行环境没交给 harness：调用时模型会收到错误，这里在这一轮开始前提醒开发者。
   * 不在构造时抛错：注册表可以在 harness 建好之后才加工具，执行环境也可能晚到。
   */
  function warnMissingExecutors(definitions: readonly ToolDefinition[]): void {
    const missing = new Map<string, string[]>();
    for (const definition of definitions) {
      if (executors.has(definition.executor) || warned.has(definition.executor)) continue;
      missing.set(definition.executor, [...(missing.get(definition.executor) ?? []), definition.name]);
    }
    for (const [name, toolNames] of missing) {
      warned.add(name);
      logger.warn(
        `Tools are bound to executor "${name}", which was not passed to createHarness; calls will return an error. ` +
          `Add it to \`executors\`.`,
        { executor: name, tools: toolNames, available: [...executors.keys()] },
      );
    }
  }

  const dispatch: ToolDispatch = async (call, definition, execution) => {
    let actual: ToolCall = call;
    const decision = await hooks.beforeTool?.(call, execution);
    let output: ToolOutput;
    if (decision && !decision.allow) {
      output = errorOutput(`Tool call "${call.name}" was not allowed: ${decision.reason}`);
    } else {
      if (decision?.input !== undefined) actual = { ...call, input: decision.input };
      output = await base(actual, definition, execution);
    }
    return (await hooks.afterTool?.(actual, output, execution)) ?? output;
  };

  /** 追加并记下新的末尾。 */
  async function append(state: RunState, entries: readonly NewEntry[], expectSeq: number | undefined) {
    const written = await store.append(
      state.request.session,
      entries,
      expectSeq === undefined ? undefined : { expectSeq },
    );
    state.recorded.push(...written);
    state.head = written.at(-1)?.seq ?? state.head;
  }

  /**
   * 本轮的写入：带 `expectSeq`（上一次写入返回的末尾）。冲突时先看有没有人给自己的 `runId` 写了 `ended`：
   * 有就是被围栏了，抛 `Fenced`；没有只是别人写了应用事件，用新的末尾重试。
   */
  async function write(state: RunState, entries: readonly NewEntry[]): Promise<void> {
    if (!state.record || entries.length === 0) return;
    try {
      for (let conflicts = 0; ; conflicts += 1) {
        try {
          return await append(state, entries, state.head);
        } catch (error) {
          if (!isConflict(error) || state.head === undefined || conflicts >= MAX_CONFLICTS) throw error;
          // 先读末尾再读 ended：中间若又有人写，下一次写入会再冲突，再查一遍。
          const head = await headSeq(store, state.request.session);
          const ended = await store.list(state.request.session, { after: state.head, kinds: [CTX_EVENTS.runEnded] });
          if (
            ended.some(
              (entry) =>
                (entry.type === 'event' ? (entry.data as { runId?: unknown } | undefined)?.runId : undefined) ===
                state.runId,
            )
          ) {
            throw new Fenced();
          }
          state.head = head;
        }
      }
    } catch (error) {
      if (!(error instanceof Fenced)) state.logFailed = true;
      throw error;
    }
  }

  /**
   * 开始一轮：会话里最后一个生命周期事件是 `started` 就说明有未结束的运行，返回 false，什么都不写；
   * 否则带着刚读到的末尾追加 `ctx.run.started`，冲突就重读重判。`record: false` 不碰日志，总是 true。
   */
  async function writeStarted(state: RunState): Promise<boolean> {
    if (!state.record) return true;
    const { agent, session } = state.request;
    const started = runStartedEntry(
      {
        runId: state.runId,
        agent: agentSpecToJson(agent),
        ...(state.request.owner !== undefined ? { owner: state.request.owner } : {}),
      },
      { source: 'harness' },
    );
    try {
      for (let conflicts = 0; ; conflicts += 1) {
        const head = await headSeq(store, session);
        const [last] = await store.list(session, { kinds: [CTX_EVENTS.runStarted, CTX_EVENTS.runEnded], last: 1 });
        if (last?.type === 'event' && last.kind === CTX_EVENTS.runStarted) return false;
        try {
          await append(state, [started], head);
          return true;
        } catch (error) {
          if (!isConflict(error) || conflicts >= MAX_CONFLICTS) throw error;
        }
      }
    } catch (error) {
      state.logFailed = true;
      throw error;
    }
  }

  async function setup(state: RunState, extras: RunExtras, signal: AbortSignal): Promise<Setup> {
    const { request } = state;
    const { agent, session } = request;
    const input = isEmptyContent(request.input) ? undefined : request.input;
    if (state.record && input !== undefined) {
      const source = options.source !== undefined ? { source: options.source } : {};
      await write(state, [userEntry(input, { ...source, ...(request.inputKey ? { key: request.inputKey } : {}) })]);
    }
    const model = resolveModel(agent.model, options.models);
    const candidates = tools ? tools.select(agent.tools ?? true) : [];
    let prepared = await context.build({
      session,
      ...(!state.record && input !== undefined ? { input } : {}),
      ...(agent.instructions !== undefined ? { instructions: agent.instructions } : {}),
      ...(request.prompt !== undefined ? { prompt: request.prompt } : {}),
      tools: candidates,
      ...(agent.window ? { window: agent.window } : {}),
      // `createContext` 自己收了事实时给 `false`，以它为准；否则按 `agent.context` 选事实和投影。
      ...(extras.facts === false
        ? { facts: false }
        : agent.context?.facts !== undefined
          ? { facts: agent.context.facts }
          : extras.facts !== undefined
            ? { facts: extras.facts }
            : {}),
      ...(agent.context?.projection !== undefined ? { projection: agent.context.projection } : {}),
      signal,
    });
    const hookContext: ModelHookContext = { runId: state.runId, session, step: 0, signal };
    prepared = (await hooks.beforeModel?.(prepared, hookContext)) ?? prepared;
    // 模型不一定看 abortSignal：已经取消就不调了。
    signal.throwIfAborted();
    const definitions = prepared.tools.flatMap((name) => {
      const found = candidates.find((tool) => tool.name === name) ?? tools?.get(name);
      return found ? [found] : [];
    });
    warnMissingExecutors(definitions);
    return {
      model,
      prepared,
      tools: toToolSet(definitions, undefined, { session, runId: state.runId, dispatch }),
      toolCount: definitions.length,
      maxSteps: agent.maxSteps ?? (definitions.length > 0 ? 5 : 1),
    };
  }

  /** `generateText` 和 `streamText` 共用的参数。 */
  function callOptions(state: RunState, ready: Setup, signal: AbortSignal) {
    const settings = state.request.agent.settings ?? {};
    const { prepared } = ready;
    const beforeModel = hooks.beforeModel?.bind(hooks);
    return {
      model: ready.model,
      ...(prepared.instructions ? { instructions: prepared.instructions } : {}),
      messages: toModelMessages(prepared.messages),
      ...(ready.toolCount > 0 ? { tools: ready.tools } : {}),
      stopWhen: stepCountIs(ready.maxSteps),
      ...(settings.temperature !== undefined ? { temperature: settings.temperature } : {}),
      ...(settings.maxOutputTokens !== undefined ? { maxOutputTokens: settings.maxOutputTokens } : {}),
      ...(settings.topP !== undefined ? { topP: settings.topP } : {}),
      ...(settings.topK !== undefined ? { topK: settings.topK } : {}),
      ...(settings.presencePenalty !== undefined ? { presencePenalty: settings.presencePenalty } : {}),
      ...(settings.frequencyPenalty !== undefined ? { frequencyPenalty: settings.frequencyPenalty } : {}),
      ...(settings.seed !== undefined ? { seed: settings.seed } : {}),
      ...(settings.stopSequences !== undefined ? { stopSequences: [...settings.stopSequences] } : {}),
      ...(settings.maxRetries !== undefined ? { maxRetries: settings.maxRetries } : {}),
      ...(settings.timeoutMs !== undefined ? { timeout: settings.timeoutMs } : {}),
      ...(settings.headers !== undefined ? { headers: { ...settings.headers } } : {}),
      ...(settings.providerOptions !== undefined
        ? { providerOptions: settings.providerOptions as Record<string, Record<string, never>> }
        : {}),
      abortSignal: signal,
      // 第一步之前已经调过 beforeModel；之后的工具步骤每一步再给它一次机会。
      ...(beforeModel
        ? {
            prepareStep: async ({ stepNumber, messages }: { stepNumber: number; messages: ModelMessage[] }) => {
              if (stepNumber === 0) return undefined;
              const call: PreparedCall = { ...prepared, messages: fromModelMessages(messages) };
              const changed = await beforeModel(call, {
                runId: state.runId,
                session: state.request.session,
                step: stepNumber,
                signal,
              });
              if (!changed || changed === call) return undefined;
              return {
                messages: toModelMessages(changed.messages),
                ...(changed.instructions !== undefined ? { instructions: changed.instructions } : {}),
              };
            },
          }
        : {}),
    };
  }

  async function finish(state: RunState, ready: Setup, produced: Produced): Promise<RunResult> {
    const messages = [...produced.messages];
    const stopReason = stopReasonOf(produced.finishReason, produced.steps, ready.maxSteps);
    const usage = usageOf(produced.usage);
    await write(state, [
      ...messages.map((message) => messageEntry(message, { source: 'model' })),
      runEndedEntry({ runId: state.runId, stopReason, ...(usage ? { usage } : {}) }, { source: 'harness' }),
    ]);
    return {
      runId: state.runId,
      text: produced.text,
      messages,
      recorded: state.recorded,
      stopReason,
      ...(usage ? { usage } : {}),
    };
  }

  /** 出错或取消：照样写 `ctx.run.ended`，返回结果而不是抛。 */
  async function fail(state: RunState, error: unknown, signal: AbortSignal): Promise<RunResult> {
    if (error instanceof Fenced) return fenced(state);
    const stopReason: StopReason = signal.aborted ? 'aborted' : 'error';
    const info = errorInfo(error);
    if (stopReason === 'error') logger.debug?.('run failed', { runId: state.runId, error: info.message });
    try {
      await write(state, [
        ...(stopReason === 'error'
          ? [
              ctxErrorEntry(
                { runId: state.runId, message: info.message, ...(info.type ? { type: info.type } : {}) },
                { source: 'harness' },
              ),
            ]
          : []),
        runEndedEntry({ runId: state.runId, stopReason }, { source: 'harness' }),
      ]);
    } catch (writeError) {
      if (writeError instanceof Fenced) return fenced(state);
      throw writeError;
    }
    return {
      runId: state.runId,
      text: '',
      messages: [],
      recorded: state.recorded,
      stopReason,
      ...(stopReason === 'error' ? { error: info } : {}),
    };
  }

  /** 进程内每会话一条队列，队尾是前一个记录型运行结束的时刻。队列里的 promise 永远 resolve，不会 reject。 */
  const tails = new Map<string, Promise<void>>();

  /**
   * 排进这个会话的队：同一个 harness 里记录型运行（`record` 不为 `false`）一个接一个，第二个等前一个结束再开始，
   * 所以 `session_busy` 只会出现在跨进程（或别的 harness 实例）的时候。`record: false` 不排。
   * 前面有人在跑、自己在排队时 `signal` 中止，就退出队列，返回 `undefined`，调用方以 `aborted` 结束，什么都没写。
   * 返回的 `release` 在运行结束时调；可以重复调。
   */
  async function enter(state: RunState): Promise<(() => void) | undefined> {
    if (!state.record) return () => {};
    const { session } = state.request;
    const { signal } = state.request;
    const queued = tails.has(session);
    const previous = tails.get(session) ?? Promise.resolve();
    const turn = Promise.withResolvers<void>();
    const tail = previous.then(() => turn.promise);
    tails.set(session, tail);
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      turn.resolve();
      void tail.finally(() => {
        if (tails.get(session) === tail) tails.delete(session);
      });
    };
    // 没人排在前面就直接开始：`signal` 已经中止的运行照常写 started 和 ended（见契约）。
    if (!queued) return release;
    if (signal) {
      // 等完就摘掉监听：调用方长期复用同一个 signal 时不会越积越多。
      let onAbort: (() => void) | undefined;
      const aborted = new Promise<void>((resolve) => {
        if (signal.aborted) return resolve();
        onAbort = resolve;
        signal.addEventListener('abort', onAbort, { once: true });
      });
      let waited = false;
      await Promise.race([previous.then(() => (waited = true)), aborted]);
      if (onAbort) signal.removeEventListener('abort', onAbort);
      if (signal.aborted || !waited) {
        release();
        return undefined;
      }
    } else {
      await previous;
    }
    return release;
  }

  async function run(request: RunRequest, extras: RunExtras = {}): Promise<RunOutcome> {
    const state = begin(request);
    const release = await enter(state);
    if (!release) return { result: fenced(state) };
    try {
      return await runLocked(state, extras);
    } finally {
      release();
    }
  }

  async function runLocked(state: RunState, extras: RunExtras): Promise<RunOutcome> {
    const { request } = state;
    const controller = linked(request.signal);
    if (!(await writeStarted(state))) return { result: busy(state) };
    try {
      const ready = await setup(state, extras, controller.signal);
      const raw = await generateText(callOptions(state, ready, controller.signal));
      const result = await finish(state, ready, {
        text: raw.text,
        // 子集之外的部件在这里抛 `unsupported_part`，下面的 catch 把这一轮以 `error` 结束。
        messages: fromModelMessages(raw.responseMessages),
        finishReason: raw.finishReason,
        steps: raw.steps.length,
        usage: raw.usage,
      });
      return { result, raw };
    } catch (error) {
      if (state.logFailed) throw error;
      return { result: await fail(state, error, controller.signal), cause: error };
    }
  }

  async function startStream(request: RunRequest, extras: RunExtras = {}): Promise<StartedStream> {
    const state = begin(request);
    const release = await enter(state);
    if (!release) {
      const outcome = Promise.resolve<RunOutcome>({ result: fenced(state) });
      return { runId: state.runId, done: () => outcome };
    }
    try {
      return await startStreamLocked(state, extras, release);
    } catch (error) {
      release();
      throw error;
    }
  }

  /** 流式的一轮；队列的位置在这一轮真正结束（结果落定）时才交出去，由 `release` 负责。 */
  async function startStreamLocked(state: RunState, extras: RunExtras, release: () => void): Promise<StartedStream> {
    const { request } = state;
    const controller = linked(request.signal);
    if (!(await writeStarted(state))) {
      release();
      const outcome = Promise.resolve<RunOutcome>({ result: busy(state) });
      return { runId: state.runId, done: () => outcome };
    }
    let ready: Setup;
    try {
      ready = await setup(state, extras, controller.signal);
    } catch (error) {
      if (state.logFailed) throw error;
      const outcome = fail(state, error, controller.signal).then((result) => ({ result, cause: error }));
      outcome.catch(() => {});
      void outcome.then(release, release);
      return { runId: state.runId, done: () => outcome };
    }

    const finished = Promise.withResolvers<RunOutcome>();
    // 没人等结果时，写日志失败也不能变成未处理的 rejection。
    finished.promise.catch(() => {});
    void finished.promise.then(release, release);
    let settled = false;
    let failure: unknown;
    const settle = (work: () => Promise<RunResult>, cause?: unknown): void => {
      if (settled) return;
      settled = true;
      work()
        .catch((error: unknown) => {
          // 被围栏：别人已经结束了这一轮，不算写日志失败。
          if (error instanceof Fenced) return fenced(state);
          throw error;
        })
        .then(
          (result) => finished.resolve(cause === undefined ? { result } : { result, cause }),
          (error: unknown) => {
            logger.warn('failed to record run', { runId: state.runId, error: errorInfo(error).message });
            finished.reject(error);
          },
        );
    };
    const report =
      extras.onError ?? ((error: unknown) => logger.warn('stream failed', { error: errorInfo(error).message }));

    const result = streamText({
      ...callOptions(state, ready, controller.signal),
      onError: ({ error }) => {
        failure = error;
        report(error);
      },
      onEnd: (event) => {
        let messages: Message[];
        try {
          messages = fromModelMessages(event.responseMessages);
        } catch (error) {
          // 子集之外的部件：这一轮以 `error` 结束，不写半截的产出。
          settle(() => fail(state, error, controller.signal), error);
          return;
        }
        settle(() =>
          finish(state, ready, {
            text: event.text,
            messages,
            finishReason: event.finishReason,
            steps: event.steps.length,
            usage: event.totalUsage,
          }),
        );
      },
      onAbort: () => {
        const reason = controller.signal.reason ?? new Error('Run aborted.');
        settle(() => fail(state, reason, controller.signal), reason);
      },
    });

    let watched = false;
    return {
      runId: state.runId,
      result,
      done() {
        if (!watched) {
          watched = true;
          // 出错或没有输出时 AI SDK 不调 onEnd，只让结果的 promise reject；读它也会让流跑完。
          result.finishReason.then(undefined, (error: unknown) => {
            const cause = failure ?? error;
            settle(() => fail(state, cause, controller.signal), cause);
          });
        }
        return finished.promise;
      },
    };
  }

  async function* stream(request: RunRequest): AsyncGenerator<RunEvent> {
    const controller = linked(request.signal);
    const started = await startStream({ ...request, signal: controller.signal });
    const { runId } = started;
    let completed = false;
    try {
      yield { type: 'run.started', runId, session: request.session };
      if (started.result) {
        let step = 0;
        try {
          for await (const part of started.result.fullStream) {
            switch (part.type) {
              case 'start-step':
                yield { type: 'model.started', runId, step };
                break;
              case 'text-delta':
                if (part.text) yield { type: 'text.delta', runId, text: part.text };
                break;
              case 'tool-call':
                yield {
                  type: 'tool.called',
                  runId,
                  call: { id: part.toolCallId, name: part.toolName, input: (part.input ?? null) as ToolCall['input'] },
                };
                break;
              case 'tool-result':
                yield { type: 'tool.returned', runId, callId: part.toolCallId, output: part.output as ToolOutput };
                break;
              case 'tool-error':
                yield {
                  type: 'tool.returned',
                  runId,
                  callId: part.toolCallId,
                  output: errorOutput(errorInfo(part.error).message),
                };
                break;
              case 'finish-step': {
                const usage = usageOf(part.usage);
                yield { type: 'model.ended', runId, step, ...(usage ? { usage } : {}) };
                step += 1;
                break;
              }
              default:
                break;
            }
          }
        } catch {
          // 流本身的错误由 done() 收进结果。
        }
      }
      const { result } = await started.done();
      completed = true;
      if (result.error) yield { type: 'error', runId, message: result.error.message };
      const { messages: _messages, recorded: _recorded, ...summary } = result;
      yield { type: 'run.ended', runId, result: summary };
    } finally {
      if (!completed) {
        // 调用方提前不读了：取消模型调用，等 ctx.run.ended 写完。
        controller.abort(new Error('Run stream closed by the consumer.'));
        await started.done().catch(() => {});
      }
    }
  }

  return {
    harness: {
      run: async (request) => (await run(request)).result,
      stream,
    },
    run,
    startStream,
  };
}

/**
 * 基于 AI SDK `generateText` / `streamText` 的 harness：`ctx.run.started` → 记输入 → `ContextBuilder.build` →
 * `beforeModel` → 调模型（每个工具调用经 `beforeTool` → 绑定的执行环境 → `afterTool`）→ 记产出 → `ctx.run.ended`。
 * 模型出错、被取消也写 `ctx.run.ended` 并照常返回；只有写日志失败才 reject。`record: false` 时一条都不写。
 */
export function createHarness(options: HarnessOptions): Harness & {
  stream(request: RunRequest): AsyncIterable<RunEvent>;
} {
  return createHarnessRuntime(options).harness;
}
