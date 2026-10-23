// 只给测试用：能完成初始化，但不声明 tools 能力（比如只提供资源的服务器）。PIDFILE 里写下自己的进程号。
import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

if (process.env.PIDFILE) writeFileSync(process.env.PIDFILE, String(process.pid));

function send(message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
}

createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  if (request.method === 'initialize') {
    send({
      id: request.id,
      result: {
        protocolVersion: request.params.protocolVersion,
        capabilities: { resources: {} },
        serverInfo: { name: 'resources-only', version: '0.0.0' },
      },
    });
  } else {
    send({ id: request.id, error: { code: -32601, message: `unknown method ${request.method}` } });
  }
});
