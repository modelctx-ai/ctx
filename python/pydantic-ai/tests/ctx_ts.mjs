// Python 的测试拿它对照 TypeScript 的参考实现。用 `node --conditions=@modelctx-ai/source ctx_ts.mjs <命令>` 跑，
// 各包读 src/*.ts，不用先构建：
// - `eval`：stdin 是 `[{ fn, args }]`，stdout 是每个调用的结果（JSON 数组）。参数里的 `null` 当成不给。
// - `remote [--max-list N]`：起一个 ctx-remote（内存存储；执行环境 `local` 带回显工具 `echo`，`broken` 打不开会话），
//   打印一行 `{ baseUrl, token }`，stdin 关了就退出。
// - `run`：stdin 是 `{ baseUrl, token, request, stream? }`，用 `createRemoteHarness` 跑一轮，stdout 是 `{ result, events }`，
//   被拒绝时是 `{ thrown: { name, message, status, type } }`。
// - `pending`：stdin 是 `{ baseUrl, token, session, executor }`，用 `runPendingTools` 把会话里等着的调用交给 ctx-remote 上的
//   那个执行环境、结果追加进会话，stdout 是 `{ executed, remaining }`。
// - `claim`：stdin 是 `{ baseUrl, token, executor }`，用 `createRemoteWorker` 按执行环境的名字领一次工作（不给会话名），
//   交给 ctx-remote 上同名的执行环境执行、结果追加回各自的会话，stdout 是 `{ executed, failed }`。
// - `compact`：stdin 是一组 `{ entries, options, script?, window?, now?, tick? }`，每一组的条目写进一个新的内存存储的会话
//   `s`，用 builder 的 `compactDetailed` 压一次，stdout 是每一组的 `{ result, thrown?, log, seen }`。摘要模型按剧本回答
//   （见 `summarizer`），`seen` 是每次交给它的 `{ system, prompt }`；钟从 `now` 开始，每次调摘要模型走 `tick` 毫秒，存储和
//   builder 用同一个钟。
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
    projectWindow: (entries, window) => {
      const { messages, tokens, dropped, truncated } = protocol.project(entries, { window });
      return { messages, tokens, dropped, truncated };
    },
    estimateTextTokens: protocol.estimateTextTokens,
    estimateFileTokens: protocol.estimateFileTokens,
    estimateTokens: protocol.estimateTokens,
    truncateText: protocol.truncateText,
    truncateMessage: protocol.truncateMessage,
    pendingToolCalls: protocol.pendingToolCalls,
    toolResultEntry: protocol.toolResultEntry,
    toolApprovalEntry: protocol.toolApprovalEntry,
    approvalDeniedOutput: protocol.approvalDeniedOutput,
    isFenced: protocol.isFenced,
    endedInFailure: protocol.endedInFailure,
    repeatsFailedInput: protocol.repeatsFailedInput,
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

async function pending() {
  const { runPendingTools } = await load('packages/core/src/index.ts');
  const { createRemoteExecutor, createRemoteSessionStore } = await load('packages/remote/src/index.ts');
  const { baseUrl, token, session, executor } = await stdin();
  const options = { baseUrl, accessToken: token };
  const result = await runPendingTools(createRemoteSessionStore(options), session, {
    executor: createRemoteExecutor({ ...options, name: executor }),
  });
  process.stdout.write(JSON.stringify(result));
}

async function claim() {
  const { createRemoteExecutor, createRemoteWorker } = await load('packages/remote/src/index.ts');
  const { baseUrl, token, executor } = await stdin();
  const options = { baseUrl, accessToken: token };
  const worker = createRemoteWorker({ ...options, executor: createRemoteExecutor({ ...options, name: executor }) });
  process.stdout.write(JSON.stringify(await worker.step()));
}

/** 摘要模型说输入太长时的报错，照 OpenAI 兼容接口的说法（`isContextOverflowError` 认得）。 */
const TOO_LONG = "This model's maximum context length is 2048 tokens. However, your messages resulted in 9000 tokens.";

/**
 * 按剧本回答的摘要模型：第 n 次调用（从 0 数，被拒的也算）回 `script[n]`，没有就回 `摘要 n+1`。一步是
 * `{ type: 'text', text, truncated? }`、`{ type: 'error', message }` 或 `{ type: 'too-long' }`；给了 `window` 时
 * 指令和记录合起来的估算 token 超过它的一律当 `too-long`。
 */
function summarizer(protocol, { script, window, tick, clock, seen }) {
  const usage = {
    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 },
  };
  return {
    specificationVersion: 'v4',
    provider: 'scripted',
    modelId: 'summarizer',
    supportedUrls: {},
    async doGenerate(call) {
      let system = '';
      let prompt = '';
      for (const message of call.prompt) {
        if (message.role === 'system') system += message.content;
        else if (message.role === 'user') {
          for (const part of message.content) if (part.type === 'text') prompt += part.text;
        }
      }
      const index = seen.length;
      seen.push({ system, prompt });
      clock.now += tick;
      const tokens = protocol.estimateTextTokens(system) + protocol.estimateTextTokens(prompt);
      const step =
        window != null && tokens > window
          ? { type: 'too-long' }
          : (script[index] ?? { type: 'text', text: `摘要 ${index + 1}` });
      if (step.type === 'too-long') throw new Error(TOO_LONG);
      if (step.type === 'error') throw new Error(step.message);
      const finish = step.truncated ? 'length' : 'stop';
      return {
        content: [{ type: 'text', text: step.text }],
        finishReason: { unified: finish, raw: finish },
        usage,
        warnings: [],
      };
    },
    async doStream() {
      throw new Error('the scripted summarizer does not stream');
    },
  };
}

async function compact() {
  const core = await load('packages/core/src/index.ts');
  const protocol = await load('packages/protocol/src/index.ts');
  const outputs = [];
  for (const one of await stdin()) outputs.push(await compactOnce(core, protocol, one));
  process.stdout.write(JSON.stringify(outputs));
}

async function compactOnce(
  core,
  protocol,
  { entries, options = {}, script = [], window = null, now: start = 0, tick = 0 },
) {
  const clock = { now: start };
  const now = () => clock.now;
  const seen = [];
  const store = core.createMemoryStore({ now });
  await store.append('s', entries);
  const model = summarizer(protocol, { script, window, tick, clock, seen });
  const builder = core.createContextBuilder({ store, model, now });
  let result;
  let thrown;
  try {
    result = await builder.compactDetailed('s', options);
  } catch (error) {
    thrown = { message: error.message, type: error.type };
  }
  return { result, thrown, log: await store.list('s'), seen };
}

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { 'max-list': { type: 'string' } },
});
const command = positionals[0];
if (command === 'eval') await evaluate();
else if (command === 'remote') await remote(values['max-list'] === undefined ? undefined : Number(values['max-list']));
else if (command === 'run') await run();
else if (command === 'pending') await pending();
else if (command === 'claim') await claim();
else if (command === 'compact') await compact();
else {
  console.error('usage: ctx_ts.mjs eval | remote [--max-list N] | run | pending | claim | compact');
  process.exit(2);
}
