import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createFunctionExecutor, createMemoryStore, createToolRegistry } from '@modelctx-ai/ctx';
import {
  childRunsOf,
  CTX_EVENTS,
  type AgentSpec,
  type ContextSource,
  type Entry,
  type Logger,
  type SessionStore,
} from '@modelctx-ai/ctx-protocol';
import { describeHarnessContract, type ModelScript } from '@modelctx-ai/ctx-protocol/testing';
import { afterAll, describe, test, vi } from 'vite-plus/test';

import { createFakeAnthropicApi, type FakeAnthropicApi, type FakeAnthropicStep } from './testing.ts';
import { CLAUDE_CODE_HARNESS, createClaudeCodeHarness, type ClaudeCodeHarness } from './index.ts';

// 对着真的 Claude Code 跑：`claude` 的接口（stream-json、续接会话、MCP）以它为准，模型换成本机的假 Anthropic 接口。
// 没装 `claude` 时跳过；`CTX_TEST_CLAUDE_CODE=required`（CI）时没装就失败。
const command = process.env['CTX_CLAUDE_CODE_COMMAND'] ?? 'claude';
function installed(): string | undefined {
  // 子进程只拿到这几个环境变量，家目录和配置目录是临时的：不读也不改本机的设置。
  const home = mkdtempSync(join(tmpdir(), 'ctx-claude-code-version-'));
  const env = {
    PATH: process.env['PATH'],
    HOME: home,
    CLAUDE_CONFIG_DIR: join(home, '.claude'),
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
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
if (!version && process.env['CTX_TEST_CLAUDE_CODE'] === 'required') {
  throw new Error(`CTX_TEST_CLAUDE_CODE=required but "${command} --version" failed.`);
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
 * 一个用例的环境：假接口、临时的家目录和工作目录、内存存储、回显工具。子进程只拿到这里列的环境变量：
 * 不读本机的 Claude Code 设置和凭证（`CLAUDE_CONFIG_DIR` 指到临时目录），也不往外发请求。
 */
async function setup(
  script: readonly FakeAnthropicStep[] | ((cwd: string) => readonly FakeAnthropicStep[]),
  options: {
    readonly tool?: string;
    readonly builtinTools?: readonly string[];
    /** 换掉缺省的回显执行环境：给一个工具目录。 */
    readonly tools?: ReturnType<typeof createToolRegistry>;
    /** 缺省 `--bare`；子代理（`Task`）在 `--bare` 下没有，那些用例关掉它。 */
    readonly bare?: boolean;
    /** 上下文来源：拿到这次的会话日志。 */
    readonly sources?: (store: SessionStore) => readonly ContextSource[];
    readonly logger?: Logger;
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'ctx-claude-code-test-'));
  roots.push(root);
  const home = join(root, 'home');
  const cwd = join(root, 'work');
  mkdirSync(join(home, '.claude'), { recursive: true });
  mkdirSync(cwd);
  const api = await createFakeAnthropicApi({
    script: typeof script === 'function' ? script(cwd) : script,
    ...(options.tool ? { tool: options.tool } : {}),
  });
  apis.push(api);
  const store = createMemoryStore();
  const echo = createFunctionExecutor('local').register(
    {
      name: 'echo',
      description: '原样返回输入',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
    },
    (input) => ({ type: 'json', value: input }),
  );
  const harness = createClaudeCodeHarness({
    store,
    ...(options.tools ? { tools: options.tools } : { executors: [echo] }),
    command,
    cwd,
    bare: options.bare ?? true,
    maxToolOutputChars,
    ...(options.builtinTools ? { builtinTools: options.builtinTools } : {}),
    ...(options.sources ? { sources: options.sources(store) } : {}),
    ...(options.logger ? { logger: options.logger } : {}),
    env: {
      PATH: process.env['PATH'],
      HOME: home,
      CLAUDE_CONFIG_DIR: join(home, '.claude'),
      // Claude Code 把子代理的输出文件写在临时目录：放进这个用例的目录，跑完一起删。
      TMPDIR: root,
      ANTHROPIC_BASE_URL: api.url,
      ANTHROPIC_API_KEY: 'sk-ant-test-not-a-real-key',
      NO_PROXY: '127.0.0.1,localhost',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      CLAUDE_CODE_MAX_RETRIES: '0',
    },
  });
  const agent: AgentSpec = { model: 'claude-test' };
  return { api, store, harness, agent, cwd };
}

// 每个用例要起一到几次 Claude Code。
vi.setConfig({ testTimeout: 120_000 });
const slow = { describe: version ? describe : describe.skip, test };

describeHarnessContract(
  `Claude Code ${version ?? '(not installed)'}`,
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

async function runs(harness: ClaudeCodeHarness, store: SessionStore, agent: AgentSpec, inputs: readonly string[]) {
  const results = [];
  for (const input of inputs) results.push(await harness.run({ session: 's', agent, input }));
  return { results, log: await store.list('s') };
}

slow.describe('Claude Code 适配器', () => {
  slow.test('ctx 的一个会话对着 Claude Code 的一个会话：下一轮续接，模型看得到上一轮', async () => {
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
    assert.equal(first?.['name'], CLAUDE_CODE_HARNESS);
    assert.equal(typeof first?.['session'], 'string');
    assert.equal(second?.['session'], first?.['session'], '第二轮续接同一个会话');
    assert.deepEqual(userTexts(api, 1), ['第一句', '第二句']);
  });

  slow.test('上一轮失败、带同样的输入重试：Claude Code 退回到失败那一轮之前，输入只出现一次', async () => {
    const { api, harness, store, agent } = await setup([
      { type: 'text', text: '一' },
      { type: 'error', message: 'network down' },
      { type: 'text', text: '二' },
    ]);
    const { results } = await runs(harness, store, { ...agent, settings: { maxRetries: 0 } }, [
      '第一句',
      '第二句',
      '第二句',
    ]);
    assert.deepEqual(
      results.map((result) => result.stopReason),
      ['end_turn', 'error', 'end_turn'],
    );
    assert.deepEqual(userTexts(api, 1), ['第一句', '第二句']);
    assert.deepEqual(userTexts(api, 2), ['第一句', '第二句'], '重试的请求和失败的那次一样');
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
      const messages = log.flatMap((entry) => (entry.type === 'message' ? [entry] : []));
      assert.deepEqual(
        messages.map((entry) => `${entry.message.role}:${entry.source ?? ''}`),
        ['user:', 'assistant:model', 'tool:local', 'assistant:model'],
      );
      const [, first, results] = messages;
      assert.ok(first && Array.isArray(first.message.content) && results && Array.isArray(results.message.content));
      assert.deepEqual(
        first.message.content.map((part) => part.type),
        ['text', 'tool-call', 'tool-call'],
      );
      assert.deepEqual(
        results.message.content.map((part) => (part.type === 'tool-result' ? part.id : part.type)),
        ['call-a', 'call-b'],
      );
      const meta = first?.meta?.['step'] as Record<string, unknown> | undefined;
      assert.equal(meta?.['step'], 0);
      assert.equal(meta?.['finishReason'], 'tool-calls');
      const ended = log.at(-1);
      assert.equal(typeof (ended?.meta?.['claudeCode'] as Record<string, unknown> | undefined)?.['last'], 'string');
    },
  );

  slow.test(
    'tools 是 createToolRegistry() 的注册表：自带的执行环境自动带上，AgentSpec.tools 挑出交给 Claude Code 的工具',
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
      assert.deepEqual(api.requests[0]?.tools, ['mcp__ctx__echo']);
      const tool = (await store.list('s')).find((entry) => entry.type === 'message' && entry.message.role === 'tool');
      assert.equal(tool?.source, tools.executor.name);
      assert.ok(JSON.stringify(tool).includes('挑出来的'));
    },
  );

  slow.test('Claude Code 自带的工具：调用和结果记进日志，执行方是 claude-code', async () => {
    const { harness, store, agent, cwd } = await setup(
      (dir) => [
        { type: 'tool-call', id: 'call-read', input: { file_path: join(dir, 'note.txt') } },
        { type: 'text', text: '读完了' },
      ],
      { tool: 'Read', builtinTools: ['Read'] },
    );
    writeFileSync(join(cwd, 'note.txt'), 'ctx-builtin-marker');
    const result = await harness.run({ session: 's', agent, input: '读一下 note.txt' });
    assert.equal(result.stopReason, 'end_turn', result.error?.message);
    assert.equal(result.text, '读完了');
    const log = await store.list('s');
    const tool = log.find((entry) => entry.type === 'message' && entry.message.role === 'tool');
    assert.equal(tool?.source, CLAUDE_CODE_HARNESS);
    assert.ok(JSON.stringify(tool).includes('ctx-builtin-marker'), '结果里有文件内容');
    const call = log.find((entry) => entry.type === 'message' && entry.message.role === 'assistant');
    assert.ok(JSON.stringify(call).includes('"name":"Read"'));
  });

  slow.test('映射不了的 AgentSpec 字段：以 invalid_request 结束，不起 Claude Code', async () => {
    const { api, harness, store, agent } = await setup([{ type: 'text', text: '不该说' }]);
    const result = await harness.run({
      session: 's',
      agent: { ...agent, settings: { temperature: 0 } },
      input: '在吗',
    });
    assert.equal(result.stopReason, 'error');
    assert.equal(result.error?.type, 'invalid_request');
    assert.match(result.error?.message ?? '', /temperature/);
    assert.equal(api.requests.length, 0);
    const last = (await store.list('s')).at(-1);
    assert.equal(last?.type === 'event' ? last.kind : last?.type, CTX_EVENTS.runEnded);
  });

  slow.test(
    '上下文来源：记下输入之后收，事实接在指令后面；不进日志、不进 Claude Code 的会话；facts 挑来源、加标题，false 不收',
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
      // 事实只在那一次的系统提示里：Claude Code 的会话（第三轮交给模型的历史）和 ctx 的日志里都没有。
      assert.deepEqual(userTexts(api, 2), ['第一轮', '第二轮', '第三轮']);
      assert.doesNotMatch(JSON.stringify(api.requests[2]?.messages), /ctx-fact|ctx-other-fact/);
      assert.doesNotMatch(JSON.stringify(await store.list('s')), /ctx-fact|ctx-other-fact/);
    },
  );

  slow.test(
    'AgentSpec.context 只认 facts，事实不能放进 prompt：别的以 invalid_request 结束，不起 Claude Code',
    async () => {
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
    },
  );

  slow.test('中途取消：中断 Claude Code，以 aborted 结束，日志里有 ctx.run.ended', async () => {
    const { harness, store, agent } = await setup([{ type: 'text', text: '太慢了', delayMs: 20_000 }]);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 1_500);
    const begun = Date.now();
    const result = await harness.run({ session: 's', agent, input: '在吗', signal: controller.signal });
    assert.equal(result.stopReason, 'aborted');
    assert.ok(Date.now() - begun < 15_000, '没有等模型答完');
    const log = await store.list('s');
    const ended = log.findLast((entry) => entry.type === 'event' && entry.kind === CTX_EVENTS.runEnded);
    assert.equal(
      (ended?.type === 'event' && (ended.data as Record<string, unknown>)['stopReason']) || undefined,
      'aborted',
    );
  });
});

/** 条目的类型和来源：`event:<kind>`、`<role>:<source>`。 */
function shape(entry: Entry): string {
  if (entry.type === 'event') return `event:${entry.kind}`;
  if (entry.type === 'message') return `${entry.message.role}:${entry.source ?? ''}`;
  return entry.type;
}

function textOf(entry: Entry | undefined): string | undefined {
  if (entry?.type !== 'message') return undefined;
  const { content } = entry.message;
  return typeof content === 'string'
    ? content
    : content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('');
}

/** 派子代理的一步：模型调 `Agent`（Claude Code 发给模型时这么叫，`--tools` 里叫 `Task`）。 */
function delegate(id: string, prompt: string): FakeAnthropicStep {
  return {
    type: 'tool-call',
    tool: 'Agent',
    id,
    input: { description: '子任务', prompt, subagent_type: 'general-purpose' },
  };
}

// 子代理要 `Task` 工具，`--bare` 下没有：这几个用例不加 `--bare`（家目录、配置目录、工作目录照样是临时的）。
slow.describe('Claude Code 的子代理', () => {
  const options = { builtinTools: ['Task'], bare: false } as const;

  slow.test('子代理的轨迹写进子会话，父会话那一侧那次调用的结果是 ChildRunResult', async () => {
    const { harness, store, agent } = await setup(
      [
        delegate('toolu_agent_1', '回显「台北晴」'),
        { type: 'tool-call', id: 'toolu_echo_1', input: { text: '台北晴' } },
        { type: 'text', text: '子代理：台北晴' },
        { type: 'text', text: '主代理：完成' },
      ],
      options,
    );
    const result = await harness.run({ session: 's', agent, input: '台北天气怎么样？' });
    assert.equal(result.stopReason, 'end_turn', result.error?.message);
    assert.equal(result.text, '主代理：完成');

    const log = await store.list('s');
    assert.deepEqual(log.map(shape), [
      'event:ctx.run.started',
      'user:',
      'assistant:model',
      `tool:${CLAUDE_CODE_HARNESS}`,
      'assistant:model',
      'event:ctx.run.ended',
    ]);
    const [child] = childRunsOf(log);
    assert.equal(child?.child.session, 's/Agent/toolu_agent_1');
    assert.equal(child?.stopReason, 'end_turn');
    assert.equal(child?.text, '子代理：台北晴');
    assert.equal(child?.toolCallId, 'toolu_agent_1');

    const sub = await store.list(child.child.session);
    assert.deepEqual(sub.map(shape), [
      'event:ctx.run.started',
      `user:${CLAUDE_CODE_HARNESS}`,
      'assistant:model',
      'tool:local',
      'assistant:model',
      'event:ctx.run.ended',
    ]);
    const [data] = started(sub);
    assert.equal(data?.['runId'], child.child.runId);
    assert.deepEqual(data?.['parent'], { session: 's', runId: result.runId, toolCallId: 'toolu_agent_1' });
    assert.equal((data?.['agent'] as Record<string, unknown> | undefined)?.['name'], 'general-purpose');
    const harnessInfo = data?.['harness'] as Record<string, unknown>;
    assert.equal(harnessInfo['name'], CLAUDE_CODE_HARNESS);
    assert.equal(harnessInfo['session'], undefined, '子代理没有能续接的会话');
    assert.equal(textOf(sub[1]), '回显「台北晴」');
    assert.ok(JSON.stringify(sub[3]).includes('台北晴'), '工具结果经 ctx 的执行环境');
    assert.equal(textOf(sub[4]), '子代理：台北晴');
    const steps = sub.flatMap((entry) => {
      const step = entry.meta?.['step'] as Record<string, unknown> | undefined;
      return step ? [step] : [];
    });
    assert.deepEqual(
      steps.map((step) => [step['runId'], step['step']]),
      [
        [child.child.runId, 0],
        [child.child.runId, 1],
      ],
    );
    const ended = sub.at(-1);
    assert.equal(ended?.type === 'event' && (ended.data as Record<string, unknown>)['stopReason'], 'end_turn');
  });

  slow.test('子代理失败：子会话以 error 结束、有 ctx.error，发起的一侧是错误结果、带 ChildRunResult', async () => {
    const { harness, store, agent } = await setup(
      [
        delegate('toolu_agent_1', '做点事'),
        { type: 'error', message: 'upstream down' },
        { type: 'text', text: '主代理：子代理没做成' },
      ],
      options,
    );
    const result = await harness.run({ session: 's', agent, input: '开始' });
    assert.equal(result.stopReason, 'end_turn', result.error?.message);
    const log = await store.list('s');
    const tool = log.find((entry) => entry.type === 'message' && entry.message.role === 'tool');
    assert.ok(tool?.type === 'message' && Array.isArray(tool.message.content));
    const part = tool.message.content[0];
    assert.equal(part?.type === 'tool-result' && part.output.type, 'error');
    const [child] = childRunsOf(log);
    assert.equal(child?.stopReason, 'error');
    assert.match(child?.error?.message ?? '', /upstream down/);
    const sub = await store.list(child.child.session);
    assert.deepEqual(sub.map(shape), [
      'event:ctx.run.started',
      `user:${CLAUDE_CODE_HARNESS}`,
      'event:ctx.error',
      'event:ctx.run.ended',
    ]);
  });

  slow.test(
    '子代理再派子代理：孙会话挂在子会话下面，只有输入、回答和结束（Claude Code 不转出它里面的消息）',
    async () => {
      const { harness, store, agent } = await setup(
        [
          delegate('toolu_agent_1', '再派一个'),
          delegate('toolu_agent_2', '孙代理做事'),
          { type: 'text', text: '孙代理：好了' },
          { type: 'text', text: '子代理：好了' },
          { type: 'text', text: '主代理：好了' },
        ],
        options,
      );
      const result = await harness.run({ session: 's', agent, input: '开始' });
      assert.equal(result.stopReason, 'end_turn', result.error?.message);
      const [child] = childRunsOf(await store.list('s'));
      assert.equal(child?.text, '子代理：好了');
      const sub = await store.list(child.child.session);
      assert.deepEqual(sub.map(shape), [
        'event:ctx.run.started',
        `user:${CLAUDE_CODE_HARNESS}`,
        'assistant:model',
        `tool:${CLAUDE_CODE_HARNESS}`,
        'assistant:model',
        'event:ctx.run.ended',
      ]);
      const [grandchild] = childRunsOf(sub);
      assert.equal(grandchild?.child.session, 's/Agent/toolu_agent_1/Agent/toolu_agent_2');
      assert.equal(grandchild?.text, '孙代理：好了');
      const deeper = await store.list(grandchild.child.session);
      assert.deepEqual(deeper.map(shape), [
        'event:ctx.run.started',
        `user:${CLAUDE_CODE_HARNESS}`,
        'assistant:model',
        'event:ctx.run.ended',
      ]);
      assert.deepEqual(started(deeper)[0]?.['parent'], {
        session: child.child.session,
        runId: child.child.runId,
        toolCallId: 'toolu_agent_2',
      });
      assert.equal(textOf(deeper[1]), '孙代理做事');
    },
  );

  slow.test('父运行在子代理跑着时被取消：子会话以 aborted 结束，发起的一侧是 aborted 的 ChildRunResult', async () => {
    const { harness, store, agent } = await setup(
      [delegate('toolu_agent_1', '慢慢做'), { type: 'text', text: '太慢了', delayMs: 20_000 }],
      options,
    );
    const controller = new AbortController();
    const session = 's/Agent/toolu_agent_1';
    void (async () => {
      // 子会话开始了再取消。
      while ((await store.list(session)).length === 0) await new Promise((resolve) => setTimeout(resolve, 50));
      controller.abort();
    })();
    const result = await harness.run({ session: 's', agent, input: '开始', signal: controller.signal });
    assert.equal(result.stopReason, 'aborted');
    const [child] = childRunsOf(await store.list('s'));
    assert.equal(child?.child.session, session);
    assert.equal(child?.stopReason, 'aborted');
    const ended = (await store.list(session)).at(-1);
    assert.equal(ended?.type === 'event' && (ended.data as Record<string, unknown>)['stopReason'], 'aborted');
  });
});
