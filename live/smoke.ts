// 对真实服务的冒烟测试。配了哪些环境变量就打哪些服务，没配的跳过。
//
//   node live/smoke.ts             # 跑配齐了的目标
//   node live/smoke.ts --record    # 通过的场景把往来录成 live/fixtures/ 里的夹具（密钥已去掉），提交后 PR 的 CI 重放
//   node live/smoke.ts --list      # 只列出每组目标要哪些环境变量
//
// 要哪些变量见 live/README.md。有场景不通过时退出码是 1；一个目标都没配时是 0。
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { fixtureFile, recordingFetch, withFetch, writeFixture, type Fixture } from './exchange.ts';
import { SCENARIOS, type Outcome, type Scenario } from './scenarios.ts';
import { redactTarget, secretsOf, TARGET_GROUPS, targetsFromEnv, type Target } from './targets.ts';

import type { JsonValue } from '@modelctx-ai/ctx';

export const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

export interface SmokeResult {
  readonly target: string;
  readonly scenario: string;
  readonly problems: string[];
  readonly fixture?: Fixture;
}

/** 对一个目标跑一个场景，同时把往来录下来。场景抛的错算一个问题，不让整次冒烟停下。 */
export async function runScenario(target: Target, scenario: Scenario): Promise<SmokeResult> {
  const recorder = recordingFetch(globalThis.fetch, secretsOf(target));
  let outcome: Outcome;
  try {
    outcome = await withFetch(recorder.fetch, () => scenario.run(target, recorder.fetch));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { target: target.name, scenario: scenario.name, problems: [`threw: ${message}`] };
  }
  const fixture: Fixture = {
    scenario: scenario.name,
    target: redactTarget(target) as unknown as JsonValue,
    recordedAt: new Date().toISOString(),
    exchanges: await recorder.finish(),
    observation: outcome.observation,
  };
  return { target: target.name, scenario: scenario.name, problems: outcome.problems, fixture };
}

async function main(args: readonly string[]): Promise<number> {
  if (args.includes('--list')) {
    for (const group of TARGET_GROUPS) {
      console.log(`${group.name}: ${group.needs.join(' ')}${group.optional ? ` [${group.optional.join(' ')}]` : ''}`);
    }
    return 0;
  }
  const record = args.includes('--record');
  const { targets, skipped } = targetsFromEnv(process.env);
  for (const group of skipped) console.log(`SKIP  ${group.name}（没有 ${group.missing.join('、')}）`);
  let failed = 0;
  for (const target of targets) {
    for (const scenario of SCENARIOS.filter((candidate) => candidate.applies(target))) {
      const result = await runScenario(target, scenario);
      if (result.problems.length > 0) {
        failed += 1;
        console.log(`FAIL  ${result.target} ${result.scenario}`);
        for (const problem of result.problems) console.log(`      - ${problem}`);
        continue;
      }
      console.log(`PASS  ${result.target} ${result.scenario}`);
      // MCP 的往来是长连接上的事件流，录不成一问一答，不做夹具。
      if (record && result.fixture && target.kind !== 'mcp') {
        const file = fixtureFile(FIXTURES, result.target, result.scenario);
        writeFixture(file, result.fixture);
        console.log(`      录到 ${path.relative(process.cwd(), file)}`);
      }
    }
  }
  if (targets.length === 0) console.log('一个目标都没配：什么都没验证。要哪些环境变量见 live/README.md。');
  return failed > 0 ? 1 : 0;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(await main(process.argv.slice(2)));
}
