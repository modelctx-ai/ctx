import { createMCPClient } from '@ai-sdk/mcp';
import { Experimental_StdioMCPTransport } from '@ai-sdk/mcp/mcp-stdio';
import { silentLogger, type Logger, type Tool, type ToolRegistry, type ToolSet } from '@modelctx-ai/ctx';

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

export interface McpConnection {
  tools(): Promise<ToolSet>;
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
  readonly connector?: McpConnector;
  /** 工具名前面加服务器名，缺省 `<server>__<tool>`；`false` 保留原名。 */
  readonly namespace?: false | ((server: string, tool: string) => string);
  readonly logger?: Logger;
  /** 连接时报给服务器的客户端名字。 */
  readonly clientName?: string;
  /** 每台服务器连接加列工具最多等多久，缺省 15 秒；0 或 Infinity 不限时。超时记为失败，不耽误别的服务器。 */
  readonly timeoutMs?: number;
}

export interface McpHub {
  /** 连上所有启用的服务器。单个失败或超时只记在状态里，不抛出。 */
  connect(): Promise<McpServerStatus[]>;
  /** 按配置顺序。 */
  status(): McpServerStatus[];
  /** 已连上的服务器提供的全部工具（已加前缀、已按 include/exclude 过滤，重名的只留第一个）。 */
  tools(): ToolSet;
  /**
   * 写进工具注册表，来源记为 `mcp:<server>`，先删掉之前写进去的。
   * 注册表里已有别的来源的同名工具时不替换，跳过并告警。返回实际写入的条数。
   */
  registerInto(registry: ToolRegistry): number;
  /** 断开全部连接，清空状态，并从写过的注册表里删掉这些工具。 */
  close(): Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 15_000;

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
      tools: async () => (await client.tools()) as ToolSet,
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

export function createMcpHub(servers: McpServers, options: McpHubOptions = {}): McpHub {
  const connector = options.connector ?? connectorFor(options.clientName);
  const logger = options.logger ?? silentLogger;
  const rename =
    options.namespace === false ? (_server: string, tool: string) => tool : (options.namespace ?? namespaced);
  const names = Object.keys(servers);
  const connections = new Map<string, McpConnection>();
  /** 每台服务器过滤、改名后的工具，按服务器给的顺序：[改名后, 原名, 工具]。 */
  const offered = new Map<string, readonly (readonly [string, string, Tool])[]>();
  const toolsByServer = new Map<string, ToolSet>();
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
      const kept: ToolSet = {};
      const skipped: string[] = [];
      for (const [tool, original, value] of list) {
        if (taken.has(tool)) {
          skipped.push(original);
          continue;
        }
        taken.add(tool);
        kept[tool] = value;
      }
      toolsByServer.set(name, kept);
      statuses.set(name, {
        name,
        state: 'connected',
        tools: Object.keys(kept),
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
      const list: (readonly [string, string, Tool])[] = [];
      for (const [tool, value] of Object.entries(all)) {
        if (config.include && !config.include.includes(tool)) continue;
        if (config.exclude?.includes(tool)) continue;
        list.push([rename(name, tool), tool, value]);
      }
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

  return {
    async connect() {
      await Promise.all(Object.entries(servers).map(([name, config]) => connectOne(name, config)));
      return status();
    },
    status,
    tools() {
      return Object.assign({}, ...toolsByServer.values()) as ToolSet;
    },
    registerInto(registry) {
      registries.add(registry);
      // 先删掉这个 hub 之前写的全部工具，再按配置顺序重新写。
      for (const name of names) registry.removeSource(`mcp:${name}`);
      let count = 0;
      for (const [server, tools] of toolsByServer) {
        const source = `mcp:${server}`;
        for (const [name, value] of Object.entries(tools)) {
          if (registry.has(name)) {
            const owner = registry.list().find((info) => info.name === name)?.source;
            logger.warn(`MCP tool "${name}" from server "${server}" skipped: name already registered`, { owner });
            continue;
          }
          try {
            registry.add(name, value, { source });
            count += 1;
          } catch (error) {
            logger.warn(`MCP tool "${name}" from server "${server}" skipped`, { error: messageOf(error) });
          }
        }
      }
      return count;
    },
    async close() {
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
    },
  };
}
