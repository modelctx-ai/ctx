// 重放 live/fixtures/ 里录下来的真实响应：不联网，PR 的 CI 跑。映射改坏了，同一份响应得出的结果就和录的时候不一样。
import assert from 'node:assert/strict';

import { describe, test } from 'vite-plus/test';

import { readFixtures, replayFetch, withFetch } from './exchange.ts';
import { scenarioNamed } from './scenarios.ts';
import { FIXTURES } from './smoke.ts';
import type { Target } from './targets.ts';

const fixtures = readFixtures(FIXTURES);

describe('重放录下来的真实响应', () => {
  test('夹具都认得：场景还在，目标的密钥已经去掉', () => {
    for (const { file, fixture } of fixtures) {
      assert.ok(scenarioNamed(fixture.scenario), `${file}: 没有叫 ${fixture.scenario} 的场景`);
      assert.doesNotMatch(
        JSON.stringify(fixture),
        /"(apiKey|accountId)":"(?!REDACTED")/,
        `${file}: 夹具里有密钥或账号`,
      );
      assert.doesNotMatch(JSON.stringify(fixture.exchanges), /authorization|x-api-key/i, `${file}: 夹具里有请求头`);
    }
  });

  for (const { file, fixture } of fixtures) {
    test(`${file}（录于 ${fixture.recordedAt}）`, async () => {
      const scenario = scenarioNamed(fixture.scenario)!;
      const replay = replayFetch(fixture.exchanges);
      const outcome = await withFetch(replay, () => scenario.run(fixture.target as unknown as Target, replay));
      assert.deepEqual(outcome.problems, []);
      assert.deepEqual(outcome.observation, fixture.observation, '同一份响应得出的结果和录的时候不一样');
    });
  }
});
