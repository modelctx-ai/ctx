// Claude Managed Agents 当 ctx 的 harness：循环在 Anthropic 那边跑，它自己存对话、自己压缩上下文；ctx 的一个会话对着
// 它的一个会话。ctx 的工具作为自定义工具交给它，调用回到 ctx 的执行环境；事件流（SSE）实时写进会话日志。
// 照 Managed Agents 的接口文档和 `@anthropic-ai/sdk` 1.10.0 的类型写，对假服务端测过，没有对真实服务验证。
import { createHash, randomUUID } from 'node:crypto';

import Anthropic, { APIError, APIUserAbortError } from '@anthropic-ai/sdk';
import type {
  BetaManagedAgentsAgentToolset20260401Params,
  BetaManagedAgentsCustomToolParams,
  BetaManagedAgentsMCPToolsetParams,
} from '@anthropic-ai/sdk/resources/beta/agents/agents';
import type {
  BetaManagedAgentsAgentCustomToolUseEvent,
  BetaManagedAgentsAgentMCPToolUseEvent,
  BetaManagedAgentsAgentToolUseEvent,
  BetaManagedAgentsEventParams,
  BetaManagedAgentsSessionStatusIdleEvent,
} from '@anthropic-ai/sdk/resources/beta/sessions/events';
import type { BetaManagedAgentsSession, SessionCreateParams } from '@anthropic-ai/sdk/resources/beta/sessions/sessions';
import {
  afterConflict,
  agentSpecToJson,
  approvalDeniedOutput,
  checkJsonSchema,
  CONTEXT_OVERFLOW,
  createSessionQueue,
  CTX_EVENTS,
  ctxErrorEntry,
  DEFAULT_MAX_TOOL_OUTPUT_CHARS,
  endedInFailure,
  errorOutput,
  eventEntry,
  executorMap,
  executorTools,
  headSeq,
  isConflict,
  isContextOverflowText,
  isEvent,
  lastHarnessRun,
  limitToolOutput,
  messageEntry,
  pendingToolCalls,
  repeatsFailedInput,
  runEndedEntry,
  runParentProblem,
  runStartedEntry,
  selectTools,
  silentLogger,
  stepMetaToJson,
  streamRun,
  toolPermission,
  toolResultEntry,
  userEntry,
  type AgentSpec,
  type AssistantPart,
  type Entry,
  type ErrorInfo,
  type Executor,
  type Executors,
  type Harness,
  type HarnessRun,
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
  type ToolApproval,
  type ToolCall,
  type ToolDefinition,
  type ToolOutput,
  type ToolPart,
  type ToolRegistry,
  type Usage,
} from '@modelctx-ai/ctx-protocol';

import {
  INTERRUPTED,
  MANAGED_AGENTS_BETA,
  MANAGED_AGENTS_EVENTS,
  MANAGED_AGENTS_HARNESS,
  MAX_CONFLICTS,
  MISSING_RESULT,
} from './constants.ts';
import {
  addUsages,
  errorOfEvent,
  resultBlocksOf,
  toolOutputOf,
  usageOf,
  userBlocksOf,
  type UserBlock,
} from './convert.ts';
import { EventFeed, type RequestOptions, type StreamEvent } from './feed.ts';

/** Managed Agents 那边执行的工具：容器里的内置工具（`agent_toolset_20260401`）、agent 的 MCP 服务器（`mcp_toolset`）。 */
export type BuiltinTool = BetaManagedAgentsAgentToolset20260401Params | BetaManagedAgentsMCPToolsetParams;

export interface ManagedAgentsHarnessOptions {
  /** 会话日志：生命周期事件、输入、模型的每一步、工具结果都实时写进来。 */
  readonly store: SessionStore;
  /** Managed Agents 的客户端，缺省 `new Anthropic()`（密钥取 `ANTHROPIC_API_KEY`）。 */
  readonly client?: Anthropic;
  /**
   * 建会话用的 agent（事先建好的，`POST /v1/agents`）：它的 id（用最新版本），或 `{ id, version }`。模型和工具每个会话按
   * `AgentSpec` 覆盖（`agent_with_overrides`），给了 `instructions` 的系统提示也是；agent 自己的 MCP 服务器、技能照用。
   */
  readonly agent: string | { readonly id: string; readonly version?: number };
  /** 建会话用的执行环境（事先建好的，`POST /v1/environments`）的 id。 */
  readonly environmentId: string;
  /** ctx 的执行环境：ctx 的工具作为自定义工具交给 Managed Agents，调用由它们执行。 */
  readonly executors?: Executors;
  /**
   * 工具目录：`AgentSpec.tools` 从这里挑，定义的 `executor` 指向 `executors` 里的一个；`createToolRegistry()` 建的注册表
   * 自带的函数执行环境自动加进来。不给就是各执行环境 `tools()` 报的全部。
   */
  readonly tools?: ToolRegistry;
  /**
   * 在别处执行的执行环境的名字（ADR 0008）：绑到它们的工具交给模型，调用不在这里执行，这一轮写下调用后以
   * `requires_action` 结束，Managed Agents 的会话停着等结果；执行方追加结果以后，下一轮把结果交回去接着跑。
   */
  readonly external?: readonly string[];
  /** Managed Agents 那边执行的工具，缺省一个都不交。它们的调用和结果只记进日志，执行方是 `managed-agents`。 */
  readonly builtinTools?: readonly BuiltinTool[];
  /** 建会话时一起给的：凭证保管库（`vault_ids`）、挂进容器的文件和仓库（`resources`）、`metadata`、`title`。 */
  readonly sessionParams?: Pick<SessionCreateParams, 'vault_ids' | 'resources' | 'metadata' | 'title'>;
  /** 一次工具结果最多多少字符，超过的截断并注明，缺省 `DEFAULT_MAX_TOOL_OUTPUT_CHARS`。 */
  readonly maxToolOutputChars?: number;
  /** 取消、超时、到了步数或预算以后，等 Managed Agents 停下（`session.status_idle`）的时间，过了就不再等。缺省 5 秒。 */
  readonly interruptTimeoutMs?: number;
  /** 输入条目的 `source`。 */
  readonly source?: string;
  readonly logger?: Logger;
}

export interface ManagedAgentsHarness extends Harness {
  stream(request: RunRequest): AsyncIterable<RunEvent>;
}

/** 认重试、找上一轮时最多往回读这么多条。 */
const SCAN = 64;

/** 会话停着等的调用最多往回找这么多个事件。 */
const BLOCKING_SCAN = 100;

/**
 * 条目的 `meta.managedAgents`。`ctx.run.started`：这个会话建好时的模型和指令（`config`，摘要），换了的不能续接；
 * `ctx.run.ended`：结束时交给它的工具（`tools`，摘要，下一轮不一样就更新）、读到的最后一个事件（`last`）、记下了但还没
 * 交给它的输入（`unsent`，条目的 `seq`，下一轮补发）；步骤的条目：它对应的 Managed Agents 事件（`event`，在控制台里按它定位）。
 */
interface ManagedMeta {
  readonly config?: string;
  readonly tools?: string;
  readonly last?: string;
  readonly event?: string;
  readonly unsent?: readonly number[];
}

type StopCause = 'aborted' | 'timeout' | 'fenced' | 'max_steps' | 'budget';

/** 一次调用在这一轮里怎么办：这里执行、Managed Agents 执行，或者停下来等（别处执行、等人确认）。 */
type Mode = 'execute' | 'remote' | 'external' | 'ask' | 'confirm';

interface StepCall {
  readonly call: ToolCall;
  readonly mode: Mode;
  readonly definition?: ToolDefinition;
  readonly approval?: ToolApproval;
  /** 绑到外部执行环境的：执行环境的名字（写进 `ctx.run.ended` 的 `executors`）。 */
  readonly executor?: string;
}

type ToolUseEvent =
  | BetaManagedAgentsAgentCustomToolUseEvent
  | BetaManagedAgentsAgentToolUseEvent
  | BetaManagedAgentsAgentMCPToolUseEvent;

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
  /** 记进日志、还没交给 Managed Agents 的输入条目的 `seq`：这一轮发出去就清空，没发出去的写进 `ctx.run.ended` 留给下一轮。 */
  unsent: number[];
}

/** 这一轮跑在哪个会话上：接着上一轮的，或者新建的（建会话出错、配置不对时没有）。 */
interface Target {
  readonly session?: string;
  /** 新建的会话（这一轮建的）。 */
  readonly created?: BetaManagedAgentsSession;
  /** 会话的模型和指令的摘要：新建的是这一轮的，接着的是它建好时记下的。 */
  readonly config?: string;
  readonly previous?: HarnessRun;
  readonly problem?: ErrorInfo;
}

interface Started {
  readonly target: Target;
  /** 这一轮的输入是上一轮失败时留下的那句，不再记。 */
  readonly repeated: boolean;
  /** 这一轮的输入是上一轮失败时留下的那句（给了 `inputKey` 的按键认）：上一轮没发出去就不再发一遍。 */
  readonly retry: boolean;
  /** 上一轮没发出去的输入（`meta.managedAgents.unsent`）。 */
  readonly unsent: readonly number[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function managedMeta(entry: Entry | undefined): ManagedMeta {
  const meta = entry?.meta?.['managedAgents'];
  if (!isObject(meta)) return {};
  const text = (key: string): { [key: string]: string } => (typeof meta[key] === 'string' ? { [key]: meta[key] } : {});
  const unsent = meta['unsent'];
  return {
    ...text('config'),
    ...text('tools'),
    ...text('last'),
    ...text('event'),
    ...(Array.isArray(unsent) && unsent.every((seq) => Number.isSafeInteger(seq))
      ? { unsent: unsent as number[] }
      : {}),
  };
}

function metaOf(meta: { readonly [K in keyof ManagedMeta]?: ManagedMeta[K] | undefined }): JsonObject | undefined {
  const fields = Object.fromEntries(
    Object.entries(meta).filter(([, value]) => typeof value === 'string' || (Array.isArray(value) && value.length > 0)),
  ) as JsonObject;
  return Object.keys(fields).length > 0 ? { managedAgents: fields } : undefined;
}

function isEmpty(content: MessageContent | undefined): boolean {
  return content === undefined || content.length === 0;
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 映射不了的 `AgentSpec` 字段：有就以 `invalid_request` 结束，不静默忽略。 */
function specProblem(agent: AgentSpec): string | undefined {
  if (typeof agent.model !== 'string' || agent.model === '') {
    return 'AgentSpec.model must be a model name: Managed Agents takes the model by name.';
  }
  if (agent.window !== undefined) return 'AgentSpec.window is not supported: Managed Agents manages its own context.';
  // 事实也不行：系统提示整个会话不变，放进这一轮的话又会一直留在 Managed Agents 的会话里。
  const context = Object.entries(agent.context ?? {}).filter(
    ([key, value]) => value !== undefined && !(key === 'facts' && value === false),
  );
  if (context.length > 0) {
    return `AgentSpec.context.${context.map(([key]) => key).join(', ')} not supported: Managed Agents manages its own context and keeps its system prompt for the whole session.`;
  }
  if (agent.toolChoice !== undefined && agent.toolChoice !== 'auto') {
    return 'AgentSpec.toolChoice is not supported by Managed Agents; only "auto".';
  }
  const unsupported = Object.keys(agent.settings ?? {}).filter(
    (key) => !['maxRetries', 'timeoutMs', 'headers'].includes(key),
  );
  if (unsupported.length > 0) {
    return `AgentSpec.settings.${unsupported.join(', ')} not supported by Managed Agents; only maxRetries, timeoutMs and headers.`;
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

/** `AgentSpec.output`：Managed Agents 没有结构化输出，schema 跟着这一轮的用户消息交出去，最后的回答按它解析。 */
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

/** 调接口出的错：404 是 `not_found`，上下文过长是 `context_overflow`，别的是 `api_call`（429、5xx、连不上能重试）。 */
function apiErrorInfo(error: unknown, what: string): ErrorInfo {
  if (error instanceof APIError) {
    const message = `${what}: ${error.message}`;
    const status = error.status;
    const body = error.error === undefined ? undefined : JSON.stringify(error.error);
    const http = {
      ...(status !== undefined ? { statusCode: status } : {}),
      ...(body !== undefined ? { responseBody: body } : {}),
    };
    if (status === 404) return { message, type: 'not_found', retryable: false, ...http };
    if (isContextOverflowText(message, status)) return { message, type: CONTEXT_OVERFLOW, retryable: false, ...http };
    const retryable = status === undefined || status === 408 || status === 409 || status === 429 || status >= 500;
    return { message, type: 'api_call', retryable, ...http };
  }
  return { message: `${what}: ${messageOf(error)}`, type: 'managed_agents' };
}

const ABORTED: ErrorInfo = { message: 'The run was aborted.' };

/** 每次调接口都带上的：`settings.maxRetries`、`settings.headers`。 */
function requestOptions(agent: AgentSpec): RequestOptions {
  const { maxRetries, headers } = agent.settings ?? {};
  return {
    ...(maxRetries !== undefined ? { maxRetries } : {}),
    ...(headers !== undefined ? { headers } : {}),
  };
}

/** 会话的模型和指令：建好以后不能改，续接时对一下。 */
function configOf(agent: AgentSpec): string {
  return digest({ model: agent.model, system: agent.instructions ?? null });
}

/** 日志里的工具调用：id → 调用。 */
function toolCallsIn(entries: readonly Entry[]): Map<string, ToolCall> {
  return new Map(
    entries.flatMap((entry) =>
      entry.type === 'message' && typeof entry.message.content !== 'string'
        ? entry.message.content.flatMap((part) =>
            part.type === 'tool-call' ? [[part.id, { id: part.id, name: part.name, input: part.input }] as const] : [],
          )
        : [],
    ),
  );
}

export function createManagedAgentsHarness(options: ManagedAgentsHarnessOptions): ManagedAgentsHarness {
  const { store } = options;
  const logger = options.logger ?? silentLogger;
  const grace = options.interruptTimeoutMs ?? 5_000;
  const maxOutputChars = options.maxToolOutputChars ?? DEFAULT_MAX_TOOL_OUTPUT_CHARS;
  const external = new Set(options.external ?? []);
  const builtinTools = options.builtinTools ?? [];
  // `createToolRegistry()` 建的注册表自带函数执行环境：和参考实现一样自动带上。
  const executors = executorMap(options.executors, options.tools);
  let client: Anthropic | undefined = options.client;
  const clientOf = (): Anthropic => (client ??= new Anthropic());
  const agentRef = typeof options.agent === 'string' ? { id: options.agent } : options.agent;

  async function catalog(): Promise<ToolDefinition[]> {
    return options.tools ? options.tools.list() : executorTools(executors.values());
  }

  /** 这一轮交给 Managed Agents 的 ctx 工具：按 `AgentSpec.tools` 挑，`deny` 的不交。 */
  async function definitionsFor(agent: AgentSpec): Promise<ToolDefinition[]> {
    return selectTools(await catalog(), agent.tools ?? true).filter(
      (definition) => toolPermission(agent.permissions, definition.name) !== 'deny',
    );
  }

  /** 交给会话的全部工具：内置的在前，ctx 的作为自定义工具。 */
  function sessionTools(definitions: readonly ToolDefinition[]): (BuiltinTool | BetaManagedAgentsCustomToolParams)[] {
    return [
      ...builtinTools,
      ...definitions.map((definition): BetaManagedAgentsCustomToolParams => ({
        type: 'custom',
        name: definition.name,
        description: definition.description || definition.name,
        input_schema: { ...definition.inputSchema, type: 'object' },
      })),
    ];
  }

  // ---- 日志 ----

  async function write(state: RunState, entries: readonly NewEntry[]): Promise<Entry[]> {
    if (!state.record || entries.length === 0 || state.fenced) return [];
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
        return written;
      } catch (error) {
        if (!isConflict(error) || conflicts >= MAX_CONFLICTS) throw error;
        // 这一轮中间别人写了东西：被围栏（`afterConflict`）就不再写，否则接在新的末尾后面。
        const head = await afterConflict(store, session, state);
        if (head === undefined) {
          state.fenced = true;
          return [];
        }
        state.head = head;
      }
    }
  }

  /**
   * 这一轮的输入是不是上一轮失败时留下的那句（`repeatsFailedInput`，同参考实现）：这个适配器写的事件和框架事件一样跳过，
   * 给了 `inputKey` 的看最近的条目里有没有这个键。
   */
  async function repeatsFailed(session: string, input: MessageContent, key: string | undefined): Promise<boolean> {
    return repeatsFailedInput(await store.list(session, { last: SCAN }), input, {
      harness: MANAGED_AGENTS_HARNESS,
      ...(key !== undefined ? { key } : {}),
    });
  }

  /**
   * 这一轮跑在哪个会话上：上一轮记下的会话就接着跑；没有（第一轮、`record: false`）就新建一个，模型、指令、工具按
   * `AgentSpec` 覆盖 agent 的。`AgentSpec` 映射不了、已经取消的不建。
   */
  async function target(state: RunState, previous: HarnessRun | undefined): Promise<Target> {
    const { agent, signal } = state.request;
    const problem = specProblem(agent);
    if (problem !== undefined) return { problem: { message: problem, type: 'invalid_request' } };
    if (previous) {
      const config = managedMeta(previous.started).config;
      return { session: previous.session, previous, ...(config !== undefined ? { config } : {}) };
    }
    if (signal?.aborted) return {};
    const definitions = await definitionsFor(agent);
    try {
      const created = await clientOf().beta.sessions.create(
        {
          ...options.sessionParams,
          agent: {
            type: 'agent_with_overrides',
            id: agentRef.id,
            ...(agentRef.version !== undefined ? { version: agentRef.version } : {}),
            model: agent.model as string,
            // 不给指令就用 agent 自己的系统提示。
            ...(agent.instructions !== undefined ? { system: agent.instructions } : {}),
            tools: sessionTools(definitions),
          },
          environment_id: options.environmentId,
        },
        { ...requestOptions(agent), ...(signal ? { signal } : {}) },
      );
      return { session: created.id, created, config: configOf(agent) };
    } catch (error) {
      if (error instanceof APIUserAbortError || signal?.aborted) return {};
      return { problem: apiErrorInfo(error, 'Could not create the Managed Agents session') };
    }
  }

  /**
   * 查忙、定会话、写 `ctx.run.started`：记录型运行先查会话忙不忙（忙就什么都不建、不写），再定这一轮跑在哪个会话上，
   * 带着读到的末尾写 `ctx.run.started`，冲突就重来（建好的会话留着用）。
   */
  async function start(state: RunState): Promise<Started | 'busy'> {
    const { session, agent, input, inputKey } = state.request;
    const hasInput = !isEmpty(input);
    if (!state.record) return { target: await target(state, undefined), repeated: false, retry: false, unsent: [] };
    let chosen: Target | undefined;
    for (let conflicts = 0; ; conflicts += 1) {
      const head = await headSeq(store, session);
      const lifecycle = await store.list(session, { kinds: [CTX_EVENTS.runStarted, CTX_EVENTS.runEnded], last: SCAN });
      if (isEvent(lifecycle.at(-1), CTX_EVENTS.runStarted)) return 'busy';
      const previous = lastHarnessRun(lifecycle, MANAGED_AGENTS_HARNESS);
      const repeated = hasInput && endedInFailure(lifecycle) && (await repeatsFailed(session, input!, inputKey));
      // 只有最近一轮是这个适配器跑的，它没发出去的输入才补发：别的 harness 跑过的那一轮已经把它们交给了自己的模型。
      const unsent = managedMeta(lifecycle.at(-1)).unsent ?? [];
      if (!chosen || chosen.previous?.started.id !== previous?.started.id) {
        chosen = chosen?.created ? chosen : await target(state, previous);
      }
      const parent = state.request.parent;
      const started = runStartedEntry(
        {
          runId: state.runId,
          agent: agentSpecToJson(agent),
          ...(state.request.owner !== undefined ? { owner: state.request.owner } : {}),
          ...(parent !== undefined && runParentProblem(parent) === undefined ? { parent: { ...parent } } : {}),
          harness: {
            name: MANAGED_AGENTS_HARNESS,
            version: MANAGED_AGENTS_BETA,
            ...(chosen.session !== undefined ? { session: chosen.session } : {}),
          },
        },
        { source: 'harness', ...(chosen.config ? { meta: metaOf({ config: chosen.config })! } : {}) },
      );
      try {
        const written = await store.append(session, [started], { expectSeq: head });
        state.recorded.push(...written);
        state.started = written.at(-1)?.seq;
        state.head = written.at(-1)?.seq ?? head;
        return { target: chosen, repeated: repeated && inputKey === undefined, retry: repeated, unsent };
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
      unsent: [],
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
    state.unsent.push(...started.unsent);
    const { target: chosen, repeated } = started;
    const { agent, signal } = request;
    let inputRecorded = false;
    /** 记下这一轮的输入（上一轮失败留下的那句不再记），记进去的算作还没发。了结写下的结果在它前面。 */
    const recordInput = async (): Promise<void> => {
      if (inputRecorded) return;
      inputRecorded = true;
      if (!state.record || isEmpty(request.input) || repeated) return;
      const written = await write(state, [
        userEntry(request.input!, {
          ...(options.source !== undefined ? { source: options.source } : {}),
          ...(request.inputKey !== undefined ? { key: request.inputKey } : {}),
        }),
      ]);
      state.unsent.push(...written.map((entry) => entry.seq));
    };
    const fail = async (error: ErrorInfo, stopReason: StopReason = 'error'): Promise<RunResult> => {
      await recordInput();
      return end(state, {
        stopReason,
        text: '',
        open: new Map(),
        pending: [],
        ...(stopReason === 'aborted' ? {} : { error }),
      });
    };
    const parentProblem = runParentProblem(request.parent);
    if (parentProblem !== undefined) return fail({ message: `${parentProblem}.`, type: 'invalid_request' });
    if (chosen.problem) return fail(chosen.problem);
    if (signal?.aborted || chosen.session === undefined) return fail(ABORTED, 'aborted');
    if (chosen.previous && chosen.config !== undefined && chosen.config !== configOf(agent)) {
      return fail({
        message:
          'AgentSpec.model or AgentSpec.instructions differ from the Managed Agents session this ctx session runs on: a Managed Agents session keeps the model and system prompt it was created with. Keep them, or use another ctx session.',
        type: 'invalid_request',
      });
    }
    const definitions = await definitionsFor(agent);
    const feed = new EventFeed(clientOf(), chosen.session, requestOptions(agent), logger);
    try {
      try {
        await feed.open();
      } catch (error) {
        if (error instanceof APIUserAbortError || signal?.aborted) return await fail(ABORTED, 'aborted');
        return await fail(apiErrorInfo(error, 'Could not open the Managed Agents event stream'));
      }
      const turn = new Turn(state, chosen.session, feed, definitions);
      let settle: BetaManagedAgentsEventParams[];
      try {
        const prepared = await turn.prepare(chosen);
        if (prepared.problem) return await fail(prepared.problem);
        settle = prepared.settle;
      } catch (error) {
        if (error instanceof APIUserAbortError || signal?.aborted) return await fail(ABORTED, 'aborted');
        if (error instanceof APIError)
          return await fail(apiErrorInfo(error, 'Could not resume the Managed Agents session'));
        throw error;
      }
      await recordInput();
      const content = await contentFor(state, started);
      if (content.length === 0 && settle.length === 0) {
        return await fail({
          message: 'Managed Agents needs a user message: give RunRequest.input or prompt.',
          type: 'invalid_request',
        });
      }
      return await turn.converse(settle, content);
    } finally {
      feed.close();
    }
  }

  /**
   * 这一轮发给 Managed Agents 的话：上一轮没发出去的输入（按记下的顺序）、这一轮的输入和 `prompt`、`AgentSpec.output`
   * 的说明。上一轮失败留下的那句：那一轮发出去了的再发一遍（Managed Agents 退不回去，它的会话里会有两遍），没发出去的
   * 已经在补发的里面。
   */
  async function contentFor(state: RunState, started: Started): Promise<UserBlock[]> {
    const { request } = state;
    const carried = state.unsent.filter((seq) => started.unsent.includes(seq));
    const entries =
      carried.length > 0
        ? (await store.list(request.session, { after: Math.min(...carried) - 1, types: ['message'] })).filter(
            (entry) => entry.type === 'message' && entry.message.role === 'user' && carried.includes(entry.seq),
          )
        : [];
    // 补发的里面读不到的（删掉、涂改了的）不再留着。
    const found = new Set(entries.map((entry) => entry.seq));
    state.unsent = state.unsent.filter((seq) => !carried.includes(seq) || found.has(seq));
    const content: UserBlock[] = entries.flatMap((entry) =>
      entry.type === 'message' && entry.message.role === 'user' ? userBlocksOf(entry.message.content) : [],
    );
    if (!(started.retry && entries.length > 0)) content.push(...userBlocksOf(request.input));
    content.push(...userBlocksOf(request.prompt));
    if (request.agent.output && content.length > 0) {
      content.push({ type: 'text', text: outputInstructions(request.agent.output) });
    }
    return content;
  }

  /**
   * 一轮在一个 Managed Agents 会话上：先把它停着等的事了结，等它把上一轮做完，再发这一轮的话，一个事件一个事件地读到
   * 它停下。
   */
  class Turn {
    readonly #state: RunState;
    readonly #session: string;
    readonly #feed: EventFeed;
    readonly #definitions: ReadonlyMap<string, ToolDefinition>;
    readonly #request: RequestOptions;
    readonly #agent: AgentSpec;
    readonly #startedAt = Date.now();
    readonly #maxSteps: number;
    /** 会话的模型（服务商响应里的标识），写进 `meta.step`。 */
    #modelId: string | undefined;
    /** 第一次交给某个执行环境之前 `open` 这个会话，一轮一次。 */
    readonly #opened = new Map<string, Promise<ToolOutput | undefined>>();
    /** 还没发的这一轮的话：先了结、等它停下再发。 */
    #content: UserBlock[] = [];

    // 停下
    #cause: StopCause | undefined;
    #deadline: Promise<void> | undefined;
    /** 发出去的中断：这一轮结束之前等它发完。 */
    #interrupting: Promise<void> | undefined;
    #idle = false;
    #outcome: { readonly stop: StopReason; readonly error?: ErrorInfo } | undefined;
    #failure: ErrorInfo | undefined;

    // 这一步
    #step = 0;
    #stepStarted = false;
    #discarding = false;
    #parts: AssistantPart[] = [];
    #calls: StepCall[] = [];
    #flushed = false;
    #stepUsage: Usage | undefined;
    #stepEvent: string | undefined;
    readonly #previews = new Map<string, Map<number, string>>();

    // 这一轮
    #total: Usage | undefined;
    #lastText = '';
    #lastEvent: string | undefined;
    /** 写下了调用、还没写结果的：调用 id → 名字。 */
    readonly #open = new Map<string, string>();
    /** 这一轮停下来等的调用（别处执行、等人确认），按出现的顺序。 */
    readonly #pending = new Map<string, StepCall>();
    /** 结果：调用 id → 结果和执行方。 */
    readonly #results = new Map<
      string,
      { readonly output: ToolOutput; readonly source: string; readonly event?: string }
    >();
    /** 结果已经交给 Managed Agents 的调用。 */
    readonly #settled = new Set<string>();

    constructor(state: RunState, session: string, feed: EventFeed, definitions: readonly ToolDefinition[]) {
      this.#state = state;
      this.#session = session;
      this.#feed = feed;
      this.#definitions = new Map(definitions.map((definition) => [definition.name, definition]));
      this.#agent = state.request.agent;
      this.#request = requestOptions(this.#agent);
      this.#maxSteps = this.#agent.maxSteps ?? (definitions.length + builtinTools.length > 0 ? 5 : 1);
    }

    get #runId(): string {
      return this.#state.runId;
    }

    #callOptions(signal = true): { maxRetries?: number; headers?: Record<string, string>; signal?: AbortSignal } {
      const aborts = signal ? this.#state.request.signal : undefined;
      return {
        ...(this.#request.maxRetries !== undefined ? { maxRetries: this.#request.maxRetries } : {}),
        ...(this.#request.headers ? { headers: { ...this.#request.headers } } : {}),
        ...(aborts ? { signal: aborts } : {}),
      };
    }

    async #send(events: readonly BetaManagedAgentsEventParams[], signal = true): Promise<void> {
      if (events.length === 0) return;
      await clientOf().beta.sessions.events.send(this.#session, { events: [...events] }, this.#callOptions(signal));
    }

    /**
     * 续接的会话先收拾好：还在跑（上一轮断在半路）就中断，等它停下；工具和上一轮结束时不一样就更新；停着等结果的调用按
     * 日志了结（见 `#settle`），返回要发的事件。新建的会话什么都不用做。
     */
    async prepare(
      chosen: Target,
    ): Promise<{ readonly settle: BetaManagedAgentsEventParams[]; readonly problem?: ErrorInfo }> {
      if (chosen.created) {
        this.#modelId = chosen.created.agent.model.id;
        return { settle: [] };
      }
      const api = clientOf();
      const session = await api.beta.sessions.retrieve(this.#session, {}, this.#callOptions());
      this.#modelId = session.agent.model.id;
      if (session.status === 'terminated' || session.archived_at !== null) {
        return {
          settle: [],
          problem: {
            message: `Managed Agents session "${this.#session}" has ${session.status === 'terminated' ? 'terminated' : 'been archived'}; it cannot be resumed. Use another ctx session.`,
            type: 'not_found',
            retryable: false,
          },
        };
      }
      let idle: BetaManagedAgentsSessionStatusIdleEvent | undefined;
      if (session.status !== 'idle') {
        idle = await this.#drain();
        if (!idle) {
          return {
            settle: [],
            problem: {
              message: `Managed Agents session "${this.#session}" is still running and did not stop within ${grace} ms of an interrupt.`,
              type: 'session_busy',
              retryable: true,
            },
          };
        }
      } else {
        const page = await api.beta.sessions.events.list(
          this.#session,
          { types: ['session.status_idle'], order: 'desc', limit: 1 },
          this.#callOptions(),
        );
        const last = page.data[0];
        if (last?.type === 'session.status_idle') idle = last;
      }
      const tools = sessionTools([...this.#definitions.values()]);
      if (managedMeta(chosen.previous?.ended).tools !== digest(tools)) {
        await api.beta.sessions.update(this.#session, { agent: { tools } }, this.#callOptions());
      }
      const blocking = idle?.stop_reason.type === 'requires_action' ? idle.stop_reason.event_ids : [];
      return { settle: blocking.length > 0 ? await this.#settle(blocking, chosen.previous) : [] };
    }

    /** 上一轮断在半路、会话还在跑：中断它，读到它停下为止（读到的不记：那一轮已经结束了）。没停下返回 `undefined`。 */
    async #drain(): Promise<BetaManagedAgentsSessionStatusIdleEvent | undefined> {
      await this.#send([{ type: 'user.interrupt' }], false);
      const deadline = Date.now() + grace;
      for (;;) {
        const left = deadline - Date.now();
        if (left <= 0) return undefined;
        const event = await this.#nextWithin(left);
        if (!event) return undefined;
        if (event.type === 'session.status_idle') return event;
      }
    }

    async #nextWithin(ms: number): Promise<StreamEvent | undefined> {
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), ms).unref();
      });
      try {
        return await Promise.race([this.#feed.next(), timeout]);
      } finally {
        clearTimeout(timer);
      }
    }

    /**
     * 会话停着等的调用（`requires_action` 的 `event_ids`）按日志了结，同参考实现：日志里有结果的交回去；确认了的、在这里
     * 执行的执行，拒绝的写上拒绝；确认了的内置工具让 Managed Agents 去执行；别的（还没决定的、别处执行还没结果的）按
     * 「没有记录到结果」交回去，不写日志——模型看到的和参考实现的投影给缺结果的调用补的一样。写下的结果在这一轮的输入前面。
     */
    async #settle(
      blocking: readonly string[],
      previous: HarnessRun | undefined,
    ): Promise<BetaManagedAgentsEventParams[]> {
      const { session } = this.#state.request;
      const uses = new Map<string, ToolUseEvent>();
      const page = await clientOf().beta.sessions.events.list(
        this.#session,
        {
          types: ['agent.custom_tool_use', 'agent.tool_use', 'agent.mcp_tool_use'],
          order: 'desc',
          limit: BLOCKING_SCAN,
        },
        this.#callOptions(),
      );
      for (const event of page.data) {
        if (
          event.type === 'agent.custom_tool_use' ||
          event.type === 'agent.tool_use' ||
          event.type === 'agent.mcp_tool_use'
        ) {
          uses.set(event.id, event);
        }
      }
      let entries = previous ? await store.list(session, { after: previous.started.seq - 1 }) : [];
      // 等着的调用在更早的一轮里（上一轮没来得及了结就失败了）：读整个日志找。少见。
      if (blocking.some((id) => !toolCallsIn(entries).has(id))) entries = await store.list(session);
      const known = toolCallsIn(entries);
      const logged = new Map<string, ToolOutput>();
      for (const entry of entries) {
        if (entry.type !== 'message' || entry.message.role !== 'tool') continue;
        for (const part of entry.message.content) if (part.type === 'tool-result') logged.set(part.id, part.output);
      }
      const pending = new Map(pendingToolCalls(entries).map((item) => [item.call.id, item]));
      const events: BetaManagedAgentsEventParams[] = [];
      const written: NewEntry[] = [];
      const record = (call: ToolCall, output: ToolOutput): void => {
        written.push(toolResultEntry(call, output, { source: 'harness' }));
        this.#state.emit({ type: 'tool.returned', runId: this.#runId, callId: call.id, output });
      };
      for (const id of blocking) {
        const use = uses.get(id);
        const custom = use === undefined || use.type === 'agent.custom_tool_use';
        const item = pending.get(id);
        const decision = item?.approval?.decision;
        let output = logged.get(id);
        if (output === undefined && item && decision) {
          if (!decision.approved) {
            output = approvalDeniedOutput(item.call, decision.reason);
            record(item.call, output);
          } else if (!custom) {
            // 确认了的内置工具：Managed Agents 去执行，结果在这一轮的事件里。
            this.#open.set(id, item.call.name);
            this.#settled.add(id);
            events.push({ type: 'user.tool_confirmation', tool_use_id: id, result: 'allow' });
            continue;
          } else if (item.executor === undefined) {
            output = (await this.#run(item.call, this.#definitions.get(item.call.name))).output;
            record(item.call, output);
          }
        }
        if (output === undefined) {
          const call = known.get(id);
          logger.warn('managed agents session waits on a tool call with no result or decision in the log', {
            session,
            call: id,
            ...(call ? { tool: call.name } : {}),
          });
          output = errorOutput(MISSING_RESULT);
        }
        events.push(...this.#resolution(id, custom, output));
      }
      await write(this.#state, written);
      return events;
    }

    /** 一次调用的结果交回 Managed Agents：自定义工具是 `user.custom_tool_result`，内置工具出错的是拒绝。 */
    #resolution(id: string, custom: boolean, output: ToolOutput): BetaManagedAgentsEventParams[] {
      this.#settled.add(id);
      if (!custom) {
        const message = output.type === 'error' ? output.message : MISSING_RESULT;
        return [{ type: 'user.tool_confirmation', tool_use_id: id, result: 'deny', deny_message: message }];
      }
      const { content, isError } = resultBlocksOf(output);
      return [
        {
          type: 'user.custom_tool_result',
          custom_tool_use_id: id,
          ...(content.length > 0 ? { content } : {}),
          ...(isError ? { is_error: true } : {}),
        },
      ];
    }

    /** 在这里执行一次 ctx 的工具：按 `inputSchema` 查输入，第一次交给执行环境之前 `open` 会话，结果截断。 */
    async #run(
      call: ToolCall,
      definition: ToolDefinition | undefined,
    ): Promise<{ output: ToolOutput; source: string }> {
      if (!definition) return { output: errorOutput(`Unknown tool: ${call.name}`), source: 'harness' };
      const problems = checkJsonSchema(definition.inputSchema, call.input);
      if (problems.length > 0) {
        return {
          output: errorOutput(`Invalid input for tool ${call.name}: ${problems.join('; ')}`),
          source: 'harness',
        };
      }
      const executor = executors.get(definition.executor);
      if (!executor) {
        return {
          output: errorOutput(
            `Tool ${call.name} is bound to executor "${definition.executor}", which this harness does not have.`,
          ),
          source: 'harness',
        };
      }
      const refused = await this.#prepareExecutor(executor, call.name);
      if (refused) return { output: refused, source: executor.name };
      const { session, signal } = this.#state.request;
      try {
        const output = await executor.execute(call, { session, runId: this.#runId, ...(signal ? { signal } : {}) });
        return { output: limitToolOutput(output, maxOutputChars), source: executor.name };
      } catch (error) {
        return {
          output: errorOutput(`Executor "${executor.name}" failed: ${messageOf(error)}`),
          source: executor.name,
        };
      }
    }

    #prepareExecutor(executor: Executor, tool: string): Promise<ToolOutput | undefined> {
      if (!executor.open) return Promise.resolve(undefined);
      let opening = this.#opened.get(executor.name);
      if (!opening) {
        const { session, signal } = this.#state.request;
        const environment = this.#agent.environment;
        opening = executor
          .open(session, { ...(environment ? { environment } : {}), ...(signal ? { signal } : {}) })
          .then(
            () => undefined,
            (error: unknown) =>
              errorOutput(
                `Executor "${executor.name}" could not prepare session "${session}" for tool "${tool}": ${messageOf(error)}`,
              ),
          );
        this.#opened.set(executor.name, opening);
      }
      return opening;
    }

    // ---- 读事件 ----

    /** 停下：中断 Managed Agents（取消的、超时的、到了上限的），等它停下的时间从这里算。被围栏的不中断：会话已经归别人了。 */
    #stop(why: StopCause): void {
      if (this.#cause !== undefined) return;
      this.#cause = why;
      this.#deadline = new Promise((resolve) => setTimeout(resolve, this.#idle ? 0 : grace).unref());
      if (this.#idle || why === 'fenced') return;
      this.#interrupting = this.#send([{ type: 'user.interrupt' }], false).catch((error: unknown) => {
        logger.warn('managed agents interrupt failed', { session: this.#session, error: messageOf(error) });
      });
    }

    #overBudget(): boolean {
      const { budget } = this.#agent;
      if (!budget) return false;
      const used = this.#total?.totalTokens ?? (this.#total?.inputTokens ?? 0) + (this.#total?.outputTokens ?? 0);
      return (
        (budget.maxTotalTokens !== undefined && used > budget.maxTotalTokens) ||
        (budget.maxDurationMs !== undefined && Date.now() - this.#startedAt > budget.maxDurationMs)
      );
    }

    #beginStep(): void {
      if (this.#stepStarted) return;
      this.#stepStarted = true;
      this.#state.emit({ type: 'model.started', runId: this.#runId, step: this.#step });
    }

    /** 这一步写完了：交出 `model.ended`，再看步数和预算——还要接着调模型、又到了上限的，中断它。 */
    #endStep(continues: boolean): void {
      const usage = this.#stepUsage;
      this.#state.emit({
        type: 'model.ended',
        runId: this.#runId,
        step: this.#step,
        ...(usage ? { usage } : {}),
        ...(this.#state.record && this.#state.head !== undefined ? { seq: this.#state.head } : {}),
      });
      this.#step += 1;
      this.#stepStarted = false;
      this.#parts = [];
      this.#calls = [];
      this.#flushed = false;
      this.#stepUsage = undefined;
      this.#stepEvent = undefined;
      if (!continues || this.#cause !== undefined) return;
      if (this.#step >= this.#maxSteps) this.#stop('max_steps');
      else if (this.#overBudget()) this.#stop('budget');
    }

    /** 这一步的助手消息收齐了：写进日志（带 `meta.step`），交出工具调用，执行这里该执行的，把结果交回去。 */
    async #flush(): Promise<void> {
      if (this.#flushed || (this.#parts.length === 0 && this.#calls.length === 0)) return;
      this.#flushed = true;
      this.#beginStep();
      const usage = this.#stepUsage;
      const meta: StepMeta = {
        runId: this.#runId,
        step: this.#step,
        ...(this.#modelId ? { modelId: this.#modelId } : {}),
        finishReason: this.#calls.length > 0 ? 'tool-calls' : 'stop',
        ...(usage ? { usage } : {}),
      };
      const message: Message = { role: 'assistant', content: [...this.#parts] };
      this.#state.messages.push(message);
      const text = this.#parts.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('');
      if (text) this.#lastText = text;
      await write(this.#state, [
        messageEntry(message, {
          source: 'model',
          meta: { step: stepMetaToJson(meta), ...metaOf({ event: this.#stepEvent }) },
        }),
      ]);
      for (const item of this.#calls) {
        this.#open.set(item.call.id, item.call.name);
        if (item.mode === 'external' || item.mode === 'ask' || item.mode === 'confirm') {
          this.#pending.set(item.call.id, item);
        }
        this.#state.emit({ type: 'tool.called', runId: this.#runId, call: item.call });
      }
      const local = this.#calls.filter((item) => item.mode === 'execute');
      if (local.length > 0 && this.#cause === undefined) {
        const done = await Promise.all(
          local.map(async (item) => ({ item, ...(await this.#run(item.call, item.definition)) })),
        );
        for (const { item, output, source } of done) {
          this.#results.set(item.call.id, { output, source });
          this.#state.emit({ type: 'tool.returned', runId: this.#runId, callId: item.call.id, output });
        }
        if (this.#cause === undefined) {
          this.#idle = false;
          await this.#send(done.flatMap(({ item, output }) => this.#resolution(item.call.id, true, output)));
        }
      }
      await this.#finishStep(false);
    }

    /** 这一步的结果到齐了（停下来等的不算）：按执行方分组写下，这一步结束。`force` 时到了多少写多少。 */
    async #finishStep(force: boolean): Promise<void> {
      if (!this.#flushed) return;
      const waiting = this.#calls.filter((item) => item.mode === 'execute' || item.mode === 'remote');
      if (!force && waiting.some((item) => !this.#results.has(item.call.id))) return;
      await this.#writeResults(waiting.map((item) => item.call));
      this.#endStep(waiting.length > 0);
    }

    /** 把这些调用到了的结果按执行方分组写成 `tool` 消息。 */
    async #writeResults(calls: readonly Pick<ToolCall, 'id' | 'name'>[]): Promise<void> {
      const groups = new Map<string, { parts: ToolPart[]; event?: string }>();
      for (const call of calls) {
        const found = this.#results.get(call.id);
        if (!found || !this.#open.has(call.id)) continue;
        const group = groups.get(found.source) ?? { parts: [] };
        group.parts.push({ type: 'tool-result', id: call.id, name: call.name, output: found.output });
        if (found.event) group.event = found.event;
        groups.set(found.source, group);
        this.#open.delete(call.id);
      }
      const entries: NewEntry[] = [];
      for (const [source, group] of groups) {
        const message: Message = { role: 'tool', content: group.parts };
        this.#state.messages.push(message);
        const meta = metaOf({ event: group.event });
        entries.push(messageEntry(message, { source, ...(meta ? { meta } : {}) }));
      }
      await write(this.#state, entries);
    }

    /** 这一步的一次工具调用：自定义工具按权限和绑定的执行环境定怎么办，内置工具看 Managed Agents 要不要确认。 */
    #callOf(event: ToolUseEvent): StepCall {
      const input = (event.input ?? {}) as JsonValue;
      if (event.type !== 'agent.custom_tool_use') {
        const name = event.type === 'agent.mcp_tool_use' ? `mcp__${event.mcp_server_name}__${event.name}` : event.name;
        const call: ToolCall = { id: event.id, name, input };
        if (event.evaluated_permission !== 'ask') return { call, mode: 'remote' };
        const how = event.evaluation?.type === 'auto' ? 'auto' : 'always_ask';
        return {
          call,
          mode: 'confirm',
          approval: {
            approvalId: randomUUID(),
            callId: event.id,
            reason: `Managed Agents holds this call for approval (${how}).`,
          },
        };
      }
      const call: ToolCall = { id: event.id, name: event.name, input };
      const definition = this.#definitions.get(event.name);
      if (!definition) return { call, mode: 'execute' };
      const bound = external.has(definition.executor) ? { executor: definition.executor } : {};
      if (toolPermission(this.#agent.permissions, definition.name) === 'ask') {
        return { call, mode: 'ask', definition, approval: { approvalId: randomUUID(), callId: event.id }, ...bound };
      }
      return { call, mode: bound.executor ? 'external' : 'execute', definition, ...bound };
    }

    /** 子线程（多 agent）的调用转到主线程上来的：不进日志，回一句不支持，免得会话一直等着。 */
    async #refuseThread(event: ToolUseEvent): Promise<void> {
      logger.warn('managed agents subagent threads are not supported; refusing a tool call from a thread', {
        session: this.#session,
        thread: event.session_thread_id,
      });
      const refusal = errorOutput('ctx-managed-agents does not run or confirm tool calls of subagent threads.');
      if (event.type === 'agent.custom_tool_use') await this.#send(this.#resolution(event.id, true, refusal));
      else if (event.evaluated_permission === 'ask') await this.#send(this.#resolution(event.id, false, refusal));
    }

    /** 一个事件。 */
    async #handle(event: StreamEvent): Promise<void> {
      if (event.type !== 'event_start' && event.type !== 'event_delta' && event.id) this.#lastEvent = event.id;
      switch (event.type) {
        case 'span.model_request_start': {
          await this.#flush();
          await this.#finishStep(true);
          if (this.#cause !== undefined) {
            this.#discarding = true;
            return;
          }
          if (this.#step >= this.#maxSteps || this.#overBudget()) {
            this.#stop(this.#step >= this.#maxSteps ? 'max_steps' : 'budget');
            this.#discarding = true;
            return;
          }
          this.#discarding = false;
          this.#beginStep();
          return;
        }
        case 'event_delta': {
          if (this.#discarding) return;
          const text = event.delta.content.text;
          if (!text) return;
          const index = event.delta.index ?? 0;
          const preview = this.#previews.get(event.event_id) ?? new Map<number, string>();
          preview.set(index, (preview.get(index) ?? '') + text);
          this.#previews.set(event.event_id, preview);
          this.#state.emit({ type: 'text.delta', runId: this.#runId, text });
          return;
        }
        case 'agent.message': {
          const preview = this.#previews.get(event.id);
          this.#previews.delete(event.id);
          if (this.#discarding) return;
          this.#beginStep();
          event.content.forEach((block, index) => {
            if (block.type !== 'text') {
              this.#parts.push({ type: 'custom', kind: `${MANAGED_AGENTS_HARNESS}.${block.type}` });
              return;
            }
            if (!block.text) return;
            this.#parts.push({ type: 'text', text: block.text });
            // 增量只是前缀（会被丢掉一截）：补上没交出去的部分，`text.delta` 连起来就是这段话。
            const shown = preview?.get(index) ?? '';
            const rest = block.text.startsWith(shown) ? block.text.slice(shown.length) : '';
            if (rest) this.#state.emit({ type: 'text.delta', runId: this.#runId, text: rest });
          });
          this.#stepEvent = event.id;
          return;
        }
        case 'agent.tool_use':
        case 'agent.mcp_tool_use':
        case 'agent.custom_tool_use': {
          if (event.session_thread_id) return this.#refuseThread(event);
          if (this.#discarding) return;
          if (this.#flushed) {
            // 写下这一步之后又来的调用：另起一条助手消息（不该发生，按事件到的顺序照记）。
            await this.#finishStep(true);
          }
          this.#beginStep();
          const item = this.#callOf(event);
          this.#calls.push(item);
          this.#parts.push({ type: 'tool-call', id: item.call.id, name: item.call.name, input: item.call.input });
          if (item.approval) {
            this.#parts.push({
              type: 'tool-approval-request',
              approvalId: item.approval.approvalId,
              callId: item.call.id,
              ...(item.approval.reason !== undefined ? { reason: item.approval.reason } : {}),
            });
          }
          this.#stepEvent = event.id;
          return;
        }
        case 'span.model_request_end': {
          const usage = usageOf(event.model_usage);
          this.#total = addUsages(this.#total, usage);
          this.#previews.clear();
          if (this.#discarding) return;
          this.#stepUsage = addUsages(this.#stepUsage, usage);
          await this.#flush();
          return;
        }
        case 'agent.tool_result':
        case 'agent.mcp_tool_result': {
          const id = event.type === 'agent.tool_result' ? event.tool_use_id : event.mcp_tool_use_id;
          if (this.#results.has(id)) return;
          await this.#flush();
          const output = toolOutputOf(event.content, event.is_error);
          this.#results.set(id, { output, source: MANAGED_AGENTS_HARNESS, event: event.id });
          const name = this.#open.get(id);
          if (name === undefined) return;
          this.#state.emit({ type: 'tool.returned', runId: this.#runId, callId: id, output });
          if (this.#calls.some((item) => item.call.id === id)) await this.#finishStep(false);
          else await this.#writeResults([{ id, name }]);
          return;
        }
        case 'agent.thread_context_compacted':
          await write(this.#state, [
            eventEntry(MANAGED_AGENTS_EVENTS.compacted, {
              source: MANAGED_AGENTS_HARNESS,
              meta: metaOf({ event: event.id })!,
            }),
          ]);
          return;
        case 'session.error':
          if (event.error.retry_status.type === 'retrying') {
            logger.warn('managed agents is retrying after an error', {
              session: this.#session,
              error: event.error.message,
            });
            return;
          }
          this.#failure = errorOfEvent(event);
          return;
        case 'session.status_running':
        case 'session.status_rescheduled':
          this.#idle = false;
          return;
        case 'session.status_idle':
          return this.#onIdle(event);
        case 'session.status_terminated':
        case 'session.deleted':
          await this.#flush();
          this.#outcome = {
            stop: 'error',
            error: this.#failure ?? {
              message: `Managed Agents session "${this.#session}" ${event.type === 'session.deleted' ? 'was deleted' : 'terminated'} during the run.`,
              type: 'managed_agents',
              retryable: false,
            },
          };
          return;
        case 'session.thread_created':
          logger.warn('managed agents started a thread; its events are not recorded', { session: this.#session });
          return;
        default:
          return;
      }
    }

    async #onIdle(event: BetaManagedAgentsSessionStatusIdleEvent): Promise<void> {
      await this.#flush();
      const reason = event.stop_reason;
      // 等的都交回去了：它收到就接着跑，这次不算停下。
      const open = reason.type === 'requires_action' ? reason.event_ids.filter((id) => !this.#settled.has(id)) : [];
      if (reason.type === 'requires_action' && open.length === 0) return;
      this.#idle = true;
      if (this.#cause !== undefined) {
        // 是我们叫停的：停在哪都算停下了（停着等结果的不了结：下一轮了结）。
        await this.#finishStep(true);
        this.#outcome = { stop: 'end_turn' };
        return;
      }
      switch (reason.type) {
        case 'requires_action': {
          // 还在这里执行的不算；剩下的都是这一轮停下来等的，才以 requires_action 结束。
          if (open.some((id) => !this.#pending.has(id) && this.#open.has(id) && !this.#results.has(id))) return;
          await this.#finishStep(true);
          this.#outcome = { stop: 'requires_action' };
          return;
        }
        case 'end_turn':
        case 'refusal':
          if (reason.type === 'refusal') {
            logger.warn('managed agents refused the turn', {
              session: this.#session,
              ...(event.stop_details?.category ? { category: event.stop_details.category } : {}),
            });
          }
          await this.#finishStep(true);
          // 上一轮停着等的做完了：发这一轮的话，接着读。
          if (this.#content.length > 0) return this.#sendContent();
          this.#outcome = { stop: 'end_turn' };
          return;
        case 'budget_reached':
          await this.#finishStep(true);
          this.#outcome = { stop: 'max_budget' };
          return;
        case 'retries_exhausted':
          await this.#finishStep(true);
          this.#outcome = {
            stop: 'error',
            error: this.#failure ?? {
              message: 'Managed Agents gave up on the turn after repeated errors (retries_exhausted).',
              type: 'managed_agents',
              retryable: true,
            },
          };
          return;
        default:
          return;
      }
    }

    /** 发这一轮的话。出错的这一轮以 `error` 结束，话留给下一轮补发。 */
    async #sendContent(): Promise<void> {
      if (this.#content.length === 0) return;
      const content = this.#content;
      this.#content = [];
      this.#idle = false;
      try {
        await this.#send([{ type: 'user.message', content }]);
        this.#state.unsent = [];
      } catch (error) {
        if (error instanceof APIUserAbortError || this.#state.request.signal?.aborted) {
          this.#stop('aborted');
          return;
        }
        this.#outcome = { stop: 'error', error: apiErrorInfo(error, 'Could not send the input to Managed Agents') };
      }
    }

    /** 下一个事件；叫停以后过了时限就不再等，返回 `undefined`。 */
    async #next(): Promise<StreamEvent | undefined> {
      const deadline = this.#deadline;
      if (!deadline) return this.#feed.next();
      return Promise.race([this.#feed.next(), deadline.then(() => undefined)]);
    }

    /** 发了结和这一轮的话（有要了结的，等它停下再发话），读事件读到 Managed Agents 停下。 */
    async converse(settle: readonly BetaManagedAgentsEventParams[], content: readonly UserBlock[]): Promise<RunResult> {
      const { request } = this.#state;
      const onAbort = (): void => this.#stop('aborted');
      request.signal?.addEventListener('abort', onAbort, { once: true });
      const timeoutMs = this.#agent.settings?.timeoutMs;
      const timer = timeoutMs !== undefined ? setTimeout(() => this.#stop('timeout'), timeoutMs).unref() : undefined;
      let failure: { readonly error: unknown } | undefined;
      try {
        this.#content = [...content];
        // 会话这时停着：`prepare` 收拾过，或者刚建好。
        this.#idle = true;
        if (request.signal?.aborted) this.#stop('aborted');
        else if (settle.length > 0) {
          this.#idle = false;
          try {
            await this.#send(settle);
          } catch (error) {
            if (error instanceof APIUserAbortError || request.signal?.aborted) this.#stop('aborted');
            else
              this.#outcome = { stop: 'error', error: apiErrorInfo(error, 'Could not settle the waiting tool calls') };
          }
        } else await this.#sendContent();
        while (this.#outcome === undefined && !this.#state.fenced) {
          if (this.#cause !== undefined && this.#idle) break;
          let event: StreamEvent | undefined;
          try {
            event = await this.#next();
          } catch (error) {
            this.#outcome = { stop: 'error', error: apiErrorInfo(error, 'The Managed Agents event stream failed') };
            break;
          }
          if (!event) break;
          await this.#handle(event);
        }
        if (this.#state.fenced) this.#stop('fenced');
        await this.#flush();
        await this.#finishStep(true);
      } catch (error) {
        // 写日志失败：停下 Managed Agents，把错误抛给调用方（同参考实现：只有写日志失败才 reject）。
        failure = { error };
        this.#stop('aborted');
      } finally {
        request.signal?.removeEventListener('abort', onAbort);
        if (timer) clearTimeout(timer);
        await this.#interrupting;
      }
      if (failure) throw failure.error;
      return this.#finish();
    }

    async #finish(): Promise<RunResult> {
      const state = this.#state;
      if (state.fenced) {
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
      if (this.#cause === 'aborted') stopReason = 'aborted';
      else if (this.#cause === 'max_steps') stopReason = 'max_steps';
      else if (this.#cause === 'budget') stopReason = 'max_budget';
      else if (this.#cause === 'timeout') {
        stopReason = 'error';
        error = {
          message: `Managed Agents did not finish within settings.timeoutMs (${String(this.#agent.settings?.timeoutMs)} ms).`,
          type: 'timeout',
          retryable: true,
        };
      } else if (this.#outcome) {
        stopReason = this.#outcome.stop;
        error = this.#outcome.error;
      } else {
        stopReason = 'error';
        error = this.#failure ?? {
          message: 'The Managed Agents event stream ended before the session stopped.',
          type: 'managed_agents',
          retryable: true,
        };
      }
      if (stopReason === 'requires_action' && this.#pending.size === 0) stopReason = 'end_turn';
      let output: JsonValue | undefined;
      const { agent } = state.request;
      if (agent.output && stopReason === 'end_turn') {
        const parsed = parseOutput(this.#lastText);
        const issues = parsed ? checkJsonSchema(agent.output.schema, parsed.value) : ['the answer is not JSON'];
        if (parsed && issues.length === 0) output = parsed.value;
        else {
          stopReason = 'error';
          error = {
            message: `The answer does not match AgentSpec.output.schema: ${issues.join('; ')}.`,
            type: 'invalid_output',
            retryable: false,
          };
        }
      }
      return end(state, {
        stopReason,
        text: stopReason === 'error' ? '' : this.#lastText,
        open: this.#open,
        pending: stopReason === 'requires_action' ? [...this.#pending.values()] : [],
        last: this.#lastEvent,
        tools: digest(sessionTools([...this.#definitions.values()])),
        ...(error ? { error } : {}),
        ...(this.#total ? { usage: this.#total } : {}),
        ...(output !== undefined ? { output } : {}),
      });
    }
  }

  /**
   * 收尾：没等到结果的工具调用补错误结果（停下来等的除外），出错写 `ctx.error`，最后写 `ctx.run.ended`（等着的调用归谁执行、
   * 交给会话的工具、读到的最后一个事件、没发出去的输入）。
   */
  async function end(
    state: RunState,
    outcome: {
      readonly stopReason: StopReason;
      readonly text: string;
      readonly open: ReadonlyMap<string, string>;
      readonly pending: readonly StepCall[];
      readonly last?: string | undefined;
      readonly tools?: string;
      readonly error?: ErrorInfo;
      readonly usage?: Usage;
      readonly output?: JsonValue;
    },
  ): Promise<RunResult> {
    const { stopReason, error, usage, output, pending } = outcome;
    const waiting = new Set(pending.map((item) => item.call.id));
    const unanswered = [...outcome.open].filter(([id]) => !waiting.has(id));
    const entries: NewEntry[] = [];
    if (unanswered.length > 0) {
      const message: Message = {
        role: 'tool',
        content: unanswered.map(([id, name]) => ({ type: 'tool-result', id, name, output: errorOutput(INTERRUPTED) })),
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
    const bound = Object.fromEntries(
      pending.flatMap((item) => (item.executor !== undefined ? [[item.call.id, item.executor]] : [])),
    );
    const meta = metaOf({ tools: outcome.tools, last: outcome.last, unsent: state.unsent });
    entries.push(
      runEndedEntry(
        {
          runId: state.runId,
          stopReason,
          ...(usage ? { usage } : {}),
          ...(Object.keys(bound).length > 0 ? { executors: bound } : {}),
        },
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
    const approvals = pending.flatMap((item) => (item.approval ? [item.approval] : []));
    const summary = {
      runId: state.runId,
      text: outcome.text,
      stopReason,
      ...(usage ? { usage } : {}),
      ...(output !== undefined ? { output } : {}),
      ...(pending.length > 0 ? { pending: pending.map((item) => item.call) } : {}),
      ...(approvals.length > 0 ? { approvals } : {}),
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

  /** 同一个实例里同一会话的记录型运行一个接一个（`createSessionQueue`，同参考实现），`session_busy` 只出现在跨进程的时候。 */
  const queue = createSessionQueue();
  async function queued(request: RunRequest, emit: (event: RunEvent) => void): Promise<RunResult> {
    if (request.record === false) return execute(request, emit);
    const release = await queue.enter(request.session, request.signal);
    if (!release) {
      // 排队时取消了：以 `aborted` 结束，什么都不写。流里照样先 `run.started` 后 `run.ended`（同参考实现）。
      const runId = request.runId ?? randomUUID();
      emit({ type: 'run.started', runId, session: request.session });
      emit({ type: 'run.ended', runId, result: { runId, text: '', stopReason: 'aborted' } });
      return { runId, text: '', messages: [], recorded: [], stopReason: 'aborted' };
    }
    try {
      return await execute(request, emit);
    } finally {
      release();
    }
  }

  return {
    run: (request) => queued(request, () => {}),
    stream: (request) => streamRun(request, queued),
  };
}
