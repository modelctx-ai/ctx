// 另一半：把 ctx 的执行环境包成 MCP 服务器，给自带循环的程序（Claude Code、pi 这类进程级的 harness）用（#23）。
// 不依赖 MCP 的 SDK：JSON-RPC 只有 initialize、ping、tools/list、tools/call 和取消，传输是 stdio（一行一条）和
// Streamable HTTP（只回 JSON，不开 SSE 流）。
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createInterface } from 'node:readline';
import { timingSafeEqual } from 'node:crypto';

import {
  checkJsonSchema,
  errorOutput,
  silentLogger,
  type Awaitable,
  type ExecutionContext,
  type Executor,
  type JsonObject,
  type JsonValue,
  type Logger,
  type ToolCall,
  type ToolDefinition,
  type ToolOutput,
} from '@modelctx-ai/ctx-protocol';

/** 认得的 MCP 协议版本，新的在前。客户端要的版本在里面就用它，不在就回第一个。 */
export const MCP_PROTOCOL_VERSIONS: readonly string[] = ['2025-06-18', '2025-03-26', '2024-11-05'];

/** 一次调用交给执行环境时的会话和运行；`signal` 由服务器给。 */
export type McpCallContext = Omit<ExecutionContext, 'signal'>;

export interface McpServerOptions {
  /** 工具按定义的 `executor` 找执行环境。 */
  readonly executors: readonly Executor[] | Readonly<Record<string, Executor>>;
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

function executorTable(executors: McpServerOptions['executors']): Map<string, Executor> {
  if (Array.isArray(executors)) return new Map((executors as readonly Executor[]).map((item) => [item.name, item]));
  return new Map(Object.entries(executors as Readonly<Record<string, Executor>>));
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
  const executors = executorTable(options.executors);
  const logger = options.logger ?? silentLogger;
  const validate = options.validateInput !== false;
  const running = new Map<RequestId, AbortController>();

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
    if (problems.length > 0) {
      output = errorOutput(`Invalid input for tool ${name}: ${problems.join('; ')}`);
    } else if (!executor) {
      output = errorOutput(
        `Tool ${name} is bound to executor "${definition.executor}", which this server does not have.`,
      );
    } else {
      const controller = new AbortController();
      const abort = (): void => controller.abort(signal?.reason);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      running.set(id, controller);
      try {
        output = await executor.execute(toolCall, { ...context, signal: controller.signal });
      } catch (error) {
        output = errorOutput(`Executor "${executor.name}" failed: ${messageOf(error)}`);
      } finally {
        running.delete(id);
        signal?.removeEventListener('abort', abort);
      }
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
