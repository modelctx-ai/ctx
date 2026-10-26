// 协议包的全部导出：类型、纯函数、框架事件。应用只装核心包也能拿到。
export * from '@modelctx-ai/ctx-protocol';

export { createMemoryStore, type ContextEntry, type ContextStore, type MemoryStoreOptions } from './store.ts';
export {
  createFunctionExecutor,
  type FunctionExecutor,
  type FunctionToolDefinition,
  type ToolFunction,
  type ToolFunctionContext,
} from './executor.ts';
export {
  createToolRegistry,
  dispatchTo,
  toToolSet,
  type Executors,
  type LocalToolRegistry,
  type ToolDispatch,
  type ToolMeta,
  type ToolRegistryOptions,
  type ToolSetOptions,
} from './tools.ts';
export {
  createContextBuilder,
  type ContextBuilderOptions,
  type FactsPlacement,
  type LocalContextBuilder,
} from './builder.ts';
export {
  createHarness,
  errorInfo,
  type GenerateTextResult,
  type HarnessOptions,
  type StreamTextResult,
} from './harness.ts';
export { findLossySummaries, recompactLossy, type FindLossyOptions, type LossySummary } from './migrate.ts';
export { createOrchestrator, type LocalOrchestrator, type OrchestratorOptions } from './orchestrator.ts';
export * from './errors.ts';
export * from './context.ts';
export {
  AI_SDK_PART_TYPES,
  fromModelMessage,
  fromModelMessages,
  fromUserContent,
  toModelMessage,
  toModelMessages,
  toUserContent,
} from './messages.ts';

// 应用定义工具、拼消息时直接从这里拿，不必再单独依赖 `ai`，版本也只有一份。
export { asSchema, dynamicTool, jsonSchema, stepCountIs, tool, zodSchema } from 'ai';
export type {
  AssistantModelMessage,
  LanguageModel,
  ModelMessage,
  SystemModelMessage,
  Tool,
  ToolModelMessage,
  ToolSet,
  UserContent,
  UserModelMessage,
} from 'ai';
