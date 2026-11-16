import type { AgentSpec } from '@modelctx-ai/ctx-protocol';
import {
  describeExecutorContract,
  describeHarnessContract,
  describeMemoryStoreContract,
  describeOrchestratorContract,
  describeSessionStoreContract,
  type ContractTestApi,
  type ModelScriptStep,
} from '@modelctx-ai/ctx-protocol/testing';

import {
  CONFORMANCE_COMPONENTS,
  CONFORMANCE_PATH,
  type ConformanceComponent,
  type ConformanceInstance,
  type ConformanceSetup,
} from './conformance-wire.ts';
import {
  createRemoteExecutor,
  createRemoteHarness,
  createRemoteMemoryStore,
  createRemoteOrchestrator,
  createRemoteSessionStore,
  type RemoteClientOptions,
} from './index.ts';

export interface ConformanceOptions extends Omit<RemoteClientOptions, 'baseUrl'> {
  /** 要测的组件，缺省全部。 */
  readonly components?: readonly ConformanceComponent[];
}

/** 编排器的契约里模型每一步等多久：第二轮提交、取消的请求到达时第一轮还在跑。 */
const ORCHESTRATOR_DELAY_MS = 150;

/** 契约给的钟换成实例的钟：读两次推出起点和步长；像真实时间的就用 `real`。 */
function clockOf(now: () => number): ConformanceSetup['clock'] {
  const first = now();
  const second = now();
  if (first > 1e12) return 'real';
  const step = second - first;
  return { at: second + step, step };
}

function agentOf(created: ConformanceInstance): AgentSpec {
  if (!created.agent) throw new Error('The conformance instance did not return an agent for harness tests.');
  return created.agent;
}

/**
 * 对一个地址跑契约测试：被测的服务以一致性模式运行（`POST /conformance/instances` 给每个用例一个新实例，见
 * `createConformanceHandler`），每个用例在自己的实例上用本包的客户端跑 `describeXContract`。任何语言写的服务端
 * 只要提供这个入口、实现了线上形态，就能这样验证。`api` 是测试框架的 `describe`、`test`（`node:test`、Vitest 都行）。
 */
export function describeConformance(baseUrl: string, options: ConformanceOptions, api: ContractTestApi): void {
  const { components = CONFORMANCE_COMPONENTS, ...client } = options;
  const root = baseUrl.replace(/\/+$/, '');
  const origin = new URL(root).origin;

  async function instance(setup: ConformanceSetup): Promise<ConformanceInstance & { client: RemoteClientOptions }> {
    const headers: Record<string, string> = { 'content-type': 'application/json', ...client.headers };
    if (client.accessToken) headers['authorization'] = `Bearer ${client.accessToken}`;
    const response = await (client.fetch ?? fetch)(`${root}${CONFORMANCE_PATH}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(setup),
    });
    if (!response.ok) {
      throw new Error(`${root}${CONFORMANCE_PATH} answered ${response.status}: ${await response.text()}`);
    }
    const created = (await response.json()) as ConformanceInstance;
    const prefix = new URL(root).pathname.replace(/\/+$/, '');
    return { ...created, client: { ...client, baseUrl: `${origin}${prefix}${created.baseUrl}` } };
  }

  const scripted = (script: readonly ModelScriptStep[], names: ConformanceComponent[], delayMs = 0) =>
    instance({ components: names, script, ...(delayMs > 0 ? { delayMs } : {}) });
  const name = `conformance ${root}`;

  if (components.includes('sessions')) {
    describeSessionStoreContract(
      name,
      async ({ now }) =>
        createRemoteSessionStore((await instance({ components: ['sessions'], clock: clockOf(now) })).client),
      api,
    );
  }
  if (components.includes('executors')) {
    describeExecutorContract(
      name,
      async () => {
        const created = await instance({ components: ['executors'] });
        if (!created.executor) throw new Error('The conformance instance did not return an executor.');
        return {
          executor: createRemoteExecutor({ ...created.client, name: created.executor.name }),
          echo: created.executor.echo,
        };
      },
      api,
    );
  }
  if (components.includes('harness')) {
    describeHarnessContract(
      name,
      async ({ script }) => {
        const created = await scripted(script, ['sessions', 'harness']);
        return {
          harness: createRemoteHarness(created.client),
          store: createRemoteSessionStore(created.client),
          agent: agentOf(created),
        };
      },
      api,
    );
  }
  if (components.includes('orchestrator')) {
    describeOrchestratorContract(
      name,
      async ({ script }) => {
        const created = await scripted(script, ['sessions', 'orchestrator'], ORCHESTRATOR_DELAY_MS);
        return {
          orchestrator: createRemoteOrchestrator(created.client),
          store: createRemoteSessionStore(created.client),
          agent: agentOf(created),
        };
      },
      api,
    );
  }
  if (components.includes('memory')) {
    describeMemoryStoreContract(
      name,
      async ({ now }) =>
        createRemoteMemoryStore((await instance({ components: ['memory'], clock: clockOf(now) })).client),
      api,
    );
  }
}

export {
  CONFORMANCE_COMPONENTS,
  CONFORMANCE_PATH,
  type ConformanceComponent,
  type ConformanceInstance,
  type ConformanceSetup,
} from './conformance-wire.ts';
