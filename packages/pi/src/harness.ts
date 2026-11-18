// pi 当 ctx 的 harness（ADR 0010）：一轮起一个 `pi --mode rpc` 进程，它自己跑循环、自己存对话；ctx 的工具经 MCP
// （`createMcpServer`）交给它，调用回到 ctx 的执行环境；RPC 的事件实时写进会话日志。这一轮的配置（MCP 服务器、拒绝的工具、
// 步数和预算、退回）写进一个扩展交给 pi（`extension.ts`）。
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createMcpHttpHandler, createMcpServer, type McpServer } from '@modelctx-ai/ctx-mcp';
import {
  afterConflict,
  agentSpecToJson,
  checkJsonSchema,
  collectFacts,
  CTX_EVENTS,
  ctxErrorEntry,
  ctxEventData,
  errorOutput,
  eventEntry,
  headSeq,
  isConflict,
  isEvent,
  isFrameworkKind,
  lastHarnessRun,
  messageEntry,
  renderFacts,
  runEndedEntry,
  runParentProblem,
  runStartedEntry,
  selectTools,
  silentLogger,
  stepMetaToJson,
  toolPermission,
  userEntry,
  type AgentSpec,
  type ContextSource,
  type Entry,
  type ErrorInfo,
  type Executor,
  type Harness,
  type JsonObject,
  type JsonValue,
  type Logger,
  type Message,
  type MessageContent,
  type NewEntry,
  type RunEvent,
  type RunRequest,
  type RunResult,
  type SessionStore,
  type StepMeta,
  type StopReason,
  type ToolCall,
  type ToolDefinition,
  type ToolOutput,
  type ToolPart,
  type ToolRegistry,
  type Usage,
} from '@modelctx-ai/ctx-protocol';

import { INTERRUPTED, MAX_CONFLICTS, PI_EVENTS, PI_HARNESS, PI_MCP_SERVER } from './constants.ts';
import { extensionSource, type ExtensionConfig } from './extension.ts';
import { dataOf, PiProcess, probeVersion, type Exit } from './process.ts';
import {
  addUsages,
  assistantMessageOf,
  errorOfMessage,
  finishReasonOf,
  isAssistant,
  isObject,
  mcpToolName,
  promptOf,
  textOf,
  toolCallsOf,
  toolOutputOf,
  usageOf,
  type PiAssistantMessage,
  type PiPrompt,
  type PiRecord,
  type PiResponse,
  type PiStopReason,
  type PiToolResult,
  type PiToolResultMessage,
} from './rpc.ts';

export interface PiHarnessOptions {
  /** 会话日志：生命周期事件、输入、模型的每一步、工具结果都实时写进来。 */
  readonly store: SessionStore;
  /** ctx 的执行环境：ctx 的工具经 MCP 交给 pi，调用由它们执行。 */
  readonly executors?: readonly Executor[] | Readonly<Record<string, Executor>>;
  /**
   * 工具目录：`AgentSpec.tools` 从这里挑，定义的 `executor` 指向 `executors` 里的一个；`createToolRegistry()` 建的注册表
   * 自带的函数执行环境自动加进来。不给就是各执行环境 `tools()` 报的全部。
   */
  readonly tools?: ToolRegistry;
  /** pi 自带的工具（`read`、`bash`、`edit`、`write`……）交出哪些，缺省一个都不交。它们的调用只记进日志，执行方是 `pi`。 */
  readonly builtinTools?: readonly string[];
  /** 可执行文件，缺省 `pi`。 */
  readonly command?: string;
  /** 加在最后的命令行参数。 */
  readonly args?: readonly string[];
  /** pi 的工作目录，缺省当前目录。没给 `sessionDir` 时它按目录存会话：同一个 ctx 会话的各轮要用同一个。 */
  readonly cwd?: string;
  /** pi 存会话的目录（`--session-dir`），缺省是它自己的（代理目录下按工作目录分）。 */
  readonly sessionDir?: string;
  /** `--provider`：在哪个提供方里找 `AgentSpec.model`。`model` 写成 `提供方/模型` 时不用给。 */
  readonly provider?: string;
  /** 子进程的环境变量，缺省 `process.env`。凭证由 pi 自己的配置（`auth.json`、`models.json`）或这里的环境变量给。 */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /**
   * 不读上下文文件（`AGENTS.md`、`CLAUDE.md`）、技能、提示模板、主题，不加载发现的扩展和内置的扩展（要 MCP 时只加载
   * `builtin:mcp`），不读项目里的 `.pi`。模型、凭证和 pi 自己的设置照常读。缺省不加。
   */
  readonly bare?: boolean;
  /** 一次工具结果最多多少字符（`createMcpServer` 的 `maxOutputChars`），缺省 `DEFAULT_MAX_TOOL_OUTPUT_CHARS`。 */
  readonly maxToolOutputChars?: number;
  /** 取消后等 pi 自己停下的时间，过了就结束进程。缺省 5 秒。 */
  readonly interruptTimeoutMs?: number;
  /**
   * 上下文来源（`ContextSource`，例如记忆的 `memory.source()`）：每轮记下输入之后收一次，收到的事实接在指令后面
   * （`--append-system-prompt`：每轮的系统提示，不进 pi 自己的会话，也不写日志）。`AgentSpec.context.facts` 选用哪些、
   * 加不加标题，`false` 不收。
   */
  readonly sources?: readonly ContextSource[];
  /** 单个来源最多等多久，缺省 2 秒（同参考实现的 builder）。 */
  readonly sourceTimeoutMs?: number;
  /** 输入条目的 `source`。 */
  readonly source?: string;
  readonly logger?: Logger;
}

export interface PiHarness extends Harness {
  stream(request: RunRequest): AsyncIterable<RunEvent>;
}

/** 认重试、找上一轮时最多往回读这么多条。 */
const SCAN = 64;

/** `bare` 加的参数。`--no-extensions` 连内置的扩展也不加载，要 MCP 时另加 `-e builtin:mcp`。 */
const BARE_ARGS = [
  '--no-context-files',
  '--no-skills',
  '--no-prompt-templates',
  '--no-themes',
  '--no-extensions',
  '--no-approve',
];

/** 这一轮那句话的 `prompt` 命令的 id：它的响应进事件流，和事件按顺序处理。 */
const PROMPT_ID = 'ctx-prompt';

/** `ctx.run.started`、`ctx.run.ended` 的 `meta.pi`：pi 会话里的位置（条目的 id）。 */
interface PiMeta {
  /** `ctx.run.started`：这一轮从 pi 会话里的哪一条接着跑；新开的会话没有。 */
  readonly resumeAt?: string;
  /** `ctx.run.ended`：这一轮结束时 pi 会话的最后一条（`leafId`）。 */
  readonly last?: string;
}

type StopCause = 'aborted' | 'timeout' | 'fenced' | 'unreachable';

interface Plan {
  /** pi 的会话 id。 */
  readonly session: string;
  readonly fresh: boolean;
  /** 上一轮失败、这一轮重试：先退回到失败那一轮开始的位置。 */
  readonly truncateAt?: string;
  readonly resumeAt?: string;
}

interface RunState {
  readonly request: RunRequest;
  readonly runId: string;
  readonly record: boolean;
  readonly emit: (event: RunEvent) => void;
  readonly recorded: Entry[];
  readonly messages: Message[];
  /** 这一轮的 `ctx.run.started` 的 `seq`：围栏认它。 */
  started?: number;
  head: number | undefined;
  fenced: boolean;
}

interface Served {
  readonly url: string;
  readonly token: string;
  /** pi 带着令牌连过来过没有。 */
  contacted(): boolean;
  close(): Promise<void>;
}

function piMeta(entry: Entry | undefined): PiMeta {
  const meta = entry?.meta?.['pi'];
  return isObject(meta) ? meta : {};
}

function metaOf(meta: { readonly [K in keyof PiMeta]?: string | undefined }): JsonObject | undefined {
  const fields = Object.fromEntries(Object.entries(meta).filter(([, value]) => typeof value === 'string'));
  return Object.keys(fields).length > 0 ? { pi: fields } : undefined;
}

function isEmpty(content: MessageContent | undefined): boolean {
  return content === undefined || content.length === 0;
}

function denied(name: string): string {
  return `Tool call "${name}" was denied by the agent's permissions.`;
}

/** 映射不了的 `AgentSpec` 字段：有就以 `invalid_request` 结束，不静默忽略。 */
function specProblem(agent: AgentSpec): string | undefined {
  if (typeof agent.model !== 'string' || agent.model === '') {
    return 'AgentSpec.model must be a model name: pi takes the model by name (--model).';
  }
  if (agent.window !== undefined) return 'AgentSpec.window is not supported: pi manages its own context.';
  const context = contextProblem(agent.context);
  if (context !== undefined) return context;
  if (agent.toolChoice !== undefined && agent.toolChoice !== 'auto') {
    return 'AgentSpec.toolChoice is not supported by pi; only "auto".';
  }
  const settings = agent.settings ?? {};
  const unsupported = Object.keys(settings).filter((key) => !['maxRetries', 'timeoutMs'].includes(key));
  if (unsupported.length > 0) {
    return `AgentSpec.settings.${unsupported.join(', ')} not supported by pi; only maxRetries (0) and timeoutMs.`;
  }
  if (settings.maxRetries !== undefined && settings.maxRetries !== 0) {
    return "AgentSpec.settings.maxRetries can only be 0 (turns pi's automatic retries off); how often pi retries is its own setting (retry.maxRetries in settings.json).";
  }
  const { permissions } = agent;
  if (
    permissions?.default === 'ask' ||
    Object.values(permissions?.tools ?? {}).some((permission) => permission === 'ask')
  ) {
    return 'AgentSpec.permissions "ask" is not supported: pi runs the whole turn itself (no requires_action).';
  }
  for (const [key, value] of Object.entries(agent.budget ?? {})) {
    if (typeof value !== 'number' || !(value > 0)) return `AgentSpec.budget.${key} must be a positive number.`;
  }
  if (agent.maxSteps !== undefined && !(Number.isSafeInteger(agent.maxSteps) && agent.maxSteps > 0)) {
    return 'AgentSpec.maxSteps must be a positive integer.';
  }
  if (agent.output !== undefined && !isObject(agent.output.schema)) {
    return 'AgentSpec.output.schema must be a JSON Schema object.';
  }
  return undefined;
}

/**
 * `AgentSpec.context` 只认 `facts`：历史、窗口、压缩是 pi 自己的。事实只能接在指令后面：放进 `prompt` 就成了这一轮的用户
 * 消息，留在 pi 自己的会话里，不再是「只在这一次调用里出现」。
 */
function contextProblem(context: AgentSpec['context']): string | undefined {
  if (context === undefined) return undefined;
  if (!isObject(context)) return 'AgentSpec.context must be an object.';
  const others = Object.entries(context)
    .filter(([key, value]) => key !== 'facts' && value !== undefined)
    .map(([key]) => key);
  if (others.length > 0) {
    return `AgentSpec.context.${others.join(', ')} not supported: pi manages its own context; only context.facts.`;
  }
  const { facts } = context;
  if (facts !== undefined && typeof facts !== 'boolean' && !isObject(facts)) {
    return 'AgentSpec.context.facts must be a boolean or an object.';
  }
  if (isObject(facts) && facts['placement'] === 'prompt') {
    return 'AgentSpec.context.facts.placement "prompt" is not supported: the prompt would stay in pi\'s own session. Facts go after the instructions.';
  }
  return undefined;
}

function endedInFailure(entry: Entry | undefined): boolean {
  const stopReason = ctxEventData(entry, CTX_EVENTS.runEnded)?.stopReason;
  return stopReason === 'error' || stopReason === 'aborted';
}

/** `AgentSpec.output`：pi 没有结构化输出，schema 写进系统提示，最后的回答按它解析。 */
function outputInstructions(output: NonNullable<AgentSpec['output']>): string {
  return [
    'When you give your final answer, reply with one JSON value that matches the JSON Schema below, and nothing else:',
    'no explanation and no Markdown code fence.',
    ...(output.description ? ['', output.description] : []),
    '',
    JSON.stringify(output.schema, null, 2),
  ].join('\n');
}

/** 最后的回答里的 JSON：允许包在一个 Markdown 代码块里。 */
function parseOutput(text: string): { readonly value: JsonValue } | undefined {
  const trimmed = text.trim();
  const fenced = /^```[\w-]*\n([\s\S]*?)\n?```$/.exec(trimmed);
  try {
    return { value: JSON.parse(fenced ? fenced[1]! : trimmed) as JsonValue };
  } catch {
    return undefined;
  }
}

export function createPiHarness(options: PiHarnessOptions): PiHarness {
  const { store } = options;
  const logger = options.logger ?? silentLogger;
  const command = options.command ?? 'pi';
  const env = options.env ?? process.env;
  const grace = options.interruptTimeoutMs ?? 5_000;
  const sources = options.sources ?? [];
  const executors = new Map<string, Executor>(
    Array.isArray(options.executors)
      ? (options.executors as readonly Executor[]).map((executor) => [executor.name, executor])
      : Object.entries((options.executors ?? {}) as Readonly<Record<string, Executor>>),
  );
  // `createToolRegistry()` 建的注册表自带函数执行环境：和参考实现一样自动带上。
  const own = (options.tools as { executor?: unknown } | undefined)?.executor;
  if (isObject(own) && typeof own['name'] === 'string' && typeof own['execute'] === 'function') {
    const executor = own as unknown as Executor;
    if (!executors.has(executor.name)) executors.set(executor.name, executor);
  }
  let version: Promise<string | undefined> | undefined;
  const versionOf = (): Promise<string | undefined> =>
    (version ??= probeVersion({ command, env, ...(options.cwd !== undefined ? { cwd: options.cwd } : {}) }));

  async function catalog(): Promise<ToolDefinition[]> {
    if (options.tools) return options.tools.list();
    const listed = (
      await Promise.all([...executors.values()].map(async (executor) => (await executor.tools?.()) ?? []))
    ).flat();
    const seen = new Set<string>();
    return listed.filter((definition) => !seen.has(definition.name) && seen.add(definition.name));
  }

  // ---- 日志 ----

  async function write(state: RunState, entries: readonly NewEntry[]): Promise<void> {
    if (!state.record || entries.length === 0 || state.fenced) return;
    const { session } = state.request;
    for (let conflicts = 0; ; conflicts += 1) {
      try {
        const written = await store.append(
          session,
          entries,
          state.head === undefined ? undefined : { expectSeq: state.head },
        );
        state.recorded.push(...written);
        if (written.length > 0) state.head = written.at(-1)!.seq;
        return;
      } catch (error) {
        if (!isConflict(error) || conflicts >= MAX_CONFLICTS) throw error;
        // 这一轮中间别人写了东西：被围栏（`afterConflict`）就不再写，否则接在新的末尾后面。
        const head = await afterConflict(store, session, state);
        if (head === undefined) {
          state.fenced = true;
          return;
        }
        state.head = head;
      }
    }
  }

  /**
   * 这一轮的输入是不是上一轮失败时留下的那句（同参考实现）：上一轮以 `error` 或 `aborted` 结束，日志里它之后只有框架和
   * 这个适配器写的事件、没盖住它的摘要。给了 `inputKey` 的看最近的条目里有没有这个键。
   */
  async function repeatsFailedInput(session: string, input: MessageContent, key: string | undefined): Promise<boolean> {
    const tail = await store.list(session, { last: SCAN });
    if (key !== undefined) return tail.some((entry) => entry.key === key);
    let covered = 0;
    for (const entry of tail.toReversed()) {
      if (entry.type === 'event' && (isFrameworkKind(entry.kind) || entry.kind.startsWith(`${PI_HARNESS}.`))) continue;
      if (entry.type === 'summary') {
        covered = Math.max(covered, entry.covers);
        continue;
      }
      return (
        entry.type === 'message' &&
        entry.message.role === 'user' &&
        entry.seq > covered &&
        JSON.stringify(entry.message.content) === JSON.stringify(input)
      );
    }
    return false;
  }

  /**
   * 定这一轮接着 pi 的哪个会话、从哪接：上一轮记下的会话和位置；上一轮失败、这一轮是重试（同样的输入，或同一个 `inputKey`）
   * 就先退回到失败那一轮开始的位置，失败那一轮的输入不在 pi 的上下文里出现两次。没有上一轮、位置不知道的，开新会话。
   * 记录型运行先查会话忙不忙，然后带着读到的末尾写 `ctx.run.started`，冲突就重来。
   */
  async function start(state: RunState): Promise<{ plan: Plan; repeated: boolean } | 'busy'> {
    const { session, agent, input, inputKey } = state.request;
    const hasInput = !isEmpty(input);
    for (let conflicts = 0; ; conflicts += 1) {
      const head = await headSeq(store, session);
      const lifecycle = await store.list(session, { kinds: [CTX_EVENTS.runStarted, CTX_EVENTS.runEnded], last: SCAN });
      const last = lifecycle.at(-1);
      if (state.record && isEvent(last, CTX_EVENTS.runStarted)) return 'busy';
      const previous = lastHarnessRun(lifecycle, PI_HARNESS);
      const failed = endedInFailure(last);
      const repeated = state.record && hasInput && failed && (await repeatsFailedInput(session, input!, inputKey));
      const position = previous && (piMeta(previous.ended).last ?? piMeta(previous.started).resumeAt);
      let plan: Plan;
      if (repeated && previous && previous.ended === last) {
        const back = piMeta(previous.started).resumeAt;
        plan = back
          ? { session: previous.session, fresh: false, truncateAt: back, resumeAt: back }
          : { session: randomUUID(), fresh: true };
      } else if (previous && position) {
        plan = { session: previous.session, fresh: false, resumeAt: position };
      } else {
        plan = { session: randomUUID(), fresh: true };
      }
      if (!state.record) return { plan, repeated: false };
      const harnessVersion = await versionOf();
      const parent = state.request.parent;
      const started = runStartedEntry(
        {
          runId: state.runId,
          agent: agentSpecToJson(agent),
          ...(state.request.owner !== undefined ? { owner: state.request.owner } : {}),
          ...(parent !== undefined && runParentProblem(parent) === undefined ? { parent: { ...parent } } : {}),
          harness: {
            name: PI_HARNESS,
            ...(harnessVersion !== undefined ? { version: harnessVersion } : {}),
            session: plan.session,
          },
        },
        { source: 'harness', ...(plan.resumeAt ? { meta: metaOf({ resumeAt: plan.resumeAt })! } : {}) },
      );
      try {
        const written = await store.append(session, [started], { expectSeq: head });
        state.recorded.push(...written);
        state.started = written.at(-1)?.seq;
        state.head = written.at(-1)?.seq ?? head;
        return { plan, repeated: repeated && inputKey === undefined };
      } catch (error) {
        if (!isConflict(error) || conflicts >= MAX_CONFLICTS) throw error;
      }
    }
  }

  // ---- 一轮 ----

  async function execute(request: RunRequest, emit: (event: RunEvent) => void): Promise<RunResult> {
    const state: RunState = {
      request,
      runId: request.runId ?? randomUUID(),
      record: request.record !== false,
      emit,
      recorded: [],
      messages: [],
      head: undefined,
      fenced: false,
    };
    const started = await start(state);
    if (started === 'busy') {
      const error: ErrorInfo = {
        message: `Session "${request.session}" already has a run in progress.`,
        type: 'session_busy',
        retryable: true,
      };
      emit({
        type: 'run.ended',
        runId: state.runId,
        result: { runId: state.runId, text: '', stopReason: 'error', error },
      });
      return { runId: state.runId, text: '', messages: [], recorded: [], stopReason: 'error', error };
    }
    emit({
      type: 'run.started',
      runId: state.runId,
      session: request.session,
      ...(state.record && state.head !== undefined ? { seq: state.head } : {}),
    });
    const { plan, repeated } = started;
    const { agent } = request;
    if (state.record && !isEmpty(request.input) && !repeated) {
      await write(state, [
        userEntry(request.input!, {
          ...(options.source !== undefined ? { source: options.source } : {}),
          ...(request.inputKey !== undefined ? { key: request.inputKey } : {}),
        }),
      ]);
    }
    const fail = (error: ErrorInfo, stopReason: StopReason = 'error'): Promise<RunResult> =>
      end(state, { stopReason, error, text: '', open: new Map(), last: undefined });
    const parentProblem = runParentProblem(request.parent);
    if (parentProblem !== undefined) return fail({ message: `${parentProblem}.`, type: 'invalid_request' });
    // `deny` 的工具照样交出去，调用时回拒绝（同参考实现）：扩展在 pi 里拦，MCP 服务器那边也拦。
    const definitions = selectTools(await catalog(), agent.tools ?? true);
    const builtins = [...new Set(options.builtinTools ?? [])];
    const problem = specProblem(agent);
    if (problem !== undefined) return fail({ message: problem, type: 'invalid_request' });
    const prompt = promptOf(request.input, request.prompt);
    if (!prompt.message && prompt.images.length === 0) {
      return fail({ message: 'pi needs a user message: give RunRequest.input or prompt.', type: 'invalid_request' });
    }
    // 输入已经在日志里：来源（记忆按会话最后一条用户消息召回）看得到这一轮说的话。
    const facts = await factsFor(request);
    if (request.signal?.aborted) return fail({ message: 'The run was aborted.' }, 'aborted');

    const mcp = definitions.length > 0 ? await serveTools(state, definitions) : undefined;
    try {
      return await converse(state, plan, definitions, builtins, prompt, mcp, facts);
    } finally {
      await mcp?.close();
    }
  }

  /** 这一轮的事实：按 `AgentSpec.context.facts` 挑来源、收（同参考实现的 builder），渲染好的文字，接在指令后面。 */
  async function factsFor(request: RunRequest): Promise<string | undefined> {
    const spec = request.agent.context?.facts;
    if (spec === false || sources.length === 0) return undefined;
    const { sources: names, heading } = typeof spec === 'object' ? spec : {};
    let chosen = sources;
    if (names) {
      const wanted = new Set(names);
      chosen = sources.filter((source) => wanted.has(source.name));
      for (const name of wanted) {
        if (!sources.some((source) => source.name === name)) logger.warn(`context source "${name}" is not registered`);
      }
    }
    if (chosen.length === 0) return undefined;
    const collected = await collectFacts(chosen, {
      session: request.session,
      ...(request.signal ? { signal: request.signal } : {}),
      ...(options.sourceTimeoutMs !== undefined ? { timeoutMs: options.sourceTimeoutMs } : {}),
      onError: (source, error) =>
        logger.warn(`context source "${source}" failed`, {
          error: error instanceof Error ? error.message : String(error),
        }),
    });
    return collected.length > 0 ? renderFacts(collected, heading) : undefined;
  }

  /** 这一轮的 MCP 服务器：只听本机、带一次性的令牌；第一次把调用交给某个执行环境之前 `open` 这个会话（ADR 0009）。 */
  async function serveTools(state: RunState, definitions: readonly ToolDefinition[]): Promise<Served> {
    const { session, agent } = state.request;
    const environment = agent.environment;
    const opened = new Map<string, Promise<void>>();
    const wrapped = [...executors.values()].map((executor): Executor => ({
      name: executor.name,
      async execute(call, context) {
        if (toolPermission(agent.permissions, call.name) === 'deny') return errorOutput(denied(call.name));
        if (executor.open) {
          let opening = opened.get(executor.name);
          if (!opening) {
            opening = executor.open(session, {
              ...(environment ? { environment } : {}),
              ...(state.request.signal ? { signal: state.request.signal } : {}),
            });
            opened.set(executor.name, opening);
          }
          try {
            await opening;
          } catch (error) {
            return errorOutput(
              `Executor "${executor.name}" could not prepare session "${session}" for tool "${call.name}": ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
        return executor.execute(call, context);
      },
    }));
    const server: McpServer = createMcpServer({
      executors: wrapped,
      tools: definitions,
      context: { session, runId: state.runId },
      name: 'ctx',
      ...(options.maxToolOutputChars !== undefined ? { maxOutputChars: options.maxToolOutputChars } : {}),
      logger,
    });
    const token = randomBytes(24).toString('base64url');
    const handler = createMcpHttpHandler(server, { accessToken: token });
    let contacted = false;
    const http: Server = createServer((req, res) => {
      if (req.headers.authorization === `Bearer ${token}`) contacted = true;
      void handler(req, res);
    });
    await new Promise<void>((resolve, reject) => {
      http.once('error', reject);
      http.listen(0, '127.0.0.1', () => resolve());
    });
    const { port } = http.address() as AddressInfo;
    return {
      url: `http://127.0.0.1:${port}/mcp`,
      token,
      contacted: () => contacted,
      async close() {
        server.close();
        http.closeAllConnections();
        await new Promise<void>((resolve) => http.close(() => resolve()));
      },
    };
  }

  function argsFor(
    state: RunState,
    plan: Plan,
    definitions: readonly ToolDefinition[],
    builtins: readonly string[],
    extension: string,
    prompts: readonly string[],
  ): string[] {
    const { agent } = state.request;
    const allowed = [...builtins, ...definitions.map((definition) => mcpToolName(PI_MCP_SERVER, definition.name))];
    const dir = options.sessionDir !== undefined ? ['--session-dir', options.sessionDir] : [];
    // 记录型运行接着（或新开）那个会话；不记的运行在一份副本上跑（`--fork`，跑完删），新开的就不存。
    const session = state.record
      ? [...dir, '--session-id', plan.session]
      : plan.fresh
        ? ['--no-session']
        : [...dir, '--fork', plan.session];
    return [
      '--mode',
      'rpc',
      ...(options.bare ? BARE_ARGS : []),
      // ctx 的工具要 pi 内置的 MCP 扩展；没有 ctx 的工具就关掉 MCP，别处配的 MCP 服务器的工具也不交出去。
      ...(definitions.length > 0 ? ['-e', 'builtin:mcp'] : ['--no-mcp']),
      '-e',
      extension,
      // 只交出这几个：自带的、ctx 的（名字以 `mcp__` 开头的项让别的 MCP 工具也不交出去）。
      ...(allowed.length > 0 ? ['--tools', allowed.join(',')] : ['--no-tools']),
      ...session,
      ...(options.provider !== undefined ? ['--provider', options.provider] : []),
      '--model',
      agent.model as string,
      // 写在文件里：`--append-system-prompt` 的参数是个存在的路径时 pi 读文件，直接给文字会被当成路径。
      ...prompts.flatMap((file) => ['--append-system-prompt', file]),
      ...(options.args ?? []),
    ];
  }

  async function converse(
    state: RunState,
    plan: Plan,
    definitions: readonly ToolDefinition[],
    builtins: readonly string[],
    prompt: PiPrompt,
    mcp: Served | undefined,
    facts: string | undefined,
  ): Promise<RunResult> {
    const { agent } = state.request;
    const byPiName = new Map(
      definitions.map((definition) => [mcpToolName(PI_MCP_SERVER, definition.name), definition]),
    );
    const toolName = (name: string): string => byPiName.get(name)?.name ?? name;
    const maxSteps = agent.maxSteps ?? (definitions.length + builtins.length > 0 ? 5 : 1);
    const deny: Record<string, string> = {};
    for (const definition of definitions) {
      if (toolPermission(agent.permissions, definition.name) === 'deny') {
        deny[mcpToolName(PI_MCP_SERVER, definition.name)] = definition.name;
      }
    }
    for (const name of builtins) if (toolPermission(agent.permissions, name) === 'deny') deny[name] = name;
    const rewind = plan.truncateAt ? `ctx-rewind-${randomBytes(8).toString('hex')}` : undefined;
    const config: ExtensionConfig = {
      ...(mcp ? { server: { name: PI_MCP_SERVER, url: mcp.url, token: mcp.token } } : {}),
      tools: [...byPiName.keys()],
      deny,
      maxSteps,
      ...(agent.budget?.maxTotalTokens !== undefined ? { maxTotalTokens: agent.budget.maxTotalTokens } : {}),
      ...(agent.budget?.maxDurationMs !== undefined ? { maxDurationMs: agent.budget.maxDurationMs } : {}),
      ...(rewind ? { rewind } : {}),
    };
    // 扩展（带着令牌）和系统提示写进只有自己读得到的临时目录，这一轮结束就删。
    const dir = await mkdtemp(join(tmpdir(), 'ctx-pi-'));
    try {
      const extension = join(dir, 'ctx.mjs');
      await writeFile(extension, extensionSource(config), { mode: 0o600 });
      const prompts: string[] = [];
      // 事实接在指令后面（同参考实现 builder 的缺省 `factsPlacement`），空行隔开。
      const instructions = [agent.instructions, facts].filter((part) => part !== undefined && part.trim() !== '');
      if (instructions.length > 0) {
        prompts.push(join(dir, 'instructions.md'));
        await writeFile(prompts.at(-1)!, instructions.join('\n\n'), { mode: 0o600 });
      }
      if (agent.output) {
        prompts.push(join(dir, 'output.md'));
        await writeFile(prompts.at(-1)!, outputInstructions(agent.output), { mode: 0o600 });
      }
      const proc = new PiProcess({
        command,
        args: argsFor(state, plan, definitions, builtins, extension, prompts),
        env,
        ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      });
      return await drive(state, plan, proc, { byPiName, toolName, maxSteps, rewind, prompt, mcp });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  async function drive(
    state: RunState,
    plan: Plan,
    proc: PiProcess,
    run: {
      readonly byPiName: ReadonlyMap<string, ToolDefinition>;
      readonly toolName: (name: string) => string;
      readonly maxSteps: number;
      readonly rewind: string | undefined;
      readonly prompt: PiPrompt;
      readonly mcp: Served | undefined;
    },
  ): Promise<RunResult> {
    const { request } = state;
    const { agent } = request;
    const settings = agent.settings ?? {};
    const { byPiName, toolName } = run;
    let cause: StopCause | undefined;
    const stop = (why: StopCause): void => {
      cause ??= why;
      proc.abort(grace);
    };
    const onAbort = (): void => stop('aborted');
    request.signal?.addEventListener('abort', onAbort, { once: true });
    const timer =
      settings.timeoutMs !== undefined ? setTimeout(() => stop('timeout'), settings.timeoutMs).unref() : undefined;
    const startedAt = Date.now();

    // 这一步的状态。
    let step = 0;
    let stepStarted = false;
    let calls: ToolCall[] = [];
    let pendingUsage: Usage | undefined;
    const results = new Map<string, { output: ToolOutput; source: string }>();
    const open = new Map<string, string>();
    /** 调用 id → 执行方：ctx 的执行环境的名字，pi 自带的工具是 `pi`。 */
    const executedBy = new Map<string, string>();
    let total: Usage | undefined;
    let lastText = '';
    let lastStop: PiStopReason | undefined;
    let apiError: string | undefined;
    let settled: { readonly aborted: boolean } | undefined;
    /** pi 不肯跑这一轮：准备的命令、那句话的 `prompt` 失败了。 */
    let refused: ErrorInfo | undefined;
    let checked = false;
    let fork: string | undefined;
    let last: string | undefined;

    const overBudget = (): boolean => {
      const { budget } = agent;
      if (!budget) return false;
      const used = total?.totalTokens ?? (total?.inputTokens ?? 0) + (total?.outputTokens ?? 0);
      return (
        (budget.maxTotalTokens !== undefined && used > budget.maxTotalTokens) ||
        (budget.maxDurationMs !== undefined && Date.now() - startedAt > budget.maxDurationMs)
      );
    };
    const beginStep = (): void => {
      if (stepStarted) return;
      stepStarted = true;
      state.emit({ type: 'model.started', runId: state.runId, step });
    };
    const endStep = (usage: Usage | undefined): void => {
      state.emit({
        type: 'model.ended',
        runId: state.runId,
        step,
        ...(usage ? { usage } : {}),
        ...(state.record && state.head !== undefined ? { seq: state.head } : {}),
      });
      step += 1;
      stepStarted = false;
    };

    /** 一条助手消息收齐了：写进日志，交出工具调用；没有调用的这一步就结束了。出错、被中断的不记（同参考实现）。 */
    const onAssistant = async (message: PiAssistantMessage): Promise<void> => {
      lastStop = message.stopReason;
      if (message.stopReason === 'error' || message.stopReason === 'aborted') {
        // 没有 `model.ended`（同参考实现）；重试时这一步重新开始。
        stepStarted = false;
        if (message.stopReason === 'error') apiError = message.errorMessage || 'The model call failed.';
        return;
      }
      apiError = undefined;
      const usage = usageOf(message.usage);
      total = addUsages(total, usage);
      if (message.content.length === 0) {
        if (stepStarted) endStep(usage);
        return;
      }
      beginStep();
      const finishReason = finishReasonOf(message.stopReason);
      const meta: StepMeta = {
        runId: state.runId,
        step,
        ...(message.provider ? { provider: message.provider } : {}),
        ...(message.model ? { modelId: message.model } : {}),
        ...(finishReason ? { finishReason } : {}),
        ...(usage ? { usage } : {}),
      };
      const assistant = assistantMessageOf(message, toolName);
      state.messages.push(assistant);
      lastText = textOf(message);
      await write(state, [messageEntry(assistant, { source: 'model', meta: { step: stepMetaToJson(meta) } })]);
      calls = toolCallsOf(message).map((call) => {
        executedBy.set(call.id, byPiName.get(call.name)?.executor ?? PI_HARNESS);
        return { id: call.id, name: toolName(call.name), input: call.arguments ?? {} };
      });
      for (const call of calls) {
        open.set(call.id, call.name);
        state.emit({ type: 'tool.called', runId: state.runId, call });
      }
      if (calls.length === 0) endStep(usage);
      else pendingUsage = usage;
    };

    const returned = (id: string, output: ToolOutput): void => {
      results.set(id, { output, source: executedBy.get(id) ?? PI_HARNESS });
      state.emit({ type: 'tool.returned', runId: state.runId, callId: id, output });
    };

    /** 一次调用执行完了：MCP 工具的结果在这里还带着 `structuredContent`。工具自己调的工具（`parentToolCallId`）不算。 */
    const onToolEnd = (record: PiRecord): void => {
      const id = record['toolCallId'];
      if (typeof id !== 'string' || !open.has(id) || results.has(id) || record['parentToolCallId'] !== undefined)
        return;
      const raw = record['toolName'];
      const result = isObject(record['result']) ? (record['result'] as PiToolResult) : undefined;
      returned(id, toolOutputOf(result, record['isError'] === true, typeof raw === 'string' && byPiName.has(raw)));
    };

    /** 这一步结束了（`turn_end`）：按执行方分组写下工具结果（ctx 的执行环境、`pi`），没执行就回了错误的从 pi 给的结果补上。 */
    const flushResults = async (toolResults: readonly PiToolResultMessage[]): Promise<void> => {
      if (calls.length === 0) return;
      for (const message of toolResults) {
        if (!isObject(message) || typeof message.toolCallId !== 'string') continue;
        const id = message.toolCallId;
        if (open.has(id) && !results.has(id)) {
          returned(id, toolOutputOf({ content: message.content ?? [] }, message.isError === true, false));
        }
      }
      const groups = new Map<string, ToolPart[]>();
      for (const call of calls) {
        const found = results.get(call.id);
        if (!found) continue;
        const group = groups.get(found.source) ?? [];
        group.push({ type: 'tool-result', id: call.id, name: call.name, output: found.output });
        groups.set(found.source, group);
        open.delete(call.id);
      }
      const entries: NewEntry[] = [];
      for (const [source, parts] of groups) {
        const message: Message = { role: 'tool', content: parts };
        state.messages.push(message);
        entries.push(messageEntry(message, { source }));
      }
      await write(state, entries);
      calls = [];
      results.clear();
      endStep(pendingUsage);
      pendingUsage = undefined;
    };

    const handle = async (record: PiRecord): Promise<void> => {
      switch (record.type) {
        case 'response': {
          if (record['id'] !== PROMPT_ID) return;
          const response = record as PiResponse;
          if (!response.success) refused = { message: response.error || 'pi did not accept the prompt.', type: 'pi' };
          else if (dataOf(response, 'disposition') !== 'started') {
            refused = {
              message: `pi did not start a run for the prompt (${String(dataOf(response, 'disposition'))}).`,
              type: 'pi',
            };
          }
          return;
        }
        case 'message_start': {
          const message = record['message'];
          if (!isAssistant(message)) return;
          // pi 调模型之前等交给模型的 MCP 服务器连上：到这里还没连过来，ctx 的工具就不在它手里（同名的服务器盖住了）。
          if (!checked) {
            checked = true;
            if (run.mcp && !run.mcp.contacted()) {
              stop('unreachable');
              return;
            }
          }
          if (message.stopReason === 'pending') beginStep();
          return;
        }
        case 'message_update': {
          const event = record['assistantMessageEvent'];
          if (!isObject(event) || typeof event['delta'] !== 'string' || !event['delta']) return;
          if (event['type'] === 'text_delta')
            state.emit({ type: 'text.delta', runId: state.runId, text: event['delta'] });
          else if (event['type'] === 'thinking_delta') {
            state.emit({ type: 'reasoning.delta', runId: state.runId, text: event['delta'] });
          }
          return;
        }
        case 'message_end': {
          const message = record['message'];
          if (isAssistant(message) && cause !== 'unreachable') await onAssistant(message);
          return;
        }
        case 'tool_execution_end':
          onToolEnd(record);
          return;
        case 'turn_end':
          await flushResults(
            Array.isArray(record['toolResults']) ? (record['toolResults'] as PiToolResultMessage[]) : [],
          );
          return;
        case 'compaction_end': {
          const result = record['result'];
          if (isObject(result) && typeof result['summary'] === 'string') {
            const data: Record<string, JsonValue> = {};
            if (typeof record['reason'] === 'string') data['reason'] = record['reason'];
            for (const key of ['tokensBefore', 'estimatedTokensAfter', 'firstKeptEntryId']) {
              const value = result[key];
              if (typeof value === 'number' || typeof value === 'string') data[key] = value;
            }
            await write(state, [
              eventEntry(PI_EVENTS.compacted, { source: PI_HARNESS, text: result['summary'], data }),
            ]);
          } else if (typeof record['errorMessage'] === 'string') {
            logger.warn('pi could not compact its context', { error: record['errorMessage'] });
          }
          return;
        }
        case 'extension_ui_request':
          if (record['method'] === 'notify' && record['notifyType'] !== 'info') {
            logger.warn('pi notice', { message: String(record['message']) });
          }
          return;
        case 'extension_error':
          logger.warn('pi extension error', {
            extension: String(record['extensionPath']),
            event: String(record['event']),
            error: String(record['error']),
          });
          return;
        case 'agent_settled':
          settled = { aborted: record['aborted'] === true };
          return;
        default:
          return;
      }
    };

    /** 发那句话之前：关自动重试、记下副本的文件、退回、核对接着跑的位置还在。 */
    const prepare = async (): Promise<ErrorInfo | undefined> => {
      if (settings.maxRetries === 0) {
        const response = await proc.request({ type: 'set_auto_retry', enabled: false });
        if (response && !response.success) return { message: `pi: set_auto_retry: ${response.error}`, type: 'pi' };
      }
      if (!state.record && !plan.fresh) {
        const sessionFile = dataOf(await proc.request({ type: 'get_state' }), 'sessionFile');
        if (typeof sessionFile === 'string') fork = sessionFile;
      }
      if (plan.truncateAt && run.rewind) {
        const response = await proc.request({ type: 'prompt', message: `/${run.rewind} ${plan.truncateAt}` });
        if (response && (!response.success || dataOf(response, 'disposition') !== 'handled')) {
          return {
            message: `pi could not go back to entry ${plan.truncateAt} of session ${plan.session}: ${response.error ?? String(dataOf(response, 'disposition'))}.`,
            type: 'pi',
          };
        }
      }
      if (state.record && !plan.fresh && plan.resumeAt) {
        const response = await proc.request({ type: 'get_entries', since: plan.resumeAt });
        if (response && !response.success) {
          return {
            message: `pi's session ${plan.session} has no entry ${plan.resumeAt} (${response.error ?? 'not found'}); was it deleted, or does this run use another cwd or sessionDir?`,
            type: 'not_found',
            retryable: false,
          };
        }
        if (response && plan.truncateAt && dataOf(response, 'leafId') !== plan.truncateAt) {
          return { message: `pi did not go back to entry ${plan.truncateAt} of session ${plan.session}.`, type: 'pi' };
        }
      }
      return undefined;
    };

    let exit: Exit | undefined;
    let failure: unknown;
    try {
      refused = await prepare();
      if (refused === undefined && cause === undefined) {
        proc.send({
          id: PROMPT_ID,
          type: 'prompt',
          message: run.prompt.message,
          ...(run.prompt.images.length > 0 ? { images: run.prompt.images } : {}),
        });
        for await (const record of proc.records()) {
          await handle(record);
          if (state.fenced) stop('fenced');
          if (settled || refused) break;
        }
        // 没等到 `turn_end` 就结束了（进程没了）：到了的结果照样写下，别的在收尾时补 `INTERRUPTED`。
        await flushResults([]);
        if (state.record && settled) {
          let entries = await proc.request({
            type: 'get_entries',
            ...(plan.resumeAt ? { since: plan.resumeAt } : {}),
          });
          if (entries && !entries.success && plan.resumeAt) entries = await proc.request({ type: 'get_entries' });
          const leaf = dataOf(entries, 'leafId');
          if (typeof leaf === 'string') last = leaf;
        }
      }
    } catch (error) {
      // 写日志失败：停下 pi，把错误抛给调用方（同参考实现：只有写日志失败才 reject）。
      failure = error;
      stop('aborted');
    } finally {
      request.signal?.removeEventListener('abort', onAbort);
      if (timer) clearTimeout(timer);
      exit = await proc.finish(grace);
      if (fork) await rm(fork, { force: true });
    }
    if (failure !== undefined) throw failure;
    if (state.fenced || cause === 'fenced') {
      return {
        runId: state.runId,
        text: '',
        messages: state.messages,
        recorded: state.recorded,
        stopReason: 'aborted',
      };
    }

    let stopReason: StopReason;
    let error: ErrorInfo | undefined;
    if (cause === 'aborted') stopReason = 'aborted';
    else if (cause === 'timeout') {
      stopReason = 'error';
      error = {
        message: `pi did not finish within settings.timeoutMs (${String(settings.timeoutMs)} ms).`,
        type: 'timeout',
        retryable: true,
      };
    } else if (cause === 'unreachable') {
      stopReason = 'error';
      error = {
        message: `pi did not connect to the MCP server with the ctx tools. Is another MCP server named "${PI_MCP_SERVER}" configured in pi's mcp.json? It takes precedence over the one this adapter registers.`,
        type: 'pi',
      };
    } else if (refused) {
      stopReason = 'error';
      error = refused;
    } else if (!settled) {
      stopReason = 'error';
      error = exitError(exit, proc.stderr);
    } else if (lastStop === 'error' && apiError !== undefined) {
      stopReason = 'error';
      error = errorOfMessage(apiError);
    } else if (settled.aborted) {
      // 没人叫停却中断了：扩展在步数或预算到了时叫停的。
      stopReason = step >= run.maxSteps ? 'max_steps' : overBudget() ? 'max_budget' : 'aborted';
    } else stopReason = lastStop === 'length' ? 'max_tokens' : 'end_turn';

    let output: JsonValue | undefined;
    if (agent.output && stopReason === 'end_turn') {
      const parsed = parseOutput(lastText);
      const issues = parsed ? checkJsonSchema(agent.output.schema, parsed.value) : ['the answer is not JSON'];
      if (issues.length > 0) {
        stopReason = 'error';
        error = {
          message: `pi's answer does not match AgentSpec.output.schema: ${issues.join('; ')}.`,
          type: 'invalid_output',
          retryable: false,
        };
      } else output = parsed!.value;
    }
    return end(state, {
      stopReason,
      text: stopReason === 'error' ? '' : lastText,
      open,
      last,
      ...(error ? { error } : {}),
      ...(total ? { usage: total } : {}),
      ...(output !== undefined ? { output } : {}),
    });
  }

  function exitError(exit: Exit | undefined, stderr: string): ErrorInfo {
    if (exit?.error) return { message: `Could not start pi ("${command}"): ${exit.error.message}`, type: 'pi' };
    const how = exit?.signal ? `signal ${exit.signal}` : `code ${String(exit?.code)}`;
    return {
      message: `pi exited (${how}) before the run finished${stderr ? `: ${stderr.slice(-500)}` : '.'}`,
      type: 'pi',
    };
  }

  /** 收尾：没等到结果的工具调用补错误结果，出错写 `ctx.error`，最后写 `ctx.run.ended`（带 pi 会话里的位置）。 */
  async function end(
    state: RunState,
    outcome: {
      readonly stopReason: StopReason;
      readonly text: string;
      readonly open: ReadonlyMap<string, string>;
      readonly last: string | undefined;
      readonly error?: ErrorInfo;
      readonly usage?: Usage;
      readonly output?: JsonValue;
    },
  ): Promise<RunResult> {
    const { stopReason, error, usage, output } = outcome;
    const entries: NewEntry[] = [];
    if (outcome.open.size > 0) {
      const message: Message = {
        role: 'tool',
        content: [...outcome.open].map(([id, name]) => ({
          type: 'tool-result',
          id,
          name,
          output: errorOutput(INTERRUPTED),
        })),
      };
      state.messages.push(message);
      entries.push(messageEntry(message, { source: 'harness' }));
    }
    if (error) {
      state.emit({ type: 'error', runId: state.runId, message: error.message });
      entries.push(
        ctxErrorEntry(
          { runId: state.runId, message: error.message, ...(error.type ? { type: error.type } : {}) },
          { source: 'harness' },
        ),
      );
    }
    const meta = metaOf({ last: outcome.last });
    entries.push(
      runEndedEntry(
        { runId: state.runId, stopReason, ...(usage ? { usage } : {}) },
        { source: 'harness', ...(meta ? { meta } : {}) },
      ),
    );
    await write(state, entries);
    if (state.fenced) {
      return {
        runId: state.runId,
        text: '',
        messages: state.messages,
        recorded: state.recorded,
        stopReason: 'aborted',
      };
    }
    const summary = {
      runId: state.runId,
      text: outcome.text,
      stopReason,
      ...(usage ? { usage } : {}),
      ...(output !== undefined ? { output } : {}),
      ...(error ? { error } : {}),
    };
    state.emit({
      type: 'run.ended',
      runId: state.runId,
      result: summary,
      ...(state.record && state.head !== undefined ? { seq: state.head } : {}),
    });
    return { ...summary, messages: state.messages, recorded: state.recorded };
  }

  // ---- 排队和流 ----

  /** 同一个实例里同一会话的记录型运行一个接一个（同参考实现），`session_busy` 只出现在跨进程的时候。 */
  const tails = new Map<string, Promise<void>>();
  async function queued(request: RunRequest, emit: (event: RunEvent) => void): Promise<RunResult> {
    if (request.record === false) return execute(request, emit);
    const previous = tails.get(request.session) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((resolve) => (release = resolve));
    const tail = previous.then(() => mine);
    tails.set(request.session, tail);
    await previous;
    try {
      return await execute(request, emit);
    } finally {
      release();
      if (tails.get(request.session) === tail) tails.delete(request.session);
    }
  }

  return {
    run: (request) => queued(request, () => {}),
    async *stream(request) {
      const events: RunEvent[] = [];
      let wake: (() => void) | undefined;
      let done = false;
      let failure: unknown;
      const controller = new AbortController();
      const signal = request.signal ? AbortSignal.any([request.signal, controller.signal]) : controller.signal;
      const task = (async () => {
        try {
          await queued({ ...request, signal }, (event) => {
            events.push(event);
            wake?.();
          });
        } catch (error) {
          failure = error;
        } finally {
          done = true;
          wake?.();
        }
      })();
      try {
        for (;;) {
          const event = events.shift();
          if (event) {
            yield event;
            continue;
          }
          if (done) break;
          await new Promise<void>((resolve) => (wake = resolve));
          wake = undefined;
        }
        if (failure !== undefined) throw failure;
      } finally {
        // 调用方提前停了：停下这一轮。
        if (!done) controller.abort();
        await task;
      }
    },
  };
}
