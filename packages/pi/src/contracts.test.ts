import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createFunctionExecutor, createMemoryStore, createToolRegistry } from '@modelctx-ai/ctx';
import {
  CTX_EVENTS,
  headSeq,
  type AgentSpec,
  type ContextSource,
  type Entry,
  type Logger,
  type SessionStore,
} from '@modelctx-ai/ctx-protocol';
import { describeHarnessContract, type ModelScript } from '@modelctx-ai/ctx-protocol/testing';
import { afterAll, describe, test, vi } from 'vite-plus/test';

import { createFakeAnthropicApi, FAKE_MODEL, type FakeAnthropicApi, type FakeAnthropicStep } from './testing.ts';
import { createPiHarness, PI_HARNESS, type PiHarness } from './index.ts';

// 对着真的 pi 跑：RPC 的命令和事件、会话、扩展、MCP 以它为准，模型换成本机的假 Anthropic 接口。
// 没装 `pi` 时跳过；`CTX_TEST_PI=required`（CI）时没装就失败。
const command = process.env['CTX_PI_COMMAND'] ?? 'pi';
function installed(): string | undefined {
  // 子进程只拿到这几个环境变量，家目录和代理目录是临时的：不读本机的设置。
  const home = mkdtempSync(join(tmpdir(), 'ctx-pi-version-'));
  const env = {
    PATH: process.env['PATH'],
    HOME: home,
    PI_CODING_AGENT_DIR: join(home, 'agent'),
    PI_OFFLINE: '1',
    PI_SKIP_VERSION_CHECK: '1',
    PI_TELEMETRY: '0',
  };
  try {
    const output = execFileSync(command, ['--version'], { encoding: 'utf8', timeout: 30_000, env, cwd: home });
    return /\d+\.\d+\.\d+\S*/.exec(output)?.[0];
  } catch {
    return undefined;
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}
const version = installed();
if (!version && process.env['CTX_TEST_PI'] === 'required') {
  throw new Error(`CTX_TEST_PI=required but "${command} --version" failed.`);
}

const roots: string[] = [];
const apis: FakeAnthropicApi[] = [];
afterAll(async () => {
  await Promise.all(apis.map((api) => api.close()));
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** 工具结果的上限调小：契约按它查截断。 */
const maxToolOutputChars = 2_000;

/**
 * 一个用例的环境：假接口、临时的家目录、代理目录（`PI_CODING_AGENT_DIR`，`models.json` 指到假接口）、会话目录和工作目录，
 * 内存存储，回显工具。子进程只拿到这里列的环境变量：不读本机的 pi 设置和凭证，也不往外发请求。
 */
async function setup(
  script: readonly FakeAnthropicStep[] | ((cwd: string) => readonly FakeAnthropicStep[]),
  options: {
    readonly tool?: string;
    readonly builtinTools?: readonly string[];
    /** 换掉缺省的回显执行环境：给一个工具目录。 */
    readonly tools?: ReturnType<typeof createToolRegistry>;
    /** 缺省 `bare`。 */
    readonly bare?: boolean;
    /** 执行环境被调到时记一笔。 */
    readonly calls?: string[];
    /** 上下文来源：拿到这次的会话日志。 */
    readonly sources?: (store: SessionStore) => readonly ContextSource[];
    readonly logger?: Logger;
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'ctx-pi-test-'));
  roots.push(root);
  const home = join(root, 'home');
  const agentDir = join(root, 'agent');
  const sessionDir = join(root, 'sessions');
  const cwd = join(root, 'work');
  for (const dir of [home, agentDir, cwd]) mkdirSync(dir, { recursive: true });
  const api = await createFakeAnthropicApi({
    script: typeof script === 'function' ? script(cwd) : script,
    ...(options.tool ? { tool: options.tool } : {}),
  });
  apis.push(api);
  writeFileSync(join(agentDir, 'models.json'), JSON.stringify(api.models));
  const store = createMemoryStore();
  const echo = createFunctionExecutor('local').register(
    {
      name: 'echo',
      description: '原样返回输入',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
    },
    (input) => {
      options.calls?.push(JSON.stringify(input));
      return { type: 'json', value: input };
    },
  );
  const harness = createPiHarness({
    store,
    ...(options.tools ? { tools: options.tools } : { executors: [echo] }),
    command,
    cwd,
    sessionDir,
    bare: options.bare ?? true,
    maxToolOutputChars,
    ...(options.builtinTools ? { builtinTools: options.builtinTools } : {}),
    ...(options.sources ? { sources: options.sources(store) } : {}),
    ...(options.logger ? { logger: options.logger } : {}),
    env: {
      PATH: process.env['PATH'],
      HOME: home,
      TMPDIR: root,
      PI_CODING_AGENT_DIR: agentDir,
      PI_OFFLINE: '1',
      PI_SKIP_VERSION_CHECK: '1',
      PI_TELEMETRY: '0',
      NO_PROXY: '127.0.0.1,localhost',
    },
  });
  const agent: AgentSpec = { model: FAKE_MODEL };
  return { api, store, harness, agent, cwd, agentDir, sessionDir };
}

// 每个用例要起一到几次 pi。
vi.setConfig({ testTimeout: 120_000 });
const slow = { describe: version ? describe : describe.skip, test };

describeHarnessContract(
  `pi ${version ?? '(not installed)'}`,
  async ({ script }: ModelScript) => {
    const { harness, store, agent } = await setup(script);
    return { harness, store, agent };
  },
  slow,
  { levels: ['trace', 'execute', 'resume', 'output'], maxToolOutputChars },
);

function started(log: readonly Entry[]): Record<string, unknown>[] {
  return log.flatMap((entry) =>
    entry.type === 'event' && entry.kind === CTX_EVENTS.runStarted ? [entry.data as Record<string, unknown>] : [],
  );
}

function ended(log: readonly Entry[]): Record<string, unknown> | undefined {
  const entry = log.findLast((item) => item.type === 'event' && item.kind === CTX_EVENTS.runEnded);
  return entry?.type === 'event' ? (entry.data as Record<string, unknown>) : undefined;
}

/** 假接口收到的第 `index` 个请求里，用户说的话（按顺序）。 */
function userTexts(api: FakeAnthropicApi, index: number): string[] {
  return (api.requests[index]?.messages ?? []).flatMap((message) => {
    if (message['role'] !== 'user') return [];
    const content = message['content'];
    if (typeof content === 'string') return [content];
    return Array.isArray(content)
      ? content.flatMap((block) => {
          const { type, text } = block as { type?: unknown; text?: unknown };
          return type === 'text' && typeof text === 'string' ? [text.trim()] : [];
        })
      : [];
  });
}

/** 条目的类型和来源：`event:<kind>`、`<role>:<source>`。 */
function shape(entry: Entry): string {
  if (entry.type === 'event') return `event:${entry.kind}`;
  if (entry.type === 'message') return `${entry.message.role}:${entry.source ?? ''}`;
  return entry.type;
}

async function runs(harness: PiHarness, store: SessionStore, agent: AgentSpec, inputs: readonly string[]) {
  const results = [];
  for (const input of inputs) results.push(await harness.run({ session: 's', agent, input }));
  return { results, log: await store.list('s') };
}

slow.describe('pi 适配器', () => {
  slow.test('ctx 的一个会话对着 pi 的一个会话：下一轮续接，模型看得到上一轮', async () => {
    const { api, harness, store, agent } = await setup([
      { type: 'text', text: '一' },
      { type: 'text', text: '二' },
    ]);
    const { results, log } = await runs(harness, store, agent, ['第一句', '第二句']);
    assert.deepEqual(
      results.map((result) => result.text),
      ['一', '二'],
    );
    const [first, second] = started(log).map((data) => data['harness'] as Record<string, unknown>);
    assert.equal(first?.['name'], PI_HARNESS);
    assert.equal(first?.['version'], version);
    assert.equal(typeof first?.['session'], 'string');
    assert.equal(second?.['session'], first?.['session'], '第二轮续接同一个会话');
    assert.deepEqual(userTexts(api, 1), ['第一句', '第二句']);
    const [start1, start2] = log.filter((entry) => entry.type === 'event' && entry.kind === CTX_EVENTS.runStarted);
    assert.equal(start1?.meta?.['pi'], undefined, '新开的会话没有 resumeAt');
    const end1 = log.find((entry) => entry.type === 'event' && entry.kind === CTX_EVENTS.runEnded);
    const last = (end1?.meta?.['pi'] as Record<string, unknown> | undefined)?.['last'];
    assert.equal(typeof last, 'string');
    assert.deepEqual(start2?.meta?.['pi'], { resumeAt: last }, '第二轮从第一轮结束的位置接着跑');
  });

  slow.test('上一轮失败、带同样的输入重试：pi 退回到失败那一轮之前，输入只出现一次', async () => {
    const { api, harness, store, agent } = await setup([
      { type: 'text', text: '一' },
      { type: 'error', message: 'network down' },
      { type: 'text', text: '二' },
      { type: 'text', text: '三' },
    ]);
    const { results, log } = await runs(harness, store, { ...agent, settings: { maxRetries: 0 } }, [
      '第一句',
      '第二句',
      '第二句',
      '第三句',
    ]);
    assert.deepEqual(
      results.map((result) => result.stopReason),
      ['end_turn', 'error', 'end_turn', 'end_turn'],
    );
    assert.deepEqual(userTexts(api, 1), ['第一句', '第二句']);
    assert.deepEqual(userTexts(api, 2), ['第一句', '第二句'], '重试的请求和失败的那次一样');
    assert.deepEqual(userTexts(api, 3), ['第一句', '第二句', '第三句'], '接在重试成功的那一支后面');
    const sessions = new Set(started(log).map((data) => (data['harness'] as Record<string, unknown>)['session']));
    assert.equal(sessions.size, 1, '一直是同一个 pi 会话');
  });

  slow.test('第一轮就失败、重试：失败的那个会话不要了，开新的', async () => {
    const { api, harness, store, agent } = await setup([
      { type: 'error', message: 'network down' },
      { type: 'text', text: '好' },
    ]);
    const { results, log } = await runs(harness, store, { ...agent, settings: { maxRetries: 0 } }, ['在吗', '在吗']);
    assert.deepEqual(
      results.map((result) => result.stopReason),
      ['error', 'end_turn'],
    );
    assert.deepEqual(userTexts(api, 1), ['在吗']);
    const [first, second] = started(log).map((data) => (data['harness'] as Record<string, unknown>)['session']);
    assert.notEqual(first, second);
  });

  slow.test(
    '一条消息里先说话再并行调两次工具：日志里是一条助手消息、一条工具结果，执行方是执行环境的名字',
    async () => {
      const { harness, store, agent } = await setup([
        {
          type: 'tool-calls',
          text: '我查两下',
          calls: [
            { id: 'call-a', input: { text: 'a' } },
            { id: 'call-b', input: { text: 'b' } },
          ],
        },
        { type: 'text', text: '好了' },
      ]);
      const result = await harness.run({ session: 's', agent, input: '查一下' });
      assert.equal(result.text, '好了');
      const log = await store.list('s');
      assert.deepEqual(log.map(shape), [
        'event:ctx.run.started',
        'user:',
        'assistant:model',
        'tool:local',
        'assistant:model',
        'event:ctx.run.ended',
      ]);
      const [, , first, results] = log;
      assert.ok(first?.type === 'message' && Array.isArray(first.message.content));
      assert.ok(results?.type === 'message' && Array.isArray(results.message.content));
      assert.deepEqual(
        first.message.content.map((part) => part.type),
        ['text', 'tool-call', 'tool-call'],
      );
      assert.deepEqual(
        results.message.content.map((part) => (part.type === 'tool-result' ? [part.id, part.output.type] : [])),
        [
          ['call-a', 'json'],
          ['call-b', 'json'],
        ],
      );
      const meta = first.meta?.['step'] as Record<string, unknown> | undefined;
      assert.equal(meta?.['step'], 0);
      assert.equal(meta?.['finishReason'], 'tool-calls');
      assert.equal(meta?.['provider'], 'fake');
      assert.equal(meta?.['modelId'], 'fake-model');
    },
  );

  slow.test(
    'tools 是 createToolRegistry() 的注册表：自带的执行环境自动带上，AgentSpec.tools 挑出交给 pi 的工具',
    async () => {
      const tools = createToolRegistry();
      const schema = { type: 'object', properties: { text: { type: 'string' } } } as const;
      tools.executor
        .register({ name: 'echo', inputSchema: schema }, (input) => ({ type: 'json', value: input }))
        .register({ name: 'hidden', inputSchema: schema }, () => ({ type: 'text', text: '不该被调' }));
      tools.add(tools.executor.definition('echo')!).add(tools.executor.definition('hidden')!);
      const { api, harness, store, agent } = await setup(
        [
          { type: 'tool-call', id: 'call-1', input: { text: '挑出来的' } },
          { type: 'text', text: '好了' },
        ],
        { tools },
      );
      const result = await harness.run({ session: 's', agent: { ...agent, tools: ['echo'] }, input: '回显一下' });
      assert.equal(result.stopReason, 'end_turn', result.error?.message);
      assert.deepEqual(api.requests[0]?.tools, ['mcp__ctx__echo'], '只交出挑出来的，pi 自带的一个都不交');
      const tool = (await store.list('s')).find((entry) => entry.type === 'message' && entry.message.role === 'tool');
      assert.equal(tool?.source, tools.executor.name);
      assert.ok(JSON.stringify(tool).includes('挑出来的'));
    },
  );

  slow.test(
    '这一轮中途会话被清掉、删到了这一轮写的条目：被围栏，以 aborted 结束，不再写；只删更早的历史照常跑',
    async () => {
      const cases = [
        ['clear', (store: SessionStore) => store.clear('s'), 'aborted'],
        ['truncate', async (store: SessionStore) => store.truncate('s', await headSeq(store, 's')), 'aborted'],
        // 只删上一轮的条目：这一轮的 started 还在。
        ['earlier', (store: SessionStore, before: number) => store.truncate('s', before), 'end_turn'],
      ] as const;
      for (const [name, erase, stopReason] of cases) {
        let wipe: (() => Promise<unknown>) | undefined;
        const tools = createToolRegistry();
        tools.executor.register(
          { name: 'echo', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
          async () => {
            await wipe?.();
            return { type: 'text', text: '删掉了' };
          },
        );
        tools.add(tools.executor.definition('echo')!);
        const { harness, store, agent } = await setup(
          [
            { type: 'text', text: '上一轮' },
            { type: 'tool-call', id: 'call-1', input: { text: 'x' } },
            { type: 'text', text: '好了' },
          ],
          { tools },
        );
        const before = (await harness.run({ session: 's', agent, input: '先说一句' })).recorded.at(-1)!.seq;
        wipe = () => erase(store, before);
        const result = await harness.run({ session: 's', agent, input: '删掉' });
        assert.equal(result.stopReason, stopReason, `${name}: ${result.error?.message ?? ''}`);
        const kinds = (await store.list('s')).map((entry) => (entry.type === 'event' ? entry.kind : entry.type));
        if (name === 'clear') assert.deepEqual(kinds, [], '会话不会被写回来');
        if (name === 'truncate') assert.deepEqual(kinds, [CTX_EVENTS.erased], '只剩擦除记录');
        if (name === 'earlier') assert.equal(kinds.at(-1), CTX_EVENTS.runEnded);
      }
    },
  );

  slow.test('pi 自带的工具：调用和结果记进日志，执行方是 pi', async () => {
    const { api, harness, store, agent, cwd } = await setup(
      (dir) => [
        { type: 'tool-call', id: 'call-read', input: { path: join(dir, 'note.txt') } },
        { type: 'text', text: '读完了' },
      ],
      { tool: 'read', builtinTools: ['read'] },
    );
    writeFileSync(join(cwd, 'note.txt'), 'ctx-builtin-marker');
    const result = await harness.run({ session: 's', agent, input: '读一下 note.txt' });
    assert.equal(result.stopReason, 'end_turn', result.error?.message);
    assert.equal(result.text, '读完了');
    assert.deepEqual((api.requests[0]?.tools ?? []).toSorted(), ['mcp__ctx__echo', 'read']);
    const log = await store.list('s');
    const tool = log.find((entry) => entry.type === 'message' && entry.message.role === 'tool');
    assert.equal(tool?.source, PI_HARNESS);
    assert.ok(JSON.stringify(tool).includes('ctx-builtin-marker'), '结果里有文件内容');
    const call = log.find((entry) => entry.type === 'message' && entry.message.role === 'assistant');
    assert.ok(JSON.stringify(call).includes('"name":"read"'));
  });

  slow.test('permissions 里 deny 的工具照样交给模型，调用时回拒绝，执行环境没被调到', async () => {
    const calls: string[] = [];
    const { api, harness, store, agent } = await setup(
      [
        { type: 'tool-call', id: 'call-1', input: { text: '不许' } },
        { type: 'text', text: '被拒绝了' },
      ],
      { calls },
    );
    const result = await harness.run({
      session: 's',
      agent: { ...agent, permissions: { tools: { echo: 'deny' } } },
      input: '回显一下',
    });
    assert.equal(result.stopReason, 'end_turn', result.error?.message);
    assert.deepEqual(api.requests[0]?.tools, ['mcp__ctx__echo']);
    assert.deepEqual(calls, []);
    const tool = (await store.list('s')).find((entry) => entry.type === 'message' && entry.message.role === 'tool');
    assert.ok(tool?.type === 'message' && Array.isArray(tool.message.content));
    const [part] = tool.message.content;
    assert.equal(part?.type === 'tool-result' && part.output.type, 'error');
    assert.match(JSON.stringify(part), /Tool call \\"echo\\" was denied by the agent's permissions\./);
  });

  slow.test('maxSteps 用完：这一步的工具照样执行、结果记下，不再调模型，stopReason 是 max_steps', async () => {
    const { api, harness, store, agent } = await setup([
      { type: 'tool-call', id: 'call-1', input: { text: 'one' } },
      { type: 'text', text: '不该调到' },
    ]);
    const result = await harness.run({ session: 's', agent: { ...agent, maxSteps: 1 }, input: '回显一下' });
    assert.equal(result.stopReason, 'max_steps', result.error?.message);
    assert.equal(api.requests.length, 1);
    const log = await store.list('s');
    assert.deepEqual(log.map(shape), [
      'event:ctx.run.started',
      'user:',
      'assistant:model',
      'tool:local',
      'event:ctx.run.ended',
    ]);
    assert.equal(ended(log)?.['stopReason'], 'max_steps');
  });

  slow.test('budget 超了：这一步调了工具就停，stopReason 是 max_budget', async () => {
    const { api, harness, agent } = await setup([
      { type: 'tool-call', id: 'call-1', input: { text: 'one' } },
      { type: 'text', text: '不该调到' },
    ]);
    const result = await harness.run({
      session: 's',
      agent: { ...agent, budget: { maxTotalTokens: 10 } },
      input: '回显',
    });
    assert.equal(result.stopReason, 'max_budget', result.error?.message);
    assert.equal(api.requests.length, 1);
  });

  slow.test('映射不了的 AgentSpec 字段：以 invalid_request 结束，不调模型', async () => {
    const { api, harness, store, agent } = await setup([{ type: 'text', text: '不该说' }]);
    for (const settings of [{ temperature: 0 }, { maxRetries: 2 }, { maxOutputTokens: 100 }]) {
      const result = await harness.run({ session: 's', agent: { ...agent, settings }, input: '在吗' });
      assert.equal(result.stopReason, 'error');
      assert.equal(result.error?.type, 'invalid_request');
      assert.match(result.error?.message ?? '', new RegExp(Object.keys(settings)[0]!));
    }
    assert.equal(api.requests.length, 0);
    assert.equal(ended(await store.list('s'))?.['stopReason'], 'error');
  });

  slow.test(
    '上下文来源：记下输入之后收，事实接在指令后面；不进日志、不进 pi 的会话；facts 挑来源、加标题，false 不收',
    async () => {
      const warnings: string[] = [];
      const logger: Logger = { warn: (message) => warnings.push(message) };
      const { api, harness, store, agent } = await setup(
        [
          { type: 'text', text: '一' },
          { type: 'text', text: '二' },
          { type: 'text', text: '三' },
        ],
        {
          logger,
          sources: (log) => [
            {
              // 和记忆的来源一样：按会话最后一条用户消息取。
              name: 'notes',
              async collect({ session }) {
                const last = (await log.list(session)).findLast(
                  (entry) => entry.type === 'message' && entry.message.role === 'user',
                );
                return last?.type === 'message' ? `ctx-fact：${JSON.stringify(last.message.content)}` : null;
              },
            },
            { name: 'other', collect: () => 'ctx-other-fact' },
            {
              name: 'broken',
              collect: () => {
                throw new Error('boom');
              },
            },
          ],
        },
      );
      const instructions = 'ctx-instructions-marker';
      const first = await harness.run({ session: 's', agent: { ...agent, instructions }, input: '第一轮' });
      assert.equal(first.stopReason, 'end_turn', first.error?.message);
      const system = api.requests[0]?.system ?? '';
      assert.match(system, /ctx-fact："第一轮"/, '来源看得到这一轮的输入');
      assert.match(system, /ctx-other-fact/);
      assert.ok(system.indexOf(instructions) < system.indexOf('ctx-fact'), '事实接在指令后面');
      assert.ok(warnings.includes('context source "broken" failed'), '出错的来源只告警');

      const second = await harness.run({
        session: 's',
        agent: { ...agent, context: { facts: { sources: ['notes', 'missing'], heading: 'ctx-heading：' } } },
        input: '第二轮',
      });
      assert.equal(second.stopReason, 'end_turn', second.error?.message);
      assert.match(api.requests[1]?.system ?? '', /ctx-heading：\nctx-fact："第二轮"/);
      assert.doesNotMatch(api.requests[1]?.system ?? '', /ctx-other-fact/);
      assert.ok(warnings.includes('context source "missing" is not registered'));

      const third = await harness.run({
        session: 's',
        agent: { ...agent, context: { facts: false } },
        input: '第三轮',
      });
      assert.equal(third.stopReason, 'end_turn', third.error?.message);
      assert.doesNotMatch(api.requests[2]?.system ?? '', /ctx-fact|ctx-other-fact/);
      // 事实只在那一次的系统提示里：pi 的会话（第三轮交给模型的历史）和 ctx 的日志里都没有。
      assert.match(JSON.stringify(api.requests[2]?.messages), /第一轮/);
      assert.doesNotMatch(JSON.stringify(api.requests[2]?.messages), /ctx-fact|ctx-other-fact/);
      assert.doesNotMatch(JSON.stringify(await store.list('s')), /ctx-fact|ctx-other-fact/);
    },
  );

  slow.test('AgentSpec.context 只认 facts，事实不能放进 prompt：别的以 invalid_request 结束，不调模型', async () => {
    const { api, harness, agent } = await setup([{ type: 'text', text: '不该说' }], {
      sources: () => [{ name: 'notes', collect: () => 'ctx-fact' }],
    });
    const cases: [AgentSpec['context'], RegExp][] = [
      [{ projection: 'default' }, /context\.projection/],
      [{ facts: true, overflow: { maxTokens: 1000 } }, /context\.overflow/],
      [{ facts: { placement: 'prompt' } }, /placement "prompt"/],
    ];
    for (const [context, message] of cases) {
      const result = await harness.run({ session: 's', agent: { ...agent, context }, input: '在吗' });
      assert.equal(result.stopReason, 'error');
      assert.equal(result.error?.type, 'invalid_request');
      assert.match(result.error?.message ?? '', message);
    }
    const windowed = await harness.run({
      session: 's',
      agent: { ...agent, window: { maxMessages: 4 } },
      input: '在吗',
    });
    assert.equal(windowed.error?.type, 'invalid_request');
    assert.equal(api.requests.length, 0);
  });

  slow.test('中途取消：中断 pi，以 aborted 结束，日志里有 ctx.run.ended', async () => {
    const { harness, store, agent } = await setup([{ type: 'text', text: '太慢了', delayMs: 20_000 }]);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 1_500);
    const begun = Date.now();
    const result = await harness.run({ session: 's', agent, input: '在吗', signal: controller.signal });
    assert.equal(result.stopReason, 'aborted');
    assert.ok(Date.now() - begun < 15_000, '没有等模型答完');
    assert.equal(ended(await store.list('s'))?.['stopReason'], 'aborted');
  });

  slow.test('排队时取消：以 aborted 结束，什么都不写，也不挡后面的运行；流里先 run.started 后 run.ended', async () => {
    const { harness, store, agent } = await setup([
      { type: 'text', text: '一' },
      { type: 'text', text: '三' },
    ]);
    const first = harness.run({ session: 's', agent, input: '一' });
    const controller = new AbortController();
    const queued = harness.run({ session: 's', agent, input: '二', signal: controller.signal });
    const streamed = (async () => {
      const events: string[] = [];
      for await (const event of harness.stream({ session: 's', agent, input: '二', signal: controller.signal })) {
        events.push(event.type === 'run.ended' ? `run.ended:${event.result.stopReason}` : event.type);
      }
      return events;
    })();
    const third = harness.run({ session: 's', agent, input: '三' });
    controller.abort();
    const skipped = await queued;
    assert.equal(skipped.stopReason, 'aborted');
    assert.deepEqual(skipped.recorded, []);
    assert.deepEqual(await streamed, ['run.started', 'run.ended:aborted']);
    assert.deepEqual([(await first).text, (await third).text], ['一', '三']);
    const log = await store.list('s');
    assert.deepEqual(
      log.flatMap((entry) =>
        entry.type === 'message' && entry.message.role === 'user' ? [entry.message.content] : [],
      ),
      ['一', '三'],
    );
    assert.equal(started(log).length, 2);
  });

  slow.test('settings.timeoutMs 到了：以 error 结束，error.type 是 timeout', async () => {
    const { harness, agent } = await setup([{ type: 'text', text: '太慢了', delayMs: 20_000 }]);
    const result = await harness.run({
      session: 's',
      agent: { ...agent, settings: { timeoutMs: 1_500 } },
      input: '在吗',
    });
    assert.equal(result.stopReason, 'error');
    assert.equal(result.error?.type, 'timeout');
    assert.equal(result.error?.retryable, true);
  });

  slow.test('record: false：看得到上一轮，自己不写日志，pi 的会话也不变', async () => {
    const { api, harness, store, agent, sessionDir } = await setup([
      { type: 'text', text: '一' },
      { type: 'text', text: '不记' },
      { type: 'text', text: '三' },
    ]);
    await harness.run({ session: 's', agent, input: '第一句' });
    const files = readdirSync(sessionDir);
    const before = await store.list('s');
    const quiet = await harness.run({ session: 's', agent, input: '这句不记', record: false });
    assert.equal(quiet.text, '不记');
    assert.deepEqual(quiet.recorded, []);
    assert.deepEqual(await store.list('s'), before);
    assert.deepEqual(userTexts(api, 1), ['第一句', '这句不记'], '看得到上一轮');
    assert.deepEqual(readdirSync(sessionDir), files, '副本跑完删了');
    await harness.run({ session: 's', agent, input: '第三句' });
    assert.deepEqual(userTexts(api, 2), ['第一句', '第三句'], '不记的那一轮不在 pi 的会话里');
  });

  slow.test('pi 的会话不在了：以 not_found 结束，不调模型', async () => {
    const { api, harness, store, agent, sessionDir } = await setup([
      { type: 'text', text: '一' },
      { type: 'text', text: '不该说' },
    ]);
    await harness.run({ session: 's', agent, input: '第一句' });
    rmSync(sessionDir, { recursive: true, force: true });
    const result = await harness.run({ session: 's', agent, input: '第二句' });
    assert.equal(result.stopReason, 'error');
    assert.equal(result.error?.type, 'not_found');
    assert.equal(api.requests.length, 1);
    assert.equal(ended(await store.list('s'))?.['stopReason'], 'error');
  });

  slow.test('pi 的 mcp.json 里有同名的 ctx 服务器：以 error 结束、说明原因，不记模型的回答', async () => {
    const { harness, store, agent, agentDir } = await setup([{ type: 'text', text: '没有工具' }]);
    writeFileSync(
      join(agentDir, 'mcp.json'),
      JSON.stringify({ mcpServers: { ctx: { url: 'http://127.0.0.1:9/mcp', exposure: 'direct' } } }),
    );
    const result = await harness.run({ session: 's', agent, input: '在吗' });
    assert.equal(result.stopReason, 'error');
    assert.match(result.error?.message ?? '', /mcp\.json/);
    assert.deepEqual((await store.list('s')).map(shape), [
      'event:ctx.run.started',
      'user:',
      'event:ctx.error',
      'event:ctx.run.ended',
    ]);
  });

  slow.test('output：回答包在代码块里也认；不是 JSON 的以 invalid_output 结束', async () => {
    const { api, harness, agent } = await setup([
      { type: 'text', text: '```json\n{"answer": 42}\n```' },
      { type: 'text', text: '答案是四十二' },
    ]);
    const output = { schema: { type: 'object', properties: { answer: { type: 'number' } }, required: ['answer'] } };
    const good = await harness.run({ session: 's', agent: { ...agent, output }, input: '答案？' });
    assert.equal(good.stopReason, 'end_turn', good.error?.message);
    assert.deepEqual(good.output, { answer: 42 });
    assert.match(api.requests[0]?.system ?? '', /"answer"/, 'schema 在系统提示里');
    const bad = await harness.run({ session: 't', agent: { ...agent, output }, input: '答案？' });
    assert.equal(bad.stopReason, 'error');
    assert.equal(bad.error?.type, 'invalid_output');
  });

  slow.test('instructions 接在 pi 的系统提示后面；输出被截断是 max_tokens；推理记成 reasoning', async () => {
    const { api, harness, store, agent } = await setup([
      { type: 'text', text: '写到一半', truncated: true, reasoning: '先想一想' },
    ]);
    const result = await harness.run({
      session: 's',
      agent: { ...agent, instructions: 'ctx-instructions-marker：只说中文。' },
      input: '写一篇长文',
    });
    assert.equal(result.stopReason, 'max_tokens');
    assert.equal(result.text, '写到一半');
    assert.match(api.requests[0]?.system ?? '', /ctx-instructions-marker/);
    const assistant = (await store.list('s')).find(
      (entry) => entry.type === 'message' && entry.message.role === 'assistant',
    );
    assert.ok(assistant?.type === 'message' && Array.isArray(assistant.message.content));
    const [reasoning] = assistant.message.content;
    assert.equal(reasoning?.type, 'reasoning');
    assert.equal(reasoning?.type === 'reasoning' && reasoning.text, '先想一想');
    assert.ok(reasoning?.type === 'reasoning' && reasoning.providerOptions?.['pi'], '签名留在 providerOptions.pi 里');
    const step = assistant.meta?.['step'] as Record<string, unknown> | undefined;
    assert.equal(step?.['finishReason'], 'length');
  });

  slow.test('不 bare：pi 读工作目录里的 AGENTS.md', async () => {
    const { api, harness, agent, cwd } = await setup([{ type: 'text', text: '好' }], { bare: false });
    writeFileSync(join(cwd, 'AGENTS.md'), 'ctx-agents-md-marker');
    const result = await harness.run({ session: 's', agent, input: '在吗' });
    assert.equal(result.stopReason, 'end_turn', result.error?.message);
    assert.match(api.requests[0]?.system ?? '', /ctx-agents-md-marker/);
    assert.ok(existsSync(cwd));
  });
});
