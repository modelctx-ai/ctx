// Claude Code 当 ctx 的 harness（#23）：一轮起一个 `claude -p` 进程，它自己跑循环、自己存对话；
// ctx 的工具经 MCP（`createMcpServer`）交给它，调用回到 ctx 的执行环境；stream-json 的输出实时写进会话日志。
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createMcpHttpHandler, createMcpServer, type McpServer } from '@modelctx-ai/ctx-mcp';
import {
  agentSpecToJson,
  checkJsonSchema,
  collectFacts,
  CTX_EVENTS,
  ctxErrorEntry,
  errorOutput,
  eventEntry,
  headSeq,
  isConflict,
  isFrameworkKind,
  messageEntry,
  renderFacts,
  runEndedEntry,
  runParentProblem,
  runStartedEntry,
  selectTools,
  silentLogger,
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

import {
  CLAUDE_CODE_EVENTS,
  CLAUDE_CODE_HARNESS,
  CLAUDE_CODE_MCP_SERVER,
  INTERRUPTED,
  MAX_CONFLICTS,
} from './constants.ts';
import { ClaudeProcess, probeVersion, type Exit } from './process.ts';
import { SubagentTrace } from './subagents.ts';
import {
  addUsages,
  assistantMessageOf,
  errorOfResult,
  finishReasonOf,
  mcpToolName,
  textOfBlocks,
  toolOutputOf,
  usageOf,
  userBlocksOf,
  type AnthropicBlock,
  type AnthropicUsage,
  type AssistantLine,
  type ClaudeLine,
  type ResultLine,
  type UserLine,
} from './stream-json.ts';

export interface ClaudeCodeHarnessOptions {
  /** 会话日志：生命周期事件、输入、模型的每一步、工具结果都实时写进来。 */
  readonly store: SessionStore;
  /** ctx 的执行环境：ctx 的工具经 MCP 交给 Claude Code，调用由它们执行。 */
  readonly executors?: readonly Executor[] | Readonly<Record<string, Executor>>;
  /**
   * 工具目录：`AgentSpec.tools` 从这里挑，定义的 `executor` 指向 `executors` 里的一个；`createToolRegistry()` 建的注册表
   * 自带的函数执行环境自动加进来。不给就是各执行环境 `tools()` 报的全部。
   */
  readonly tools?: ToolRegistry;
  /** Claude Code 自带的工具（`Read`、`Bash`……）交出哪些，缺省一个都不交。它们的调用只记进日志，执行方是 `claude-code`。 */
  readonly builtinTools?: readonly string[];
  /** 可执行文件，缺省 `claude`。 */
  readonly command?: string;
  /** 加在最后的命令行参数。 */
  readonly args?: readonly string[];
  /** Claude Code 的工作目录，缺省当前目录。它按目录存会话：同一个 ctx 会话的各轮要用同一个。 */
  readonly cwd?: string;
  /** 子进程的环境变量，缺省 `process.env`。凭证（`ANTHROPIC_API_KEY` 等）从这里给。 */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** 加 `--bare`：不读用户和项目的设置、`CLAUDE.md`、钩子、插件，鉴权只认 `ANTHROPIC_API_KEY`。缺省不加。 */
  readonly bare?: boolean;
  /** 一次工具结果最多多少字符（`createMcpServer` 的 `maxOutputChars`），缺省 `DEFAULT_MAX_TOOL_OUTPUT_CHARS`。 */
  readonly maxToolOutputChars?: number;
  /** 取消后等 Claude Code 自己停下的时间，过了就结束进程。缺省 5 秒。 */
  readonly interruptTimeoutMs?: number;
  /**
   * 上下文来源（`ContextSource`，例如记忆的 `memory.source()`）：每轮记下输入之后收一次，收到的事实接在指令后面
   * （`--append-system-prompt`：每轮的系统提示，不进 Claude Code 自己的会话，也不写日志）。`AgentSpec.context.facts`
   * 选用哪些、加不加标题，`false` 不收。
   */
  readonly sources?: readonly ContextSource[];
  /** 单个来源最多等多久，缺省 2 秒（同参考实现的 builder）。 */
  readonly sourceTimeoutMs?: number;
  /** 输入条目的 `source`。 */
  readonly source?: string;
  readonly logger?: Logger;
}

export interface ClaudeCodeHarness extends Harness {
  stream(request: RunRequest): AsyncIterable<RunEvent>;
}

/** 认重试、找上一轮时最多往回读这么多条。 */
const SCAN = 64;

/** `ctx.run.started`、`ctx.run.ended` 和每一步的条目的 `meta.claudeCode`：Claude Code 记录里的位置。 */
interface ClaudeMeta {
  /** `ctx.run.started`：这一轮从 Claude Code 记录里的哪一条接着跑；新开的会话没有。 */
  readonly resumeAt?: string;
  /** `ctx.run.ended`：这一轮结束时 Claude Code 记录的最后一条。 */
  readonly last?: string;
  /** 步骤的条目：它对应的 Claude Code 记录里的那一条。 */
  readonly uuid?: string;
}

type StopCause = 'aborted' | 'budget' | 'timeout' | 'fenced';

interface Plan {
  readonly session: string;
  readonly fresh: boolean;
  /** 给 `--resume-session-at`：上一轮失败、这一轮重试，退回到失败那一轮开始的位置。 */
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
  head: number | undefined;
  fenced: boolean;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isEvent(entry: Entry | undefined, kind: string): entry is Extract<Entry, { type: 'event' }> {
  return entry?.type === 'event' && entry.kind === kind;
}

function runIdOf(entry: Entry): unknown {
  return entry.type === 'event' && isObject(entry.data) ? entry.data['runId'] : undefined;
}

function claudeMeta(entry: Entry | undefined): ClaudeMeta {
  const meta = entry?.meta?.['claudeCode'];
  return isObject(meta) ? meta : {};
}

function metaOf(meta: { readonly [K in keyof ClaudeMeta]?: string | undefined }): JsonObject | undefined {
  const fields = Object.fromEntries(Object.entries(meta).filter(([, value]) => typeof value === 'string'));
  return Object.keys(fields).length > 0 ? { claudeCode: fields } : undefined;
}

function isEmpty(content: MessageContent | undefined): boolean {
  return content === undefined || (typeof content === 'string' ? content.length === 0 : content.length === 0);
}

/** 映射不了的 `AgentSpec` 字段：有就以 `invalid_request` 结束，不静默忽略。 */
function specProblem(agent: AgentSpec): string | undefined {
  if (typeof agent.model !== 'string' || agent.model === '') {
    return 'AgentSpec.model must be a model name: Claude Code takes the model by name (--model).';
  }
  if (agent.window !== undefined) return 'AgentSpec.window is not supported: Claude Code manages its own context.';
  const context = contextProblem(agent.context);
  if (context !== undefined) return context;
  if (agent.toolChoice !== undefined && agent.toolChoice !== 'auto') {
    return 'AgentSpec.toolChoice is not supported by Claude Code; only "auto".';
  }
  const unsupported = Object.keys(agent.settings ?? {}).filter(
    (key) => !['maxRetries', 'maxOutputTokens', 'timeoutMs'].includes(key),
  );
  if (unsupported.length > 0) {
    return `AgentSpec.settings.${unsupported.join(', ')} not supported by Claude Code; only maxRetries, maxOutputTokens and timeoutMs.`;
  }
  const { permissions } = agent;
  if (
    permissions?.default === 'ask' ||
    Object.values(permissions?.tools ?? {}).some((permission) => permission === 'ask')
  ) {
    return 'AgentSpec.permissions "ask" is not supported: Claude Code runs the whole turn itself (no requires_action).';
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
 * `AgentSpec.context` 只认 `facts`：历史、窗口、压缩是 Claude Code 自己的。事实只能接在指令后面：放进 `prompt` 就成了
 * 这一轮的用户消息，留在 Claude Code 自己的会话里，不再是「只在这一次调用里出现」。
 */
function contextProblem(context: AgentSpec['context']): string | undefined {
  if (context === undefined) return undefined;
  if (!isObject(context)) return 'AgentSpec.context must be an object.';
  const others = Object.entries(context)
    .filter(([key, value]) => key !== 'facts' && value !== undefined)
    .map(([key]) => key);
  if (others.length > 0) {
    return `AgentSpec.context.${others.join(', ')} not supported: Claude Code manages its own context; only context.facts.`;
  }
  const { facts } = context;
  if (facts !== undefined && typeof facts !== 'boolean' && !isObject(facts)) {
    return 'AgentSpec.context.facts must be a boolean or an object.';
  }
  if (isObject(facts) && facts['placement'] === 'prompt') {
    return 'AgentSpec.context.facts.placement "prompt" is not supported: the prompt would stay in Claude Code\'s own session. Facts go after the instructions.';
  }
  return undefined;
}

/** 上一轮由这个适配器跑的运行：它的 `ctx.run.started`、`ctx.run.ended`（还没结束就没有）。 */
function previousRun(lifecycle: readonly Entry[]) {
  for (let index = lifecycle.length - 1; index >= 0; index -= 1) {
    const started = lifecycle[index]!;
    if (!isEvent(started, CTX_EVENTS.runStarted) || !isObject(started.data)) continue;
    const harness = started.data['harness'];
    if (!isObject(harness) || harness['name'] !== CLAUDE_CODE_HARNESS || typeof harness['session'] !== 'string')
      continue;
    const runId = started.data['runId'];
    const ended = lifecycle
      .slice(index + 1)
      .find((entry) => isEvent(entry, CTX_EVENTS.runEnded) && runIdOf(entry) === runId);
    return { started, ended, session: harness['session'] };
  }
  return undefined;
}

function endedInFailure(entry: Entry | undefined): boolean {
  if (!isEvent(entry, CTX_EVENTS.runEnded) || !isObject(entry.data)) return false;
  const { stopReason } = entry.data;
  return stopReason === 'error' || stopReason === 'aborted';
}

export function createClaudeCodeHarness(options: ClaudeCodeHarnessOptions): ClaudeCodeHarness {
  const { store } = options;
  const logger = options.logger ?? silentLogger;
  const command = options.command ?? 'claude';
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
        // 这一轮中间别人写了东西（应用的事件）：给这一轮写了 ended（被围栏）就不再写，否则接在新的末尾后面。
        const after = await store.list(session, { after: state.head ?? 0 });
        if (after.some((entry) => isEvent(entry, CTX_EVENTS.runEnded) && runIdOf(entry) === state.runId)) {
          state.fenced = true;
          return;
        }
        state.head = after.at(-1)?.seq ?? state.head;
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
      if (entry.type === 'event' && (isFrameworkKind(entry.kind) || entry.kind.startsWith(`${CLAUDE_CODE_HARNESS}.`)))
        continue;
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
   * 定这一轮接着 Claude Code 的哪个会话、从哪接：上一轮记下的会话和位置；上一轮失败、这一轮是重试（同样的输入，或同一个
   * `inputKey`）就退回到失败那一轮开始的位置（`--resume-session-at`），失败那一轮的输入不在 Claude Code 的上下文里出现两次。
   * 没有上一轮、位置不知道的，开新会话。记录型运行先查会话忙不忙，然后带着读到的末尾写 `ctx.run.started`，冲突就重来。
   */
  async function start(state: RunState): Promise<{ plan: Plan; repeated: boolean } | 'busy'> {
    const { session, agent, input, inputKey } = state.request;
    const hasInput = !isEmpty(input);
    for (let conflicts = 0; ; conflicts += 1) {
      const head = await headSeq(store, session);
      const lifecycle = await store.list(session, { kinds: [CTX_EVENTS.runStarted, CTX_EVENTS.runEnded], last: SCAN });
      const last = lifecycle.at(-1);
      if (state.record && isEvent(last, CTX_EVENTS.runStarted)) return 'busy';
      const previous = previousRun(lifecycle);
      const failed = endedInFailure(last);
      const repeated = state.record && hasInput && failed && (await repeatsFailedInput(session, input!, inputKey));
      const position = previous && (claudeMeta(previous.ended).last ?? claudeMeta(previous.started).resumeAt);
      let plan: Plan;
      if (repeated && previous && previous.ended === last) {
        const back = claudeMeta(previous.started).resumeAt;
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
            name: CLAUDE_CODE_HARNESS,
            ...(harnessVersion !== undefined ? { version: harnessVersion } : {}),
            session: plan.session,
          },
        },
        { source: 'harness', ...(plan.resumeAt ? { meta: metaOf({ resumeAt: plan.resumeAt })! } : {}) },
      );
      try {
        const written = await store.append(session, [started], { expectSeq: head });
        state.recorded.push(...written);
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
      const result: RunResult = {
        runId: state.runId,
        text: '',
        messages: [],
        recorded: [],
        stopReason: 'error',
        error,
      };
      emit({
        type: 'run.ended',
        runId: state.runId,
        result: { runId: state.runId, text: '', stopReason: 'error', error },
      });
      return result;
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
    const signal = request.signal;
    const fail = (error: ErrorInfo, stopReason: StopReason = 'error'): Promise<RunResult> =>
      end(state, { stopReason, error, text: '', open: new Map(), last: undefined });
    const parentProblem = runParentProblem(request.parent);
    if (parentProblem !== undefined) return fail({ message: `${parentProblem}.`, type: 'invalid_request' });
    const definitions = selectTools(await catalog(), agent.tools ?? true).filter(
      (definition) => toolPermission(agent.permissions, definition.name) !== 'deny',
    );
    const builtins = (options.builtinTools ?? []).filter((name) => toolPermission(agent.permissions, name) !== 'deny');
    const problem = specProblem(agent);
    if (problem !== undefined) return fail({ message: problem, type: 'invalid_request' });
    const content = [...userBlocksOf(request.input), ...userBlocksOf(request.prompt)];
    if (content.length === 0) {
      return fail({
        message: 'Claude Code needs a user message: give RunRequest.input or prompt.',
        type: 'invalid_request',
      });
    }
    // 输入已经在日志里：来源（记忆按会话最后一条用户消息召回）看得到这一轮说的话。
    const facts = await factsFor(request);
    if (signal?.aborted) return fail({ message: 'The run was aborted.' }, 'aborted');

    const mcp = definitions.length > 0 ? await serveTools(state, definitions) : undefined;
    try {
      return await converse(state, plan, definitions, builtins, content, mcp?.configPath, facts);
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
  async function serveTools(state: RunState, definitions: readonly ToolDefinition[]) {
    const { session, agent } = state.request;
    const environment = agent.environment;
    const opened = new Map<string, Promise<void>>();
    const wrapped = [...executors.values()].map((executor): Executor => ({
      name: executor.name,
      async execute(call, context) {
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
    const http: Server = createServer((req, res) => void handler(req, res));
    await new Promise<void>((resolve, reject) => {
      http.once('error', reject);
      http.listen(0, '127.0.0.1', () => resolve());
    });
    const { port } = http.address() as AddressInfo;
    // 配置写进只有自己读得到的临时文件，令牌不出现在命令行里。
    const dir = await mkdtemp(join(tmpdir(), 'ctx-claude-code-'));
    const configPath = join(dir, 'mcp.json');
    const config = {
      mcpServers: {
        [CLAUDE_CODE_MCP_SERVER]: {
          type: 'http',
          url: `http://127.0.0.1:${port}/mcp`,
          headers: { Authorization: `Bearer ${token}` },
        },
      },
    };
    await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
    return {
      configPath,
      async close() {
        server.close();
        http.closeAllConnections();
        await new Promise<void>((resolve) => http.close(() => resolve()));
        await rm(dir, { recursive: true, force: true });
      },
    };
  }

  function argsFor(
    state: RunState,
    plan: Plan,
    definitions: readonly ToolDefinition[],
    builtins: readonly string[],
    configPath: string | undefined,
    facts: string | undefined,
  ): string[] {
    const { agent } = state.request;
    // 事实接在指令后面（同参考实现 builder 的缺省 `factsPlacement`），空行隔开。
    const instructions = [agent.instructions, facts]
      .filter((part) => part !== undefined && part.trim() !== '')
      .join('\n\n');
    const allowed = [
      ...definitions.map((definition) => mcpToolName(CLAUDE_CODE_MCP_SERVER, definition.name)),
      ...builtins,
    ];
    const maxSteps = agent.maxSteps ?? (definitions.length + builtins.length > 0 ? 5 : 1);
    return [
      ...(options.bare ? ['--bare'] : []),
      '-p',
      '--output-format',
      'stream-json',
      '--input-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      ...(plan.fresh ? ['--session-id', plan.session] : ['--resume', plan.session]),
      ...(plan.truncateAt ? ['--resume-session-at', plan.truncateAt] : []),
      ...(state.record ? [] : ['--no-session-persistence']),
      '--tools',
      builtins.join(','),
      '--strict-mcp-config',
      ...(configPath ? ['--mcp-config', configPath] : []),
      ...(allowed.length > 0 ? ['--allowedTools', allowed.join(',')] : []),
      '--model',
      agent.model as string,
      ...(instructions ? ['--append-system-prompt', instructions] : []),
      '--max-turns',
      String(maxSteps),
      ...(agent.output ? ['--json-schema', JSON.stringify(agent.output.schema)] : []),
      ...(options.args ?? []),
    ];
  }

  async function converse(
    state: RunState,
    plan: Plan,
    definitions: readonly ToolDefinition[],
    builtins: readonly string[],
    content: readonly AnthropicBlock[],
    configPath: string | undefined,
    facts: string | undefined,
  ): Promise<RunResult> {
    const { request } = state;
    const { agent } = request;
    const settings = agent.settings ?? {};
    const byMcpName = new Map(
      definitions.map((definition) => [mcpToolName(CLAUDE_CODE_MCP_SERVER, definition.name), definition]),
    );
    const toolName = (name: string): string => byMcpName.get(name)?.name ?? name;
    const childEnv = {
      ...env,
      // 子代理和后台命令在这一轮里跑完：一轮到 `result` 就结束，后台的活不过这一轮，子代理的轨迹也就不全。
      CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
      ...(settings.maxRetries !== undefined ? { CLAUDE_CODE_MAX_RETRIES: String(settings.maxRetries) } : {}),
      ...(settings.maxOutputTokens !== undefined
        ? { CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(settings.maxOutputTokens) }
        : {}),
    };
    const proc = new ClaudeProcess({
      command,
      args: argsFor(state, plan, definitions, builtins, configPath, facts),
      env: childEnv,
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    });
    proc.send({ type: 'user', message: { role: 'user', content } });

    const claudeVersion = state.record ? await versionOf() : undefined;
    const subagents = state.record
      ? new SubagentTrace({
          store,
          root: { session: request.session, runId: state.runId },
          agent,
          ...(request.owner !== undefined ? { owner: request.owner } : {}),
          ...(claudeVersion !== undefined ? { version: claudeVersion } : {}),
          toolName,
          executorOf: (name) => byMcpName.get(name)?.executor ?? CLAUDE_CODE_HARNESS,
        })
      : undefined;
    let cause: StopCause | undefined;
    const stop = (why: StopCause): void => {
      cause ??= why;
      proc.interrupt(grace);
    };
    const onAbort = (): void => stop('aborted');
    request.signal?.addEventListener('abort', onAbort, { once: true });
    const timer =
      settings.timeoutMs !== undefined ? setTimeout(() => stop('timeout'), settings.timeoutMs).unref() : undefined;
    const startedAt = Date.now();

    // 这一步的状态。
    let step = 0;
    let stepStarted = false;
    let streaming: string | undefined;
    let current: { id: string; model?: string; blocks: AnthropicBlock[]; uuid?: string } | undefined;
    const stepUsage = new Map<string, { start?: AnthropicUsage; delta?: AnthropicUsage; stop?: string | null }>();
    let calls: ToolCall[] = [];
    const results = new Map<string, { output: ToolOutput; source: string; uuid?: string }>();
    const open = new Map<string, string>();
    /** 调用 id → 执行方：ctx 的执行环境的名字，Claude Code 自带的工具是 `claude-code`。 */
    const executedBy = new Map<string, string>();
    let total: Usage | undefined;
    let lastText = '';
    let tip: string | undefined;
    let result: ResultLine | undefined;
    let apiError: { status?: number; message: string } | undefined;

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
    let pendingUsage: Usage | undefined;

    /** 一条助手消息收齐了：写进日志，交出工具调用；没有调用的这一步就结束了。 */
    const flushAssistant = async (): Promise<void> => {
      const message = current;
      current = undefined;
      if (!message || message.blocks.length === 0) return;
      beginStep();
      const info = stepUsage.get(message.id);
      stepUsage.delete(message.id);
      const usage = usageOf(
        info?.start || info?.delta
          ? {
              ...info.start,
              ...(info.delta?.output_tokens !== undefined ? { output_tokens: info.delta.output_tokens } : {}),
            }
          : undefined,
      );
      total = addUsages(total, usage);
      const finishReason = finishReasonOf(info?.stop);
      const meta: StepMeta = {
        runId: state.runId,
        step,
        ...(message.model ? { modelId: message.model } : {}),
        ...(finishReason ? { finishReason } : {}),
        ...(usage ? { usage } : {}),
      };
      const assistant = assistantMessageOf(message.blocks, toolName);
      state.messages.push(assistant);
      lastText = textOfBlocks(message.blocks);
      await write(state, [
        messageEntry(assistant, {
          source: 'model',
          meta: { step: meta as unknown as JsonObject, ...metaOf({ uuid: message.uuid }) },
        }),
      ]);
      calls = message.blocks.flatMap((block) => {
        if (block.type !== 'tool_use' || !block.id || !block.name) return [];
        executedBy.set(block.id, byMcpName.get(block.name)?.executor ?? CLAUDE_CODE_HARNESS);
        return [{ id: block.id, name: toolName(block.name), input: (block.input ?? {}) as JsonValue }];
      });
      for (const call of calls) {
        open.set(call.id, call.name);
        state.emit({ type: 'tool.called', runId: state.runId, call });
      }
      if (calls.length === 0) endStep(usage);
      else pendingUsage = usage;
    };

    /** 这一步的工具结果到齐了：按执行方分组写下（ctx 的执行环境、`claude-code`），这一步结束。 */
    const flushResults = async (force: boolean): Promise<void> => {
      if (calls.length === 0) return;
      if (!force && calls.some((call) => !results.has(call.id))) return;
      const groups = new Map<string, { parts: ToolPart[]; uuid?: string }>();
      for (const call of calls) {
        const found = results.get(call.id);
        if (!found) continue;
        const group = groups.get(found.source) ?? { parts: [] };
        group.parts.push({ type: 'tool-result', id: call.id, name: call.name, output: found.output });
        if (found.uuid) group.uuid = found.uuid;
        groups.set(found.source, group);
        open.delete(call.id);
      }
      const entries: NewEntry[] = [];
      for (const [source, group] of groups) {
        const message: Message = { role: 'tool', content: group.parts };
        state.messages.push(message);
        const meta = metaOf({ uuid: group.uuid });
        entries.push(messageEntry(message, { source, ...(meta ? { meta } : {}) }));
      }
      await write(state, entries);
      calls = [];
      results.clear();
      endStep(pendingUsage);
      pendingUsage = undefined;
      if (cause === undefined && overBudget()) stop('budget');
    };

    const onAssistant = async (line: AssistantLine): Promise<void> => {
      if (line.is_api_error_message || line.message.model === '<synthetic>') {
        await flushAssistant();
        apiError = {
          message: textOfBlocks(line.message.content),
          ...(typeof line.api_error_status === 'number' ? { status: line.api_error_status } : {}),
        };
        return;
      }
      subagents?.calls(line.message.content, undefined);
      if (current && current.id !== line.message.id) await flushAssistant();
      current ??= { id: line.message.id, ...(line.message.model ? { model: line.message.model } : {}), blocks: [] };
      current.blocks.push(...line.message.content);
      const uuid = (line as { uuid?: unknown }).uuid;
      if (typeof uuid === 'string') current.uuid = uuid;
      if (line.message.usage && !stepUsage.has(line.message.id))
        stepUsage.set(line.message.id, { start: line.message.usage });
    };

    const onUser = async (line: UserLine): Promise<void> => {
      await flushAssistant();
      const uuid = (line as { uuid?: unknown }).uuid;
      const meta = metaOf({ uuid: typeof uuid === 'string' ? uuid : undefined });
      const blocks: readonly AnthropicBlock[] =
        typeof line.message.content === 'string'
          ? [{ type: 'text', text: line.message.content }]
          : line.message.content;
      const toolResults = blocks.filter((block) => block.type === 'tool_result' && block.tool_use_id);
      if (toolResults.length === 0) {
        const text = textOfBlocks(blocks);
        if (text) {
          await write(state, [
            eventEntry(CLAUDE_CODE_EVENTS.synthetic, { text, source: CLAUDE_CODE_HARNESS, ...(meta ? { meta } : {}) }),
          ]);
        }
        return;
      }
      for (const block of toolResults) {
        const id = block.tool_use_id!;
        const raw = toolResults.length === 1 ? line.tool_use_result : undefined;
        // 子代理的调用：结果换成 `ChildRunResult`，子会话里的那一轮在这里写完。
        const output = (await subagents?.finish(id, block, raw)) ?? toolOutputOf(block, raw);
        results.set(id, {
          output,
          source: executedBy.get(id) ?? CLAUDE_CODE_HARNESS,
          ...(typeof uuid === 'string' ? { uuid } : {}),
        });
        state.emit({ type: 'tool.returned', runId: state.runId, callId: id, output });
      }
      await flushResults(false);
    };

    const handle = async (line: ClaudeLine): Promise<void> => {
      const uuid = (line as { uuid?: unknown }).uuid;
      const parentCall = (line as { parent_tool_use_id?: unknown }).parent_tool_use_id;
      if ((line.type === 'assistant' || line.type === 'user') && typeof uuid === 'string') {
        // 子代理里面的消息进子会话，不算这一轮在 Claude Code 记录里的位置。
        if (!parentCall) tip = uuid;
      }
      if (parentCall) {
        if (typeof parentCall === 'string' && (line.type === 'assistant' || line.type === 'user')) {
          await subagents?.line(line, parentCall);
        }
        return;
      }
      switch (line.type) {
        case 'system': {
          if (line.subtype === 'init') {
            const init = line as Extract<ClaudeLine, { subtype: 'init' }>;
            if (init.session_id !== plan.session) {
              logger.warn('claude code reported another session id', { expected: plan.session, got: init.session_id });
            }
            const failed = init.mcp_servers?.find(
              (server) => server.name === CLAUDE_CODE_MCP_SERVER && server.status !== 'connected',
            );
            if (failed) logger.warn('claude code could not connect to the ctx MCP server', { status: failed.status });
          } else if (line.subtype.startsWith('task_')) {
            await subagents?.system(line);
          } else if (line.subtype === 'compact_boundary') {
            const data = (line as { compact_metadata?: unknown }).compact_metadata;
            await write(state, [
              eventEntry(CLAUDE_CODE_EVENTS.compacted, {
                source: CLAUDE_CODE_HARNESS,
                ...(isObject(data) ? { data: data as JsonObject } : {}),
              }),
            ]);
          }
          return;
        }
        case 'stream_event': {
          const event = line.event;
          if (event.type === 'message_start') {
            await flushAssistant();
            await flushResults(true);
            streaming = event.message.id;
            stepUsage.set(event.message.id, event.message.usage ? { start: event.message.usage } : {});
            beginStep();
          } else if (event.type === 'content_block_delta') {
            if (event.delta.type === 'text_delta' && event.delta.text) {
              state.emit({ type: 'text.delta', runId: state.runId, text: event.delta.text });
            } else if (event.delta.type === 'thinking_delta' && event.delta.thinking) {
              state.emit({ type: 'reasoning.delta', runId: state.runId, text: event.delta.thinking });
            }
          } else if (event.type === 'message_delta' && streaming) {
            const info = stepUsage.get(streaming) ?? {};
            stepUsage.set(streaming, {
              ...info,
              ...(event.usage ? { delta: event.usage } : {}),
              stop: event.delta.stop_reason ?? null,
            });
          } else if (event.type === 'message_stop') {
            if (current?.id === streaming) await flushAssistant();
            streaming = undefined;
          }
          return;
        }
        case 'assistant':
          return onAssistant(line);
        case 'user':
          return onUser(line);
        case 'result':
          result = line;
          return;
        default:
          return;
      }
    };

    let exit: Exit | undefined;
    let failure: unknown;
    /** 没等到结果就结束了的子代理：它的调用补的结果（`ChildRunResult`，`aborted`）。 */
    let closed: ReadonlyMap<string, ToolOutput> | undefined;
    try {
      for await (const line of proc.lines()) {
        await handle(line);
        if (state.fenced) stop('fenced');
        if (result) break;
      }
      await flushAssistant();
      await flushResults(true);
      closed = await subagents?.close();
    } catch (error) {
      // 写日志失败：停下 Claude Code，把错误抛给调用方（同参考实现：只有写日志失败才 reject）。
      failure = error;
      stop('aborted');
    } finally {
      request.signal?.removeEventListener('abort', onAbort);
      if (timer) clearTimeout(timer);
      exit = await proc.finish(grace);
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

    const usage = result?.usage ? usageOf(result.usage) : total;
    let stopReason: StopReason;
    let error: ErrorInfo | undefined;
    if (cause === 'budget') stopReason = 'max_budget';
    else if (cause === 'aborted') stopReason = 'aborted';
    else if (cause === 'timeout') {
      stopReason = 'error';
      error = {
        message: `Claude Code did not finish within settings.timeoutMs (${String(settings.timeoutMs)} ms).`,
        type: 'timeout',
        retryable: true,
      };
    } else if (!result) {
      stopReason = 'error';
      error = exitError(exit, proc.stderr);
    } else if (result.subtype === 'error_max_turns') stopReason = 'max_steps';
    else if (result.subtype === 'error_max_budget_usd') stopReason = 'max_budget';
    else if (result.subtype === 'error_max_structured_output_retries') {
      // 催了几次，模型还是没调 `StructuredOutput`。
      stopReason = 'error';
      error = {
        message: result.errors?.join('; ') || 'Claude Code gave up waiting for a structured output.',
        type: 'invalid_output',
        retryable: false,
      };
    } else if (result.is_error || result.subtype !== 'success') {
      stopReason = 'error';
      error = errorOfResult(result, apiError);
    } else stopReason = result.stop_reason === 'max_tokens' ? 'max_tokens' : 'end_turn';

    let output: JsonValue | undefined;
    if (agent.output && stopReason === 'end_turn') {
      const value = result?.structured_output;
      const issues =
        value === undefined || value === null ? ['no structured output'] : checkJsonSchema(agent.output.schema, value);
      if (issues.length > 0) {
        stopReason = 'error';
        error = {
          message: `Claude Code did not return a structured output matching AgentSpec.output.schema: ${issues.join('; ')}.`,
          type: 'invalid_output',
          retryable: false,
        };
      } else output = value as JsonValue;
    }
    const text =
      stopReason === 'error' ? '' : lastText || result?.result || (output !== undefined ? JSON.stringify(output) : '');
    return end(state, {
      stopReason,
      text,
      open,
      ...(closed ? { closed } : {}),
      last: tip,
      ...(error ? { error } : {}),
      ...(usage ? { usage } : {}),
      ...(output !== undefined ? { output } : {}),
    });
  }

  function exitError(exit: Exit | undefined, stderr: string): ErrorInfo {
    if (exit?.error) {
      return { message: `Could not start Claude Code ("${command}"): ${exit.error.message}`, type: 'claude_code' };
    }
    const how = exit?.signal ? `signal ${exit.signal}` : `code ${String(exit?.code)}`;
    return {
      message: `Claude Code exited (${how}) without a result${stderr ? `: ${stderr.slice(-500)}` : '.'}`,
      type: 'claude_code',
    };
  }

  /** 收尾：没等到结果的工具调用补错误结果，出错写 `ctx.error`，最后写 `ctx.run.ended`（带 Claude Code 记录里的位置）。 */
  async function end(
    state: RunState,
    outcome: {
      readonly stopReason: StopReason;
      readonly text: string;
      readonly open: ReadonlyMap<string, string>;
      /** 没等到结果的子代理调用的结果，别的没等到结果的调用补 `INTERRUPTED`。 */
      readonly closed?: ReadonlyMap<string, ToolOutput>;
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
          output: outcome.closed?.get(id) ?? errorOutput(INTERRUPTED),
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
