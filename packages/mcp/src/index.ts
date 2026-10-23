import { createMCPClient } from '@ai-sdk/mcp';
import { Experimental_StdioMCPTransport } from '@ai-sdk/mcp/mcp-stdio';
import { silentLogger, type Logger, type ToolRegistry, type ToolSet } from '@modelctx-ai/ctx';

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
}

/** 和常见的 `mcpServers` 配置同一种写法：有 `command` 是本机进程，有 `url` 是远程。 */
export type McpServerConfig = (StdioServerConfig | RemoteServerConfig) & ServerOptions;
export type McpServers = Readonly<Record<string, McpServerConfig>>;

export interface McpConnection {
  tools(): Promise<ToolSet>;
  close(): Promise<void>;
}

export type McpConnector = (name: string, config: McpServerConfig) => Promise<McpConnection>;

export type McpServerStatus =
  | { readonly name: string; readonly state: 'connected'; readonly tools: readonly string[] }
  | { readonly name: string; readonly state: 'failed'; readonly error: string }
  | { readonly name: string; readonly state: 'disabled' };

export interface McpHubOptions {
  readonly connector?: McpConnector;
  /** 工具名前面加服务器名，缺省 `<server>__<tool>`；`false` 保留原名。 */
  readonly namespace?: false | ((server: string, tool: string) => string);
  readonly logger?: Logger;
  /** 连接时报给服务器的客户端名字。 */
  readonly clientName?: string;
}

export interface McpHub {
  /** 连上所有启用的服务器。单个失败只记在状态里，不抛出。 */
  connect(): Promise<McpServerStatus[]>;
  status(): McpServerStatus[];
  /** 已连上的服务器提供的全部工具（已加前缀、已按 include/exclude 过滤）。 */
  tools(): ToolSet;
  /** 写进工具注册表，来源记为 `mcp:<server>`。返回写入的条数。 */
  registerInto(registry: ToolRegistry): number;
  close(): Promise<void>;
}

export function isStdioConfig(config: McpServerConfig): config is StdioServerConfig & ServerOptions {
  return 'command' in config && typeof config.command === 'string';
}

export function connectorFor(clientName = 'ctx'): McpConnector {
  return async (_name, config) => {
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
    const client = await createMCPClient({ transport, name: clientName });
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

export function createMcpHub(servers: McpServers, options: McpHubOptions = {}): McpHub {
  const connector = options.connector ?? connectorFor(options.clientName);
  const logger = options.logger ?? silentLogger;
  const rename =
    options.namespace === false ? (_server: string, tool: string) => tool : (options.namespace ?? namespaced);
  const connections = new Map<string, McpConnection>();
  const toolsByServer = new Map<string, ToolSet>();
  const statuses = new Map<string, McpServerStatus>();

  async function connectOne(name: string, config: McpServerConfig): Promise<void> {
    if (config.enabled === false) {
      statuses.set(name, { name, state: 'disabled' });
      return;
    }
    if (connections.has(name)) return;
    try {
      const connection = await connector(name, config);
      const all = await connection.tools();
      const picked: ToolSet = {};
      for (const [tool, value] of Object.entries(all)) {
        if (config.include && !config.include.includes(tool)) continue;
        if (config.exclude?.includes(tool)) continue;
        picked[rename(name, tool)] = value;
      }
      connections.set(name, connection);
      toolsByServer.set(name, picked);
      statuses.set(name, { name, state: 'connected', tools: Object.keys(picked) });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      statuses.set(name, { name, state: 'failed', error: message });
      logger.warn(`MCP server "${name}" failed to connect`, { error: message });
    }
  }

  return {
    async connect() {
      await Promise.all(Object.entries(servers).map(([name, config]) => connectOne(name, config)));
      return [...statuses.values()];
    },
    status() {
      return [...statuses.values()];
    },
    tools() {
      return Object.assign({}, ...toolsByServer.values()) as ToolSet;
    },
    registerInto(registry) {
      let count = 0;
      for (const [server, tools] of toolsByServer) {
        registry.removeSource(`mcp:${server}`);
        registry.addAll(tools, { source: `mcp:${server}`, replace: true });
        count += Object.keys(tools).length;
      }
      return count;
    },
    async close() {
      const open = [...connections.entries()];
      connections.clear();
      toolsByServer.clear();
      await Promise.all(
        open.map(async ([name, connection]) => {
          try {
            await connection.close();
          } catch (error) {
            logger.warn(`MCP server "${name}" failed to close`, {
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }),
      );
    },
  };
}
