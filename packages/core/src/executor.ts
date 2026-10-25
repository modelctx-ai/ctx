import {
  errorOutput,
  isValidToolName,
  type AddToolOptions,
  type Awaitable,
  type ExecutionContext,
  type Executor,
  type JsonValue,
  type ToolDefinition,
  type ToolOutput,
} from '@modelctx-ai/ctx-protocol';

/** 函数执行时拿到的环境：协议的 `ExecutionContext` 加上这次调用的 id。 */
export interface ToolFunctionContext extends ExecutionContext {
  readonly callId: string;
}

/** 进程内的工具函数。返回协议的 `ToolOutput`；抛出的错误会变成 `{ type: 'error' }`。 */
export type ToolFunction = (input: JsonValue, context: ToolFunctionContext) => Awaitable<ToolOutput>;

/** 注册时的定义：`executor` 由函数执行环境自己填。 */
export type FunctionToolDefinition = Omit<ToolDefinition, 'executor'>;

/** 进程内函数执行环境：持有 `name → 函数` 的表，`tools()` 报注册过的定义。 */
export interface FunctionExecutor extends Executor {
  tools(): Promise<ToolDefinition[]>;
  /** 名字不合法、或同名已存在且没给 `replace` 时抛错。 */
  register(definition: FunctionToolDefinition, fn: ToolFunction, options?: AddToolOptions): FunctionExecutor;
  unregister(name: string): boolean;
  has(name: string): boolean;
  /** 注册过的定义，`executor` 已经填成这个执行环境的名字。 */
  definition(name: string): ToolDefinition | undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 进程内函数执行环境。执行出错（不认识的工具、`signal` 已中止、函数抛错）都返回 `{ type: 'error' }`，不抛。
 * `dispose` 之后不再执行。
 */
export function createFunctionExecutor(name = 'local'): FunctionExecutor {
  const table = new Map<string, { definition: ToolDefinition; fn: ToolFunction }>();
  let disposed = false;

  const executor: FunctionExecutor = {
    name,
    async tools() {
      return [...table.values()].map((entry) => entry.definition);
    },
    register(definition, fn, options) {
      if (!isValidToolName(definition.name)) {
        throw new Error(`Invalid tool name "${definition.name}": use [a-zA-Z0-9_-], at most 64 chars.`);
      }
      if (table.has(definition.name) && !options?.replace) {
        throw new Error(`Tool "${definition.name}" is already registered.`);
      }
      table.set(definition.name, { definition: { ...definition, executor: name }, fn });
      return executor;
    },
    unregister: (tool) => table.delete(tool),
    has: (tool) => table.has(tool),
    definition: (tool) => table.get(tool)?.definition,
    async execute(call, context) {
      if (disposed) return errorOutput(`Executor "${name}" has been disposed; tool "${call.name}" did not run.`);
      if (context.signal?.aborted) return errorOutput(`Aborted before tool "${call.name}" ran.`);
      const found = table.get(call.name);
      if (!found) {
        const available = [...table.keys()].join(', ') || '(none)';
        return errorOutput(`Unknown tool "${call.name}". Available tools: ${available}.`);
      }
      try {
        return await found.fn(call.input, { ...context, callId: call.id });
      } catch (error) {
        return errorOutput(`Tool "${call.name}" failed: ${messageOf(error)}`);
      }
    },
    async provision() {},
    async dispose() {
      disposed = true;
    },
  };
  return executor;
}
