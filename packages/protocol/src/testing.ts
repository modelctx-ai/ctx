/**
 * 协议的契约测试。实现一个协议时，用同一套用例验证行为和参考实现一致。
 * 不绑定测试框架：把所用框架的 `describe`、`test` 传进来（Vitest、`node:test`、Jest、Bun 都行），断言用 `node:assert/strict`：
 *
 * ```ts
 * import { describe, test } from 'vitest'; // 或 'node:test'
 * import { describeSessionStoreContract } from '@modelctx-ai/ctx-protocol/testing';
 * describeSessionStoreContract('my-store', ({ now }) => createMyStore({ now }), { describe, test });
 * ```
 */
export * from './testing/api.ts';
export * from './testing/session-store.ts';
export * from './testing/executor.ts';
export * from './testing/tool-registry.ts';
export * from './testing/harness.ts';
export * from './testing/context-builder.ts';
export * from './testing/orchestrator.ts';
export * from './testing/memory-store.ts';
export * from './testing/scripted-models.ts';
export * from './testing/decision-model.ts';
export * from './testing/extraction-model.ts';
export * from './testing/memory.ts';
