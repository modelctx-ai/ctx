import assert from 'node:assert/strict';

import { describe, test } from 'vite-plus/test';

import { main as memory } from './memory.ts';
import { main as moveSession } from './move-session.ts';
import { main as remoteSplit } from './remote-split.ts';
import { main as singleProcess } from './single-process.ts';
import { main as twoProcesses } from './two-processes.ts';

// 每个例子用剧本模型跑一遍：例子和代码脱节了，这里先红。
function quiet(): void {}

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
});
