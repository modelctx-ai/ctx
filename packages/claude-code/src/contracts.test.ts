import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createFunctionExecutor, createMemoryStore, createToolRegistry } from '@modelctx-ai/ctx';
import { CTX_EVENTS, type AgentSpec, type Entry, type SessionStore } from '@modelctx-ai/ctx-protocol';
import { describeHarnessContract, type ModelScript } from '@modelctx-ai/ctx-protocol/testing';
import { afterAll, describe, test, vi } from 'vite-plus/test';

import { createFakeAnthropicApi, type FakeAnthropicApi, type FakeAnthropicStep } from './testing.ts';
import { CLAUDE_CODE_HARNESS, createClaudeCodeHarness, type ClaudeCodeHarness } from './index.ts';

// 对着真的 Claude Code 跑：`claude` 的接口（stream-json、续接会话、MCP）以它为准，模型换成本机的假 Anthropic 接口。
// 没装 `claude` 时跳过；`CTX_TEST_CLAUDE_CODE=required`（CI）时没装就失败。
const command = process.env['CTX_CLAUDE_CODE_COMMAND'] ?? 'claude';
function installed(): string | undefined {
  try {
    return /\d+\.\d+\.\d+\S*/.exec(execFileSync(command, ['--version'], { encoding: 'utf8', timeout: 30_000 }))?.[0];
  } catch {
    return undefined;
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
    bare: true,
    maxToolOutputChars,
    ...(options.builtinTools ? { builtinTools: options.builtinTools } : {}),
    env: {
      PATH: process.env['PATH'],
      HOME: home,
      CLAUDE_CONFIG_DIR: join(home, '.claude'),
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
