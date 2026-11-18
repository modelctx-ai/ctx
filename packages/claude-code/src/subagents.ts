// Claude Code 自己起的子代理（`Task` 工具，发给模型时叫 `Agent`）：轨迹写进子会话，发起的那一侧那次调用的结果是
// `ChildRunResult`（docs/protocol.md「父子运行」）。子会话名同进程内派子 agent 的缺省：`<发起方的会话>/<工具名>/<调用 id>`。
//
// 对照 Claude Code 2.1.326 的实际输出核实过（子代理在前台跑：适配器设 `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`）：
//
//   system task_started       { task_id, tool_use_id, subagent_type, prompt, task_type: 'local_agent', parent_task_id? }
//   user / assistant          `parent_tool_use_id` 是那次调用：子代理收到的输入、它每一步的消息和工具结果
//   system task_updated       { task_id, patch: { status, error? } }
//   system task_notification  { tool_use_id, status: 'completed' | 'failed' | 'stopped', summary, usage }
//   user（发起的一方）        那次调用的 tool_result；父运行那一层还带 `tool_use_result`：完成时是
//                             `{ status, content, usage, resolvedModel, harnessNoteCount, harnessTailCount, … }`，失败、中断时是一段文字
//
// 子代理最后的回答不单独转出：完成时从 `tool_use_result.content` 取（去掉 Claude Code 在前后加的说明），取不到用
// `task_notification` 的 `summary`。子代理再派的子代理（`spawn_depth` 2 起）里面的消息不转出，它的子会话只有输入、回答和结束。
import { randomUUID } from 'node:crypto';

import {
  afterConflict,
  agentSpecToJson,
  childRunOutput,
  CONTEXT_OVERFLOW,
  CTX_EVENTS,
  ctxErrorEntry,
  errorOutput,
  eventEntry,
  headSeq,
  isConflict,
  isContextOverflowText,
  isEvent,
  messageEntry,
  runEndedEntry,
  runStartedEntry,
  stepMetaToJson,
  userEntry,
  type AgentSpec,
  type Entry,
  type JsonObject,
  type JsonValue,
  type Message,
  type NewEntry,
  type RunParent,
  type SessionStore,
  type StepMeta,
  type StopReason,
  type ToolCall,
  type ToolOutput,
  type ToolPart,
  type Usage,
} from '@modelctx-ai/ctx-protocol';

import { CLAUDE_CODE_EVENTS, CLAUDE_CODE_HARNESS, INTERRUPTED, MAX_CONFLICTS } from './constants.ts';
import {
  addUsages,
  assistantMessageOf,
  textOfBlocks,
  toolOutputOf,
  usageOf,
  type AnthropicBlock,
  type AnthropicUsage,
  type AssistantLine,
  type UserLine,
} from './stream-json.ts';

/** `system` 行里和子代理有关的几种（只列用到的字段）。 */
export interface TaskLine {
  readonly type: 'system';
  readonly subtype: string;
  readonly task_id?: string;
  readonly tool_use_id?: string;
  readonly task_type?: string;
  readonly subagent_type?: string;
  readonly prompt?: string;
  readonly parent_task_id?: string;
  readonly status?: string;
  readonly summary?: string;
  readonly patch?: { readonly status?: string; readonly error?: string };
}

export interface SubagentTraceOptions {
  readonly store: SessionStore;
  /** 父运行：它的会话和 `runId`。 */
  readonly root: { readonly session: string; readonly runId: string };
  /** 父运行的配置：子运行的 `agent` 记子代理的类型（`name`）和这里的模型。 */
  readonly agent: AgentSpec;
  readonly owner?: string;
  /** Claude Code 的版本，记进子运行的 `harness`。 */
  readonly version?: string;
  /** Claude Code 那边的工具名换回 ctx 的名字。 */
  readonly toolName: (name: string) => string;
  /** 一个工具（Claude Code 那边的名字）由谁执行：ctx 的执行环境的名字，自带的工具是 `claude-code`。 */
  readonly executorOf: (name: string) => string;
}

interface Pending {
  readonly id: string;
  readonly model?: string;
  readonly blocks: AnthropicBlock[];
  readonly usage?: AnthropicUsage;
  uuid?: string;
}

/** 子会话上的一轮。 */
interface Child {
  readonly call: string;
  readonly session: string;
  readonly runId: string;
  readonly parent: RunParent;
  readonly agentId?: string;
  readonly agentType?: string;
  readonly prompt?: string;
  head: number | undefined;
  fenced: boolean;
  /** `#start` 来过了（写没写成都算）。 */
  opened: boolean;
  /** 子会话上这一轮的 `ctx.run.started` 的 `seq`，和这一轮写进子会话的条目：围栏认它们。 */
  started?: number;
  readonly recorded: Entry[];
  hasInput: boolean;
  step: number;
  current?: Pending;
  calls: ToolCall[];
  readonly results: Map<string, { output: ToolOutput; source: string; uuid?: string }>;
  readonly open: Map<string, string>;
  model?: string;
  usage?: Usage;
  status?: string;
  summary?: string;
  error?: string;
  ended: boolean;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function metaOf(uuid: string | undefined): JsonObject {
  return uuid ? { claudeCode: { uuid } } : {};
}

/** 完成时 `tool_use_result.content` 里子代理的回答：去掉前面 `harnessNoteCount`、后面 `harnessTailCount` 段说明。 */
function reportOf(raw: unknown): string | undefined {
  if (!isObject(raw) || !Array.isArray(raw['content'])) return undefined;
  const blocks = raw['content'] as AnthropicBlock[];
  const head = typeof raw['harnessNoteCount'] === 'number' ? raw['harnessNoteCount'] : 0;
  const tail = typeof raw['harnessTailCount'] === 'number' ? raw['harnessTailCount'] : 0;
  return textOfBlocks(blocks.slice(head, blocks.length - tail)) || undefined;
}

function stopReasonOf(status: string | undefined): StopReason {
  if (status === 'completed') return 'end_turn';
  if (status === 'stopped' || status === 'killed') return 'aborted';
  return 'error';
}

/** 子代理失败时 Claude Code 给的说法（带着「HTTP 500」这类）换成 `ChildRunResult.error`。 */
function errorOf(message: string): { message: string; type: string } {
  if (isContextOverflowText(message)) return { message, type: CONTEXT_OVERFLOW };
  return { message, type: /\bHTTP \d{3}\b/.test(message) ? 'api_call' : CLAUDE_CODE_HARNESS };
}

/**
 * 一轮里 Claude Code 起的子代理：每个子代理在子会话上记一轮（`ctx.run.started` 带 `parent`、输入、每一步、`ctx.run.ended`），
 * 发起方收到的那次调用的结果换成 `ChildRunResult`。只在记录型的运行里用。
 */
export class SubagentTrace {
  readonly #options: SubagentTraceOptions;
  readonly #children = new Map<string, Child>();
  /** 调用 id → 谁发的（`undefined` 是父运行，否则是那个子代理的调用 id）、工具在 Claude Code 那边的名字。 */
  readonly #callers = new Map<string, { readonly from: string | undefined; readonly name: string }>();

  constructor(options: SubagentTraceOptions) {
    this.#options = options;
  }

  /** 一条助手消息里的工具调用：记下是谁发的。父运行的在它的 `assistant` 行到的时候就要记，那时 `task_started` 还没来。 */
  calls(blocks: readonly AnthropicBlock[], from: string | undefined): void {
    for (const block of blocks) {
      if (block.type === 'tool_use' && block.id && block.name) this.#callers.set(block.id, { from, name: block.name });
    }
  }

  /** `system` 的 `task_started`、`task_updated`、`task_notification`。 */
  async system(line: TaskLine): Promise<void> {
    if (line.subtype === 'task_started') {
      if ((line.task_type !== undefined && line.task_type !== 'local_agent') || !line.tool_use_id) return;
      await this.#start(this.#childOf(line.tool_use_id, line));
      return;
    }
    const child =
      line.subtype === 'task_notification' && line.tool_use_id
        ? this.#children.get(line.tool_use_id)
        : [...this.#children.values()].find((candidate) => candidate.agentId === line.task_id);
    if (!child || child.ended) return;
    if (line.subtype === 'task_notification') {
      if (line.status) child.status = line.status;
      if (line.summary !== undefined) child.summary = line.summary;
    } else if (line.subtype === 'task_updated') {
      if (line.patch?.status) child.status = line.patch.status;
      if (line.patch?.error) child.error = line.patch.error;
    }
  }

  /** 带 `parent_tool_use_id` 的 `assistant`、`user` 行：子代理里面的消息。 */
  async line(line: AssistantLine | UserLine, call: string): Promise<void> {
    const child = this.#childOf(call);
    if (child.ended) return;
    await this.#start(child);
    const uuid = (line as { uuid?: unknown }).uuid;
    if (line.type === 'assistant') {
      // 接口错误包成的合成消息不是子代理说的话：失败由 `task_notification` 报。
      if (line.is_api_error_message || line.message.model === '<synthetic>') return;
      this.calls(line.message.content, call);
      if (child.current && child.current.id !== line.message.id) await this.#flushAssistant(child);
      child.current ??= {
        id: line.message.id,
        ...(line.message.model ? { model: line.message.model } : {}),
        blocks: [],
        ...(line.message.usage ? { usage: line.message.usage } : {}),
      };
      child.current.blocks.push(...line.message.content);
      if (typeof uuid === 'string') child.current.uuid = uuid;
      return;
    }
    await this.#flushAssistant(child);
    const blocks: readonly AnthropicBlock[] =
      typeof line.message.content === 'string' ? [{ type: 'text', text: line.message.content }] : line.message.content;
    const results = blocks.filter((block) => block.type === 'tool_result' && block.tool_use_id);
    if (results.length === 0) {
      const text = textOfBlocks(blocks);
      if (!text) return;
      if (!child.hasInput) {
        child.hasInput = true;
        await this.#write(child, [userEntry(text, { source: CLAUDE_CODE_HARNESS })]);
      } else {
        await this.#write(child, [
          eventEntry(CLAUDE_CODE_EVENTS.synthetic, {
            text,
            source: CLAUDE_CODE_HARNESS,
            ...(typeof uuid === 'string' ? { meta: metaOf(uuid) } : {}),
          }),
        ]);
      }
      return;
    }
    for (const block of results) {
      const id = block.tool_use_id!;
      const nested = await this.finish(id, block, undefined);
      child.results.set(id, {
        output: nested ?? toolOutputOf(block, results.length === 1 ? line.tool_use_result : undefined),
        source: this.#options.executorOf(this.#callers.get(id)?.name ?? ''),
        ...(typeof uuid === 'string' ? { uuid } : {}),
      });
    }
    await this.#flushResults(child, false);
  }

  /**
   * 发起方收到了那次调用的结果：子代理这一轮结束，在子会话里写完；返回发起方那一侧的结果（`ChildRunResult`）。
   * 不是子代理的调用（或者没起来就失败了）返回 `undefined`。
   */
  async finish(call: string, block: AnthropicBlock, raw: unknown): Promise<ToolOutput | undefined> {
    const child = this.#children.get(call);
    if (!child || child.ended) return undefined;
    await this.#start(child);
    const status = isObject(raw) && typeof raw['status'] === 'string' ? raw['status'] : child.status;
    const stopReason = stopReasonOf(status ?? (block.is_error ? 'failed' : 'completed'));
    const finalUsage = isObject(raw) ? usageOf(raw['usage'] as AnthropicUsage | undefined) : undefined;
    const model = isObject(raw) && typeof raw['resolvedModel'] === 'string' ? raw['resolvedModel'] : child.model;
    const text = stopReason === 'end_turn' ? (reportOf(raw) ?? child.summary ?? '') : '';
    const said = typeof block.content === 'string' ? block.content : textOfBlocks(block.content ?? []);
    const failure =
      stopReason === 'error'
        ? errorOf(
            child.error ??
              child.summary ??
              (typeof raw === 'string' ? raw : undefined) ??
              (said || 'The subagent failed.'),
          )
        : undefined;
    const answer: Message | undefined = text ? { role: 'assistant', content: [{ type: 'text', text }] } : undefined;
    const usage = await this.#end(child, stopReason, { answer, model, finalUsage, failure });
    return childRunOutput(
      { session: child.session, runId: child.runId },
      {
        runId: child.runId,
        text,
        stopReason,
        ...(usage ? { usage } : {}),
        ...(failure ? { error: failure } : {}),
      },
    );
  }

  /**
   * 父运行结束了：还没结束的子代理（进程没了、没等到结果）以 `aborted` 结束。返回父运行直接派的那些调用的结果
   * （`ChildRunResult`），父运行给没等到结果的调用补结果时用。
   */
  async close(): Promise<ReadonlyMap<string, ToolOutput>> {
    const outputs = new Map<string, ToolOutput>();
    for (const child of this.#children.values()) {
      if (child.ended) continue;
      const usage = await this.#end(child, 'aborted', {});
      if (child.parent.session !== this.#options.root.session) continue;
      outputs.set(
        child.call,
        childRunOutput(
          { session: child.session, runId: child.runId },
          { runId: child.runId, text: '', stopReason: 'aborted', ...(usage ? { usage } : {}) },
        ),
      );
    }
    return outputs;
  }

  // ---- 内部 ----

  #childOf(call: string, line?: TaskLine): Child {
    const existing = this.#children.get(call);
    if (existing) return existing;
    const caller = this.#callers.get(call);
    let owner: { readonly session: string; readonly runId: string } = this.#options.root;
    if (caller?.from !== undefined) {
      owner = this.#children.get(caller.from) ?? owner;
    } else if (!caller && line?.parent_task_id) {
      owner = [...this.#children.values()].find((child) => child.agentId === line.parent_task_id) ?? owner;
    }
    const name = this.#options.toolName(caller?.name ?? 'Task');
    const child: Child = {
      call,
      session: `${owner.session}/${name}/${call}`,
      runId: randomUUID(),
      parent: { session: owner.session, runId: owner.runId, toolCallId: call },
      ...(line?.task_id ? { agentId: line.task_id } : {}),
      ...(line?.subagent_type ? { agentType: line.subagent_type } : {}),
      ...(line?.prompt !== undefined ? { prompt: line.prompt } : {}),
      head: undefined,
      fenced: false,
      opened: false,
      recorded: [],
      hasInput: false,
      step: 0,
      calls: [],
      results: new Map(),
      open: new Map(),
      ended: false,
    };
    this.#children.set(call, child);
    return child;
  }

  async #start(child: Child): Promise<void> {
    if (child.opened) return;
    child.opened = true;
    const { agent, owner, version } = this.#options;
    const spec: AgentSpec = { ...(child.agentType ? { name: child.agentType } : {}), model: agent.model };
    await this.#write(child, [
      runStartedEntry(
        {
          runId: child.runId,
          agent: agentSpecToJson(spec),
          ...(owner !== undefined ? { owner } : {}),
          parent: { ...child.parent },
          harness: { name: CLAUDE_CODE_HARNESS, ...(version !== undefined ? { version } : {}) },
        },
        { source: 'harness', ...(child.agentId ? { meta: { claudeCode: { agentId: child.agentId } } } : {}) },
      ),
    ]);
    child.started = child.recorded.find((entry) => isEvent(entry, CTX_EVENTS.runStarted))?.seq;
  }

  async #write(child: Child, entries: readonly NewEntry[]): Promise<void> {
    if (entries.length === 0 || child.fenced) return;
    const { store } = this.#options;
    for (let conflicts = 0; ; conflicts += 1) {
      try {
        const head = child.head ?? (await headSeq(store, child.session));
        const written = await store.append(child.session, entries, { expectSeq: head });
        child.recorded.push(...written);
        child.head = written.at(-1)?.seq ?? head;
        return;
      } catch (error) {
        if (!isConflict(error) || conflicts >= MAX_CONFLICTS) throw error;
        // 子会话里别人写了东西：被围栏（`afterConflict`）就不再写，否则接在新的末尾后面。
        const head = await afterConflict(store, child.session, child);
        if (head === undefined) {
          child.fenced = true;
          return;
        }
        child.head = head;
      }
    }
  }

  #stepMeta(child: Child, model: string | undefined, usage: Usage | undefined, finishReason?: string): JsonObject {
    const meta: StepMeta = {
      runId: child.runId,
      step: child.step,
      ...(model ? { modelId: model } : {}),
      ...(finishReason ? { finishReason } : {}),
      ...(usage ? { usage } : {}),
    };
    return stepMetaToJson(meta);
  }

  async #flushAssistant(child: Child): Promise<void> {
    const message = child.current;
    child.current = undefined;
    if (!message || message.blocks.length === 0) return;
    const usage = usageOf(message.usage);
    child.usage = addUsages(child.usage, usage);
    if (message.model) child.model = message.model;
    const assistant = assistantMessageOf(message.blocks, this.#options.toolName);
    await this.#write(child, [
      messageEntry(assistant, {
        source: 'model',
        meta: { step: this.#stepMeta(child, message.model, usage), ...metaOf(message.uuid) },
      }),
    ]);
    child.calls = message.blocks.flatMap((block) =>
      block.type === 'tool_use' && block.id && block.name
        ? [{ id: block.id, name: this.#options.toolName(block.name), input: (block.input ?? {}) as JsonValue }]
        : [],
    );
    for (const call of child.calls) child.open.set(call.id, call.name);
    if (child.calls.length === 0) child.step += 1;
  }

  /** 这一步的工具结果到齐了（或者子代理结束了）：按执行方分组写下，这一步结束。 */
  async #flushResults(child: Child, force: boolean): Promise<void> {
    if (child.calls.length === 0) return;
    if (!force && child.calls.some((call) => !child.results.has(call.id))) return;
    const groups = new Map<string, { parts: ToolPart[]; uuid?: string }>();
    for (const call of child.calls) {
      const found = child.results.get(call.id);
      if (!found) continue;
      const group = groups.get(found.source) ?? { parts: [] };
      group.parts.push({ type: 'tool-result', id: call.id, name: call.name, output: found.output });
      if (found.uuid) group.uuid = found.uuid;
      groups.set(found.source, group);
      child.open.delete(call.id);
    }
    const entries: NewEntry[] = [];
    for (const [source, group] of groups) {
      entries.push(
        messageEntry(
          { role: 'tool', content: group.parts },
          { source, ...(group.uuid ? { meta: metaOf(group.uuid) } : {}) },
        ),
      );
    }
    await this.#write(child, entries);
    child.calls = [];
    child.results.clear();
    child.step += 1;
  }

  /** 收尾：没等到结果的调用补错误结果，有回答写回答，出错写 `ctx.error`，最后写 `ctx.run.ended`。返回这一轮的用量。 */
  async #end(
    child: Child,
    stopReason: StopReason,
    outcome: {
      readonly answer?: Message | undefined;
      readonly model?: string | undefined;
      readonly finalUsage?: Usage | undefined;
      readonly failure?: { readonly message: string; readonly type: string } | undefined;
    },
  ): Promise<Usage | undefined> {
    child.ended = true;
    await this.#start(child);
    // 再往下派的子代理（输出里没有它的消息）：输入只在 `task_started` 里。
    if (!child.hasInput && child.prompt) {
      child.hasInput = true;
      await this.#write(child, [userEntry(child.prompt, { source: CLAUDE_CODE_HARNESS })]);
    }
    await this.#flushAssistant(child);
    await this.#flushResults(child, true);
    for (const nested of this.#children.values()) {
      if (!nested.ended && nested.parent.session === child.session) await this.#end(nested, 'aborted', {});
    }
    const entries: NewEntry[] = [];
    if (child.open.size > 0) {
      entries.push(
        messageEntry(
          {
            role: 'tool',
            content: [...child.open].map(([id, name]) => ({
              type: 'tool-result',
              id,
              name,
              output: errorOutput(INTERRUPTED),
            })),
          },
          { source: 'harness' },
        ),
      );
      child.open.clear();
    }
    const usage = addUsages(child.usage, outcome.finalUsage);
    if (outcome.answer) {
      entries.push(
        messageEntry(outcome.answer, {
          source: 'model',
          meta: { step: this.#stepMeta(child, outcome.model, outcome.finalUsage, 'stop') },
        }),
      );
    }
    if (outcome.failure) {
      entries.push(
        ctxErrorEntry(
          { runId: child.runId, message: outcome.failure.message, type: outcome.failure.type },
          { source: 'harness' },
        ),
      );
    }
    entries.push(runEndedEntry({ runId: child.runId, stopReason, ...(usage ? { usage } : {}) }, { source: 'harness' }));
    await this.#write(child, entries);
    return usage;
  }
}
