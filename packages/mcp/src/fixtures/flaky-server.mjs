// 只给测试用的 stdio MCP 服务器：有的工具不回话，有的让进程退出，有的换掉工具列表再发 list_changed。
import { createInterface } from 'node:readline';

const input = { type: 'object', properties: { text: { type: 'string' } } };
const tools = [
  { name: 'echo', description: '原样返回', inputSchema: input },
  { name: 'hang', description: '收到以后不回话', inputSchema: input },
  { name: 'late', description: '过 150 毫秒才回话', inputSchema: input },
  { name: 'quit', description: '不回话，进程直接退出', inputSchema: input },
  { name: 'grow', description: '多出一个 extra 工具，发 list_changed', inputSchema: input },
];

function send(message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
}

function text(id, value) {
  send({ id, result: { content: [{ type: 'text', text: value }] } });
}

createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  switch (request.method) {
    case 'initialize':
      send({
        id: request.id,
        result: {
          protocolVersion: request.params.protocolVersion,
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: 'flaky', version: '0.0.0' },
        },
      });
      break;
    case 'tools/list':
      send({ id: request.id, result: { tools } });
      break;
    case 'tools/call': {
      const value = String(request.params.arguments?.text ?? '');
      switch (request.params.name) {
        case 'hang':
          break;
        case 'late':
          setTimeout(() => text(request.id, value), 150);
          break;
        case 'quit':
          process.exit(0);
          break;
        case 'grow':
          tools.push({ name: 'extra', description: '后来才有的', inputSchema: input });
          send({ method: 'notifications/tools/list_changed' });
          text(request.id, value);
          break;
        default:
          text(request.id, `${process.pid}:${value}`);
      }
      break;
    }
    default:
      send({ id: request.id, error: { code: -32601, message: `unknown method ${request.method}` } });
  }
});
