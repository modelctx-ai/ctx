import assert from 'node:assert/strict';

import {
  pendingToolCalls,
  toolApprovalEntry,
  type AgentSpec,
  type Harness,
  type RunEvent,
  type RunRequest,
} from '../harness.ts';
import { CTX_EVENTS, type Entry, type SessionStore } from '../session.ts';
import { DEFAULT_MAX_TOOL_OUTPUT_CHARS, type ToolOutput } from '../tools.ts';
import type { JsonObject } from '../types.ts';

import type { ContractTestApi } from './api.ts';
import { dialogue, eventData, kinds, lifecycle, roundTrips } from './shared.ts';

/**
 * 契约测试给模型的剧本：每调一次模型按顺序取下一步。`text` 回一段文字并停下，带 `truncated` 时这段输出是被
 * `maxOutputTokens` 截断的（`finishReason` 是 `length`）；`tool-call` 调用回显工具（名字由实现方填，就是 fixture 的
 * `echo`）；`error` 让这次模型调用抛出带这段信息的错误。
 */
export type ModelScriptStep =
  | { readonly type: 'text'; readonly text: string; readonly truncated?: boolean }
  | { readonly type: 'tool-call'; readonly id: string; readonly input: JsonObject }
  | { readonly type: 'error'; readonly message: string };

export interface ModelScript {
  readonly script: readonly ModelScriptStep[];
}

export interface HarnessFixture {
  readonly harness: Harness;
  /** harness 写日志用的存储，用例从这里读日志。 */
  readonly store: SessionStore;
  /**
   * 一个能跑的 agent：模型按剧本回答（流式和非流式都要支持），工具里有回显工具：`inputSchema` 要求 `text` 是字符串
   * （`{ type: 'object', properties: { text: { type: 'string' } } }`，别的键不限），结果里原样带着输入。
   */
  readonly agent: AgentSpec;
}

/** 每个用例调一次，拿到一个空的存储和按这份剧本回答的模型。 */
export type HarnessFactory = (setup: ModelScript) => HarnessFixture | Promise<HarnessFixture>;

/** 模型出错的用例不要重试，免得剧本被多取几步。 */
function noRetry(agent: AgentSpec): AgentSpec {
  return { ...agent, settings: { ...agent.settings, maxRetries: 0 } };
}

function randomMarker(): string {
  return `echo-${Math.random().toString(36).slice(2)}`;
}

/**
 * harness 的一致性等级（#23）。前三级是 trace、execute、resume，后两项是和等级正交的能力：
 *
 * - `trace`：一轮写进会话日志：生命周期事件、输入、回复、错误、取消、`runId`、`owner`、`parent`，`record: false` 不写，
 *   流的事件顺序。做到这一级，日志可看，记忆可用，别的组件可以订阅。
 * - `execute`：工具调用交给 ctx 的 `Executor`，每一步结束就落日志。
 * - `resume`：一个会话一个未结束的运行（`session_busy`）、输入的幂等（`inputKey`、失败的重试不再记输入），崩溃后能从日志接着跑。
 * - `context`：用 `ContextBuilder` 组装上下文：`agent.context`（投影名、事实）、`context.overflow`。自己管上下文的 harness 不跑。
 * - `output`：`AgentSpec.output` 的结构化输出和 `version`。
 * - `approval`：人工确认经日志往返：`ask` 的调用不执行，确认请求（`tool-approval-request`）写在调用的助手消息里，
 *   `RunResult.approvals` 列出；应用追加 `toolApprovalEntry` 后下一轮先执行确认了的、给拒绝的写上拒绝。
 */
export type HarnessLevel = 'trace' | 'execute' | 'resume' | 'context' | 'output' | 'approval';

export const HARNESS_LEVELS: readonly HarnessLevel[] = ['trace', 'execute', 'resume', 'context', 'output', 'approval'];

export interface HarnessContractOptions {
  /** 跑哪几级，缺省全部。参考实现全过；适配器按自己做到的跑，并在文档里写明。 */
  readonly levels?: readonly HarnessLevel[];
  /**
   * 被测的 harness 一次工具结果最多留多少字符，缺省 `DEFAULT_MAX_TOOL_OUTPUT_CHARS`。`execute` 级回显一个比它长的输入，
   * 查日志里的结果截到了它以内（另留一千字符给说明）。
   */
  readonly maxToolOutputChars?: number;
}

/** 日志里的工具结果，按顺序。 */
function toolResults(entries: readonly Entry[]): { id: string; output: ToolOutput }[] {
  return entries.flatMap((entry) =>
    entry.type === 'message' && entry.message.role === 'tool'
      ? entry.message.content.flatMap((part) =>
          part.type === 'tool-result' ? [{ id: part.id, output: part.output }] : [],
        )
      : [],
  );
}

/** 工具结果里给模型看的文字：错误信息、序列化的 `json`、`content` 各段（内联文件的数据也算）连起来。 */
function outputText(output: ToolOutput): string {
  if (output.type === 'text') return output.text;
  if (output.type === 'error') return output.message;
  if (output.type === 'json') return JSON.stringify(output.value) ?? 'null';
  return output.parts
    .map((part) => {
      if (part.type === 'text') return part.text;
      if (part.data.type === 'data') return part.data.data;
      return part.data.type === 'text' ? part.data.text : '';
    })
    .join('');
}

/** 截断时给说明留的字符数。 */
const TRUNCATION_NOTE_CHARS = 1_000;

export function describeHarnessContract(
  name: string,
  factory: HarnessFactory,
  { describe, test }: ContractTestApi,
  options: HarnessContractOptions = {},
): void {
  const levels = new Set(options.levels ?? HARNESS_LEVELS);
  for (const level of levels) {
    if (!HARNESS_LEVELS.includes(level)) throw new Error(`Unknown harness level "${level}".`);
  }
  const maxToolOutputChars = options.maxToolOutputChars ?? DEFAULT_MAX_TOOL_OUTPUT_CHARS;
  if (!Number.isSafeInteger(maxToolOutputChars) || maxToolOutputChars <= 0) {
    throw new Error(`maxToolOutputChars must be a positive integer, got ${String(options.maxToolOutputChars)}.`);
  }
  const atLevel = (level: HarnessLevel, title: string, fn: () => Promise<void>): void => {
    if (levels.has(level)) test(`[${level}] ${title}`, fn);
  };
  describe(`Harness contract: ${name}`, () => {
    atLevel('trace', '一轮：ctx.run.started → 输入 → 回复 → ctx.run.ended，recorded 就是写进日志的', async () => {
      const { harness, store, agent } = await factory({ script: [{ type: 'text', text: '在的' }] });
      const result = await harness.run({ session: 's', agent, input: '在吗', runId: 'run-1' });
      assert.equal(result.runId, 'run-1');
      assert.equal(result.text, '在的');
      assert.equal(result.stopReason, 'end_turn');
      assert.equal(result.error, undefined);
      assert.ok(result.messages.length > 0, '有模型产出的消息');
      const log = await store.list('s');
      assert.deepEqual(kinds(log), [CTX_EVENTS.runStarted, 'user', 'assistant', CTX_EVENTS.runEnded]);
      const [started] = eventData(log, CTX_EVENTS.runStarted);
      assert.equal(started?.['runId'], 'run-1');
      assert.equal(typeof (started?.['agent'] as Record<string, unknown> | undefined)?.['model'], 'string');
      assert.equal(eventData(log, CTX_EVENTS.runEnded)[0]?.['stopReason'], 'end_turn');
      assert.deepEqual(
        result.recorded.map((entry) => entry.id),
        log.map((entry) => entry.id),
      );
      assert.ok(roundTrips(eventData(log, CTX_EVENTS.runStarted)), 'ctx.run.started 的 data 能序列化');
    });

    atLevel('trace', '不给 runId 时生成一个，两轮不同', async () => {
      const { harness, agent } = await factory({
        script: [
          { type: 'text', text: '一' },
          { type: 'text', text: '二' },
        ],
      });
      const first = await harness.run({ session: 's', agent, input: '1' });
      const second = await harness.run({ session: 's', agent, input: '2' });
      assert.equal(typeof first.runId, 'string');
      assert.ok(first.runId.length > 0);
      assert.notEqual(first.runId, second.runId);
    });

    atLevel('execute', '工具调用交给执行环境，结果回到模型，调用和结果都记下', async () => {
      const text = randomMarker();
      const { harness, store, agent } = await factory({
        script: [
          { type: 'tool-call', id: 'call-1', input: { text } },
          { type: 'text', text: '好了' },
        ],
      });
      const result = await harness.run({ session: 's', agent, input: '回显一下' });
      assert.equal(result.text, '好了');
      assert.equal(result.stopReason, 'end_turn');
      const log = await store.list('s');
      assert.deepEqual(kinds(log), [
        CTX_EVENTS.runStarted,
        'user',
        'assistant',
        'tool',
        'assistant',
        CTX_EVENTS.runEnded,
      ]);
      const tool = log.find((entry) => entry.type === 'message' && entry.message.role === 'tool');
      assert.ok(JSON.stringify(tool).includes(text), '工具结果里有回显的输入');
    });

    atLevel('trace', '模型出错：run 照常返回 stopReason error 和 error，日志里有 ctx.run.ended', async () => {
      const { harness, store, agent } = await factory({ script: [{ type: 'error', message: 'model exploded' }] });
      const result = await harness.run({ session: 's', agent: noRetry(agent), input: '在吗' });
      assert.equal(result.stopReason, 'error');
      assert.match(result.error?.message ?? '', /model exploded/);
      const log = await store.list('s');
      assert.equal(kinds(log).at(-1), CTX_EVENTS.runEnded);
      assert.equal(eventData(log, CTX_EVENTS.runEnded)[0]?.['stopReason'], 'error');
      assert.deepEqual(
        eventData(log, CTX_EVENTS.runStarted).map((data) => data['runId']),
        eventData(log, CTX_EVENTS.runEnded).map((data) => data['runId']),
        'started 和 ended 成对',
      );
    });

    atLevel('execute', '每一步结束就落日志：工具调用之后模型出错，前一步的调用和结果留在日志里', async () => {
      const text = randomMarker();
      const { harness, store, agent } = await factory({
        script: [
          { type: 'tool-call', id: 'call-1', input: { text } },
          { type: 'error', message: 'model exploded' },
        ],
      });
      const result = await harness.run({ session: 's', agent: noRetry(agent), input: '回显一下' });
      assert.equal(result.stopReason, 'error');
      const log = await store.list('s');
      assert.deepEqual(kinds(log), [
        CTX_EVENTS.runStarted,
        'user',
        'assistant',
        'tool',
        CTX_EVENTS.error,
        CTX_EVENTS.runEnded,
      ]);
      const tool = log.find((entry) => entry.type === 'message' && entry.message.role === 'tool');
      assert.ok(JSON.stringify(tool).includes(text), '工具结果在日志里');
    });

    atLevel(
      'execute',
      '工具输入不合 inputSchema：不执行，问题作为 { type: "error" } 回给模型；改对了再调照常执行',
      async () => {
        const text = randomMarker();
        const { harness, store, agent } = await factory({
          script: [
            { type: 'tool-call', id: 'call-1', input: { text: 42 } },
            { type: 'tool-call', id: 'call-2', input: { text } },
            { type: 'text', text: '好了' },
          ],
        });
        const result = await harness.run({ session: 's', agent: { ...agent, maxSteps: 4 }, input: '回显一下' });
        assert.equal(result.text, '好了');
        assert.equal(result.stopReason, 'end_turn');
        const log = await store.list('s');
        assert.deepEqual(kinds(log), [
          CTX_EVENTS.runStarted,
          'user',
          'assistant',
          'tool',
          'assistant',
          'tool',
          'assistant',
          CTX_EVENTS.runEnded,
        ]);
        const [invalid, valid] = toolResults(log);
        assert.ok(invalid && valid, '两次调用都有结果');
        assert.equal(invalid.id, 'call-1');
        assert.equal(invalid.output.type, 'error', '回显工具不会回错误：这是执行前拦下的');
        assert.ok(outputText(invalid.output).length > 0, '说明哪里不对');
        assert.equal(valid.id, 'call-2');
        assert.notEqual(valid.output.type, 'error');
        assert.ok(outputText(valid.output).includes(text), '改对了的照常回显');
      },
    );

    atLevel('execute', '工具结果超过上限：截到上限以内并注明省略了多少，模型拿到截过的结果接着跑', async () => {
      const marker = randomMarker();
      // 回显的结果比上限长得多；填充用的 `x` 里没有数字，截过的结果里有数字就是说明里省略了多少。
      const text = `${marker}${'x'.repeat(maxToolOutputChars + 4 * TRUNCATION_NOTE_CHARS)}`;
      const { harness, store, agent } = await factory({
        script: [
          { type: 'tool-call', id: 'call-1', input: { text } },
          { type: 'text', text: '好了' },
        ],
      });
      const result = await harness.run({ session: 's', agent, input: '回显一个很长的' });
      assert.equal(result.text, '好了');
      assert.equal(result.stopReason, 'end_turn');
      const log = await store.list('s');
      assert.deepEqual(kinds(log), [
        CTX_EVENTS.runStarted,
        'user',
        'assistant',
        'tool',
        'assistant',
        CTX_EVENTS.runEnded,
      ]);
      const [cut] = toolResults(log);
      assert.ok(cut, '日志里有工具结果');
      const shown = outputText(cut.output);
      assert.ok(
        shown.length <= maxToolOutputChars + TRUNCATION_NOTE_CHARS,
        `结果有 ${shown.length} 个字符，上限 ${maxToolOutputChars}`,
      );
      assert.ok(shown.includes(marker), '截的是回显的结果，不是换成别的');
      assert.match(shown.replace(marker, ''), /\d/, '注明省略了多少');
    });

    atLevel(
      'output',
      'AgentSpec.output：最后的回答按 schema 解析进 RunResult.output；version 原样记进 ctx.run.started',
      async () => {
        const { harness, store, agent } = await factory({ script: [{ type: 'text', text: '{"answer":42}' }] });
        const result = await harness.run({
          session: 's',
          agent: {
            ...agent,
            version: 'contract@1',
            output: { schema: { type: 'object', properties: { answer: { type: 'number' } }, required: ['answer'] } },
          },
          input: '答案是多少？',
        });
        assert.equal(result.stopReason, 'end_turn');
        assert.deepEqual(result.output, { answer: 42 });
        const [started] = eventData(await store.list('s'), CTX_EVENTS.runStarted);
        assert.equal((started?.['agent'] as Record<string, unknown> | undefined)?.['version'], 'contract@1');
      },
    );

    atLevel('trace', 'RunRequest.parent 原样记进 ctx.run.started：子会话知道自己是谁派的', async () => {
      const { harness, store, agent } = await factory({ script: [{ type: 'text', text: '好' }] });
      const parent = { session: 'parent', runId: 'r-parent', toolCallId: 'call-1' };
      await harness.run({ session: 's', agent, input: '子任务', parent });
      const [started] = eventData(await store.list('s'), CTX_EVENTS.runStarted);
      assert.deepEqual(started?.['parent'], parent);
    });

    atLevel('resume', 'inputKey：失败后用同一个键重试，输入只记一次', async () => {
      const { harness, store, agent } = await factory({
        script: [
          { type: 'error', message: 'network down' },
          { type: 'text', text: '三点了' },
        ],
      });
      const request: RunRequest = { session: 's', agent: noRetry(agent), input: '几点了？', inputKey: 'turn-1' };
      assert.equal((await harness.run(request)).stopReason, 'error');
      const retry = await harness.run(request);
      assert.equal(retry.stopReason, 'end_turn');
      assert.equal(retry.text, '三点了');
      const log = await store.list('s');
      assert.equal(kinds(log).filter((kind) => kind === 'user').length, 1);
      assert.ok(!retry.recorded.some((entry) => entry.type === 'message' && entry.message.role === 'user'));
    });

    atLevel('trace', 'record: false 一条都不写，输入照样交给模型', async () => {
      const { harness, store, agent } = await factory({ script: [{ type: 'text', text: '好' }] });
      const result = await harness.run({ session: 's', agent, input: '不记', record: false });
      assert.equal(result.text, '好');
      assert.deepEqual(result.recorded, []);
      assert.deepEqual(await store.list('s'), []);
    });

    atLevel(
      'resume',
      '会话里有未结束的运行（最后一个生命周期事件是 started）：run 以 session_busy 结束，什么都不写',
      async () => {
        const { harness, store, agent } = await factory({ script: [{ type: 'text', text: '好' }] });
        await store.append('s', [lifecycle(CTX_EVENTS.runStarted, 'other')]);
        const before = await store.list('s');
        const result = await harness.run({ session: 's', agent, input: '在吗' });
        assert.equal(result.stopReason, 'error');
        assert.equal(result.error?.type, 'session_busy');
        assert.equal(result.error?.retryable, true);
        assert.deepEqual(result.recorded, []);
        assert.deepEqual(await store.list('s'), before, '一条都没写');
        // 别的会话不受影响；那个运行结束以后就能接着跑。
        assert.equal((await harness.run({ session: 't', agent, input: '在吗' })).stopReason, 'end_turn');
      },
    );

    atLevel(
      'resume',
      '上一轮已经 ended：可以接着跑；record: false 的运行不受未结束的运行影响，也不留生命周期事件',
      async () => {
        const { harness, store, agent } = await factory({
          script: [
            { type: 'text', text: '一' },
            { type: 'text', text: '二' },
          ],
        });
        await store.append('s', [lifecycle(CTX_EVENTS.runStarted, 'old'), lifecycle(CTX_EVENTS.runEnded, 'old')]);
        assert.equal((await harness.run({ session: 's', agent, input: '1' })).stopReason, 'end_turn');
        await store.append('t', [lifecycle(CTX_EVENTS.runStarted, 'stuck')]);
        const quiet = await harness.run({ session: 't', agent, input: '2', record: false });
        assert.equal(quiet.stopReason, 'end_turn');
        assert.equal(quiet.text, '二');
        assert.deepEqual(kinds(await store.list('t')), [CTX_EVENTS.runStarted], '只有原来那一条');
      },
    );

    atLevel('resume', 'stream（有时）：会话忙时 run.ended 带 session_busy，不写日志', async () => {
      const { harness, store, agent } = await factory({ script: [{ type: 'text', text: '好' }] });
      if (!harness.stream) return;
      await store.append('s', [lifecycle(CTX_EVENTS.runStarted, 'other')]);
      const events: RunEvent[] = [];
      for await (const event of harness.stream({ session: 's', agent, input: '在吗' })) events.push(event);
      const ended = events.at(-1);
      assert.equal(ended?.type === 'run.ended' && ended.result.error?.type, 'session_busy');
      assert.equal((await store.list('s')).length, 1);
    });

    atLevel('trace', 'owner 写进 ctx.run.started；不给就没有这个字段', async () => {
      const { harness, store, agent } = await factory({
        script: [
          { type: 'text', text: '一' },
          { type: 'text', text: '二' },
        ],
      });
      await harness.run({ session: 's', agent, input: '1', owner: 'yoyo' });
      await harness.run({ session: 's', agent, input: '2' });
      const started = eventData(await store.list('s'), CTX_EVENTS.runStarted);
      assert.deepEqual(
        started.map((data) => data['owner']),
        ['yoyo', undefined],
      );
      assert.ok(!('owner' in started[1]!));
    });

    atLevel(
      'context',
      'agent.context 交给 ContextBuilder：不认识的投影名以 not_found 结束，不调模型；facts: false 照常跑',
      async () => {
        const { harness, store, agent } = await factory({
          script: [
            { type: 'text', text: '好' },
            { type: 'text', text: '多余' },
          ],
        });
        // 忽略 `context` 的 builder 会静默回到缺省，在这里被暴露。
        const unknown = await harness.run({
          session: 's',
          agent: { ...agent, context: { projection: 'no-such-projection' } },
          input: '在吗',
        });
        assert.equal(unknown.stopReason, 'error');
        assert.equal(unknown.error?.type, 'not_found');
        assert.equal(eventData(await store.list('s'), CTX_EVENTS.runEnded)[0]?.['stopReason'], 'error');
        const quiet = await harness.run({
          session: 't',
          agent: { ...agent, context: { facts: false } },
          input: '在吗',
        });
        assert.equal(quiet.stopReason, 'end_turn');
        assert.equal(quiet.text, '好');
      },
    );

    atLevel('context', 'agent.context 记进 ctx.run.started 的 agent，能 JSON 往返', async () => {
      const { harness, store, agent } = await factory({ script: [{ type: 'text', text: '好' }] });
      const context = {
        facts: { sources: ['clock'], placement: 'prompt', heading: '环境' },
        projection: 'default',
        overflow: { maxTokens: 100_000, strategy: 'trim', compact: { keep: 4, maxInputTokens: 8_000 } },
      } as const;
      await harness.run({ session: 's', agent: { ...agent, context }, input: '在吗' });
      const [started] = eventData(await store.list('s'), CTX_EVENTS.runStarted);
      assert.deepEqual((started?.['agent'] as Record<string, unknown> | undefined)?.['context'], context);
    });

    atLevel('resume', '不给 inputKey：上一轮失败留下的输入，带同样的输入重试不再记一遍；换一句照常记', async () => {
      const { harness, store, agent } = await factory({
        script: [
          { type: 'error', message: 'network down' },
          { type: 'error', message: 'network down' },
          { type: 'text', text: '三点了' },
          { type: 'error', message: 'network down' },
          { type: 'text', text: '晴' },
        ],
      });
      const request: RunRequest = { session: 's', agent: noRetry(agent), input: '几点了？' };
      assert.equal((await harness.run(request)).stopReason, 'error');
      assert.equal((await harness.run(request)).stopReason, 'error');
      const retry = await harness.run(request);
      assert.equal(retry.text, '三点了');
      const users = async (): Promise<number> => kinds(await store.list('s')).filter((kind) => kind === 'user').length;
      assert.equal(await users(), 1, '失败的重试不让历史变长');
      assert.ok(!retry.recorded.some((entry) => entry.type === 'message' && entry.message.role === 'user'));
      // 换了一句话就是新的输入；上一轮成功之后再说同一句也是。
      assert.equal((await harness.run({ ...request, input: '天气呢？' })).stopReason, 'error');
      assert.equal((await harness.run({ ...request, input: '我是说今天的天气' })).text, '晴');
      assert.equal(await users(), 3);
    });

    atLevel('trace', '模型报上下文过长：以 error 结束，error.type 是 context_overflow，不可重试', async () => {
      const { harness, store, agent } = await factory({
        script: [
          {
            type: 'error',
            message:
              "This model's maximum context length is 8192 tokens. However, your messages resulted in 9000 tokens.",
          },
        ],
      });
      const result = await harness.run({ session: 's', agent: noRetry(agent), input: '在吗' });
      assert.equal(result.stopReason, 'error');
      assert.equal(result.error?.type, 'context_overflow');
      assert.equal(result.error?.retryable, false);
      assert.equal(eventData(await store.list('s'), CTX_EVENTS.error)[0]?.['type'], 'context_overflow');
    });

    atLevel(
      'context',
      'agent.context.overflow：超了又选 error 就不调模型，以 context_overflow 结束；没超照常跑',
      async () => {
        const { harness, store, agent } = await factory({ script: [{ type: 'text', text: '好' }] });
        const strict = { ...agent, context: { overflow: { maxTokens: 1, strategy: 'error' } } } as const;
        const over = await harness.run({ session: 's', agent: strict, input: '在吗' });
        assert.equal(over.stopReason, 'error');
        assert.equal(over.error?.type, 'context_overflow');
        assert.equal(eventData(await store.list('s'), CTX_EVENTS.runEnded)[0]?.['stopReason'], 'error');
        // 剧本只有一步：上面要是调了模型，这里就没得回了。
        const roomy = { ...agent, context: { overflow: { maxTokens: 1_000_000, strategy: 'error' } } } as const;
        const fine = await harness.run({ session: 't', agent: roomy, input: '在吗' });
        assert.equal(fine.stopReason, 'end_turn');
        assert.equal(fine.text, '好');
      },
    );

    atLevel('context', 'agent.context.overflow：历史超了，裁到放得下再调模型（trim 不写摘要）', async () => {
      const { harness, store, agent } = await factory({ script: [{ type: 'text', text: '好' }] });
      await store.append('s', dialogue(40, 400));
      const result = await harness.run({
        session: 's',
        agent: { ...agent, context: { overflow: { maxTokens: 1_500, strategy: 'trim' } } },
        input: '接着说',
      });
      assert.equal(result.stopReason, 'end_turn', result.error?.message);
      assert.equal(result.text, '好');
      assert.deepEqual(await store.list('s', { types: ['summary'] }), []);
    });

    atLevel('trace', 'signal 已中止：返回 stopReason aborted，写 ctx.run.ended', async () => {
      const { harness, store, agent } = await factory({ script: [{ type: 'text', text: '不该说' }] });
      const result = await harness.run({ session: 's', agent, input: '在吗', signal: AbortSignal.abort() });
      assert.equal(result.stopReason, 'aborted');
      assert.equal(eventData(await store.list('s'), CTX_EVENTS.runEnded)[0]?.['stopReason'], 'aborted');
    });

    atLevel('trace', 'stream（有时）：run.started 在最前、run.ended 在最后，工具事件在两次模型调用之间', async () => {
      const text = randomMarker();
      const { harness, store, agent } = await factory({
        script: [
          { type: 'tool-call', id: 'call-1', input: { text } },
          { type: 'text', text: '好了' },
        ],
      });
      if (!harness.stream) return;
      const events: RunEvent[] = [];
      for await (const event of harness.stream({ session: 's', agent, input: '回显一下' })) events.push(event);
      const types = events.map((event) => event.type);
      assert.equal(types[0], 'run.started');
      assert.equal(types.at(-1), 'run.ended');
      assert.ok(
        events.every((event) => event.runId === events[0]!.runId),
        '同一个 runId',
      );
      const at = (type: RunEvent['type'], from = 0) => types.indexOf(type, from);
      assert.ok(at('model.started') > 0);
      assert.ok(at('tool.called') > at('model.started'));
      assert.ok(at('tool.returned') > at('tool.called'));
      assert.ok(at('model.started', at('tool.returned')) > at('tool.returned'), '工具结果之后再调一次模型');
      const deltas = events.flatMap((event) => (event.type === 'text.delta' ? [event.text] : []));
      assert.equal(deltas.join(''), '好了');
      const returned = events.find((event) => event.type === 'tool.returned');
      assert.ok(JSON.stringify(returned).includes(text), 'tool.returned 带着回显的输入');
      const ended = events.at(-1);
      assert.equal(ended?.type === 'run.ended' && ended.result.stopReason, 'end_turn');
      assert.equal(kinds(await store.list('s')).at(-1), CTX_EVENTS.runEnded);
    });

    atLevel(
      'approval',
      'ask：不执行，确认请求和调用在同一条助手消息里；确认了的下一轮先执行，拒绝的模型看到拒绝和原因',
      async () => {
        const text = randomMarker();
        const { harness, store, agent } = await factory({
          script: [
            { type: 'tool-call', id: 'call-1', input: { text } },
            { type: 'text', text: '回显好了' },
            { type: 'tool-call', id: 'call-2', input: { text: 'again' } },
            { type: 'text', text: '那就不回显' },
          ],
        });
        const asking: AgentSpec = { ...agent, permissions: { default: 'ask' } };
        const first = await harness.run({ session: 's', agent: asking, input: '回显一下' });
        assert.equal(first.stopReason, 'requires_action');
        assert.deepEqual(
          first.pending?.map((call) => call.id),
          ['call-1'],
        );
        const [approval] = first.approvals ?? [];
        assert.equal(approval?.callId, 'call-1');
        assert.ok(roundTrips(first.approvals));
        const entries = await store.list('s');
        assert.deepEqual(toolResults(entries), [], '等确认的调用不执行');
        const asked = entries.find(
          (entry) =>
            entry.type === 'message' &&
            typeof entry.message.content !== 'string' &&
            entry.message.content.some((part) => part.type === 'tool-approval-request'),
        );
        assert.ok(
          asked?.type === 'message' &&
            typeof asked.message.content !== 'string' &&
            asked.message.content.some((part) => part.type === 'tool-call' && part.id === 'call-1'),
          '确认请求和调用在同一条助手消息里',
        );
        assert.equal(pendingToolCalls(entries)[0]?.approval?.approvalId, approval.approvalId);

        await store.append('s', [toolApprovalEntry(approval.approvalId, { approved: true })]);
        const second = await harness.run({ session: 's', agent: asking });
        assert.equal(second.stopReason, 'end_turn');
        assert.equal(second.text, '回显好了');
        const results = toolResults(await store.list('s'));
        assert.deepEqual(
          results.map((result) => result.id),
          ['call-1'],
        );
        assert.ok(outputText(results[0]!.output).includes(text), '确认了的调用执行了');

        const third = await harness.run({ session: 's', agent: asking, input: '再来一次' });
        assert.equal(third.stopReason, 'requires_action');
        const [again] = third.approvals ?? [];
        assert.equal(again?.callId, 'call-2');
        await store.append('s', [toolApprovalEntry(again.approvalId, { approved: false, reason: 'not now' })]);
        const fourth = await harness.run({ session: 's', agent: asking });
        assert.equal(fourth.stopReason, 'end_turn');
        assert.equal(fourth.text, '那就不回显');
        const denied = toolResults(await store.list('s')).find((result) => result.id === 'call-2');
        assert.equal(denied?.output.type, 'error');
        assert.match(outputText(denied.output), /not now/);
      },
    );

    atLevel('approval', 'stream（有时）：等确认时 run.ended 的结果带 approvals', async () => {
      const { harness, agent } = await factory({
        script: [{ type: 'tool-call', id: 'call-1', input: { text: randomMarker() } }],
      });
      if (!harness.stream) return;
      const events: RunEvent[] = [];
      const asking: AgentSpec = { ...agent, permissions: { default: 'ask' } };
      for await (const event of harness.stream({ session: 's', agent: asking, input: '回显一下' })) events.push(event);
      const ended = events.at(-1);
      assert.equal(ended?.type, 'run.ended');
      if (ended?.type !== 'run.ended') return;
      assert.equal(ended.result.stopReason, 'requires_action');
      assert.deepEqual(
        ended.result.approvals?.map((approval) => approval.callId),
        ['call-1'],
      );
      assert.ok(!events.some((event) => event.type === 'tool.returned'), '等确认的调用不执行');
    });

    atLevel('trace', 'stream（有时）：模型出错时先给 error 再给 run.ended，不抛', async () => {
      const { harness, agent } = await factory({ script: [{ type: 'error', message: 'model exploded' }] });
      if (!harness.stream) return;
      const types: string[] = [];
      for await (const event of harness.stream({ session: 's', agent: noRetry(agent), input: '在吗' })) {
        types.push(event.type);
        if (event.type === 'run.ended') assert.equal(event.result.stopReason, 'error');
      }
      assert.deepEqual(types.slice(-2), ['error', 'run.ended']);
    });
  });
}
