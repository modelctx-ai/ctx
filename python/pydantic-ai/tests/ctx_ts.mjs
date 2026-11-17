// Python 的测试拿它对照 TypeScript 的参考实现。用 `node --conditions=@modelctx-ai/source ctx_ts.mjs <命令>` 跑，
// 各包读 src/*.ts，不用先构建：
// - `eval`：stdin 是 `[{ fn, args }]`，stdout 是每个调用的结果（JSON 数组）。参数里的 `null` 当成不给。
// - `remote [--max-list N]`：起一个 ctx-remote（内存存储；执行环境 `local` 带回显工具 `echo`，`broken` 打不开会话），
//   打印一行 `{ baseUrl, token }`，stdin 关了就退出。
// - `run`：stdin 是 `{ baseUrl, token, request, stream? }`，用 `createRemoteHarness` 跑一轮，stdout 是 `{ result, events }`，
//   被拒绝时是 `{ thrown: { name, message, status, type } }`。
import { parseArgs } from 'node:util';

const root = new URL('../../../', import.meta.url);
const load = (path) => import(new URL(path, root).href);

async function stdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function evaluate() {
  const protocol = await load('packages/protocol/src/index.ts');
  const functions = {
    isContextOverflowText: protocol.isContextOverflowText,
    limitToolOutput: protocol.limitToolOutput,
    selectTools: protocol.selectTools,
    toolPermission: protocol.toolPermission,
    agentSpecToJson: protocol.agentSpecToJson,
    runParentProblem: protocol.runParentProblem,
    filterEntries: protocol.filterEntries,
    project: (entries) => protocol.project(entries).messages,
  };
  const calls = await stdin();
  const results = calls.map(({ fn, args }) => {
    const found = functions[fn];
    if (!found) throw new Error(`unknown function ${fn}`);
    return found(...args.map((arg) => (arg === null ? undefined : arg))) ?? null;
  });
  process.stdout.write(JSON.stringify(results));
}

async function remote(maxList) {
  const core = await load('packages/core/src/index.ts');
  const { startRemote } = await load('packages/remote/src/server.ts');
  const local = core.createFunctionExecutor('local').register(
    {
      name: 'echo',
      description: '原样返回输入',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
    },
    async (input) => ({ type: 'json', value: input }),
  );
  const broken = {
    name: 'broken',
    async tools() {
      return [{ name: 'probe', description: '要先打开会话', inputSchema: { type: 'object' }, executor: 'broken' }];
    },
    async open() {
      throw new Error('no sandbox for this session');
    },
    async execute(call) {
      return { type: 'text', text: `ran ${call.name}` };
    },
  };
  const token = 'conformance-token';
  const server = await startRemote({
    store: core.createMemoryStore(),
    executors: [local, broken],
    accessToken: token,
    ...(maxList === undefined ? {} : { maxListEntries: maxList }),
  });
  process.stdout.write(`${JSON.stringify({ baseUrl: server.baseUrl, token })}\n`);
  process.stdin.resume();
  process.stdin.on('end', () => {
    void server.close().then(() => process.exit(0));
  });
}

async function run() {
  const { createRemoteHarness } = await load('packages/remote/src/index.ts');
  const { baseUrl, token, request, stream } = await stdin();
  const harness = createRemoteHarness({ baseUrl, accessToken: token });
  const events = [];
  let result;
  try {
    if (stream) {
      for await (const event of harness.stream(request)) {
        events.push(event);
        if (event.type === 'run.ended') result = event.result;
      }
    } else {
      result = await harness.run(request);
    }
  } catch (error) {
    // 服务端拒绝（`RemoteError`）：状态码和错误类型交给 Python 那边查。
    const { name, message, status, type } = error;
    process.stdout.write(JSON.stringify({ thrown: { name, message, status, type }, events }));
    return;
  }
  process.stdout.write(JSON.stringify({ result, events }));
}

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { 'max-list': { type: 'string' } },
});
const command = positionals[0];
if (command === 'eval') await evaluate();
else if (command === 'remote') await remote(values['max-list'] === undefined ? undefined : Number(values['max-list']));
else if (command === 'run') await run();
else {
  console.error('usage: ctx_ts.mjs eval | remote [--max-list N] | run');
  process.exit(2);
}
