import { createMCPClient } from '@ai-sdk/mcp';
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
}

/**
 * 一组 MCP 服务器，本身是一个执行环境（`Executor`）：`tools()` 报全部工具的定义，`execute` 调对应服务器的工具。
 */
export interface McpHub extends Executor {
  /** 连上所有启用的服务器。单个失败或超时只记在状态里，不抛出。 */
  connect(): Promise<McpServerStatus[]>;
  /** 按配置顺序。 */
  status(): McpServerStatus[];
  /** 已连上的服务器提供的全部工具的定义（已加前缀、已按 include/exclude 过滤，重名的只留第一个），绑定到这个 hub。 */
  tools(): Promise<ToolDefinition[]>;
  /** 同样这些工具，`@ai-sdk/mcp` 给出的原样。 */
  toolSet(): McpToolSet;
  /** 调对应服务器的工具。不认识的工具、`signal` 已中止、服务器报错都返回 `{ type: 'error' }`。 */
  execute(call: ToolCall, context: ExecutionContext): Promise<ToolOutput>;
  /**
   * 把工具定义写进工具目录，来源记为 `mcp:<server>`，执行环境是这个 hub，先删掉之前写进去的。
   * 目录里已有别的来源的同名工具时不替换，跳过并告警。返回实际写入的条数。
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

interface Offered {
  readonly definition: ToolDefinition;
  /** 服务器上的原名。 */
  readonly original: string;
  readonly tool: McpTool;
}

export function isStdioConfig(config: McpServerConfig): config is StdioServerConfig & ServerOptions {
  return 'command' in config && typeof config.command === 'string';
}

export function connectorFor(clientName = 'ctx'): McpConnector {
  return async (_name, config, options = {}) => {
    const transport = isStdioConfig(config)
      ? new Experimental_StdioMCPTransport({
          command: config.command,
          args: [...(config.args ?? [])],
          ...(config.env ? { env: { ...config.env } } : {}),
          ...(config.cwd ? { cwd: config.cwd } : {}),
        })
      : {
          type: config.type ?? 'http',
          url: config.url,
          ...(config.headers ? { headers: { ...config.headers } } : {}),
        };
    const client = await createMCPClient({
      transport,
      name: clientName,
      ...(options.signal ? { initializationOptions: { signal: options.signal } } : {}),
    });
    return {
      tools: async () => await client.tools(),
      close: () => client.close(),
    };
  };
}

/** 工具名只能是 `[a-zA-Z0-9_-]`、最长 64，服务器名和工具名里别的字符换成 `_`。 */
export function namespaced(server: string, tool: string): string {
  return `${server}__${tool}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

/** MCP 的 `CallToolResult` 转成协议的结果：全是文字时合成一段，`isError` 变成错误。 */
export function toolOutputFromMcp(result: unknown): ToolOutput {
  if (typeof result === 'string') return { type: 'text', text: result };
  const content = (result as { content?: unknown } | null | undefined)?.content;
  if (!Array.isArray(content)) return { type: 'json', value: JSON.parse(JSON.stringify(result ?? null)) as JsonValue };
  const parts = (content as McpPart[]).map(partOf);
  const text = parts.every((part) => part.type === 'text');
  if ((result as { isError?: unknown }).isError === true) {
    const message = parts.map((part) => (part.type === 'text' ? part.text : `[${part.mediaType}]`)).join('\n');
    return errorOutput(message || 'MCP tool reported an error.');
  }
  if (text) return { type: 'text', text: parts.map((part) => (part.type === 'text' ? part.text : '')).join('\n') };
  return { type: 'content', parts };
}

export function createMcpHub(servers: McpServers, options: McpHubOptions = {}): McpHub {
  const hubName = options.name ?? 'mcp';
  const connector = options.connector ?? connectorFor(options.clientName);
  const logger = options.logger ?? silentLogger;
  const rename =
    options.namespace === false ? (_server: string, tool: string) => tool : (options.namespace ?? namespaced);
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
  const registries = new Set<ToolRegistry>();
  const closed = new Error('MCP hub closed');

  async function closeQuietly(name: string, connection: McpConnection): Promise<void> {
    try {
      await connection.close();
    } catch (error) {
      logger.warn(`MCP server "${name}" failed to close`, { error: messageOf(error) });
    }
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
      toolsByServer.set(name, kept);
      statuses.set(name, {
        name,
        state: 'connected',
        tools: [...kept.keys()],
        ...(skipped.length > 0 ? { skipped } : {}),
      });
    }
  }

  async function attempt(name: string, config: McpServerConfig): Promise<void> {
    const limit = config.timeoutMs ?? options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const controller = new AbortController();
    attempts.add(controller);
    const timer =
      Number.isFinite(limit) && limit > 0
        ? setTimeout(() => controller.abort(new Error(`timed out after ${limit}ms`)), limit)
        : undefined;
    const stopped = new Promise<never>((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
    });
    let connection: McpConnection | undefined;
    const work = (async () => {
      const opened = await connector(name, config, { signal: controller.signal });
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
      const list: Offered[] = [];
      for (const [tool, value] of Object.entries(all)) {
        if (config.include && !config.include.includes(tool)) continue;
        if (config.exclude?.includes(tool)) continue;
        const definition: ToolDefinition = {
          name: rename(name, tool),
          ...(typeof value.description === 'string' ? { description: value.description } : {}),
          inputSchema: await schemaOf(value),
          executor: hubName,
          source: `mcp:${name}`,
        };
        list.push({ definition, original: tool, tool: value });
      }
      // 列工具、取 schema 期间被关掉或超时：不收。
      if (controller.signal.aborted) throw controller.signal.reason;
      connections.set(name, opened);
      offered.set(name, list);
      resolveNames();
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

  async function close(): Promise<void> {
    for (const controller of attempts) controller.abort(closed);
    await Promise.all(pending.values());
    const open = [...connections.entries()];
    connections.clear();
    offered.clear();
    toolsByServer.clear();
    statuses.clear();
    for (const registry of registries) {
      for (const name of names) registry.removeSource(`mcp:${name}`);
    }
    registries.clear();
    await Promise.all(open.map(([name, connection]) => closeQuietly(name, connection)));
  }

  return {
    name: hubName,
    connect,
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
        const available = offeredTools()
          .map((item) => item.definition.name)
          .join(', ');
        return errorOutput(`Unknown MCP tool "${call.name}". Available tools: ${available || '(none)'}.`);
      }
      const run = found.tool.execute as McpExecute | undefined;
      if (typeof run !== 'function') return errorOutput(`MCP tool "${call.name}" cannot be executed.`);
      try {
        const output = await run(call.input, {
          toolCallId: call.id,
          messages: [],
          context: {},
          ...(context.signal ? { abortSignal: context.signal } : {}),
        });
        return toolOutputFromMcp(output);
      } catch (error) {
        return errorOutput(`MCP tool "${call.name}" failed: ${messageOf(error)}`);
      }
    },
    async provision() {
      await connect();
    },
    dispose: close,
    registerInto(registry) {
      registries.add(registry);
      // 先删掉这个 hub 之前写的全部工具，再按配置顺序重新写。
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
    },
    close,
  };
}
