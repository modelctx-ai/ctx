import {
  childRunOutput,
  errorOutput,
  type AgentSpec,
  type Awaitable,
  type Harness,
  type JsonObject,
  type JsonValue,
  type MessageContent,
  type Orchestrator,
  type RunRequest,
  type RunResult,
  type SessionStore,
} from '@modelctx-ai/ctx-protocol';

import type { FunctionToolDefinition, ToolFunction } from './executor.ts';

/** 派子 agent 时知道的：父会话、父运行和这次工具调用。 */
export interface SubagentContext {
  readonly session: string;
  readonly runId?: string;
  readonly callId: string;
}

export interface SubagentToolOptions {
  readonly name: string;
  readonly description?: string;
  /** 模型给的输入的结构，缺省 `{ task: string }`。 */
  readonly inputSchema?: JsonObject;
  /** 子运行交给谁：`Harness` 直接跑，`Orchestrator` 排进队列（取消用 `cancel`）。 */
  readonly runner: Harness | Orchestrator;
  readonly agent: AgentSpec | ((input: JsonValue, context: SubagentContext) => Awaitable<AgentSpec>);
  /** 子会话名，缺省 `<父会话>/<工具名>/<调用 id>`：每次调用一个新会话。给同一个名字就是让子 agent 接着上次的会话。 */
  readonly session?: (context: SubagentContext) => string;
  /** 子运行的输入，缺省取输入的 `task`（是字符串时），否则整个输入的 JSON 文本。带一段摘要就在这里拼进去。 */
  readonly input?: (input: JsonValue, context: SubagentContext) => Awaitable<MessageContent>;
  /**
   * 子 agent 的上下文：`fresh`（缺省）只有它自己会话里的；`inherit` 再带上父会话到这次调用之前的投影
   * （`AgentSpec.context.inherit`），要给 `store` 才能找到「这次调用之前」。
   */
  readonly context?: 'fresh' | 'inherit';
  /** `context: 'inherit'` 时读父会话用，和 harness 用的是同一个存储。 */
  readonly store?: SessionStore;
}

/** 一个派子 agent 的工具：注册进函数执行环境（`executor.register(definition, execute)`）后加进注册表。 */
export interface SubagentTool {
  readonly definition: FunctionToolDefinition;
  readonly execute: ToolFunction;
}

const DEFAULT_INPUT: JsonObject = {
  type: 'object',
  properties: {
    task: { type: 'string', description: 'What the subagent should do, with everything it needs to know.' },
  },
  required: ['task'],
};

function defaultInput(input: JsonValue): MessageContent {
  if (typeof input === 'object' && input !== null && !Array.isArray(input) && typeof input['task'] === 'string') {
    return input['task'];
  }
  return typeof input === 'string' ? input : JSON.stringify(input);
}

function isOrchestrator(runner: Harness | Orchestrator): runner is Orchestrator {
  return typeof (runner as Orchestrator).submit === 'function';
}

/** 父会话里带着这次调用的那条助手消息之前的 `seq`；没记日志就找不到，取整段。 */
async function before(store: SessionStore, session: string, callId: string): Promise<number | undefined> {
  const recent = await store.list(session, { types: ['message'], last: 32 });
  for (const entry of recent.toReversed()) {
    if (entry.type !== 'message' || typeof entry.message.content === 'string') continue;
    if (entry.message.content.some((part) => part.type === 'tool-call' && part.id === callId)) return entry.seq - 1;
  }
  return undefined;
}

/**
 * 派子 agent 的工具：模型调用它，就在子会话上跑一轮，`RunRequest.parent` 指回这次调用（记进子会话的 `ctx.run.started`），
 * 结果是 `ChildRunResult`（`childRunOutput`），父会话的日志里由此找得到子会话（`childRunsOf`）。
 * 父运行取消时子运行跟着取消：`Harness` 经工具的 `signal`，`Orchestrator` 经 `cancel`。
 * 编排模式（路由、群聊、层级）不在这里：这只是一次工具调用派一轮。
 */
export function createSubagentTool(options: SubagentToolOptions): SubagentTool {
  const { name, runner } = options;
  if (options.context === 'inherit' && !options.store) {
    throw new TypeError(`Subagent tool "${name}" uses context "inherit" and needs the session store.`);
  }
  const definition: FunctionToolDefinition = {
    name,
    ...(options.description !== undefined ? { description: options.description } : {}),
    inputSchema: options.inputSchema ?? DEFAULT_INPUT,
  };
  const execute: ToolFunction = async (input, context) => {
    const from: SubagentContext = {
      session: context.session,
      ...(context.runId !== undefined ? { runId: context.runId } : {}),
      callId: context.callId,
    };
    const session = options.session?.(from) ?? `${context.session}/${name}/${context.callId}`;
    if (session === context.session) {
      return errorOutput(`Subagent tool "${name}" cannot run in its parent's session "${session}".`);
    }
    let agent = typeof options.agent === 'function' ? await options.agent(input, from) : options.agent;
    if (options.context === 'inherit') {
      const upTo = await before(options.store!, context.session, context.callId);
      agent = {
        ...agent,
        context: { ...agent.context, inherit: { session: context.session, ...(upTo !== undefined ? { upTo } : {}) } },
      };
    }
    const runId = crypto.randomUUID();
    const request: RunRequest = {
      session,
      agent,
      input: await (options.input ?? defaultInput)(input, from),
      runId,
      ...(context.runId !== undefined
        ? { parent: { session: context.session, runId: context.runId, toolCallId: context.callId } }
        : {}),
    };
    let result: RunResult;
    if (isOrchestrator(runner)) {
      const handle = await runner.submit(request);
      const onAbort = (): void => void runner.cancel(handle.runId);
      context.signal?.addEventListener('abort', onAbort, { once: true });
      if (context.signal?.aborted) onAbort();
      try {
        result = await handle.done;
      } finally {
        context.signal?.removeEventListener('abort', onAbort);
      }
    } else {
      result = await runner.run({ ...request, ...(context.signal ? { signal: context.signal } : {}) });
    }
    return childRunOutput({ session, runId: result.runId }, result);
  };
  return { definition, execute };
}
