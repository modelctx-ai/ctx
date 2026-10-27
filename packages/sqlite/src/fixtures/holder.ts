// 测试用的子进程：打开 argv[2] 的库（新库，rollback 模式），用 BEGIN IMMEDIATE 拿着写锁等 argv[3] 毫秒再提交。
// 拿到锁后打印 `ready`。模拟「别的进程正占着写锁」，看 createSqliteStore 开库切 WAL 时等不等。
import { DatabaseSync } from 'node:sqlite';

const [path, holdMs] = process.argv.slice(2);
const database = new DatabaseSync(path!);
database.exec('CREATE TABLE IF NOT EXISTS holder (x)');
database.exec('BEGIN IMMEDIATE');
database.exec('INSERT INTO holder VALUES (1)');
console.log('ready');
await new Promise((resolve) => setTimeout(resolve, Number(holdMs)));
database.exec('COMMIT');
database.close();
