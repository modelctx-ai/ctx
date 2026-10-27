// 测试用的假模型：基于 `ai/test` 的 `MockLanguageModelV4`。不从包里导出，只给本包的测试用。
import { MockLanguageModelV4 } from 'ai/test';

type GenerateResult = Awaited<ReturnType<MockLanguageModelV4['doGenerate']>>;
type CallOptions = Parameters<MockLanguageModelV4['doGenerate']>[0];

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

/** 一次调用的系统指令和用户输入，拼成文字。 */
export function promptOf(options: CallOptions): { system: string; user: string } {
  const system: string[] = [];
  const user: string[] = [];
  for (const message of options.prompt) {
    if (message.role === 'system') system.push(message.content);
    else if (message.role === 'user')
      for (const part of message.content) if (part.type === 'text') user.push(part.text);
  }
  return { system: system.join('\n'), user: user.join('\n') };
}

/** 按收到的提示词回答文字的假模型；`calls` 记下每次的提示词。 */
export function textModel(answer: (prompt: { system: string; user: string }) => string): MockLanguageModelV4 & {
  readonly calls: { system: string; user: string }[];
} {
  const calls: { system: string; user: string }[] = [];
  const model = new MockLanguageModelV4({
    provider: 'mock',
    modelId: 'json',
    doGenerate: async (options): Promise<GenerateResult> => {
      const prompt = promptOf(options);
      calls.push(prompt);
      return {
        content: [{ type: 'text', text: answer(prompt) }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage,
        warnings: [],
      };
    },
  });
  return Object.assign(model, { calls });
}
