import assert from 'node:assert/strict';

import { MockLanguageModelV4 } from 'ai/test';
import { describe, test } from 'vite-plus/test';

import { agentSpecToJson, modelName } from './harness.ts';

describe('agent spec', () => {
  test('模型对象记成 provider/modelId，名字原样', () => {
    assert.equal(modelName('anthropic/claude-sonnet-5'), 'anthropic/claude-sonnet-5');
    assert.equal(modelName(new MockLanguageModelV4({ provider: 'mock', modelId: 'm1' })), 'mock/m1');
  });

  test('可序列化部分只带给了的字段', () => {
    const json = agentSpecToJson({
      name: 'pet',
      model: new MockLanguageModelV4({ provider: 'mock', modelId: 'm1' }),
      tools: { tags: ['read'] },
      settings: { temperature: 0.2, stopSequences: ['\n\n'] },
    });
    assert.deepEqual(json, {
      model: 'mock/m1',
      name: 'pet',
      tools: { tags: ['read'] },
      settings: { temperature: 0.2, stopSequences: ['\n\n'] },
    });
    assert.deepEqual(JSON.parse(JSON.stringify(json)), json);
  });
});
