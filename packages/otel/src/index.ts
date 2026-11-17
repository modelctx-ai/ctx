/**
 * OpenTelemetry 适配：span 从会话日志的条目派生，不另记一套。会话日志是事实来源；这里只是把结束了的运行
 * 换一种形状交给 OpenTelemetry。属性按 GenAI 语义约定（`gen_ai.*`），框架自己的放在 `ctx.*` 下。
 */
import {
  context,
  SpanKind,
  SpanStatusCode,
  trace,
  type Attributes,
  type Context,
  type Span,
  type Tracer,
} from '@opentelemetry/api';
import {
  CTX_EVENTS,
  stepMetaOf,
  type Entry,
  type JsonObject,
  type SessionStore,
  type StopReason,
  type Usage,
} from '@modelctx-ai/ctx-protocol';

/** 一个 span 的描述：派生出来、还没交给 OpenTelemetry。时间是毫秒（条目的 `at`）。 */
export interface SpanRecord {
  readonly name: string;
  /** `invoke_agent`（一轮）、`chat`（一次模型调用）、`execute_tool`（一次工具调用）。 */
  readonly operation: 'invoke_agent' | 'chat' | 'execute_tool';
  readonly start: number;
  readonly end: number;
  readonly attributes: Attributes;
  /** 出错时的说明；没有就是正常结束。 */
  readonly error?: string;
  readonly children: readonly SpanRecord[];
}

export interface DerivedSpans {
  /** 每个结束了的运行一棵：`invoke_agent` 下面是 `chat`，`chat` 下面是这一步的 `execute_tool`。 */
  readonly runs: readonly SpanRecord[];
  /**
   * 到这里为止的运行都派生过了：最后一个结束了的运行的 `ctx.run.ended` 的 `seq`（没有就是 `after`，或者 0）。
   * 下一次从它往后读，不会重复、不会漏；还没结束的运行留到下一次。
   */
  readonly upTo: number;
}

export interface DeriveOptions {
  /** 会话名，记成 `gen_ai.conversation.id`。不给就从条目的 `session` 取。 */
  readonly session?: string;
  /** 条目从哪个 `seq` 之后读的；没有结束了的运行时 `upTo` 就是它。 */
  readonly after?: number;
}

interface OpenRun {
  readonly runId: string;
  readonly started: Entry;
  readonly agent: JsonObject;
  readonly entries: Entry[];
}

function dataOf(entry: Entry): Record<string, unknown> {
  return entry.type === 'event' && typeof entry.data === 'object' && entry.data !== null && !Array.isArray(entry.data)
    ? entry.data
    : {};
}

function usageAttributes(usage: Usage | undefined): Attributes {
  if (!usage) return {};
  const out: Attributes = {};
  if (usage.inputTokens !== undefined) out['gen_ai.usage.input_tokens'] = usage.inputTokens;
  if (usage.outputTokens !== undefined) out['gen_ai.usage.output_tokens'] = usage.outputTokens;
  if (usage.cacheReadTokens !== undefined) out['gen_ai.usage.cache_read.input_tokens'] = usage.cacheReadTokens;
  if (usage.cacheWriteTokens !== undefined) out['gen_ai.usage.cache_creation.input_tokens'] = usage.cacheWriteTokens;
  if (usage.reasoningTokens !== undefined) out['gen_ai.usage.reasoning.output_tokens'] = usage.reasoningTokens;
  return out;
}

function modelOf(agent: JsonObject): string | undefined {
  return typeof agent['model'] === 'string' ? agent['model'] : undefined;
}

/** 一步（一条带 `meta.step` 的助手消息）和它的工具调用。 */
function stepSpan(entries: readonly Entry[], index: number, start: number, agent: JsonObject): SpanRecord {
  const entry = entries[index]!;
  const meta = stepMetaOf(entry)!;
  const requested = modelOf(agent);
  const model = meta.modelId ?? requested;
  const tools: SpanRecord[] = [];
  if (entry.type === 'message' && typeof entry.message.content !== 'string') {
    for (const part of entry.message.content) {
      if (part.type !== 'tool-call' || part.providerExecuted === true) continue;
      // 结果在这一步之后的 tool 消息里；到下一步为止没找到就是没等到结果。
      let result: { readonly at: number; readonly error?: string } | undefined;
      for (const later of entries.slice(index + 1)) {
        if (stepMetaOf(later) !== undefined) break;
        if (later.type !== 'message' || later.message.role !== 'tool') continue;
        const found = later.message.content.find((item) => item.type === 'tool-result' && item.id === part.id);
        if (found?.type === 'tool-result') {
          result = {
            at: later.at,
            ...(found.output.type === 'error' ? { error: found.output.message } : {}),
          };
          break;
        }
      }
      tools.push({
        name: `execute_tool ${part.name}`,
        operation: 'execute_tool',
        start: entry.at,
        end: result?.at ?? entry.at,
        attributes: {
          'gen_ai.operation.name': 'execute_tool',
          'gen_ai.tool.name': part.name,
          'gen_ai.tool.call.id': part.id,
        },
        ...(result === undefined ? { error: 'No result was recorded for this tool call.' } : {}),
        ...(result?.error !== undefined ? { error: result.error } : {}),
        children: [],
      });
    }
  }
  return {
    name: model ? `chat ${model}` : 'chat',
    operation: 'chat',
    start,
    end: entry.at,
    attributes: {
      'gen_ai.operation.name': 'chat',
      ...(meta.provider !== undefined ? { 'gen_ai.provider.name': meta.provider } : {}),
      ...(requested !== undefined ? { 'gen_ai.request.model': requested } : {}),
      ...(meta.modelId !== undefined ? { 'gen_ai.response.model': meta.modelId } : {}),
      ...(meta.finishReason !== undefined ? { 'gen_ai.response.finish_reasons': [meta.finishReason] } : {}),
      'ctx.step': meta.step,
      ...usageAttributes(meta.usage),
    },
    children: tools,
  };
}

function runSpan(run: OpenRun, ended: Entry, session: string): SpanRecord {
  const data = dataOf(ended);
  const stopReason = typeof data['stopReason'] === 'string' ? (data['stopReason'] as StopReason) : undefined;
  const usage = data['usage'] as Usage | undefined;
  const { entries, agent } = run;
  const steps: SpanRecord[] = [];
  // 一步的模型调用从它前面那条条目（输入、上一步的工具结果）写下时算起。
  let last = run.started.at;
  for (const [index, entry] of entries.entries()) {
    if (stepMetaOf(entry)?.runId === run.runId) steps.push(stepSpan(entries, index, last, agent));
    last = entry.at;
  }
  const failure = entries.findLast((entry) => entry.type === 'event' && entry.kind === CTX_EVENTS.error);
  const message = failure ? dataOf(failure)['message'] : undefined;
  const name = typeof agent['name'] === 'string' ? agent['name'] : undefined;
  const model = modelOf(agent);
  return {
    name: name ? `invoke_agent ${name}` : 'invoke_agent',
    operation: 'invoke_agent',
    start: run.started.at,
    end: ended.at,
    attributes: {
      'gen_ai.operation.name': 'invoke_agent',
      ...(name !== undefined ? { 'gen_ai.agent.name': name } : {}),
      'gen_ai.conversation.id': session,
      ...(model !== undefined ? { 'gen_ai.request.model': model } : {}),
      'ctx.run.id': run.runId,
      ...(stopReason !== undefined ? { 'ctx.run.stop_reason': stopReason } : {}),
      ...usageAttributes(usage),
    },
    ...(stopReason === 'error'
      ? { error: typeof message === 'string' ? message : 'The run ended with an error.' }
      : {}),
    children: steps,
  };
}

/**
 * 从一个会话的条目（按 `seq` 排好）派生结束了的运行的 span。纯函数，不碰 OpenTelemetry：用它自己检查，或者交给
 * `emitSpans`。每一步的 span 靠 harness 写在助手消息上的 `meta.step`（`StepMeta`），旧日志里没有它的运行只有
 * `invoke_agent` 一层。消息正文、工具输入和输出不进属性。
 */
export function deriveSpans(entries: readonly Entry[], options: DeriveOptions = {}): DerivedSpans {
  const runs: SpanRecord[] = [];
  let upTo = options.after ?? 0;
  let open: OpenRun | undefined;
  for (const entry of entries) {
    if (entry.type === 'event' && entry.kind === CTX_EVENTS.runStarted) {
      const data = dataOf(entry);
      const runId = data['runId'];
      open =
        typeof runId === 'string'
          ? { runId, started: entry, agent: (data['agent'] ?? {}) as JsonObject, entries: [] }
          : undefined;
      continue;
    }
    if (entry.type === 'event' && entry.kind === CTX_EVENTS.runEnded) {
      if (open && dataOf(entry)['runId'] === open.runId) {
        runs.push(runSpan(open, entry, options.session ?? entry.session));
        upTo = entry.seq;
      }
      open = undefined;
      continue;
    }
    open?.entries.push(entry);
  }
  return { runs, upTo };
}

function emitOne(record: SpanRecord, tracer: Tracer, parent: Context): void {
  const span: Span = tracer.startSpan(
    record.name,
    {
      startTime: record.start,
      kind: record.operation === 'chat' ? SpanKind.CLIENT : SpanKind.INTERNAL,
      attributes: record.attributes,
    },
    parent,
  );
  if (record.error !== undefined) span.setStatus({ code: SpanStatusCode.ERROR, message: record.error });
  const inner = trace.setSpan(parent, span);
  for (const child of record.children) emitOne(child, tracer, inner);
  span.end(record.end);
}

/** 把派生出来的 span 交给 OpenTelemetry：开始和结束时间用条目的 `at`。`parent` 缺省是当前的上下文。 */
export function emitSpans(records: readonly SpanRecord[], tracer: Tracer, parent: Context = context.active()): void {
  for (const record of records) emitOne(record, tracer, parent);
}

export interface TraceSessionOptions {
  readonly tracer: Tracer;
  /** 从这个 `seq` 之后读；传上一次返回的 `upTo`，结束了的运行只发一次。缺省从头读。 */
  readonly after?: number;
  readonly parent?: Context;
}

export interface TraceSessionResult {
  /** 这一次发了几个运行。 */
  readonly runs: number;
  /** 下一次的 `after`。 */
  readonly upTo: number;
}

/**
 * 读一个会话 `after` 之后的条目，把结束了的运行发成 span。常驻进程里在每轮结束后（例如编排器的 `run.completed`）
 * 调一次，带上上一次的 `upTo`；也可以离线对整个库跑一遍。
 */
export async function traceSession(
  store: SessionStore,
  session: string,
  options: TraceSessionOptions,
): Promise<TraceSessionResult> {
  const after = options.after ?? 0;
  const entries = await store.list(session, { after });
  const derived = deriveSpans(entries, { session, after });
  emitSpans(derived.runs, options.tracer, options.parent ?? context.active());
  return { runs: derived.runs.length, upTo: derived.upTo };
}
