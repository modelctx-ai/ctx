// 最小的 stdio MCP 服务器，只给测试用：一个 echo 工具，一个 shout 工具。
import { createInterface } from 'node:readline';

const tools = [
  {
    name: 'echo',
    description: '原样返回',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  },
  {
    name: 'shout',
    description: '大写返回',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  },
];

function send(message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
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
          capabilities: { tools: {} },
          serverInfo: { name: 'echo', version: '0.0.0' },
        },
      });
      break;
    case 'tools/list':
      send({ id: request.id, result: { tools } });
      break;
    case 'tools/call': {
      const text = String(request.params.arguments?.text ?? '');
      const value = request.params.name === 'shout' ? text.toUpperCase() : `${process.env.ECHO_PREFIX ?? ''}${text}`;
      send({ id: request.id, result: { content: [{ type: 'text', text: value }] } });
      break;
    }
    default:
      send({ id: request.id, error: { code: -32601, message: `unknown method ${request.method}` } });
  }
});
