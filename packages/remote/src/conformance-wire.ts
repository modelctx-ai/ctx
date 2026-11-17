import type { AgentSpec } from '@modelctx-ai/ctx-protocol';
import type { ModelScriptStep } from '@modelctx-ai/ctx-protocol/testing';

/** 一致性测试能对一个地址测的组件：能跨进程的那几个。 */
export const CONFORMANCE_COMPONENTS = ['sessions', 'executors', 'harness', 'orchestrator', 'memory'] as const;
export type ConformanceComponent = (typeof CONFORMANCE_COMPONENTS)[number];

/** 建实例的入口。 */
export const CONFORMANCE_PATH = '/conformance/instances';

/** `POST /conformance/instances` 的请求体：每个用例一个新实例。 */
export interface ConformanceSetup {
  readonly components: readonly ConformanceComponent[];
  /**
   * harness、编排器的模型剧本：第 n 次调用模型回第 n 步。`text` 是一段回答（`truncated` 时 `finishReason` 是
   * `length`），`tool-call` 是调用回显工具（`input` 原样），`error` 是模型调用失败。
   */
  readonly script?: readonly ModelScriptStep[];
  /** 模型每一步先等这么久（毫秒）：编排器的契约要在第一轮还在跑时提交、取消第二轮。缺省 0。 */
  readonly delayMs?: number;
  /** 存储的钟：`{ at, step }` 第 n 次读是 `at + n × step`；`real` 是真实时间。缺省 `real`。 */
  readonly clock?: { readonly at: number; readonly step: number } | 'real';
}

/** 建好的实例。 */
export interface ConformanceInstance {
  /** 实例的地址，相对建实例的那个服务。 */
  readonly baseUrl: string;
  /** harness、编排器的契约用的 agent。 */
  readonly agent?: Pick<AgentSpec, 'model'> & Partial<AgentSpec>;
  /** 执行环境的契约用。 */
  readonly executor?: { readonly name: string; readonly echo: string };
}
