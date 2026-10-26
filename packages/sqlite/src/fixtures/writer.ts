// 测试用的子进程：打开 argv[2] 的库，往会话 argv[3] 逐条写 argv[4] 条。
// 由 Node 直接跑（类型剥离），所以只能引 ../index.ts，不能引需要 `@modelctx-ai/source` 条件的包。
import { createSqliteStore } from '../index.ts';

const [path, session, count] = process.argv.slice(2);
const store = createSqliteStore({ path: path! });
for (let i = 0; i < Number(count); i++) {
  await store.append(session!, [{ type: 'event', kind: 'test.write', text: `${session}:${i}` }]);
}
store.close();
