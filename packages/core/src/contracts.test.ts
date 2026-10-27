import { describe, test } from 'vite-plus/test';

import { createContextBuilder } from './builder.ts';
import { createFunctionExecutor } from './executor.ts';
import { createHarness } from './harness.ts';
import { createOrchestrator } from './orchestrator.ts';
import { createMemoryStore } from './store.ts';
import {
  createScriptedModel,
  describeExecutorContract,
  describeHarnessContract,
  describeOrchestratorContract,
  describeSessionStoreContract,
  describeToolRegistryContract,
  type ModelScript,
} from './testing.ts';
import { createToolRegistry } from './tools.ts';

const api = { describe, test };

describeSessionStoreContract('memory', ({ now }) => createMemoryStore({ now }), api);

describeExecutorContract(
  'function',
  () => {
    const executor = createFunctionExecutor().register(
      { name: 'echo', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
      (input) => ({ type: 'json', value: input }),
    );
    return { executor, echo: 'echo' };
  },
  api,
);

describeToolRegistryContract('local', () => createToolRegistry(), api);

/** 内存存储 + 回显工具 + 按剧本回答的模型。 */
function fixture({ script }: ModelScript) {
  const store = createMemoryStore();
  const tools = createToolRegistry();
  tools.executor.register({ name: 'echo', description: '原样返回输入', inputSchema: { type: 'object' } }, (input) => ({
    type: 'json',
    value: input,
  }));
  tools.add(tools.executor.definition('echo')!);
  const harness = createHarness({ store, context: createContextBuilder({ store }), tools });
  return { store, harness, agent: { model: createScriptedModel(script) } };
}

describeHarnessContract('ai-sdk', fixture, api);

describeOrchestratorContract(
  'local',
  (setup) => {
    const { store, harness, agent } = fixture(setup);
    return { store, agent, orchestrator: createOrchestrator({ harness, store }) };
  },
  api,
);
