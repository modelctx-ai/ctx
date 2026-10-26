// 测试用的子进程：打开 argv[2] 的库，等到 argv[5] 这个时刻（毫秒时间戳，让几个进程同时出手），
// 往会话 argv[3] 带 `expectSeq: argv[4]` 写一条事件。成功打印 `ok`，前提不满足打印 `conflict`，别的错误打印错误本身。
// 由 Node 直接跑（类型剥离），带 `--conditions=@modelctx-ai/source`，让协议包解析到源码而不是还没构建的 dist。
import { createSqliteStore } from '../index.ts';

const [path, session, expectSeq, startAt] = process.argv.slice(2);
const store = createSqliteStore({ path: path! });
while (Date.now() < Number(startAt)) {
  // 忙等到约定的时刻。
}
try {
  await store.append(session!, [{ type: 'event', kind: 'test.claim', text: String(process.pid) }], {
    expectSeq: Number(expectSeq),
  });
  console.log('ok');
} catch (error) {
  console.log((error as { type?: string }).type === 'conflict' ? 'conflict' : String(error));
}
store.close();
