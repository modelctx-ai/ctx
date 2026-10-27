// 测试用的子进程：打开 argv[2] 的库，等到 argv[5]（毫秒时刻）再开始，对事实 argv[3] 逐次写 argv[4] 轮：
// 一条笔记、一次 touch、一段新证据（cite）、一个 core 版本。每轮各是一次单独的写事务，和别的进程交错。
// 由 Node 直接跑（类型剥离），带 `--conditions=@modelctx-ai/source`。
import { createSqliteMemoryStore } from '../memory.ts';

const [path, factId, count, startAt] = process.argv.slice(2);
const store = createSqliteMemoryStore({ path: path! });
await new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(startAt) - Date.now())));
for (let i = 0; i < Number(count); i++) {
  await store.notes.add([{ session: `p${process.pid}`, from: i + 1, upTo: i + 1, at: i, salience: 0.5 }]);
  await store.facts.touch([factId!], i);
  await store.facts.cite(factId!, [{ session: `p${process.pid}`, from: i + 1, upTo: i + 1 }]);
  await store.core.set(`p${process.pid}:${i}`, i);
}
store.close();
