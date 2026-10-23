import type { Tool, ToolSet } from 'ai';

export interface ToolInfo {
  readonly name: string;
  /** 工具从哪来：`local`、`mcp:<server>` 之类。 */
  readonly source: string;
  readonly tags: readonly string[];
}

export interface ToolMeta {
  readonly source?: string;
  readonly tags?: readonly string[];
  /** 同名时替换，而不是报错。 */
  readonly replace?: boolean;
}

/** `true` 全部、`false` 不要、名字列表，或者按信息筛。 */
export type ToolFilter = boolean | readonly string[] | ((info: ToolInfo) => boolean);

/** 本地工具和 MCP 工具放在一处，每次调用按需挑一部分交给模型。 */
export interface ToolRegistry {
  readonly size: number;
  add(name: string, tool: Tool, meta?: ToolMeta): ToolRegistry;
  addAll(tools: ToolSet, meta?: ToolMeta): ToolRegistry;
  remove(name: string): boolean;
  /** 删掉某个来源的全部工具，返回条数。 */
  removeSource(source: string): number;
  has(name: string): boolean;
  list(): ToolInfo[];
  select(filter?: ToolFilter): ToolSet;
}

/** 各家接口对函数名的共同限制。 */
const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

export function isValidToolName(name: string): boolean {
  return TOOL_NAME.test(name);
}

export function createToolRegistry(): ToolRegistry {
  const tools = new Map<string, { tool: Tool; info: ToolInfo }>();

  const registry: ToolRegistry = {
    get size() {
      return tools.size;
    },
    add(name, tool, meta = {}) {
      if (!isValidToolName(name)) throw new Error(`Invalid tool name "${name}": use [a-zA-Z0-9_-], at most 64 chars.`);
      if (tools.has(name) && !meta.replace) throw new Error(`Tool "${name}" is already registered.`);
      tools.set(name, { tool, info: { name, source: meta.source ?? 'local', tags: meta.tags ?? [] } });
      return registry;
    },
    addAll(set, meta) {
      for (const [name, tool] of Object.entries(set)) registry.add(name, tool, meta);
      return registry;
    },
    remove(name) {
      return tools.delete(name);
    },
    removeSource(source) {
      let removed = 0;
      for (const [name, entry] of tools) {
        if (entry.info.source === source && tools.delete(name)) removed += 1;
      }
      return removed;
    },
    has(name) {
      return tools.has(name);
    },
    list() {
      return [...tools.values()].map((entry) => entry.info);
    },
    select(filter = true) {
      const out: ToolSet = {};
      if (filter === false) return out;
      for (const [name, entry] of tools) {
        const picked =
          filter === true ? true : typeof filter === 'function' ? filter(entry.info) : filter.includes(name);
        if (picked) out[name] = entry.tool;
      }
      return out;
    },
  };
  return registry;
}
