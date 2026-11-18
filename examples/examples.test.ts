import assert from 'node:assert/strict';

import { describe, test } from 'vite-plus/test';

import { claudeCodeInstalled, main as claudeCode } from './claude-code.ts';
import { main as memory } from './memory.ts';
import { main as memoryPi } from './memory-pi.ts';
import { main as moveSession } from './move-session.ts';
import { main as pi, piInstalled } from './pi.ts';
import { main as pydanticAI, uvInstalled } from './pydantic-ai.ts';
import { main as remoteSplit } from './remote-split.ts';
import { main as singleProcess } from './single-process.ts';
import { main as twoProcesses } from './two-processes.ts';

// 每个例子用剧本模型跑一遍：例子和代码脱节了，这里先红。
function quiet(): void {}

// claude-code.ts 要装 Claude Code：没装就跳过，`CTX_TEST_CLAUDE_CODE=required`（CI 的 Claude Code 作业）时没装就失败。
const hasClaudeCode = claudeCodeInstalled();
if (!hasClaudeCode && process.env['CTX_TEST_CLAUDE_CODE'] === 'required') {
  throw new Error('CTX_TEST_CLAUDE_CODE=required but Claude Code is not installed.');
}

// pi.ts 要装 pi：没装就跳过，`CTX_TEST_PI=required`（CI 的 pi 作业）时没装就失败。
const hasPi = piInstalled();
if (!hasPi && process.env['CTX_TEST_PI'] === 'required') {
  throw new Error('CTX_TEST_PI=required but pi is not installed.');
}

// pydantic-ai.ts 要装 uv：没装就跳过，`CTX_TEST_PYDANTIC_AI=required`（CI 的 pydantic-ai 作业）时没装就失败。
const hasUv = uvInstalled();
if (!hasUv && process.env['CTX_TEST_PYDANTIC_AI'] === 'required') {
  throw new Error('CTX_TEST_PYDANTIC_AI=required but uv is not installed.');
}

describe('examples', () => {
  test('single-process：SQLite 加一个模型，带工具', async () => {
    assert.match(await singleProcess(quiet), /带把伞/);
  });

  test('remote-split：存储和执行环境各在一个服务后面', async () => {
    assert.match(await remoteSplit(quiet), /11 个字符/);
  });

  test('two-processes：别人没结束的运行挡住提交，只有它自己的 recover 能收走', async () => {
    const lines = await twoProcesses(quiet);
    assert.match(lines[0]!, /error（session_busy）/);
    assert.match(lines[1]!, /收走 0 个/);
    assert.match(lines[2]!, /收走 run-crashed/);
    assert.match(lines[3]!, /end_turn，回答「在的。」/);
    assert.match(
      lines[4]!,
      /^生命周期事件：ctx\.run\.started\(run-crashed\) → ctx\.run\.ended\(run-crashed\) → ctx\.run\.started/,
    );
  });

  test('memory：一个会话里说的事，另一个会话的上下文里有', async () => {
    assert.match(await memory(quiet), /花生过敏/);
  });

  test('move-session：内存、SQLite、远端三个实现之间搬会话，上下文不变', async () => {
    const [memoryView, sqliteView, remoteView] = await moveSession(quiet);
    assert.equal(memoryView!.length, 3, '摘要加摘要之后的一问一答');
    assert.match(memoryView![0]!, /周三要见客户/);
    assert.deepEqual(sqliteView, memoryView);
    assert.deepEqual(remoteView, memoryView);
  });

  test.skipIf(!hasClaudeCode)(
    'claude-code：Claude Code 跑循环，ctx 的工具经 MCP 回到 ctx，第二轮续接它自己的会话',
    { timeout: 120_000 },
    async () => {
      const result = await claudeCode(quiet);
      assert.ok(result);
      assert.match(result.answers[0]!, /带把伞/);
      assert.match(result.answers[1]!, /不用带伞/);
      assert.equal(result.sessions.length, 2);
      assert.ok(result.sessions[0]);
      assert.equal(result.sessions[1], result.sessions[0]);
      assert.deepEqual(result.toolSources, ['local', 'local']);
    },
  );

  test.skipIf(!hasPi)(
    'pi：pi 跑循环，ctx 的工具经 MCP 回到 ctx，第二轮续接它自己的会话',
    { timeout: 120_000 },
    async () => {
      const result = await pi(quiet);
      assert.ok(result);
      assert.match(result.answers[0]!, /带把伞/);
      assert.match(result.answers[1]!, /不用带伞/);
      assert.equal(result.sessions.length, 2);
      assert.ok(result.sessions[0]);
      assert.equal(result.sessions[1], result.sessions[0]);
      assert.deepEqual(result.toolSources, ['local', 'local']);
    },
  );

  test.skipIf(!hasPi)(
    'memory-pi：pi 跑的会话照样进记忆，记忆经来源和 recall 工具回到 pi',
    { timeout: 120_000 },
    async () => {
      const result = await memoryPi(quiet);
      assert.ok(result);
      assert.equal(result.notes, 1);
      assert.equal(result.facts, 1);
      assert.ok(result.injected, '第二个会话的系统提示里有画像');
      assert.equal(result.recallSource, 'memory');
      assert.ok(result.recalled, 'recall 查到的事实回到了模型');
      assert.match(result.answer, /不放花生/);
    },
  );

  test.skipIf(!hasUv)(
    'pydantic-ai：Python 的 harness 经线上协议跑，日志和工具在 ctx-remote 里',
    { timeout: 300_000 },
    async () => {
      const result = await pydanticAI(quiet);
      assert.ok(result);
      for (const answer of result.answers) assert.match(answer, /傍晚有阵雨/);
      assert.deepEqual(result.harnesses, ['pydantic-ai', 'pydantic-ai']);
      // 第二轮的历史从日志来，`test` 模型在里面看到了上一轮的工具结果，不再调工具。
      assert.deepEqual(result.toolSources, ['local']);
    },
  );
});
