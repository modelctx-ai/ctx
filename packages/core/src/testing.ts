/**
 * 协议的契约测试，从 `@modelctx-ai/ctx-protocol/testing` 原样转出：只装核心包的应用也能验证自己的实现。
 *
 * ```ts
 * import { describe, test } from 'vitest'; // 或 'node:test'
 * import { describeSessionStoreContract } from '@modelctx-ai/ctx/testing';
 * describeSessionStoreContract('my-store', ({ now }) => createMyStore({ now }), { describe, test });
 * ```
 */
import type { ModelScriptStep } from '@modelctx-ai/ctx-protocol/testing';
import { convertArrayToReadableStream, MockLanguageModelV4 } from 'ai/test';

export * from '@modelctx-ai/ctx-protocol/testing';

type GenerateResult = Awaited<ReturnType<MockLanguageModelV4['doGenerate']>>;
type StreamResult = Awaited<ReturnType<MockLanguageModelV4['doStream']>>;
type StreamPart = StreamResult['stream'] extends ReadableStream<infer Part> ? Part : never;

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

export interface ScriptedModelOptions {
  /** `tool-call` 这一步调用的工具名，缺省 `echo`。 */
  readonly tool?: string;
  readonly provider?: string;
  readonly modelId?: string;
}

/**
 * 按契约测试的剧本回答的假模型（基于 `ai/test` 的 `MockLanguageModelV4`）：每调一次（流式或非流式）取下一步，
 * 剧本用完后再调就抛错。给 `describeHarnessContract`、`describeOrchestratorContract` 的工厂用。
 */
export function createScriptedModel(
  script: readonly ModelScriptStep[],
  options: ScriptedModelOptions = {},
): MockLanguageModelV4 {
  const tool = options.tool ?? 'echo';
  let index = 0;
  type Answer = Exclude<ModelScriptStep, { type: 'error' }>;
  const next = (): Answer => {
    const step = script[index];
    index += 1;
    if (!step) throw new Error(`Scripted model ran out of steps after ${script.length}.`);
    if (step.type === 'error') throw new Error(step.message);
    return step;
  };
  return new MockLanguageModelV4({
    provider: options.provider ?? 'scripted',
    modelId: options.modelId ?? 'model',
    doGenerate: async (): Promise<GenerateResult> => {
      const step = next();
      if (step.type === 'text') {
        return {
          content: [{ type: 'text', text: step.text }],
          finishReason: { unified: 'stop', raw: 'stop' },
          usage,
          warnings: [],
        };
      }
      return {
        content: [{ type: 'tool-call', toolCallId: step.id, toolName: tool, input: JSON.stringify(step.input) }],
        finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
        usage,
        warnings: [],
      };
    },
    doStream: async (): Promise<StreamResult> => {
      const step = next();
      const parts: StreamPart[] = [{ type: 'stream-start', warnings: [] }];
      if (step.type === 'text') {
        parts.push(
          { type: 'text-start', id: '1' },
          { type: 'text-delta', id: '1', delta: step.text },
          { type: 'text-end', id: '1' },
          { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
        );
      } else {
        parts.push(
          { type: 'tool-call', toolCallId: step.id, toolName: tool, input: JSON.stringify(step.input) },
          { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage },
        );
      }
      return { stream: convertArrayToReadableStream(parts) };
    },
  });
}
