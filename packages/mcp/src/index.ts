import { createMCPClient, type MCPTransport } from '@ai-sdk/mcp';
import { Experimental_StdioMCPTransport } from '@ai-sdk/mcp/mcp-stdio';
import {
  errorOutput,
  silentLogger,
  type ExecutionContext,
  type Executor,
  type JsonObject,
  type JsonValue,
  type Logger,
  type ToolCall,
  type ToolContentPart,
  type ToolDefinition,
  type ToolOutput,
  type ToolRegistry,
} from '@modelctx-ai/ctx-protocol';

/** 本机进程，走 stdin/stdout。 */
export interface StdioServerConfig {
  readonly command: string;
  readonly args?: readonly string[];
  /** 额外的环境变量。PATH、HOME 这类基础变量会自动带上。 */
  readonly env?: Readonly<Record<string, string>>;
  readonly cwd?: string;
}

/** 远程服务器，缺省走 Streamable HTTP，`type: 'sse'` 走旧的 SSE。 */
export interface RemoteServerConfig {
  readonly url: string;
  readonly type?: 'http' | 'sse';
  readonly headers?: Readonly<Record<string, string>>;
}

interface ServerOptions {
  /** 缺省启用。 */
  readonly enabled?: boolean;
  /** 只要这些工具（服务器原名）。 */
  readonly include?: readonly string[];
  /** 不要这些工具（服务器原名）。 */
  readonly exclude?: readonly string[];
  /** 连接加列工具最多等多久，缺省用 hub 的 `timeoutMs`。 */
  readonly timeoutMs?: number;
  /** 这台服务器的工具一次调用最多等多久，缺省用 hub 的 `callTimeoutMs`。 */
  readonly callTimeoutMs?: number;
}

/** 和常见的 `mcpServers` 配置同一种写法：有 `command` 是本机进程，有 `url` 是远程。 */
export type McpServerConfig = (StdioServerConfig | RemoteServerConfig) & ServerOptions;
export type McpServers = Readonly<Record<string, McpServerConfig>>;

/** `@ai-sdk/mcp` 给出的工具里用到的部分：输入结构是 `jsonSchema(...)` 包过的 JSON Schema。 */
export interface McpTool {
  readonly description?: unknown;
  readonly inputSchema?: unknown;
  /** `(input, { toolCallId, messages, context, abortSignal }) => result`。 */
  readonly execute?: unknown;
}

type McpExecute = (
  input: unknown,
  options: { toolCallId: string; messages: never[]; context: object; abortSignal?: AbortSignal },
) => unknown;

export type McpToolSet = Readonly<Record<string, McpTool>>;

export interface McpConnection {
  tools(): Promise<McpToolSet>;
  close(): Promise<void>;
}

export interface McpConnectOptions {
  /** 超时或 hub 关闭时中止连接。 */
  readonly signal?: AbortSignal;
  /**
   * 连接自己断了（服务器进程退出、传输关闭、会话过期）时调，`reason` 是给人看的原因。
   * 调用方自己 `close()` 引起的关闭报不报都行，hub 只认还在用的连接。
   */
  readonly onClose?: (reason?: string) => void;
  /** 服务器发来 `notifications/tools/list_changed` 时调，hub 会重新 `tools()`。 */
  readonly onToolsChanged?: () => void;
}

export type McpConnector = (
  name: string,
  config: McpServerConfig,
  options?: McpConnectOptions,
) => Promise<McpConnection>;

export type McpServerStatus =
  | {
      readonly name: string;
      readonly state: 'connected';
      readonly tools: readonly string[];
      /** 改名后和前面的工具重名、没有收进来的工具（服务器原名）。 */
      readonly skipped?: readonly string[];
      /** 最近一次刷新工具列表失败的原因；这时 `tools` 还是上一次成功列到的。下次刷新成功就没有了。 */
      readonly refreshError?: string;
    }
  | { readonly name: string; readonly state: 'failed'; readonly error: string }
  | { readonly name: string; readonly state: 'disabled' };

export interface McpHubOptions {
  /** 作为执行环境的名字，工具定义的 `executor` 指向它。缺省 `mcp`；一个应用开几个 hub 时各起一个名字。 */
  readonly name?: string;
  readonly connector?: McpConnector;
  /** 工具名前面加服务器名，缺省 `<server>__<tool>`；`false` 保留原名。 */
  readonly namespace?: false | ((server: string, tool: string) => string);
  readonly logger?: Logger;
  /** 连接时报给服务器的客户端名字。 */
  readonly clientName?: string;
  /** 每台服务器连接加列工具最多等多久，缺省 15 秒；0 或 Infinity 不限时。超时记为失败，不耽误别的服务器。 */
  readonly timeoutMs?: number;
  /**
   * 一次工具调用最多等多久，缺省 60 秒；0 或 Infinity 不限时。到点返回 `{ type: 'error' }`，
   * 并经 `abortSignal` 取消底层请求。服务器配置里的 `callTimeoutMs` 优先。
   */
  readonly callTimeoutMs?: number;
  /** 工具说明最多多少个字符，缺省 2000；0 或 Infinity 不限。超过的截断，末尾注明。 */
  readonly maxDescriptionChars?: number;
  /** 一次结果里的文字最多多少个字符，缺省 100000；0 或 Infinity 不限。见 `McpOutputLimits`。 */
  readonly maxOutputChars?: number;
  /** 一次结果里的图片、音频合计最多多少字节，缺省 5 MiB；0 或 Infinity 不限。见 `McpOutputLimits`。 */
  readonly maxFileBytes?: number;
}

/** 工具结果的上限。哪一项没给（或是 0、Infinity）哪一项就不限。 */
export interface McpOutputLimits {
  /**
   * 一次结果里的文字最多多少个字符（UTF-16 码元）。超过的截断，并注明省略了多少；
   * `content` 里几段文字合起来算，`json` 结果序列化后超了就换成截断的文字，错误信息同样处理。
   */
  readonly maxOutputChars?: number;
  /** 一次结果里的图片、音频（base64 解码后）合计最多多少字节。放不下的那个换成一段说明文字。 */
  readonly maxFileBytes?: number;
}

/**
 * 一组 MCP 服务器，本身是一个执行环境（`Executor`）：`tools()` 报全部工具的定义，`execute` 调对应服务器的工具。
 */
export interface McpHub extends Executor {
  /** 连上所有启用的服务器。单个失败或超时只记在状态里，不抛出。断开的服务器在这里重连。 */
  connect(): Promise<McpServerStatus[]>;
  /**
   * 重新列一台（不给名字就是全部）已连上的服务器的工具，返回全部状态。没连上的不动，要重连用 `connect()`。
   * 列不出来时不抛、不断开，保留原来的工具，原因记在状态的 `refreshError` 里。
   */
  refresh(name?: string): Promise<McpServerStatus[]>;
  /** 按配置顺序。 */
  status(): McpServerStatus[];
  /** 已连上的服务器提供的全部工具的定义（已加前缀、已按 include/exclude 过滤，重名的只留第一个），绑定到这个 hub。 */
  tools(): Promise<ToolDefinition[]>;
  /** 同样这些工具，`@ai-sdk/mcp` 给出的原样：说明不截断，直接调它们也不受 hub 的时限和结果上限约束。 */
  toolSet(): McpToolSet;
  /** 调对应服务器的工具。不认识的工具、`signal` 中止、超时、服务器断开或报错都返回 `{ type: 'error' }`。 */
  execute(call: ToolCall, context: ExecutionContext): Promise<ToolOutput>;
  /**
   * 把工具定义写进工具目录，来源记为 `mcp:<server>`，执行环境是这个 hub，先删掉之前写进去的。
   * 目录里已有别的来源的同名工具时不替换，跳过并告警。返回实际写入的条数。
   * 之后工具有变化（重连、断开、刷新）时，写过的目录跟着重写。
   */
  registerInto(registry: ToolRegistry): number;
  /** 同 `connect`，不返回状态。 */
  provision(): Promise<void>;
  /** 同 `close`。 */
  dispose(): Promise<void>;
  /** 断开全部连接，清空状态，并从写过的目录里删掉这些工具。 */
  close(): Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_CALL_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_DESCRIPTION_CHARS = 2_000;
const DEFAULT_MAX_OUTPUT_CHARS = 100_000;
const DEFAULT_MAX_FILE_BYTES = 5 * 1024 * 1024;

const TOOLS_CHANGED = 'notifications/tools/list_changed';
/** `@ai-sdk/mcp` 的 SSE 传输在流意外结束时报的错（`MCP SSE Transport Error: Connection closed unexpectedly`）。 */
const SSE_STREAM_CLOSED = /SSE Transport Error: Connection closed unexpectedly/;

interface Offered {
  readonly definition: ToolDefinition;
  /** 哪台服务器的。 */
  readonly server: string;
  /** 服务器上的原名。 */
  readonly original: string;
  readonly tool: McpTool;
}

export function isStdioConfig(config: McpServerConfig): config is StdioServerConfig & ServerOptions {
  return 'command' in config && typeof config.command === 'string';
}

/**
 * 在传输上接两个钩子：关闭时报 `onClose`，收到工具列表变更的通知时报 `onToolsChanged`。
 * `@ai-sdk/mcp` 的客户端不报连接关闭，也不认服务器发来的通知，所以接在它装好的处理函数外面；
 * 别的消息照旧交给客户端。
 */
function watch(transport: MCPTransport, reason: string, options: McpConnectOptions): void {
  const { onclose, onmessage } = transport;
  const hooks: Pick<MCPTransport, 'onclose' | 'onmessage'> = {
    onclose: () => {
      onclose?.();
      options.onClose?.(reason);
    },
    onmessage: (message) => {
      if ('method' in message && !('id' in message) && message.method === TOOLS_CHANGED) {
        options.onToolsChanged?.();
        return;
      }
      onmessage?.(message);
    },
  };
  // 传输只有 `onclose`、`onmessage` 这两个槽，没有 `addEventListener`，只能整个换掉。
  Object.assign(transport, hooks);
}

/**
 * `@ai-sdk/mcp` 不导出远程传输的类，也不给客户端留收通知的口子，只能从客户端上取它建好的那个传输（私有字段）。
 * 取不到（它改了内部结构）就不接钩子：收不到 `list_changed`，别的照常，这时用 `refresh()`。
 */
function transportOf(client: object): MCPTransport | undefined {
  const transport = (client as { transport?: Partial<MCPTransport> | null }).transport;
  if (!transport || typeof transport.onmessage !== 'function' || typeof transport.onclose !== 'function') {
    return undefined;
  }
  return transport as MCPTransport;
}

export function connectorFor(clientName = 'ctx'): McpConnector {
  return async (_name, config, options = {}) => {
    const shared = {
      name: clientName,
      ...(options.signal ? { initializationOptions: { signal: options.signal } } : {}),
    };
    if (isStdioConfig(config)) {
      const transport = new Experimental_StdioMCPTransport({
        command: config.command,
        args: [...(config.args ?? [])],
        ...(config.env ? { env: { ...config.env } } : {}),
        ...(config.cwd ? { cwd: config.cwd } : {}),
      });
      const client = await createMCPClient({ transport, ...shared });
      // 进程退出时传输会关闭。
      watch(transport, 'server process exited', options);
      return { tools: async () => await client.tools(), close: () => client.close() };
    }
    const client = await createMCPClient({
      transport: {
        type: config.type ?? 'http',
        url: config.url,
        ...(config.headers ? { headers: { ...config.headers } } : {}),
        // Streamable HTTP 的会话没了（服务器重启之类）：这条连接要重新初始化才能用，按断开报。
        onSessionExpired: () => options.onClose?.('session expired'),
      },
      // SSE 的流断了，传输不报关闭，只报这个错，之后的请求都是 Not connected。别的错不代表连接没了。
      onUncaughtError: (error) => {
        if (config.type === 'sse' && SSE_STREAM_CLOSED.test(messageOf(error))) options.onClose?.('SSE stream closed');
      },
      ...shared,
    });
    const transport = transportOf(client);
    if (transport) watch(transport, 'connection closed', options);
    return { tools: async () => await client.tools(), close: () => client.close() };
  };
}

/** 工具名只能是 `[a-zA-Z0-9_-]`、最长 64，服务器名和工具名里别的字符换成 `_`。 */
export function namespaced(server: string, tool: string): string {
  return `${server}__${tool}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 上限和时限的同一种写法：没给、0、负数、Infinity 都是不限，返回 `undefined`。 */
function limitOf(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** 最多等 `limit` 毫秒，`undefined` 一直等。到点只是不等了，`work` 本身不会被取消。 */
async function within<T>(work: Promise<T>, limit: number | undefined): Promise<T> {
  if (limit === undefined) return await work;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${limit}ms`)), limit);
  });
  try {
    return await Promise.race([work, late]);
  } finally {
    clearTimeout(timer);
  }
}

/** 留下前 `limit` 个字符（UTF-16 码元），不把一对代理项切成两半。 */
function clip(text: string, limit: number): string {
  let end = Math.min(Math.max(Math.floor(limit), 0), text.length);
  const last = text.charCodeAt(end - 1);
  if (end < text.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
  return text.slice(0, end);
}

const OUTPUT_HINT = 'narrow the request (filters, paging, a smaller range) to see the rest';

function truncatedNote(dropped: number): string {
  return `[… truncated ${dropped} more characters; ${OUTPUT_HINT}]`;
}

/** 文字超过上限就截断，另起一行注明省略了多少。 */
function bounded(text: string, limit: number | undefined): string {
  if (limit === undefined || text.length <= limit) return text;
  const kept = clip(text, limit);
  return `${kept}\n${truncatedNote(text.length - kept.length)}`;
}

/** 工具说明超过上限就截断，末尾注明。 */
function describe(text: string, limit: number | undefined): string {
  if (limit === undefined || text.length <= limit) return text;
  const kept = clip(text, limit);
  return `${kept}… [description truncated, ${text.length - kept.length} more characters]`;
}

/** 工具的输入结构：`jsonSchema(...)` 包过的取出里面的 JSON Schema，取不到就是任意对象。 */
async function schemaOf(tool: McpTool): Promise<JsonObject> {
  const wrapped = (tool.inputSchema as { jsonSchema?: unknown } | undefined)?.jsonSchema;
  const schema: unknown = await wrapped;
  if (schema && typeof schema === 'object' && !Array.isArray(schema)) {
    return JSON.parse(JSON.stringify(schema)) as JsonObject;
  }
  return { type: 'object' };
}

type McpPart = {
  readonly type?: unknown;
  readonly text?: unknown;
  readonly data?: unknown;
  readonly mimeType?: unknown;
};

function partOf(part: McpPart): ToolContentPart {
  if (part.type === 'text' && typeof part.text === 'string') return { type: 'text', text: part.text };
  if ((part.type === 'image' || part.type === 'audio') && typeof part.data === 'string') {
    const mediaType = typeof part.mimeType === 'string' ? part.mimeType : 'application/octet-stream';
    return { type: 'file', mediaType, data: { type: 'data', data: part.data } };
  }
  return { type: 'text', text: JSON.stringify(part) };
}

/** base64 解码后大约多少字节。 */
function base64Bytes(data: string): number {
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((data.length * 3) / 4) - padding);
}

/**
 * 按上限收下 `content` 的各段：文字合起来最多 `maxChars`，超的那一段截断并注明一共省略多少，后面的文字不要了；
 * 文件合起来最多 `maxBytes`，放不下的那个换成一段说明（文件没法只留一半）。
 */
function fit(
  parts: readonly ToolContentPart[],
  maxChars: number | undefined,
  maxBytes: number | undefined,
): ToolContentPart[] {
  let total = 0;
  for (const part of parts) if (part.type === 'text') total += part.text.length;
  let chars = maxChars ?? Infinity;
  let bytes = maxBytes ?? Infinity;
  let kept = 0;
  let truncated = false;
  const out: ToolContentPart[] = [];
  for (const part of parts) {
    if (part.type === 'text') {
      if (truncated) continue;
      if (part.text.length <= chars) {
        chars -= part.text.length;
        kept += part.text.length;
        out.push(part);
        continue;
      }
      const head = clip(part.text, chars);
      const note = truncatedNote(total - kept - head.length);
      out.push({ type: 'text', text: head ? `${head}\n${note}` : note });
      truncated = true;
      continue;
    }
    const size = part.data.type === 'data' ? base64Bytes(part.data.data) : 0;
    if (size <= bytes) {
      bytes -= size;
      out.push(part);
      continue;
    }
    out.push({
      type: 'text',
      text: `[${part.mediaType} file omitted: its ${size} bytes do not fit in the ${maxBytes ?? 0}-byte limit for files in one tool result]`,
    });
  }
  return out;
}

/**
 * MCP 的 `CallToolResult` 转成协议的结果：全是文字时合成一段，`isError` 变成错误。
 * 不给 `limits` 时原样转，不截断；给了就按 `McpOutputLimits` 收。
 */
export function toolOutputFromMcp(result: unknown, limits: McpOutputLimits = {}): ToolOutput {
  const maxChars = limitOf(limits.maxOutputChars);
  if (typeof result === 'string') return { type: 'text', text: bounded(result, maxChars) };
  const content = (result as { content?: unknown } | null | undefined)?.content;
  if (!Array.isArray(content)) {
    const json = JSON.stringify(result ?? null);
    if (maxChars !== undefined && json.length > maxChars) return { type: 'text', text: bounded(json, maxChars) };
    return { type: 'json', value: JSON.parse(json) as JsonValue };
  }
  const parts = (content as McpPart[]).map(partOf);
  if ((result as { isError?: unknown }).isError === true) {
    const message = parts.map((part) => (part.type === 'text' ? part.text : `[${part.mediaType}]`)).join('\n');
    return errorOutput(bounded(message, maxChars) || 'MCP tool reported an error.');
  }
  if (parts.every((part) => part.type === 'text')) {
    const text = parts.map((part) => (part.type === 'text' ? part.text : '')).join('\n');
    return { type: 'text', text: bounded(text, maxChars) };
  }
  return { type: 'content', parts: fit(parts, maxChars, limitOf(limits.maxFileBytes)) };
}

/** 一台服务器同一时间只有一次刷新在跑；跑的时候又有人要刷新，跑完再来一次。 */
interface Refresh {
  done: Promise<void>;
  again: boolean;
}

const STOPPED = Symbol('stopped');

export function createMcpHub(servers: McpServers, options: McpHubOptions = {}): McpHub {
  const hubName = options.name ?? 'mcp';
  const connector = options.connector ?? connectorFor(options.clientName);
  const logger = options.logger ?? silentLogger;
  const rename =
    options.namespace === false ? (_server: string, tool: string) => tool : (options.namespace ?? namespaced);
  const maxDescriptionChars = limitOf(options.maxDescriptionChars ?? DEFAULT_MAX_DESCRIPTION_CHARS);
  const limits: McpOutputLimits = {
    maxOutputChars: options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS,
    maxFileBytes: options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
  };
  const names = Object.keys(servers);
  const connections = new Map<string, McpConnection>();
  /** 每台服务器过滤、改名后的工具，按服务器给的顺序。 */
  const offered = new Map<string, readonly Offered[]>();
  /** 每台服务器最后收下的工具：改名后的名字 → 工具和定义。 */
  const toolsByServer = new Map<string, Map<string, Offered>>();
  const statuses = new Map<string, McpServerStatus>();
  /** 每台服务器同一时间只有一次连接在进行。 */
  const pending = new Map<string, Promise<void>>();
  const attempts = new Set<AbortController>();
  const refreshes = new Map<string, Refresh>();
  /** 连着的服务器最近一次刷新失败的原因。 */
  const refreshErrors = new Map<string, string>();
  /** 断开的服务器原来提供的工具：改名后的名字 → 哪台服务器、为什么断的。重连上或 hub 关闭时清掉。 */
  const lost = new Map<string, { readonly server: string; readonly reason: string }>();
  const registries = new Set<ToolRegistry>();
  const closed = new Error('MCP hub closed');

  async function closeQuietly(name: string, connection: McpConnection): Promise<void> {
    try {
      await connection.close();
    } catch (error) {
      logger.warn(`MCP server "${name}" failed to close`, { error: messageOf(error) });
    }
  }

  function connectLimit(config: McpServerConfig): number | undefined {
    return limitOf(config.timeoutMs ?? options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  }

  /** 改名后重名的工具按配置顺序留第一个，后面的记进 skipped。 */
  function resolveNames(): void {
    const taken = new Set<string>();
    toolsByServer.clear();
    for (const name of names) {
      const list = offered.get(name);
      if (!list) continue;
      const kept = new Map<string, Offered>();
      const skipped: string[] = [];
      for (const item of list) {
        if (taken.has(item.definition.name)) {
          skipped.push(item.original);
          continue;
        }
        taken.add(item.definition.name);
        kept.set(item.definition.name, item);
      }
      const refreshError = refreshErrors.get(name);
      toolsByServer.set(name, kept);
      statuses.set(name, {
        name,
        state: 'connected',
        tools: [...kept.keys()],
        ...(skipped.length > 0 ? { skipped } : {}),
        ...(refreshError !== undefined ? { refreshError } : {}),
      });
    }
  }

  /** 把现在的工具写进一个目录：先删掉这个 hub 之前写的，再按配置顺序重新写。 */
  function write(registry: ToolRegistry): number {
    for (const name of names) registry.removeSource(`mcp:${name}`);
    let count = 0;
    for (const [server, tools] of toolsByServer) {
      for (const [name, item] of tools) {
        if (registry.has(name)) {
          const owner = registry.get(name)?.source;
          logger.warn(`MCP tool "${name}" from server "${server}" skipped: name already registered`, { owner });
          continue;
        }
        try {
          registry.add(item.definition);
          count += 1;
        } catch (error) {
          logger.warn(`MCP tool "${name}" from server "${server}" skipped`, { error: messageOf(error) });
        }
      }
    }
    return count;
  }

  /** 工具变了（连上、断开、刷新）：重新排重名，写过的目录跟着重写。 */
  function changed(): void {
    resolveNames();
    for (const registry of registries) write(registry);
  }

  /** 服务器给的工具按 include/exclude 过滤、改名、截说明，变成这个 hub 的定义。 */
  async function definitionsOf(name: string, config: McpServerConfig, all: McpToolSet): Promise<Offered[]> {
    const list: Offered[] = [];
    for (const [tool, value] of Object.entries(all)) {
      if (config.include && !config.include.includes(tool)) continue;
      if (config.exclude?.includes(tool)) continue;
      const definition: ToolDefinition = {
        name: rename(name, tool),
        ...(typeof value.description === 'string'
          ? { description: describe(value.description, maxDescriptionChars) }
          : {}),
        inputSchema: await schemaOf(value),
        executor: hubName,
        source: `mcp:${name}`,
      };
      list.push({ definition, server: name, original: tool, tool: value });
    }
    return list;
  }

  /** 用着的连接自己断了：摘掉它和它的工具，状态记为失败，下次 `connect()` 重连。 */
  function disconnected(name: string, connection: McpConnection, reason: string): void {
    connections.delete(name);
    for (const tool of toolsByServer.get(name)?.keys() ?? []) lost.set(tool, { server: name, reason });
    offered.delete(name);
    refreshErrors.delete(name);
    changed();
    statuses.set(name, { name, state: 'failed', error: `disconnected: ${reason}` });
    logger.warn(`MCP server "${name}" disconnected`, { error: reason });
    // 传输已经关了，这里只是让连接把剩下的东西放掉。
    void closeQuietly(name, connection);
  }

  /** 重新列一遍这台服务器的工具。列不出来就留着原来的，原因记进状态。 */
  async function relist(name: string): Promise<void> {
    const connection = connections.get(name);
    const config = servers[name];
    if (!connection || !config) return;
    // 列的中途断开、关闭或重连了：结果不要，也不记错。
    const current = () => connections.get(name) === connection;
    try {
      const list = await definitionsOf(name, config, await within(connection.tools(), connectLimit(config)));
      if (!current()) return;
      offered.set(name, list);
      refreshErrors.delete(name);
    } catch (error) {
      if (!current()) return;
      const message = messageOf(error);
      refreshErrors.set(name, message);
      logger.warn(`MCP server "${name}" failed to refresh tools`, { error: message });
    }
    changed();
  }

  function refreshOne(name: string): Promise<void> {
    const running = refreshes.get(name);
    if (running) {
      // 正在列的那一次可能是变化之前答的，跑完再列一次；等的人拿到的是最后一次的结果。
      running.again = true;
      return running.done;
    }
    if (!connections.has(name)) return Promise.resolve();
    const state: Refresh = { done: Promise.resolve(), again: false };
    // 先登记再开始列，列的过程里来的刷新都并到这一次上。
    refreshes.set(name, state);
    state.done = (async () => {
      try {
        do {
          state.again = false;
          await relist(name);
        } while (state.again);
      } finally {
        refreshes.delete(name);
      }
    })();
    return state.done;
  }

  async function attempt(name: string, config: McpServerConfig): Promise<void> {
    const limit = connectLimit(config);
    const controller = new AbortController();
    attempts.add(controller);
    const timer =
      limit === undefined
        ? undefined
        : setTimeout(() => controller.abort(new Error(`timed out after ${limit}ms`)), limit);
    const stopped = new Promise<never>((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
    });
    let connection: McpConnection | undefined;
    /** 还没收下这条连接的时候，服务器就说工具变了。 */
    let stale = false;
    const work = (async () => {
      const opened = await connector(name, config, {
        signal: controller.signal,
        onClose: (reason = 'connection closed') => {
          if (connection !== undefined && connections.get(name) === connection) {
            disconnected(name, connection, reason);
          } else if (attempts.has(controller)) {
            // 还在连接、列工具的时候就断了：这次连接算失败。
            controller.abort(new Error(reason));
          }
        },
        onToolsChanged: () => {
          if (connection !== undefined && connections.get(name) === connection) void refreshOne(name);
          else stale = true;
        },
      });
      // 超时或关闭之后才连上：马上关掉，不留下进程。
      if (controller.signal.aborted) {
        await closeQuietly(name, opened);
        throw controller.signal.reason;
      }
      connection = opened;
      return [opened, await opened.tools()] as const;
    })();
    try {
      const [opened, all] = await Promise.race([work, stopped]);
      const list = await definitionsOf(name, config, all);
      // 列工具、取 schema 期间被关掉、超时或断开：不收。
      if (controller.signal.aborted) throw controller.signal.reason;
      connections.set(name, opened);
      offered.set(name, list);
      for (const [tool, gone] of lost) if (gone.server === name) lost.delete(tool);
      changed();
      if (stale) void refreshOne(name);
    } catch (error) {
      // 连上以后任何一步出错（列工具失败、超时）都要把连接关掉。
      if (connection) await closeQuietly(name, connection);
      if (error === closed) return;
      const message = messageOf(error);
      statuses.set(name, { name, state: 'failed', error: message });
      logger.warn(`MCP server "${name}" failed to connect`, { error: message });
    } finally {
      clearTimeout(timer);
      attempts.delete(controller);
    }
  }

  function connectOne(name: string, config: McpServerConfig): Promise<void> {
    if (config.enabled === false) {
      statuses.set(name, { name, state: 'disabled' });
      return Promise.resolve();
    }
    if (connections.has(name)) return Promise.resolve();
    let running = pending.get(name);
    if (!running) {
      running = attempt(name, config).finally(() => pending.delete(name));
      pending.set(name, running);
    }
    return running;
  }

  function status(): McpServerStatus[] {
    return names.flatMap((name) => statuses.get(name) ?? []);
  }

  function find(name: string): Offered | undefined {
    for (const tools of toolsByServer.values()) {
      const found = tools.get(name);
      if (found) return found;
    }
    return undefined;
  }

  function offeredTools(): Offered[] {
    return [...toolsByServer.values()].flatMap((tools) => [...tools.values()]);
  }

  async function connect(): Promise<McpServerStatus[]> {
    await Promise.all(Object.entries(servers).map(([name, config]) => connectOne(name, config)));
    return status();
  }

  async function refresh(name?: string): Promise<McpServerStatus[]> {
    await Promise.all((name === undefined ? names : [name]).map((server) => refreshOne(server)));
    return status();
  }

  async function close(): Promise<void> {
    for (const controller of attempts) controller.abort(closed);
    await Promise.all(pending.values());
    const open = [...connections.entries()];
    connections.clear();
    offered.clear();
    toolsByServer.clear();
    statuses.clear();
    refreshErrors.clear();
    lost.clear();
    for (const registry of registries) {
      for (const name of names) registry.removeSource(`mcp:${name}`);
    }
    registries.clear();
    await Promise.all(open.map(([name, connection]) => closeQuietly(name, connection)));
  }

  return {
    name: hubName,
    connect,
    refresh,
    status,
    async tools() {
      return offeredTools().map((item) => item.definition);
    },
    toolSet() {
      return Object.fromEntries(offeredTools().map((item) => [item.definition.name, item.tool]));
    },
    async execute(call, context) {
      if (context.signal?.aborted) return errorOutput(`Aborted before MCP tool "${call.name}" ran.`);
      const found = find(call.name);
      if (!found) {
        const gone = lost.get(call.name);
        if (gone) {
          return errorOutput(
            `MCP server "${gone.server}" is disconnected (${gone.reason}), so tool "${call.name}" is unavailable until it reconnects.`,
          );
        }
        const available = offeredTools()
          .map((item) => item.definition.name)
          .join(', ');
        return errorOutput(`Unknown MCP tool "${call.name}". Available tools: ${available || '(none)'}.`);
      }
      const run = found.tool.execute as McpExecute | undefined;
      if (typeof run !== 'function') return errorOutput(`MCP tool "${call.name}" cannot be executed.`);
      const { server } = found;
      const connection = connections.get(server);
      const limit = limitOf(servers[server]?.callTimeoutMs ?? options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS);
      // 到点或调用方中止都经这个 signal 传给底层请求；同时自己不再等，工具不理会 signal 也不会挂住。
      const timeout = new AbortController();
      const signal = context.signal ? AbortSignal.any([context.signal, timeout.signal]) : timeout.signal;
      const stopped = new Promise<typeof STOPPED>((resolve) => {
        signal.addEventListener('abort', () => resolve(STOPPED), { once: true });
      });
      const timer = limit === undefined ? undefined : setTimeout(() => timeout.abort(), limit);
      const interrupted = (): ToolOutput =>
        timeout.signal.aborted
          ? errorOutput(
              `MCP tool "${call.name}" (tool "${found.original}" on server "${server}") timed out after ${limit}ms. ` +
                'The request was cancelled on this side; the server may still be running it.',
            )
          : errorOutput(`Aborted while MCP tool "${call.name}" was running.`);
      try {
        const work = (async () =>
          await run(call.input, { toolCallId: call.id, messages: [], context: {}, abortSignal: signal }))();
        const output = await Promise.race([work, stopped]);
        if (output === STOPPED) return interrupted();
        return toolOutputFromMcp(output, limits);
      } catch (error) {
        if (signal.aborted) return interrupted();
        const message = bounded(messageOf(error), limitOf(limits.maxOutputChars));
        if (connections.get(server) !== connection) {
          return errorOutput(`MCP server "${server}" disconnected while tool "${call.name}" was running: ${message}`);
        }
        return errorOutput(`MCP tool "${call.name}" failed: ${message}`);
      } finally {
        clearTimeout(timer);
      }
    },
    async provision() {
      await connect();
    },
    dispose: close,
    registerInto(registry) {
      registries.add(registry);
      return write(registry);
    },
    close,
  };
}

export {
  createMcpHttpHandler,
  createMcpServer,
  listenMcpHttp,
  MCP_PROTOCOL_VERSIONS,
  mcpToolName,
  serveMcpStdio,
  toolOutputToMcp,
  type McpCallContext,
  type McpHttpListener,
  type McpHttpOptions,
  type McpServer,
  type McpServerOptions,
  type McpStdioOptions,
} from './server.ts';
