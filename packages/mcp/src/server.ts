// 另一半：把 ctx 的执行环境包成 MCP 服务器，给自带循环的程序（Claude Code、pi 这类进程级的 harness）用（#23）。
// 不依赖 MCP 的 SDK：JSON-RPC 只有 initialize、ping、tools/list、tools/call 和取消，传输是 stdio（一行一条）和
// Streamable HTTP（只回 JSON，不开 SSE 流）。
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createInterface } from 'node:readline';

import {
  checkJsonSchema,
  DEFAULT_MAX_TOOL_OUTPUT_CHARS,
  errorOutput,
  executorMap,
  limitToolOutput,
  silentLogger,
  toolPermission,
  type Awaitable,
  type ExecutionContext,
  type Executor,
  type Executors,
  type ExecutorSessionOptions,
  type JsonObject,
  type JsonValue,
  type Logger,
  type ToolCall,
  type ToolDefinition,
  type ToolOutput,
  type ToolPermissions,
} from '@modelctx-ai/ctx-protocol';

/** 认得的 MCP 协议版本，新的在前。客户端要的版本在里面就用它，不在就回第一个。 */
export const MCP_PROTOCOL_VERSIONS: readonly string[] = ['2025-06-18', '2025-03-26', '2024-11-05'];

/** 一次调用交给执行环境时的会话和运行；`signal` 由服务器给。 */
export type McpCallContext = Omit<ExecutionContext, 'signal'>;

export interface McpServerOptions {
  /** 工具按定义的 `executor` 找执行环境。 */
  readonly executors: Executors;
  /** 交出去的工具；不给就是各个执行环境 `tools()` 报的全部。同名的只留第一个。 */
  readonly tools?: readonly ToolDefinition[];
  /** 调用记在哪个会话、哪一轮（`ExecutionContext`）。函数时每次调用取一次。 */
  readonly context: McpCallContext | (() => McpCallContext);
  /** `initialize` 回的 `serverInfo`，缺省 `ctx`、`0.0.0`。 */
  readonly name?: string;
  readonly version?: string;
  /** `initialize` 回的 `instructions`。 */
  readonly instructions?: string;
  /** 执行前按 `inputSchema` 查输入（`checkJsonSchema`），缺省查：调用方不经过 harness。 */
  readonly validateInput?: boolean;
  /**
   * 一次结果最多多少字符，超过的截断并注明（`limitToolOutput`），缺省 `DEFAULT_MAX_TOOL_OUTPUT_CHARS`；0 或 Infinity 不限。
   * 和输入检查一样是 harness 那一层的兜底：调用方不经过 harness。`onResult` 收到的是截过的。
   */
  readonly maxOutputChars?: number;
  /**
   * 第一次把调用交给某个执行环境之前，用调用的会话（`context` 的 `session`）`open` 它，带着这里的选项（ADR 0009）；
   * 每个执行环境每个会话只开一次，打不开时它的调用都回错误，模型看得到原因。不给就不 `open`。
   */
  readonly open?: ExecutorSessionOptions;
  /** `deny` 的调用不执行，回拒绝（`toolPermission`，只看 `deny`）。 */
  readonly permissions?: ToolPermissions;
  /** 每次调用结束以后调，适配器用它把经 ctx 执行的调用记进日志。抛错只记告警，不影响结果。 */
  readonly onResult?: (call: ToolCall, output: ToolOutput, context: McpCallContext) => Awaitable<void>;
  readonly logger?: Logger;
}

export interface McpServer {
  /**
   * 处理一条 JSON-RPC 消息：请求返回响应，通知和客户端的响应返回 `undefined`。不抛：解析不了、方法不认识都是 JSON-RPC 错误。
   * `signal` 中止时正在跑的调用跟着中止（HTTP 断开）。
   */
  handle(message: unknown, options?: { readonly signal?: AbortSignal }): Promise<JsonObject | undefined>;
  /** 中止所有正在跑的调用。 */
  close(): void;
}

type RequestId = string | number;

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function rpcError(id: RequestId | null, code: number, message: string): JsonObject {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

/** 内联文件的 MCP 写法：图片、音频是它们自己的块，别的是嵌入的资源。 */
function fileBlock(
  part: Extract<Extract<ToolOutput, { type: 'content' }>['parts'][number], { type: 'file' }>,
  index: number,
): JsonObject {
  const { data, mediaType } = part;
  const name = part.filename ?? `file-${index + 1}`;
  switch (data.type) {
    case 'data':
      if (mediaType.startsWith('image/') || mediaType === 'image') {
        return { type: 'image', data: data.data, mimeType: mediaType === 'image' ? 'image/png' : mediaType };
      }
      if (mediaType.startsWith('audio/')) return { type: 'audio', data: data.data, mimeType: mediaType };
      return {
        type: 'resource',
        resource: { uri: `ctx-file:///${encodeURIComponent(name)}`, mimeType: mediaType, blob: data.data },
      };
    case 'url':
      return { type: 'resource_link', uri: data.url, name, mimeType: mediaType };
    case 'text':
      return {
        type: 'resource',
        resource: { uri: `ctx-file:///${encodeURIComponent(name)}`, mimeType: mediaType, text: data.text },
      };
    default:
      return { type: 'text', text: `[${mediaType} file held by the provider: ${JSON.stringify(data.reference)}]` };
  }
}

/**
 * 协议的结果转成 MCP 的 `CallToolResult`：文字是一段 `text`；`json` 是它的 JSON 文字，值是对象时另放进 `structuredContent`；
 * 内联文件按类型换成 `image`、`audio`、嵌入的资源或资源链接；错误是 `isError: true`，`data` 跟在信息后面。
 */
export function toolOutputToMcp(output: ToolOutput): JsonObject {
  switch (output.type) {
    case 'text':
      return { content: [{ type: 'text', text: output.text }] };
    case 'json':
      return {
        content: [{ type: 'text', text: JSON.stringify(output.value) }],
        ...(isObject(output.value) ? { structuredContent: output.value } : {}),
      };
    case 'content':
      return {
        content: output.parts.map((part, index) =>
          part.type === 'text' ? { type: 'text', text: part.text } : fileBlock(part, index),
        ),
      };
    default: {
      const details = [
        ...(output.retryable === undefined ? [] : [`retryable: ${output.retryable}`]),
        ...(output.data === undefined ? [] : [JSON.stringify(output.data)]),
      ];
      return {
        isError: true,
        content: [{ type: 'text', text: [output.message, ...details].join('\n') }],
      };
    }
  }
}

/**
 * 把执行环境包成 MCP 服务器。工具定义原样交出（名字、说明、`inputSchema`），调用经 `execute` 交给绑定的执行环境，
 * `ExecutionContext` 来自 `context`。执行环境返回的 `{ type: 'error' }` 是 `isError` 的结果，不是 JSON-RPC 错误：
 * 模型要看得到。用 `serveMcpStdio` 或 `createMcpHttpHandler` 接上传输。
 */
export function createMcpServer(options: McpServerOptions): McpServer {
  const executors = executorMap(options.executors);
  const logger = options.logger ?? silentLogger;
  const validate = options.validateInput !== false;
  const maxOutputChars = options.maxOutputChars ?? DEFAULT_MAX_TOOL_OUTPUT_CHARS;
  const running = new Map<RequestId, AbortController>();
  /** 会话、执行环境 → 那一次 `open`。 */
  const opened = new Map<string, Promise<void>>();

  /** 交给 `executor` 之前先 `open` 会话：打开了返回 `undefined`，打不开返回给模型看的错误。 */
  async function prepare(executor: Executor, session: string, tool: string): Promise<ToolOutput | undefined> {
    if (!options.open || !executor.open) return undefined;
    const key = `${session}\u0000${executor.name}`;
    try {
      let opening = opened.get(key);
      if (!opening) {
        opening = executor.open(session, options.open);
        opened.set(key, opening);
      }
      await opening;
      return undefined;
    } catch (error) {
      return errorOutput(
        `Executor "${executor.name}" could not prepare session "${session}" for tool "${tool}": ${messageOf(error)}`,
      );
    }
  }

  async function definitions(): Promise<ToolDefinition[]> {
    const listed =
      options.tools ??
      (await Promise.all([...executors.values()].map(async (executor) => (await executor.tools?.()) ?? []))).flat();
    const seen = new Set<string>();
    const out: ToolDefinition[] = [];
    for (const definition of listed) {
      if (seen.has(definition.name)) continue;
      seen.add(definition.name);
      out.push(definition);
    }
    return out;
  }

  function contextOf(): McpCallContext {
    return typeof options.context === 'function' ? options.context() : options.context;
  }

  /** 交给执行环境执行；HTTP 断开、客户端取消、服务器关掉时中止。结果按 `maxOutputChars` 截断。 */
  async function execute(
    id: RequestId,
    executor: Executor,
    toolCall: ToolCall,
    context: McpCallContext,
    signal: AbortSignal | undefined,
  ): Promise<ToolOutput> {
    const controller = new AbortController();
    const abort = (): void => controller.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    running.set(id, controller);
    try {
      return limitToolOutput(
        await executor.execute(toolCall, { ...context, signal: controller.signal }),
        maxOutputChars,
      );
    } catch (error) {
      return errorOutput(`Executor "${executor.name}" failed: ${messageOf(error)}`);
    } finally {
      running.delete(id);
      signal?.removeEventListener('abort', abort);
    }
  }

  async function call(
    id: RequestId,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
  ): Promise<JsonObject> {
    const name = params['name'];
    if (typeof name !== 'string') return rpcError(id, INVALID_PARAMS, 'tools/call needs params.name');
    const definition = (await definitions()).find((item) => item.name === name);
    if (!definition) return rpcError(id, INVALID_PARAMS, `Unknown tool: ${name}`);
    const input = (params['arguments'] ?? {}) as JsonValue;
    const toolCall: ToolCall = { id: `mcp-${String(id)}`, name, input };
    const context = contextOf();
    let output: ToolOutput;
    const problems = validate ? checkJsonSchema(definition.inputSchema, input) : [];
    const executor = executors.get(definition.executor);
    if (options.permissions && toolPermission(options.permissions, name) === 'deny') {
      output = errorOutput(`Tool call "${name}" was denied by the agent's permissions.`);
    } else if (problems.length > 0) {
      output = errorOutput(`Invalid input for tool ${name}: ${problems.join('; ')}`);
    } else if (!executor) {
      output = errorOutput(
        `Tool ${name} is bound to executor "${definition.executor}", which this server does not have.`,
      );
    } else {
      output =
        (await prepare(executor, context.session, name)) ?? (await execute(id, executor, toolCall, context, signal));
    }
    try {
      await options.onResult?.(toolCall, output, context);
    } catch (error) {
      logger.warn('mcp server onResult threw', { tool: name, error: messageOf(error) });
    }
    return { jsonrpc: '2.0', id, result: toolOutputToMcp(output) };
  }

  async function request(
    id: RequestId,
    method: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
  ): Promise<JsonObject> {
    switch (method) {
      case 'initialize': {
        const asked = params['protocolVersion'];
        const protocolVersion =
          typeof asked === 'string' && MCP_PROTOCOL_VERSIONS.includes(asked) ? asked : MCP_PROTOCOL_VERSIONS[0]!;
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: options.name ?? 'ctx', version: options.version ?? '0.0.0' },
            ...(options.instructions ? { instructions: options.instructions } : {}),
          },
        };
      }
      case 'ping':
        return { jsonrpc: '2.0', id, result: {} };
      case 'tools/list': {
        const tools = (await definitions()).map((definition) => ({
          name: definition.name,
          ...(definition.description !== undefined ? { description: definition.description } : {}),
          inputSchema: definition.inputSchema,
        }));
        return { jsonrpc: '2.0', id, result: { tools } };
      }
      case 'tools/call':
        return call(id, params, signal);
      default:
        return rpcError(id, METHOD_NOT_FOUND, `Method not found: ${method}`);
    }
  }

  return {
    async handle(message, handleOptions = {}) {
      if (!isObject(message) || message['jsonrpc'] !== '2.0') {
        return rpcError(null, INVALID_REQUEST, 'Expected one JSON-RPC 2.0 message (batches are not supported).');
      }
      const { id, method } = message;
      const params = isObject(message['params']) ? message['params'] : {};
      if (typeof method !== 'string') return undefined; // 客户端回的响应：这个服务器不发请求，忽略。
      if (id === undefined) {
        if (method === 'notifications/cancelled') {
          const target = params['requestId'];
          if (typeof target === 'string' || typeof target === 'number')
            running.get(target)?.abort(new Error('Cancelled by the client.'));
        }
        return undefined;
      }
      if (typeof id !== 'string' && typeof id !== 'number')
        return rpcError(null, INVALID_REQUEST, 'id must be a string or number');
      try {
        return await request(id, method, params, handleOptions.signal);
      } catch (error) {
        logger.warn('mcp server request failed', { method, error: messageOf(error) });
        return rpcError(id, -32603, `Internal error: ${messageOf(error)}`);
      }
    },
    close() {
      for (const controller of running.values()) controller.abort(new Error('MCP server closed.'));
      running.clear();
    },
  };
}

export interface McpStdioOptions {
  /** 缺省 `process.stdin`、`process.stdout`。日志不能写 stdout。 */
  readonly input?: NodeJS.ReadableStream;
  readonly output?: NodeJS.WritableStream;
}

/** 走 stdio：一行一条 JSON-RPC 消息。输入结束时 resolve，正在跑的调用随之中止。 */
export async function serveMcpStdio(server: McpServer, options: McpStdioOptions = {}): Promise<void> {
  const output = options.output ?? process.stdout;
  const lines = createInterface({ input: options.input ?? process.stdin, crlfDelay: Infinity });
  const pending = new Set<Promise<void>>();
  const send = (message: JsonObject | undefined): void => {
    if (message) output.write(`${JSON.stringify(message)}\n`);
  };
  for await (const line of lines) {
    if (!line.trim()) continue;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      send(rpcError(null, PARSE_ERROR, 'Parse error'));
      continue;
    }
    // 不排队：一次慢的调用不挡 ping 和取消。
    const task = server.handle(message).then(send);
    pending.add(task);
    void task.finally(() => pending.delete(task));
  }
  server.close();
  await Promise.allSettled(pending);
}

export interface McpHttpOptions {
  /** 只认这个路径，缺省 `/mcp`。 */
  readonly path?: string;
  /** 要求 `Authorization: Bearer <accessToken>`。 */
  readonly accessToken?: string;
  /** 带 `Origin` 的请求只放行这些来源，缺省一个都不放（挡 DNS rebinding）。 */
  readonly allowedOrigins?: readonly string[];
  /** 请求体上限，缺省 4 MiB。 */
  readonly maxBodyBytes?: number;
}

function reply(res: ServerResponse, status: number, body?: JsonObject): void {
  if (body === undefined) {
    res.writeHead(status).end();
    return;
  }
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) }).end(text);
}

async function readBody(req: IncomingMessage, limit: number): Promise<string | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) return undefined;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function bearerMatches(req: IncomingMessage, token: string): boolean {
  const given = Buffer.from(/^bearer\s+(.+)$/i.exec(req.headers.authorization ?? '')?.[1] ?? '');
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * 走 Streamable HTTP：`POST <path>` 一条消息，请求回 `application/json`，通知回 202；`GET`（服务器发起的流）和 `DELETE`
 * 回 405：这个服务器没有要主动发的消息，也不建会话。客户端断开时那次调用中止。
 */
export function createMcpHttpHandler(
  server: McpServer,
  options: McpHttpOptions = {},
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const path = options.path ?? '/mcp';
  const origins = new Set((options.allowedOrigins ?? []).map((origin) => origin.toLowerCase()));
  const limit = options.maxBodyBytes ?? 4 * 1024 * 1024;
  if (options.accessToken !== undefined && !options.accessToken.trim()) {
    throw new Error('`accessToken` is empty. Leave it out to run without authentication, or pass a real token.');
  }
  return async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://mcp.local');
    if (url.pathname !== path) return reply(res, 404, rpcError(null, INVALID_REQUEST, `not found: ${url.pathname}`));
    const origin = req.headers.origin;
    if (origin !== undefined && !origins.has(origin.toLowerCase())) {
      return reply(res, 403, rpcError(null, INVALID_REQUEST, 'origin not allowed'));
    }
    if (options.accessToken && !bearerMatches(req, options.accessToken)) {
      return reply(res, 401, rpcError(null, INVALID_REQUEST, 'unauthorized: send Authorization: Bearer <token>'));
    }
    if (req.method !== 'POST') {
      res.setHeader('allow', 'POST');
      return reply(res, 405, rpcError(null, INVALID_REQUEST, `use POST ${path}`));
    }
    const text = await readBody(req, limit);
    if (text === undefined) return reply(res, 413, rpcError(null, INVALID_REQUEST, 'request body too large'));
    let message: unknown;
    try {
      message = JSON.parse(text);
    } catch {
      return reply(res, 400, rpcError(null, PARSE_ERROR, 'Parse error'));
    }
    const controller = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) controller.abort(new Error('Client disconnected.'));
    });
    const response = await server.handle(message, { signal: controller.signal });
    if (res.destroyed) return;
    reply(res, response === undefined ? 202 : 200, response);
  };
}

/** `listenMcpHttp` 起的本机服务器。 */
export interface McpHttpListener {
  /** `http://127.0.0.1:<端口><path>`。 */
  readonly url: string;
  /** 请求要带的令牌（`Authorization: Bearer <token>`），每次 `listenMcpHttp` 新生成。 */
  readonly token: string;
  /** 带着令牌的请求进来过没有：程序连上了没有。 */
  contacted(): boolean;
  /** 中止正在跑的调用（`server.close()`），断开连接，不再监听。 */
  close(): Promise<void>;
}

/**
 * 在本机（`127.0.0.1`）的空闲端口上听 Streamable HTTP（`createMcpHttpHandler`），带一次性的令牌：给自己起的子进程
 * （Claude Code、pi）连，用完就关。别的选项同 `createMcpHttpHandler`。
 */
export async function listenMcpHttp(
  server: McpServer,
  options: Omit<McpHttpOptions, 'accessToken'> = {},
): Promise<McpHttpListener> {
  const path = options.path ?? '/mcp';
  const token = randomBytes(24).toString('base64url');
  const handler = createMcpHttpHandler(server, { ...options, path, accessToken: token });
  let contacted = false;
  const http = createServer((req, res) => {
    if (bearerMatches(req, token)) contacted = true;
    void handler(req, res);
  });
  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(0, '127.0.0.1', () => resolve());
  });
  const { port } = http.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}${path}`,
    token,
    contacted: () => contacted,
    async close() {
      server.close();
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}

/** Claude Code、pi 给 MCP 服务器的工具起的名字：`mcp__<server>__<tool>`。 */
export function mcpToolName(server: string, tool: string): string {
  return `mcp__${server}__${tool}`;
}
