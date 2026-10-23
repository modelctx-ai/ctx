// 只给测试用：启动以后什么都不回，也不自己退出。PIDFILE 里写下自己的进程号。
import { writeFileSync } from 'node:fs';

if (process.env.PIDFILE) writeFileSync(process.env.PIDFILE, String(process.pid));
setInterval(() => {}, 1000);
process.stdin.resume();
