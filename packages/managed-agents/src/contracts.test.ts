import assert from 'node:assert/strict';

import Anthropic from '@anthropic-ai/sdk';
import { createFunctionExecutor, createMemoryStore, createToolRegistry } from '@modelctx-ai/ctx';
import {
  CTX_EVENTS,
  toolApprovalEntry,
  toolResultEntry,
  type AgentSpec,
  type Entry,
  type Logger,
  type RunEvent,
  type RunRequest,
} from '@modelctx-ai/ctx-protocol';
import { describeHarnessContract, type ModelScript } from '@modelctx-ai/ctx-protocol/testing';
import { afterAll, describe, test } from 'vite-plus/test';

import { createFakeManagedAgents, type FakeManagedAgents, type FakeManagedAgentsStep } from './testing.ts';
import {
  createManagedAgentsHarness,
  MANAGED_AGENTS_EVENTS,
  MANAGED_AGENTS_HARNESS,
  type ManagedAgentsHarnessOptions,
} from './index.ts';

const fakes: FakeManagedAgents[] = [];
afterAll(async () => {
  await Promise.all(fakes.map((fake) => fake.close()));
});

/** 工具结果的上限调小：契约按它查截断。 */
const maxToolOutputChars = 2_000;

const schema = { type: 'object', properties: { text: { type: 'string' } } } as const;

/**
 * 一个用例的环境：假接口、内存存储、回显工具。客户端只认这个假接口：密钥是假的，不读环境变量，不往外发请求。
 */
async function setup(
  script: readonly FakeManagedAgentsStep[],
  options: Partial<Omit<ManagedAgentsHarnessOptions, 'store' | 'client' | 'agent' | 'environmentId'>> = {},
) {
  const fake = await createFakeManagedAgents({ script });
  fakes.push(fake);
  const store = createMemoryStore();
  const echo = createFunctionExecutor('local').register(
    { name: 'echo', description: '原样返回输入', inputSchema: schema },
    (input) => ({ type: 'json', value: input }),
  );
  const client = new Anthropic({ apiKey: 'sk-ant-test-not-a-real-key', baseURL: fake.url, maxRetries: 0 });
  const harness = createManagedAgentsHarness({
    store,
    client,
    agent: 'agent_test',
    environmentId: 'env_test',
    maxToolOutputChars,
    interruptTimeoutMs: 1_000,
    ...(options.tools ? {} : { executors: [echo] }),
    ...options,
  });
  const agent: AgentSpec = { model: 'claude-test' };
  return { fake, store, harness, agent };
}

describeHarnessContract(
  'Managed Agents（假服务端）',
  async ({ script }: ModelScript) => {
    const { harness, store, agent } = await setup(script);
    return { harness, store, agent };
  },
  { describe, test },
  { levels: ['trace', 'execute', 'resume', 'output', 'approval'], maxToolOutputChars },
);

function started(log: readonly Entry[]): Record<string, unknown>[] {
  return log.flatMap((entry) =>
    entry.type === 'event' && entry.kind === CTX_EVENTS.runStarted ? [entry.data as Record<string, unknown>] : [],
  );
}

/** 假服务端收到的用户消息里的文字，按顺序。 */
function userTexts(fake: FakeManagedAgents, index = 0): string[] {
  return (fake.sessions[index]?.received ?? []).flatMap((event) => {
    if (event['type'] !== 'user.message' || !Array.isArray(event['content'])) return [];
    return event['content'].flatMap((block) => {
      const { type, text } = block as { type?: unknown; text?: unknown };
      return type === 'text' && typeof text === 'string' ? [text] : [];
    });
  });
}

function messages(log: readonly Entry[]): string[] {
  return log.flatMap((entry) => (entry.type === 'message' ? [`${entry.message.role}:${entry.source ?? ''}`] : []));
}

function received(fake: FakeManagedAgents, index = 0): string[] {
  return (fake.sessions[index]?.received ?? []).map((event) =>
    typeof event['type'] === 'string' ? event['type'] : '',
  );
}

function recording(): { logger: Logger; warnings: string[] } {
  const warnings: string[] = [];
  return { logger: { warn: (message) => warnings.push(message) }, warnings };
}

describe('Managed Agents 适配器', () => {
  test('ctx 的一个会话对着 Managed Agents 的一个会话：模型、指令、工具按 AgentSpec 覆盖，下一轮续接', async () => {
    const { fake, harness, store, agent } = await setup([
      { type: 'text', text: '一' },
      { type: 'text', text: '二' },
    ]);
    const spec = { ...agent, instructions: '你是测试' };
    const first = await harness.run({ session: 's', agent: spec, input: '第一句' });
    const second = await harness.run({ session: 's', agent: spec, input: '第二句' });
    assert.deepEqual([first.text, second.text], ['一', '二']);
    assert.equal(fake.sessions.length, 1, '第二轮续接，不另建会话');
    const [session] = fake.sessions;
    assert.deepEqual(session?.request['agent'], {
      type: 'agent_with_overrides',
      id: 'agent_test',
      model: 'claude-test',
      system: '你是测试',
      tools: [{ type: 'custom', name: 'echo', description: '原样返回输入', input_schema: schema }],
    });
    assert.equal(session?.request['environment_id'], 'env_test');
    assert.deepEqual(userTexts(fake), ['第一句', '第二句']);
    const log = await store.list('s');
    const [one, two] = started(log).map((data) => data['harness'] as Record<string, unknown>);
    assert.equal(one?.['name'], MANAGED_AGENTS_HARNESS);
    assert.equal(one?.['session'], session?.id);
    assert.equal(two?.['session'], session?.id);
    const step = log.find((entry) => entry.type === 'message' && entry.message.role === 'assistant')?.meta?.['step'];
    assert.equal((step as Record<string, unknown> | undefined)?.['modelId'], 'claude-test');
    assert.ok(
      !fake.requests.some((request) => request.method === 'POST' && /\/v1\/sessions\/[^/]+$/.test(request.path)),
      '工具没变不更新',
    );
  });

  test('续接时模型或指令变了：invalid_request，不调模型；工具变了就更新会话的工具', async () => {
    const { fake, harness, agent } = await setup([
      { type: 'text', text: '一' },
      { type: 'text', text: '二' },
    ]);
    await harness.run({ session: 's', agent, input: '1' });
    const changed = await harness.run({ session: 's', agent: { ...agent, model: 'claude-other' }, input: '2' });
    assert.equal(changed.stopReason, 'error');
    assert.equal(changed.error?.type, 'invalid_request');
    const fewer = await harness.run({ session: 's', agent: { ...agent, tools: [] }, input: '3' });
    assert.equal(fewer.text, '二');
    assert.deepEqual(fake.sessions[0]?.agent.tools, []);
  });

  test('映射不了的 AgentSpec 字段：invalid_request，不建会话', async () => {
    const { fake, harness, agent } = await setup([{ type: 'text', text: '不该说' }]);
    for (const spec of [
      { ...agent, window: { maxMessages: 4 } },
      { ...agent, context: { projection: 'default' } },
      { ...agent, toolChoice: 'required' as const },
      { ...agent, settings: { temperature: 0 } },
    ] satisfies AgentSpec[]) {
      const result = await harness.run({ session: 's', agent: spec, input: '在吗' });
      assert.equal(result.error?.type, 'invalid_request', JSON.stringify(spec));
    }
    assert.equal(fake.sessions.length, 0);
    const quiet = await harness.run({ session: 't', agent: { ...agent, context: { facts: false } }, input: '在吗' });
    assert.equal(quiet.stopReason, 'end_turn');
  });

  test('一条消息里先说话再并行调两次工具：日志里一条助手消息、一条工具结果，执行方是执行环境的名字', async () => {
    const { fake, harness, store, agent } = await setup([
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
    assert.deepEqual(messages(log), ['user:', 'assistant:model', 'tool:local', 'assistant:model']);
    const assistant = log.find((entry) => entry.type === 'message' && entry.message.role === 'assistant');
    assert.ok(assistant?.type === 'message' && Array.isArray(assistant.message.content));
    assert.deepEqual(
      assistant.message.content.map((part) => part.type),
      ['text', 'tool-call', 'tool-call'],
    );
    const results = fake.sessions[0]?.received.filter((event) => event['type'] === 'user.custom_tool_result');
    assert.deepEqual(
      results?.map((event) => event['custom_tool_use_id']),
      ['call-a', 'call-b'],
    );
    const ended = log.at(-1);
    assert.equal(typeof (ended?.meta?.['managedAgents'] as Record<string, unknown> | undefined)?.['last'], 'string');
  });

  test('Managed Agents 那边执行的内置工具：调用和结果记进日志，执行方是 managed-agents', async () => {
    const { harness, store, agent } = await setup(
      [
        { type: 'builtin', id: 'tool-1', name: 'bash', input: { command: 'ls' }, result: 'a.txt' },
        { type: 'text', text: '有一个文件' },
      ],
      { builtinTools: [{ type: 'agent_toolset_20260401' }] },
    );
    const result = await harness.run({ session: 's', agent, input: '看看有什么' });
    assert.equal(result.text, '有一个文件');
    const log = await store.list('s');
    assert.deepEqual(messages(log), ['user:', 'assistant:model', `tool:${MANAGED_AGENTS_HARNESS}`, 'assistant:model']);
    const tool = log.find((entry) => entry.type === 'message' && entry.message.role === 'tool');
    assert.ok(tool?.type === 'message' && Array.isArray(tool.message.content));
    assert.deepEqual(tool.message.content[0], {
      type: 'tool-result',
      id: 'tool-1',
      name: 'bash',
      output: { type: 'text', text: 'a.txt' },
    });
  });

  test('Managed Agents 要确认的内置工具：requires_action 带确认请求；确认了的下一轮让它执行，结果记进日志', async () => {
    const { fake, harness, store, agent } = await setup(
      [
        {
          type: 'builtin',
          id: 'tool-1',
          name: 'bash',
          input: { command: 'rm -rf build' },
          permission: 'ask',
          result: 'done',
        },
        { type: 'text', text: '删好了' },
      ],
      { builtinTools: [{ type: 'agent_toolset_20260401' }] },
    );
    const first = await harness.run({ session: 's', agent, input: '清一下' });
    assert.equal(first.stopReason, 'requires_action');
    const [approval] = first.approvals ?? [];
    assert.equal(approval?.callId, 'tool-1');
    assert.match(approval?.reason ?? '', /Managed Agents/);
    await store.append('s', [toolApprovalEntry(approval.approvalId, { approved: true })]);
    const second = await harness.run({ session: 's', agent });
    assert.equal(second.stopReason, 'end_turn', second.error?.message);
    assert.equal(second.text, '删好了');
    const confirmation = fake.sessions[0]?.received.find((event) => event['type'] === 'user.tool_confirmation');
    assert.equal(confirmation?.['result'], 'allow');
    const tool = (await store.list('s')).find(
      (entry) =>
        entry.type === 'message' &&
        entry.message.role === 'tool' &&
        entry.message.content.some((part) => part.type === 'tool-result'),
    );
    assert.equal(tool?.source, MANAGED_AGENTS_HARNESS);
    assert.ok(JSON.stringify(tool).includes('done'));
  });

  test('外部执行环境：调用写进日志、以 requires_action 结束；执行方追加结果后下一轮交回去接着跑', async () => {
    const tools = createToolRegistry();
    tools.add({ name: 'deploy', description: '部署', inputSchema: schema, executor: 'worker' });
    const { fake, harness, store, agent } = await setup(
      [
        { type: 'tool-call', id: 'call-1', input: { text: 'v2' }, tool: 'deploy' },
        { type: 'text', text: '部署好了' },
      ],
      { tools, external: ['worker'] },
    );
    const first = await harness.run({ session: 's', agent, input: '部署 v2' });
    assert.equal(first.stopReason, 'requires_action');
    assert.deepEqual(
      first.pending?.map((call) => call.name),
      ['deploy'],
    );
    const ended = (await store.list('s')).at(-1);
    assert.deepEqual((ended?.type === 'event' ? (ended.data as Record<string, unknown>) : {})['executors'], {
      'call-1': 'worker',
    });
    const [call] = first.pending ?? [];
    assert.ok(call);
    await store.append('s', [toolResultEntry(call, { type: 'text', text: 'ok' }, { source: 'worker' })]);
    const second = await harness.run({ session: 's', agent });
    assert.equal(second.text, '部署好了', second.error?.message);
    const result = fake.sessions[0]?.received.find((event) => event['type'] === 'user.custom_tool_result');
    assert.deepEqual(result?.['content'], [{ type: 'text', text: 'ok' }]);
  });

  test('上一轮停着等确认、这一轮又说了话：没决定的按没有结果交回去，等它把上一轮做完再发这一轮的话', async () => {
    const { fake, harness, store, agent } = await setup([
      { type: 'tool-call', id: 'call-1', input: { text: 'x' } },
      { type: 'text', text: '那先不回显' },
      { type: 'text', text: '好的' },
    ]);
    const asking: AgentSpec = { ...agent, permissions: { default: 'ask' } };
    assert.equal((await harness.run({ session: 's', agent: asking, input: '回显一下' })).stopReason, 'requires_action');
    const second = await harness.run({ session: 's', agent: asking, input: '算了，说点别的' });
    assert.equal(second.stopReason, 'end_turn', second.error?.message);
    assert.equal(second.text, '好的');
    assert.deepEqual(received(fake), ['user.message', 'user.custom_tool_result', 'user.message']);
    const result = fake.sessions[0]?.received[1];
    assert.equal(result?.['is_error'], true);
    assert.deepEqual(userTexts(fake), ['回显一下', '算了，说点别的']);
    assert.deepEqual(messages(await store.list('s')), [
      'user:',
      'assistant:model',
      'user:',
      'assistant:model',
      'assistant:model',
    ]);
  });

  test('取消：中断 Managed Agents，以 aborted 结束，下一轮接着用这个会话', async () => {
    const { fake, harness, agent } = await setup([
      { type: 'text', text: '慢慢说', delayMs: 2_000 },
      { type: 'text', text: '好' },
    ]);
    const controller = new AbortController();
    const running = harness.run({ session: 's', agent, input: '说点什么', signal: controller.signal });
    setTimeout(() => controller.abort(), 200);
    const result = await running;
    assert.equal(result.stopReason, 'aborted');
    assert.ok(received(fake).includes('user.interrupt'), '发了中断');
    const later = await harness.run({ session: 's', agent, input: '接着说' });
    assert.equal(later.text, '好', later.error?.message);
    assert.equal(fake.sessions.length, 1);
  });

  test('记进日志、没发出去的输入：下一轮和这一轮的话一起发，每句只记一次', async () => {
    const { fake, harness, store, agent } = await setup([
      { type: 'text', text: '一' },
      { type: 'text', text: '好' },
    ]);
    await harness.run({ session: 's', agent, input: '第一句' });
    const invalid = await harness.run({
      session: 's',
      agent: { ...agent, window: { maxMessages: 4 } },
      input: '这句没发出去',
    });
    assert.equal(invalid.error?.type, 'invalid_request');
    const later = await harness.run({ session: 's', agent, input: '接着说' });
    assert.equal(later.text, '好', later.error?.message);
    assert.deepEqual(userTexts(fake), ['第一句', '这句没发出去', '接着说']);
    assert.deepEqual(
      fake.sessions[0]?.received.map((event) => (Array.isArray(event['content']) ? event['content'].length : 0)),
      [1, 2],
      '补发的和这一轮的在一条消息里',
    );
    const users = (await store.list('s')).filter((entry) => entry.type === 'message' && entry.message.role === 'user');
    assert.equal(users.length, 3, '每句只记一次');
  });

  test('settings.timeoutMs：到了就中断，以 timeout 结束', async () => {
    const { fake, harness, agent } = await setup([{ type: 'text', text: '太慢了', delayMs: 2_000 }]);
    const result = await harness.run({ session: 's', agent: { ...agent, settings: { timeoutMs: 200 } }, input: '快' });
    assert.equal(result.stopReason, 'error');
    assert.equal(result.error?.type, 'timeout');
    assert.ok(received(fake).includes('user.interrupt'));
  });

  test('maxSteps：到了步数就中断，以 max_steps 结束，后面那次模型请求不记', async () => {
    const { fake, harness, store, agent } = await setup([
      { type: 'tool-call', id: 'call-1', input: { text: '1' } },
      { type: 'tool-call', id: 'call-2', input: { text: '2' } },
      { type: 'text', text: '不该记' },
    ]);
    const result = await harness.run({ session: 's', agent: { ...agent, maxSteps: 1 }, input: '回显' });
    assert.equal(result.stopReason, 'max_steps');
    assert.ok(received(fake).includes('user.interrupt'));
    assert.deepEqual(messages(await store.list('s')), ['user:', 'assistant:model', 'tool:local']);
  });

  test('事件流断了：重连，从历史里补上断开期间的事件，text.delta 连起来还是那段话', async () => {
    const { logger, warnings } = recording();
    const { harness, agent } = await setup([{ type: 'text', text: '断了也能接上', drop: true }], { logger });
    const events: RunEvent[] = [];
    for await (const event of harness.stream({ session: 's', agent, input: '在吗' })) events.push(event);
    const ended = events.at(-1);
    assert.equal(ended?.type === 'run.ended' && ended.result.text, '断了也能接上');
    const deltas = events.flatMap((event) => (event.type === 'text.delta' ? [event.text] : []));
    assert.equal(deltas.join(''), '断了也能接上');
    assert.ok(warnings.some((warning) => /reconnect/.test(warning)));
  });

  test('Managed Agents 压缩了上下文：记一条 managed-agents.compacted', async () => {
    const { harness, store, agent } = await setup([{ type: 'text', text: '好', compact: true }]);
    await harness.run({ session: 's', agent, input: '在吗' });
    const kinds = (await store.list('s')).flatMap((entry) => (entry.type === 'event' ? [entry.kind] : []));
    assert.ok(kinds.includes(MANAGED_AGENTS_EVENTS.compacted));
  });

  test('续接的会话没了：not_found；结束了的也是', async () => {
    const { fake, harness, agent } = await setup([
      { type: 'text', text: '一' },
      { type: 'text', text: '二' },
    ]);
    await harness.run({ session: 's', agent, input: '1' });
    fake.end(fake.sessions[0]!.id, 'delete');
    const gone = await harness.run({ session: 's', agent, input: '2' });
    assert.equal(gone.error?.type, 'not_found');
    await harness.run({ session: 't', agent, input: '1' });
    fake.end(fake.sessions[1]!.id, 'terminate');
    const ended = await harness.run({ session: 't', agent, input: '2' });
    assert.equal(ended.error?.type, 'not_found');
  });

  test('record: false：每次一个新会话，什么都不写', async () => {
    const { fake, harness, store, agent } = await setup([
      { type: 'text', text: '一' },
      { type: 'text', text: '二' },
    ]);
    const request: RunRequest = { session: 's', agent, input: '在吗', record: false };
    assert.equal((await harness.run(request)).text, '一');
    assert.equal((await harness.run(request)).text, '二');
    assert.equal(fake.sessions.length, 2);
    assert.deepEqual(await store.list('s'), []);
  });

  test('tools 是 createToolRegistry() 的注册表：自带的执行环境自动带上，AgentSpec.tools 挑出交给会话的', async () => {
    const tools = createToolRegistry();
    tools.executor
      .register({ name: 'echo', inputSchema: schema }, (input) => ({ type: 'json', value: input }))
      .register({ name: 'hidden', inputSchema: schema }, () => ({ type: 'text', text: '不该被调' }));
    tools.add(tools.executor.definition('echo')!).add(tools.executor.definition('hidden')!);
    const { fake, harness, agent } = await setup(
      [
        { type: 'tool-call', id: 'call-1', input: { text: '挑出来的' } },
        { type: 'text', text: '好了' },
      ],
      { tools },
    );
    const result = await harness.run({ session: 's', agent: { ...agent, tools: ['echo'] }, input: '回显一下' });
    assert.equal(result.text, '好了', result.error?.message);
    assert.deepEqual(
      fake.sessions[0]?.agent.tools.map((tool) => tool['name']),
      ['echo'],
    );
  });
});
