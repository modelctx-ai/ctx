import {
  checkJsonSchema,
  errorOutput,
  isValidToolName,
  limitToolOutput,
  selectTools,
  toolOutputFromAiSdk,
  toolOutputToAiSdk,
  type AddToolOptions,
  type ExecutionContext,
  type Executor,
  type JsonObject,
  type JsonValue,
  type ToolCall,
  type ToolDefinition,
  type ToolFilter,
  type ToolOutput,
  type ToolRegistry,
} from '@modelctx-ai/ctx-protocol';
import { asSchema, dynamicTool, jsonSchema, type Tool, type ToolResultPart, type ToolSet } from 'ai';

import { createFunctionExecutor, type FunctionExecutor, type ToolFunction } from './executor.ts';

/** 执行环境的集合：数组按各自的 `name`，对象按键。 */
export type Executors = readonly Executor[] | Readonly<Record<string, Executor>>;

export function executorMap(executors: Executors | undefined): Map<string, Executor> {
  if (!executors) return new Map();
  if (Array.isArray(executors)) return new Map(executors.map((executor: Executor) => [executor.name, executor]));
  return new Map(Object.entries(executors));
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 把一次工具调用交给执行环境。harness 用它插入钩子。 */
export type ToolDispatch = (
  call: ToolCall,
  definition: ToolDefinition,
  context: ExecutionContext,
) => Promise<ToolOutput>;

export interface ToolSetOptions {
  /** 交给执行环境的会话名，缺省 `''`。 */
  readonly session?: string;
  readonly runId?: string;
  /** 换掉缺省的分发（找到绑定的执行环境 → `execute`）。 */
  readonly dispatch?: ToolDispatch;
  /**
   * 执行前按工具的 `inputSchema` 查模型给的输入（`checkJsonSchema`，只查认识的关键字），不合就不执行，
   * 把问题作为错误结果回给模型。缺省查；`false` 关掉，函数按工具决定。注册表的 `toolSet` 和 harness 缺省不查
   * `addTool` 加的工具：它们在函数执行环境里按自己原来的 schema（zod）校验，比这里准。
   */
  readonly validateInput?: boolean | ((definition: ToolDefinition) => boolean);
  /** 结果超过这么多字符时截断并注明（`limitToolOutput`），缺省 `DEFAULT_MAX_TOOL_OUTPUT_CHARS`；0 或 Infinity 不限。 */
  readonly maxOutputChars?: number;
  /**
   * 不在这里执行的工具：交给模型的定义照旧，但不带 `execute`，模型调用它时 AI SDK 停下这一轮，调用留给别处执行
   * （harness 以 `requires_action` 结束）。
   */
  readonly external?: (definition: ToolDefinition) => boolean;
}

/** 不在这里执行的工具的输出结构：别处执行，结果经日志回来，这里不校验。 */
const EXTERNAL_OUTPUT = jsonSchema({});

/**
 * 工具结果长度的兜底，20 万字符（大约 5 万到 20 万 token）。该截断、分页的是执行环境，它知道怎么截才有用；
 * 这一层只保证哪个执行环境忘了也不会把一次结果原样塞满上下文。
 */
export const DEFAULT_MAX_TOOL_OUTPUT_CHARS = 200_000;

/** 缺省的分发：找到绑定的执行环境执行。找不到、或执行环境本身抛错，都变成给模型看的错误。 */
export function dispatchTo(executors: Executors | undefined): ToolDispatch {
  const map = executorMap(executors);
  return async (call, definition, context) => {
    const executor = map.get(definition.executor);
    if (!executor) {
      const available = [...map.keys()].join(', ') || 'none';
      return errorOutput(
        `Tool "${call.name}" is bound to executor "${definition.executor}", which is not available (available: ${available}).`,
      );
    }
    try {
      return await executor.execute(call, context);
    } catch (error) {
      return errorOutput(`Executor "${executor.name}" failed while running "${call.name}": ${messageOf(error)}`);
    }
  };
}

/**
 * 把选中的工具定义包成 AI SDK 的 `ToolSet`：每个工具的 `execute` 转给绑定的执行环境，
 * 结果是协议的 `ToolOutput`，经 `toolOutputToAiSdk` 交回模型。
 */
export function toToolSet(
  definitions: readonly ToolDefinition[],
  executors: Executors | undefined,
  options: ToolSetOptions = {},
): ToolSet {
  const dispatch = options.dispatch ?? dispatchTo(executors);
  const validates = (definition: ToolDefinition): boolean =>
    typeof options.validateInput === 'function' ? options.validateInput(definition) : options.validateInput !== false;
  const maxOutputChars = options.maxOutputChars ?? DEFAULT_MAX_TOOL_OUTPUT_CHARS;
  const out: ToolSet = {};
  for (const definition of definitions) {
    if (options.external?.(definition)) {
      out[definition.name] = dynamicTool({
        ...(definition.description !== undefined ? { description: definition.description } : {}),
        inputSchema: jsonSchema(definition.inputSchema as Parameters<typeof jsonSchema>[0]),
        outputSchema: EXTERNAL_OUTPUT,
        toModelOutput: ({ output }) => toolOutputToAiSdk(output as ToolOutput) as ToolResultPart['output'],
      });
      continue;
    }
    out[definition.name] = dynamicTool({
      ...(definition.description !== undefined ? { description: definition.description } : {}),
      inputSchema: jsonSchema(definition.inputSchema as Parameters<typeof jsonSchema>[0]),
      execute: async (input, execution) => {
        const call: ToolCall = { id: execution.toolCallId, name: definition.name, input: (input ?? null) as JsonValue };
        const context: ExecutionContext = {
          session: options.session ?? '',
          ...(options.runId !== undefined ? { runId: options.runId } : {}),
          ...(execution.abortSignal ? { signal: execution.abortSignal } : {}),
        };
        if (validates(definition)) {
          const issues = checkJsonSchema(definition.inputSchema, call.input);
          if (issues.length > 0) {
            return errorOutput(
              `Invalid input for tool "${definition.name}": ${issues.join('; ')}. Fix the input and call the tool again.`,
            );
          }
        }
        return limitToolOutput(await dispatch(call, definition, context), maxOutputChars);
      },
      toModelOutput: ({ output }) => toolOutputToAiSdk(output as ToolOutput) as ToolResultPart['output'],
    });
  }
  return out;
}

export interface ToolMeta {
  /** 缺省 `local`。 */
  readonly source?: string;
  readonly tags?: readonly string[];
  /** 同名时替换，而不是报错。 */
  readonly replace?: boolean;
}

/** 协议的工具目录，加上把 AI SDK 工具放进来、再包回 `ToolSet` 的糖。 */
export interface LocalToolRegistry extends ToolRegistry {
  /** `addTool` 加进来的执行函数放在这里。harness 要把它列进执行环境。 */
  readonly executor: FunctionExecutor;
  add(definition: ToolDefinition, options?: AddToolOptions): LocalToolRegistry;
  /**
   * 加一个 AI SDK 工具（`tool({ inputSchema, execute })`）：输入结构转成 JSON Schema 定义，
   * 执行函数放进注册表自带的函数执行环境。没有 `execute` 的工具（服务商工具、只声明的工具）不收。
   */
  addTool(name: string, tool: Tool, meta?: ToolMeta): LocalToolRegistry;
  /** 这个工具是不是 `addTool` 加的：是的话它自己按原来的 schema 校验输入，harness 不再按 JSON Schema 查一遍。 */
  validatesInput(name: string): boolean;
  addAll(tools: ToolSet, meta?: ToolMeta): LocalToolRegistry;
  /** 按筛选挑工具并包成 AI SDK 的 `ToolSet`，执行环境是注册表自带的加上 `executors`。 */
  toolSet(filter?: ToolFilter, options?: ToolSetOptions & { readonly executors?: Executors }): ToolSet;
}

export interface ToolRegistryOptions {
  /** `addTool` 用的函数执行环境，缺省新建一个名为 `local` 的。 */
  readonly executor?: FunctionExecutor;
}

/** AI SDK 工具的输出转成协议的结果：有 `toModelOutput` 就用它，否则字符串是文字，其余按 JSON。 */
async function outputOf(tool: Tool, toolCallId: string, input: unknown, output: unknown): Promise<ToolOutput> {
  if (tool.toModelOutput) return toolOutputFromAiSdk(await tool.toModelOutput({ toolCallId, input, output }));
  if (typeof output === 'string') return { type: 'text', text: output };
  if (output === undefined) return { type: 'json', value: null };
  return { type: 'json', value: JSON.parse(JSON.stringify(output)) as JsonValue };
}

/** 流式工具（返回 AsyncIterable）取最后一个值。 */
async function settle(value: unknown): Promise<unknown> {
  if (value && typeof value === 'object' && Symbol.asyncIterator in value) {
    let last: unknown;
    for await (const item of value as AsyncIterable<unknown>) last = item;
    return last;
  }
  return value;
}

function definitionOf(name: string, tool: Tool, executor: string, meta: ToolMeta): ToolDefinition {
  if (tool.type === 'provider') throw new Error(`Tool "${name}" is a provider tool; it cannot go into the registry.`);
  if (!tool.execute) throw new Error(`Tool "${name}" has no execute function.`);
  const schema = asSchema(tool.inputSchema).jsonSchema;
  if (typeof (schema as PromiseLike<unknown>).then === 'function') {
    throw new Error(`Tool "${name}" has an async input schema; pass a JSON Schema or a zod schema.`);
  }
  return {
    name,
    ...(typeof tool.description === 'string' ? { description: tool.description } : {}),
    inputSchema: JSON.parse(JSON.stringify(schema)) as JsonObject,
    executor,
    source: meta.source ?? 'local',
    tags: [...(meta.tags ?? [])],
  };
}

function functionOf(name: string, tool: Tool): ToolFunction {
  const schema = asSchema(tool.inputSchema);
  return async (raw, context) => {
    // 交给模型的是 JSON Schema，AI SDK 不会再按原来的 zod 校验，这里补上（默认值、转换也在这一步）。
    let input: unknown = raw;
    if (schema.validate) {
      const checked = await schema.validate(raw);
      if (!checked.success) return errorOutput(`Invalid input for tool "${name}": ${checked.error.message}`);
      input = checked.value;
    }
    const output = await settle(
      tool.execute!(input, {
        toolCallId: context.callId,
        messages: [],
        context: {},
        ...(context.signal ? { abortSignal: context.signal } : {}),
      }),
    );
    return outputOf(tool, context.callId, input, output);
  };
}

export function createToolRegistry(options: ToolRegistryOptions = {}): LocalToolRegistry {
  const executor = options.executor ?? createFunctionExecutor();
  const tools = new Map<string, ToolDefinition>();
  /** 经 `addTool` 放进函数执行环境的名字，删除或被替换时一起拿掉。 */
  const owned = new Set<string>();

  function release(name: string): void {
    if (owned.delete(name)) executor.unregister(name);
  }

  function addDefinition(definition: ToolDefinition, replace: boolean | undefined): void {
    if (!isValidToolName(definition.name)) {
      throw new Error(`Invalid tool name "${definition.name}": use [a-zA-Z0-9_-], at most 64 chars.`);
    }
    if (tools.has(definition.name) && !replace) throw new Error(`Tool "${definition.name}" is already registered.`);
    release(definition.name);
    tools.set(definition.name, definition);
  }

  function addTool(name: string, tool: Tool, meta: ToolMeta = {}): LocalToolRegistry {
    if (!isValidToolName(name)) throw new Error(`Invalid tool name "${name}": use [a-zA-Z0-9_-], at most 64 chars.`);
    if (tools.has(name) && !meta.replace) throw new Error(`Tool "${name}" is already registered.`);
    const definition = definitionOf(name, tool, executor.name, meta);
    addDefinition(definition, true);
    const { executor: _bound, ...rest } = definition;
    executor.register(rest, functionOf(name, tool), { replace: true });
    owned.add(name);
    return registry;
  }

  const registry: LocalToolRegistry = {
    executor,
    get size() {
      return tools.size;
    },
    add(definition, addOptions) {
      addDefinition(definition, addOptions?.replace);
      return registry;
    },
    addTool,
    validatesInput: (name) => owned.has(name),
    addAll(set, meta) {
      for (const [name, tool] of Object.entries(set)) addTool(name, tool, meta);
      return registry;
    },
    remove(name) {
      release(name);
      return tools.delete(name);
    },
    removeSource(source) {
      let removed = 0;
      for (const [name, definition] of tools) {
        if (definition.source !== source) continue;
        release(name);
        if (tools.delete(name)) removed += 1;
      }
      return removed;
    },
    has: (name) => tools.has(name),
    get: (name) => tools.get(name),
    list: () => [...tools.values()],
    select: (filter) => selectTools([...tools.values()], filter),
    toolSet(filter, toolSetOptions = {}) {
      const { executors, ...rest } = toolSetOptions;
      const all = [executor, ...executorMap(executors).values()];
      return toToolSet(selectTools([...tools.values()], filter), all, {
        validateInput: (definition) => !owned.has(definition.name),
        ...rest,
      });
    },
  };
  return registry;
}

/**
 * 会话结束了：让每个执行环境释放这个会话（`close`，没有就跳过）。一个失败不挡别的，失败的列在 `failed` 里。
 * 什么时候算会话结束由应用决定（ADR 0009）。
 */
export async function closeExecutorSessions(
  executors: Executors,
  session: string,
): Promise<{ readonly closed: string[]; readonly failed: { readonly executor: string; readonly error: unknown }[] }> {
  const entries = [...executorMap(executors)].filter(([, executor]) => typeof executor.close === 'function');
  const settled = await Promise.allSettled(entries.map(([, executor]) => executor.close!(session)));
  const closed: string[] = [];
  const failed: { executor: string; error: unknown }[] = [];
  settled.forEach((result, index) => {
    const name = entries[index]![0];
    if (result.status === 'fulfilled') closed.push(name);
    else failed.push({ executor: name, error: result.reason });
  });
  return { closed, failed };
}
