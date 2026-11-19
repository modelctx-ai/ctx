import { PROTOCOL_VERSION } from './discovery.ts';
import type { JsonObject, JsonValue } from './types.ts';

/**
 * 线上 JSON 形状的 JSON Schema（2020-12），给别的语言实现组件用：`$defs` 里每个形状一条，名字和 TypeScript 的类型名一样。
 * 只描述过线的形状：`AgentSpec.model` 只能是名字，`RunRequest` 没有 `signal`。对象都不收没列出的键（`additionalProperties:
 * false`），TypeScript 那边加了字段而这里没加，校验真实值的测试会红。服务端在 `GET /protocol/schema` 给出同一份，
 * 仓库根的 `schema/protocol.schema.json` 是它的副本。
 */

type Schema = JsonObject;

const ref = (name: string): Schema => ({ $ref: `#/$defs/${name}` });
const str: Schema = { type: 'string' };
const num: Schema = { type: 'number' };
const int: Schema = { type: 'integer' };
const bool: Schema = { type: 'boolean' };
const any: Schema = {};
const arrayOf = (items: Schema): Schema => ({ type: 'array', items });
const recordOf = (values: Schema): Schema => ({ type: 'object', additionalProperties: values });
const literal = (value: string): Schema => ({ const: value });
const oneOf = (...options: Schema[]): Schema => ({ oneOf: options });
const anyOf = (...options: Schema[]): Schema => ({ anyOf: options });

/** 必填的键、可选的键：不收别的键。 */
function obj(required: Record<string, Schema>, optional: Record<string, Schema> = {}, description?: string): Schema {
  return {
    type: 'object',
    ...(description !== undefined ? { description } : {}),
    properties: { ...required, ...optional },
    ...(Object.keys(required).length > 0 ? { required: Object.keys(required) } : {}),
    additionalProperties: false,
  };
}

const providerOptions = recordOf({ type: 'object' });
const withProvider = { providerOptions: ref('MessageProviderOptions') };
const entryBase = { id: str, session: str, v: int, seq: int, at: num };
const entryOptional = { key: str, source: str, meta: { type: 'object' } };
/** 追加时：`id`、`at` 可选，`session`、`seq`、`v` 由存储填。 */
const entryDraft = { id: str, at: num, ...entryOptional };
const note = { session: str, from: int, upTo: int, at: num, salience: num };
const noteOptional = { kind: str, topic: str, settledAt: num };
const fact = {
  subject: str,
  text: str,
  validFrom: num,
  confidence: num,
  salience: num,
  sources: arrayOf(ref('SourceRef')),
};
const factOptional = { key: str, predicate: str, topic: str };
const procedure = { when: str, do: str, evidence: arrayOf(ref('SourceRef')), at: num };
const usage = ['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens'];

const defs: Record<string, Schema> = {
  JsonValue: { description: '任何 JSON 值' },
  JsonObject: { type: 'object' },
  ErrorInfo: obj(
    { message: str },
    { type: str, retryable: bool, statusCode: int, responseBody: str },
    '跨边界的错误：`{ error: ErrorInfo }`',
  ),
  MessageProviderOptions: providerOptions,

  // ---- 消息 ----
  ToolFileData: oneOf(
    obj({ type: literal('data'), data: str }),
    obj({ type: literal('url'), url: str }),
    obj({ type: literal('reference'), reference: recordOf(str) }),
    obj({ type: literal('text'), text: str }),
  ),
  TextPart: obj({ type: literal('text'), text: str }, withProvider),
  FilePart: obj(
    { type: literal('file'), mediaType: str, data: ref('ToolFileData') },
    { filename: str, ...withProvider },
  ),
  ReasoningPart: obj({ type: literal('reasoning'), text: str }, withProvider),
  ReasoningFilePart: obj(
    {
      type: literal('reasoning-file'),
      mediaType: str,
      data: oneOf(obj({ type: literal('data'), data: str }), obj({ type: literal('url'), url: str })),
    },
    withProvider,
  ),
  CustomPart: obj({ type: literal('custom'), kind: str }, withProvider),
  ToolCallPart: obj(
    { type: literal('tool-call'), id: str, name: str, input: any },
    { providerExecuted: bool, ...withProvider },
  ),
  ToolResultPart: obj({ type: literal('tool-result'), id: str, name: str, output: ref('ToolOutput') }, withProvider),
  ToolApprovalRequestPart: obj(
    { type: literal('tool-approval-request'), approvalId: str, callId: str },
    { reason: str, isAutomatic: bool, signature: str, inputSchemaInput: any },
  ),
  ToolApprovalResponsePart: obj(
    { type: literal('tool-approval-response'), approvalId: str, approved: bool },
    { reason: str, providerExecuted: bool },
  ),
  MessageContent: anyOf(str, arrayOf(oneOf(ref('TextPart'), ref('FilePart')))),
  Message: oneOf(
    obj({ role: literal('system'), content: str }, withProvider),
    obj({ role: literal('user'), content: ref('MessageContent') }, withProvider),
    obj(
      {
        role: literal('assistant'),
        content: anyOf(
          str,
          arrayOf(
            oneOf(
              ref('TextPart'),
              ref('FilePart'),
              ref('ReasoningPart'),
              ref('ReasoningFilePart'),
              ref('CustomPart'),
              ref('ToolCallPart'),
              ref('ToolResultPart'),
              ref('ToolApprovalRequestPart'),
            ),
          ),
        ),
      },
      withProvider,
    ),
    obj(
      { role: literal('tool'), content: arrayOf(oneOf(ref('ToolResultPart'), ref('ToolApprovalResponsePart'))) },
      withProvider,
    ),
  ),

  // ---- 会话 ----
  MessageEntry: obj({ ...entryBase, type: literal('message'), message: ref('Message') }, entryOptional),
  EventEntry: obj({ ...entryBase, type: literal('event'), kind: str }, { ...entryOptional, text: str, data: any }),
  SummaryEntry: obj({ ...entryBase, type: literal('summary'), text: str, covers: int }, entryOptional),
  Entry: oneOf(ref('MessageEntry'), ref('EventEntry'), ref('SummaryEntry')),
  NewEntry: oneOf(
    obj({ type: literal('message'), message: ref('Message') }, { ...entryDraft }),
    obj({ type: literal('event'), kind: str }, { ...entryDraft, text: str, data: any }),
    obj({ type: literal('summary'), text: str, covers: int }, { ...entryDraft }),
  ),

  // ---- 工具 ----
  ToolCall: obj({ id: str, name: str, input: any }),
  ToolContentPart: oneOf(
    obj({ type: literal('text'), text: str }),
    obj({ type: literal('file'), mediaType: str, data: ref('ToolFileData') }, { filename: str }),
  ),
  ToolOutput: oneOf(
    obj({ type: literal('text'), text: str }),
    obj({ type: literal('json'), value: any }),
    obj({ type: literal('content'), parts: arrayOf(ref('ToolContentPart')) }),
    obj({ type: literal('error'), message: str }, { retryable: bool, data: any }),
  ),
  ToolDefinition: obj(
    { name: str, inputSchema: { type: 'object' }, executor: str },
    { description: str, source: str, tags: arrayOf(str) },
  ),
  ToolSelection: anyOf(bool, arrayOf(str), obj({}, { names: arrayOf(str), tags: arrayOf(str), sources: arrayOf(str) })),

  // ---- Harness ----
  Usage: obj({}, Object.fromEntries(usage.map((key) => [key, num]))),
  StopReason: {
    enum: ['end_turn', 'max_steps', 'max_tokens', 'max_budget', 'requires_action', 'aborted', 'error'],
  },
  CallSettings: obj(
    {},
    {
      temperature: num,
      maxOutputTokens: int,
      topP: num,
      topK: num,
      presencePenalty: num,
      frequencyPenalty: num,
      seed: int,
      stopSequences: arrayOf(str),
      maxRetries: int,
      timeoutMs: num,
      headers: recordOf(str),
      providerOptions,
    },
  ),
  WindowOptions: obj({}, { maxMessages: int, maxTokens: num, truncate: bool }),
  ContextSpec: obj(
    {},
    {
      facts: anyOf(
        bool,
        obj({}, { sources: arrayOf(str), placement: { enum: ['instructions', 'prompt'] }, heading: str }),
      ),
      projection: str,
      overflow: obj(
        { maxTokens: num },
        {
          strategy: { enum: ['compact', 'trim', 'error'] },
          compact: obj(
            {},
            { keep: int, minimum: int, instructions: str, maxInputTokens: num, maxOutputTokens: int, timeoutMs: num },
          ),
        },
      ),
      inherit: obj({ session: str }, { upTo: int }),
    },
  ),
  AgentSpec: obj(
    { model: { type: 'string', description: '模型名：跨边界时只能是名字' } },
    {
      name: str,
      instructions: str,
      tools: ref('ToolSelection'),
      maxSteps: int,
      window: ref('WindowOptions'),
      context: ref('ContextSpec'),
      settings: ref('CallSettings'),
      version: str,
      output: obj({ schema: { type: 'object' } }, { name: str, description: str }),
      toolChoice: anyOf({ enum: ['auto', 'none', 'required'] }, obj({ tool: str })),
      permissions: obj({}, { default: ref('ToolPermission'), tools: recordOf(ref('ToolPermission')) }),
      budget: obj({}, { maxTotalTokens: num, maxDurationMs: num }),
      environment: ref('EnvironmentSpec'),
    },
  ),
  EnvironmentSpec: obj(
    {},
    {
      name: str,
      image: str,
      packages: recordOf(arrayOf(str)),
      network: obj({}, { allow: arrayOf(str) }),
      env: arrayOf(str),
      meta: { type: 'object' },
    },
  ),
  ToolPermission: { enum: ['allow', 'ask', 'deny'] },
  RunParent: obj({ session: str, runId: str }, { toolCallId: str }),
  RunRequest: obj(
    { session: str, agent: ref('AgentSpec') },
    {
      input: ref('MessageContent'),
      inputKey: str,
      prompt: ref('MessageContent'),
      record: bool,
      runId: str,
      owner: str,
      parent: ref('RunParent'),
      aborted: { type: 'boolean', description: '线上才有：发出时调用方已经取消了' },
    },
    '`POST /runs`、`POST /orchestrator/runs` 的请求体：`RunRequest` 去掉 `signal`',
  ),
  RunResultSummary: obj(
    { runId: str, text: str, stopReason: ref('StopReason') },
    {
      usage: ref('Usage'),
      output: any,
      pending: arrayOf(ref('ToolCall')),
      approvals: arrayOf(ref('ToolApproval')),
      error: ref('ErrorInfo'),
    },
    '`RunResult` 去掉 `messages`、`recorded`：`run.ended` 事件和编排器的结果',
  ),
  RunResult: obj(
    {
      runId: str,
      text: str,
      messages: arrayOf(ref('Message')),
      recorded: arrayOf(ref('Entry')),
      stopReason: ref('StopReason'),
    },
    {
      usage: ref('Usage'),
      output: any,
      pending: arrayOf(ref('ToolCall')),
      approvals: arrayOf(ref('ToolApproval')),
      error: ref('ErrorInfo'),
    },
  ),
  ToolApproval: obj({ approvalId: str, callId: str }, { reason: str }, '等确认的一次工具调用（`RunResult.approvals`）'),
  ApprovalDecision: obj({ approved: bool }, { reason: str }),
  PendingApproval: obj({ approvalId: str }, { reason: str, decision: ref('ApprovalDecision') }),
  ClaimedToolCall: obj(
    { session: str, runId: str, seq: int, call: ref('ToolCall') },
    { approval: ref('PendingApproval'), executor: str },
    '`POST /work/:executor/claim` 领到的一次调用：等着的调用（`PendingToolCall`）加上它所在的会话',
  ),
  RunEvent: oneOf(
    obj({ type: literal('run.started'), runId: str, session: str }, { seq: int }),
    obj({ type: literal('model.started'), runId: str, step: int }),
    obj({ type: literal('text.delta'), runId: str, text: str }),
    obj({ type: literal('reasoning.delta'), runId: str, text: str }),
    obj({ type: literal('tool.called'), runId: str, call: ref('ToolCall') }),
    obj({ type: literal('tool.returned'), runId: str, callId: str, output: ref('ToolOutput') }),
    obj({ type: literal('model.ended'), runId: str, step: int }, { usage: ref('Usage'), seq: int }),
    obj({ type: literal('run.ended'), runId: str, result: ref('RunResultSummary') }, { seq: int }),
    obj({ type: literal('error'), runId: str, message: str }),
  ),
  StepMeta: obj(
    { runId: str, step: int },
    {
      provider: str,
      modelId: str,
      finishReason: str,
      usage: ref('Usage'),
      estimatedInputTokens: num,
      calibration: num,
    },
  ),
  ChildRunResult: obj(
    { child: obj({ session: str, runId: str }), stopReason: ref('StopReason') },
    { text: str, output: any, usage: ref('Usage'), error: obj({ message: str }, { type: str }) },
  ),

  // ---- 编排 ----
  RunStatus: { enum: ['queued', 'running', 'completed', 'failed', 'cancelled'] },
  OrchestratorEvent: obj({
    type: { enum: ['run.queued', 'run.running', 'run.completed', 'run.failed', 'run.cancelled'] },
    runId: str,
    session: str,
  }),
  RecoveredRun: obj({ session: str, runId: str }, { resumed: str }),

  // ---- 记忆 ----
  SourceRef: obj({ session: str, from: int, upTo: int }),
  Note: obj({ id: str, ...note }, { ...noteOptional, attempts: int, error: str, failedAt: num }),
  NewNote: obj(note, noteOptional),
  MemoryFact: obj(
    { id: str, ...fact, recalls: arrayOf(num) },
    { ...factOptional, validTo: num, supersededBy: str, archivedAt: num },
  ),
  NewMemoryFact: obj(fact, factOptional),
  FactHit: obj({ fact: ref('MemoryFact'), score: num }),
  SearchQuery: obj({ text: str }, { topic: str, k: int, open: bool, archived: bool }),
  Procedure: obj({ id: str, ...procedure, confirmations: int }, { topic: str, retiredAt: num }),
  NewProcedure: obj(procedure, { topic: str }),
  CoreVersion: obj({ text: str, at: num }),

  // ---- 发现 ----
  ProtocolInfo: obj(
    {
      protocol: str,
      entryVersion: int,
      components: obj(
        {},
        {
          sessions: obj({ watch: bool }),
          executors: obj({ names: arrayOf(str) }),
          harness: obj({ stream: bool }),
          orchestrator: obj({ recover: bool, events: bool }),
          memory: obj({}),
        },
      ),
    },
    {},
    '`GET /protocol` 的响应',
  ),
};

export const PROTOCOL_SCHEMA_ID: string = `https://modelctx.ai/schema/protocol/${PROTOCOL_VERSION}`;

export const PROTOCOL_SCHEMA: JsonObject = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: PROTOCOL_SCHEMA_ID,
  title: `ctx protocol ${PROTOCOL_VERSION}`,
  description: '线上 JSON 形状。名字和 @modelctx-ai/ctx-protocol 的类型名一样；只描述过线的形状。',
  $defs: defs,
};

/**
 * 把 `$ref: '#/$defs/X'` 就地换成那个定义对象，得到一个能直接交给 `checkJsonSchema` 的 schema（它不解析 `$ref`）。
 * 递归的形状变成环，按值的深度走，不会转圈。给测试和别的只认内联 schema 的校验器用。
 */
export function resolveSchemaRefs(schema: JsonObject, name: string): JsonObject {
  const source = (schema['$defs'] ?? {}) as Record<string, JsonValue>;
  const resolved = new Map<string, JsonObject>();
  const resolve = (value: JsonValue): JsonValue => {
    if (Array.isArray(value)) return value.map(resolve);
    if (typeof value !== 'object' || value === null) return value;
    const target = value['$ref'];
    if (typeof target === 'string' && target.startsWith('#/$defs/')) return definition(target.slice('#/$defs/'.length));
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolve(item)]));
  };
  const definition = (key: string): JsonObject => {
    const known = resolved.get(key);
    if (known) return known;
    const shell: JsonObject = {};
    resolved.set(key, shell);
    const found = source[key];
    if (found === undefined) throw new Error(`Unknown schema definition "${key}".`);
    Object.assign(shell, resolve(found));
    return shell;
  };
  return definition(name);
}
