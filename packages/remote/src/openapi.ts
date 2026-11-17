import { PROTOCOL_SCHEMA, PROTOCOL_VERSION, type JsonObject, type JsonValue } from '@modelctx-ai/ctx-protocol';

/**
 * `ctx-remote` 线上形态的 OpenAPI 3.1 文档：每条路径一项，请求体和响应引用 `PROTOCOL_SCHEMA` 的形状
 * （`components.schemas`，名字和 TypeScript 的类型名一样）。服务端在 `GET /protocol/openapi` 给出，仓库根的
 * `schema/openapi.json` 是它的副本；测试逐项请求服务端，保证这里列出的路径服务端都认。
 */

type Schema = JsonObject;

const ref = (name: string): Schema => ({ $ref: `#/components/schemas/${name}` });
const str: Schema = { type: 'string' };
const int: Schema = { type: 'integer' };
const bool: Schema = { type: 'boolean' };
const arrayOf = (items: Schema): Schema => ({ type: 'array', items });
const shape = (required: Record<string, Schema>, optional: Record<string, Schema> = {}): Schema => ({
  type: 'object',
  properties: { ...required, ...optional },
  ...(Object.keys(required).length > 0 ? { required: Object.keys(required) } : {}),
});

interface Operation {
  readonly method: 'get' | 'post' | 'put' | 'delete';
  readonly path: string;
  readonly tag: string;
  readonly summary: string;
  readonly query?: readonly string[];
  readonly body?: Schema;
  /** JSON 响应；`stream` 时是 NDJSON，每行一个这个形状。 */
  readonly response: Schema;
  readonly stream?: boolean;
  /** `POST /runs?stream=1`：同一条路径，带查询参数时换成 NDJSON。 */
  readonly streamWhen?: { readonly query: string; readonly item: Schema };
}

const ids = shape({ ids: arrayOf(str) });
const count = (name: string): Schema => shape({ [name]: int });
const empty = shape({});

const OPERATIONS: readonly Operation[] = [
  {
    method: 'get',
    path: '/protocol',
    tag: '发现',
    summary: '协议版本、条目格式、挂了哪些组件',
    response: ref('ProtocolInfo'),
  },
  {
    method: 'get',
    path: '/protocol/schema',
    tag: '发现',
    summary: '线上形状的 JSON Schema',
    response: { type: 'object' },
  },
  { method: 'get', path: '/protocol/openapi', tag: '发现', summary: '这份 OpenAPI 文档', response: { type: 'object' } },

  {
    method: 'get',
    path: '/sessions',
    tag: '会话',
    summary: 'sessions：会话名，升序',
    query: ['prefix', 'after', 'limit'],
    response: shape({ sessions: arrayOf(str) }),
  },
  { method: 'delete', path: '/sessions/{session}', tag: '会话', summary: 'clear', response: count('deleted') },
  {
    method: 'get',
    path: '/sessions/{session}/entries',
    tag: '会话',
    summary: 'list：一次最多一页，more 时用最后一条的 seq 当 after 接着读',
    query: ['after', 'last', 'limit', 'types', 'kinds', 'atAfter'],
    response: shape({ entries: arrayOf(ref('Entry')) }, { more: bool }),
  },
  {
    method: 'post',
    path: '/sessions/{session}/entries',
    tag: '会话',
    summary: 'append：expectSeq 对不上是 409 conflict',
    body: shape({ entries: arrayOf(ref('NewEntry')) }, { expectSeq: int }),
    response: shape({ entries: arrayOf(ref('Entry')) }),
  },
  {
    method: 'get',
    path: '/sessions/{session}/entries/stream',
    tag: '会话',
    summary: 'watch',
    query: ['after'],
    response: ref('Entry'),
    stream: true,
  },
  {
    method: 'post',
    path: '/sessions/{session}/entries/truncate',
    tag: '会话',
    summary: 'truncate',
    body: shape({ upTo: int }),
    response: count('deleted'),
  },
  {
    method: 'post',
    path: '/sessions/{session}/entries/remove',
    tag: '会话',
    summary: 'remove',
    body: ids,
    response: count('removed'),
  },
  {
    method: 'post',
    path: '/sessions/{session}/entries/redact',
    tag: '会话',
    summary: 'redact',
    body: ids,
    response: count('redacted'),
  },

  {
    method: 'get',
    path: '/executors',
    tag: '执行环境',
    summary: '执行环境的名字',
    response: shape({ executors: arrayOf(str) }),
  },
  {
    method: 'get',
    path: '/executors/{name}/tools',
    tag: '执行环境',
    summary: 'tools',
    response: shape({ tools: arrayOf(ref('ToolDefinition')) }),
  },
  {
    method: 'post',
    path: '/executors/{name}/sessions/{session}/open',
    tag: '执行环境',
    summary: 'open：为一个会话准备好，可以重复调',
    body: shape({}, { environment: ref('EnvironmentSpec') }),
    response: empty,
  },
  {
    method: 'delete',
    path: '/executors/{name}/sessions/{session}',
    tag: '执行环境',
    summary: 'close',
    response: empty,
  },
  {
    method: 'post',
    path: '/executors/{name}/execute',
    tag: '执行环境',
    summary: 'execute：断开即中止；等结果时先发 200 和心跳换行',
    body: shape({ call: ref('ToolCall'), context: shape({ session: str }, { runId: str }) }),
    response: shape({ output: ref('ToolOutput') }),
  },

  {
    method: 'post',
    path: '/runs',
    tag: 'Harness',
    summary: 'run；带 stream=1 时是 stream（NDJSON RunEvent，断开即中止）',
    query: ['stream'],
    body: ref('RunRequest'),
    response: ref('RunResult'),
    streamWhen: { query: 'stream', item: ref('RunEvent') },
  },
  {
    method: 'delete',
    path: '/runs/{runId}',
    tag: 'Harness',
    summary: '取消（signal）',
    response: shape({ cancelled: bool }),
  },

  {
    method: 'post',
    path: '/orchestrator/runs',
    tag: '编排',
    summary: 'submit',
    body: ref('RunRequest'),
    response: shape({ runId: str, session: str }),
  },
  {
    method: 'get',
    path: '/orchestrator/runs/{runId}',
    tag: '编排',
    summary: 'status / done：wait 是长轮询的毫秒数；给了 session 时结果可以从会话日志还原',
    query: ['wait', 'session'],
    response: shape(
      { runId: str, status: ref('RunStatus') },
      { session: str, result: ref('RunResult'), error: ref('ErrorInfo') },
    ),
  },
  {
    method: 'delete',
    path: '/orchestrator/runs/{runId}',
    tag: '编排',
    summary: 'cancel',
    response: shape({ cancelled: bool }),
  },
  {
    method: 'post',
    path: '/orchestrator/recover',
    tag: '编排',
    summary: 'recover',
    response: shape({ recovered: arrayOf(ref('RecoveredRun')) }),
  },
  {
    method: 'get',
    path: '/orchestrator/events',
    tag: '编排',
    summary: 'events',
    response: ref('OrchestratorEvent'),
    stream: true,
  },

  {
    method: 'post',
    path: '/memory/notes',
    tag: '记忆',
    summary: 'notes.add',
    query: ['scope'],
    body: shape({ notes: arrayOf(ref('NewNote')) }),
    response: shape({ notes: arrayOf(ref('Note')) }),
  },
  {
    method: 'get',
    path: '/memory/notes',
    tag: '记忆',
    summary: 'notes.list',
    query: ['scope', 'session', 'pending', 'failed', 'since', 'limit'],
    response: shape({ notes: arrayOf(ref('Note')) }),
  },
  {
    method: 'post',
    path: '/memory/notes/settle',
    tag: '记忆',
    summary: 'notes.settle',
    query: ['scope'],
    body: shape({ ids: arrayOf(str), at: { type: 'number' } }),
    response: count('settled'),
  },
  {
    method: 'post',
    path: '/memory/notes/fail',
    tag: '记忆',
    summary: 'notes.fail',
    query: ['scope'],
    body: shape({ ids: arrayOf(str), at: { type: 'number' }, error: str }, { maxAttempts: int }),
    response: shape({ notes: arrayOf(ref('Note')) }),
  },
  {
    method: 'post',
    path: '/memory/notes/retry',
    tag: '记忆',
    summary: 'notes.retry',
    query: ['scope'],
    body: ids,
    response: count('retried'),
  },
  {
    method: 'post',
    path: '/memory/notes/forget',
    tag: '记忆',
    summary: 'notes.forget',
    query: ['scope'],
    body: shape({}, { session: str }),
    response: count('forgotten'),
  },
  {
    method: 'get',
    path: '/memory/notes/head',
    tag: '记忆',
    summary: 'notes.head',
    query: ['scope', 'session'],
    response: count('head'),
  },
  {
    method: 'post',
    path: '/memory/facts',
    tag: '记忆',
    summary: 'facts.add',
    query: ['scope'],
    body: shape({ fact: ref('NewMemoryFact') }),
    response: shape({ fact: ref('MemoryFact') }),
  },
  {
    method: 'get',
    path: '/memory/facts',
    tag: '记忆',
    summary: 'facts.list',
    query: ['scope', 'subject', 'topic', 'open', 'after', 'limit'],
    response: shape({ facts: arrayOf(ref('MemoryFact')) }),
  },
  {
    method: 'post',
    path: '/memory/facts/search',
    tag: '记忆',
    summary: 'facts.search',
    query: ['scope'],
    body: ref('SearchQuery'),
    response: shape({ hits: arrayOf(ref('FactHit')) }),
  },
  {
    method: 'post',
    path: '/memory/facts/touch',
    tag: '记忆',
    summary: 'facts.touch',
    query: ['scope'],
    body: shape({ ids: arrayOf(str), at: { type: 'number' } }),
    response: empty,
  },
  {
    method: 'post',
    path: '/memory/facts/archive',
    tag: '记忆',
    summary: 'facts.archive',
    query: ['scope'],
    body: shape({ ids: arrayOf(str), at: { type: 'number' } }),
    response: count('archived'),
  },
  {
    method: 'post',
    path: '/memory/facts/restore',
    tag: '记忆',
    summary: 'facts.restore',
    query: ['scope'],
    body: ids,
    response: count('restored'),
  },
  {
    method: 'post',
    path: '/memory/facts/reopen',
    tag: '记忆',
    summary: 'facts.reopen',
    query: ['scope'],
    body: ids,
    response: count('reopened'),
  },
  {
    method: 'post',
    path: '/memory/facts/forget',
    tag: '记忆',
    summary: 'facts.forget',
    query: ['scope'],
    body: ids,
    response: count('forgotten'),
  },
  {
    method: 'post',
    path: '/memory/facts/{id}/supersede',
    tag: '记忆',
    summary: 'facts.supersede',
    query: ['scope'],
    body: shape({ fact: ref('NewMemoryFact'), at: { type: 'number' } }),
    response: shape({ fact: ref('MemoryFact') }),
  },
  {
    method: 'post',
    path: '/memory/facts/{id}/close',
    tag: '记忆',
    summary: 'facts.close',
    query: ['scope'],
    body: shape({ at: { type: 'number' } }, { supersededBy: str }),
    response: empty,
  },
  {
    method: 'post',
    path: '/memory/facts/{id}/cite',
    tag: '记忆',
    summary: 'facts.cite',
    query: ['scope'],
    body: shape({ sources: arrayOf(ref('SourceRef')) }),
    response: shape({ fact: ref('MemoryFact') }),
  },
  {
    method: 'post',
    path: '/memory/procedures',
    tag: '记忆',
    summary: 'procedures.add',
    query: ['scope'],
    body: shape({ procedure: ref('NewProcedure') }),
    response: shape({ procedure: ref('Procedure') }),
  },
  {
    method: 'get',
    path: '/memory/procedures',
    tag: '记忆',
    summary: 'procedures.list',
    query: ['scope', 'topic', 'active'],
    response: shape({ procedures: arrayOf(ref('Procedure')) }),
  },
  {
    method: 'post',
    path: '/memory/procedures/forget',
    tag: '记忆',
    summary: 'procedures.forget',
    query: ['scope'],
    body: ids,
    response: count('forgotten'),
  },
  {
    method: 'post',
    path: '/memory/procedures/{id}/confirm',
    tag: '记忆',
    summary: 'procedures.confirm',
    query: ['scope'],
    body: shape({ evidence: arrayOf(ref('SourceRef')) }),
    response: shape({ procedure: ref('Procedure') }),
  },
  {
    method: 'post',
    path: '/memory/procedures/{id}/retire',
    tag: '记忆',
    summary: 'procedures.retire',
    query: ['scope'],
    body: shape({ at: { type: 'number' } }),
    response: empty,
  },
  {
    method: 'get',
    path: '/memory/core',
    tag: '记忆',
    summary: 'core.get',
    query: ['scope'],
    response: shape({ core: { anyOf: [ref('CoreVersion'), { type: 'null' }] } }),
  },
  {
    method: 'put',
    path: '/memory/core',
    tag: '记忆',
    summary: 'core.set',
    query: ['scope'],
    body: shape({ text: str, at: { type: 'number' } }),
    response: empty,
  },
  {
    method: 'delete',
    path: '/memory/core',
    tag: '记忆',
    summary: 'core.clear',
    query: ['scope'],
    response: count('cleared'),
  },
  {
    method: 'get',
    path: '/memory/core/history',
    tag: '记忆',
    summary: 'core.history',
    query: ['scope', 'last'],
    response: shape({ versions: arrayOf(ref('CoreVersion')) }),
  },
];

/** 线上的每一条路径和方法：给测试逐项请求服务端用。 */
export function openApiOperations(): readonly { readonly method: string; readonly path: string }[] {
  return OPERATIONS.map(({ method, path }) => ({ method, path }));
}

function json(schema: Schema): JsonObject {
  return { 'application/json': { schema } };
}

function ndjson(item: Schema): JsonObject {
  return {
    'application/x-ndjson': { schema: item, description: '每行一个值；空行是心跳；出错时最后一行是 { error }' },
  };
}

function operation(op: Operation): JsonObject {
  const params = [...op.path.matchAll(/\{(\w+)\}/g)].map((match) => ({
    name: match[1]!,
    in: 'path',
    required: true,
    schema: str,
  }));
  const query = (op.query ?? []).map((name) => ({ name, in: 'query', required: false, schema: str }));
  const content = op.stream
    ? ndjson(op.response)
    : op.streamWhen
      ? { ...json(op.response), ...ndjson(op.streamWhen.item) }
      : json(op.response);
  return {
    tags: [op.tag],
    summary: op.summary,
    ...(params.length + query.length > 0 ? { parameters: [...params, ...query] } : {}),
    ...(op.body ? { requestBody: { required: true, content: json(op.body) } } : {}),
    responses: {
      '200': { description: 'OK', content },
      default: { $ref: '#/components/responses/Error' },
    },
  };
}

/** `$ref: '#/$defs/X'` 换成 OpenAPI 的 `#/components/schemas/X`。 */
function toComponents(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(toComponents);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      key === '$ref' && typeof item === 'string'
        ? item.replace('#/$defs/', '#/components/schemas/')
        : toComponents(item),
    ]),
  );
}

export function openApiDocument(): JsonObject {
  const paths: Record<string, Record<string, JsonValue>> = {};
  for (const op of OPERATIONS) (paths[op.path] ??= {})[op.method] = operation(op);
  return {
    openapi: '3.1.0',
    info: {
      title: 'ctx remote',
      version: PROTOCOL_VERSION,
      description:
        '`ctx-remote` 的 HTTP 线上形态。鉴权是 `Authorization: Bearer <token>`；客户端第一次请求前读 `GET /protocol`，版本不同就失败。路径可以整体挂在一个前缀下。',
    },
    security: [{ bearer: [] }],
    paths,
    components: {
      schemas: toComponents(PROTOCOL_SCHEMA['$defs'] ?? {}),
      securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } },
      responses: {
        Error: {
          description: '错误正文：`{ error: ErrorInfo }`',
          content: json({ type: 'object', properties: { error: ref('ErrorInfo') }, required: ['error'] }),
        },
      },
    },
  };
}
