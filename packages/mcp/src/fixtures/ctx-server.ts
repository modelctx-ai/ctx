// 只给测试用：用 serveMcpStdio 把一个函数执行环境当 stdio MCP 服务器跑起来。
// 由测试以 `node --conditions=@modelctx-ai/source` 起，读各包的源码。
import { createFunctionExecutor } from '@modelctx-ai/ctx';

import { createMcpServer, serveMcpStdio } from '../server.ts';

const box = createFunctionExecutor('box').register(
  {
    name: 'where',
    description: '回答这次调用记在哪个会话',
    inputSchema: { type: 'object', properties: {} },
  },
  (_input, context) => ({ type: 'text', text: `${context.session}/${context.runId ?? ''}` }),
);

await serveMcpStdio(
  createMcpServer({ executors: [box], context: { session: process.env.CTX_SESSION ?? 's', runId: 'r1' } }),
);
