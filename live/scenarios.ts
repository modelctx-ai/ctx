// 冒烟场景：每个对一个目标跑一小段真实的往来，返回看到的结果（`observation`）和不对的地方（`problems`）。
// 结果只留确定的部分（没有 `runId`、时间），所以同一份录下来的响应重放出来的结果和录的时候一样。
import { randomBytes } from 'node:crypto';

import {
  createContext,
  createContextBuilder,
  createHarness,
  createMemoryStore,
  createToolRegistry,
  messageEntry,
  userEntry,
  type JsonValue,
} from '@modelctx-ai/ctx';
import { startGateway, withContext } from '@modelctx-ai/ctx-gateway';
import { createMcpHub } from '@modelctx-ai/ctx-mcp';
import { createDecisionModel, createExtractionModel, createModel } from '@modelctx-ai/ctx-models';
import { tool } from 'ai';
import { z } from 'zod';

import type { Target } from './targets.ts';

export interface Outcome {
  readonly observation: JsonValue;
  /** 空就是通过。 */
  readonly problems: string[];
}

export interface Scenario {
  readonly name: string;
  /** 这个场景对哪种目标跑。 */
  applies(target: Target): boolean;
  /** `fetchImpl` 给有注入口的适配器（System One）；别的走全局 `fetch`，由调用方换掉。 */
  run(target: Target, fetchImpl: typeof fetch): Promise<Outcome>;
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function unit(value: unknown): boolean {
  return isNumber(value) && value >= 0 && value <= 1;
}

/** 一轮带工具调用的流式运行：模型要调 `add`，拿到结果再回答。 */
const modelToolStream: Scenario = {
  name: 'tool-stream',
  applies: (target) => target.kind === 'model',
  async run(target) {
    if (target.kind !== 'model') throw new Error('tool-stream needs a model target.');
    const store = createMemoryStore();
    const tools = createToolRegistry().addTool(
      'add',
      tool({
        description: 'Add two integers and return the sum.',
        inputSchema: z.object({ a: z.number(), b: z.number() }),
        execute: async ({ a, b }) => String(a + b),
      }),
    );
    const harness = createHarness({ store, context: createContextBuilder({ store }), tools });
    const events: string[] = [];
    const toolCalls: JsonValue[] = [];
    const toolOutputs: JsonValue[] = [];
    let text = '';
    let stopReason = '';
    let error: string | undefined;
    let usage: JsonValue = null;
    for await (const event of harness.stream({
      session: 'live',
      agent: {
        model: createModel(target.spec),
        instructions: 'Use the add tool to do arithmetic. Answer with one short sentence that contains the number.',
        maxSteps: 4,
      },
      input: 'What is 17 + 25? Call the add tool, then tell me the result.',
    })) {
      // 连着的文字增量记一次：分几块来由服务端定，不算映射的一部分。
      if (event.type !== 'text.delta' || events.at(-1) !== 'text.delta') events.push(event.type);
      if (event.type === 'tool.called') toolCalls.push({ name: event.call.name, input: event.call.input });
      if (event.type === 'tool.returned') toolOutputs.push(event.output as unknown as JsonValue);
      if (event.type === 'error') error = event.message;
      if (event.type === 'run.ended') {
        text = event.result.text;
        stopReason = event.result.stopReason;
        usage = (event.result.usage ?? null) as JsonValue;
      }
    }

    const problems: string[] = [];
    if (error) problems.push(`run reported an error: ${error}`);
    const call = toolCalls[0] as { name?: string; input?: { a?: unknown; b?: unknown } } | undefined;
    if (call?.name !== 'add') problems.push('the model did not call the add tool');
    else if (call.input?.a !== 17 || call.input?.b !== 25) {
      problems.push(`add was called with ${JSON.stringify(call.input)}, expected { a: 17, b: 25 } as numbers`);
    }
    if (!JSON.stringify(toolOutputs).includes('42')) problems.push('the tool result did not come back as 42');
    if (!events.includes('text.delta')) problems.push('no text.delta events: the answer was not streamed');
    if (!text.includes('42')) problems.push(`the final text does not contain 42: ${JSON.stringify(text)}`);
    if (stopReason !== 'end_turn') problems.push(`stopReason is ${JSON.stringify(stopReason)}, expected end_turn`);
    const counted = usage as { inputTokens?: unknown; outputTokens?: unknown } | null;
    if (!isNumber(counted?.inputTokens) || counted.inputTokens <= 0) problems.push('usage.inputTokens is missing');
    if (!isNumber(counted?.outputTokens) || counted.outputTokens <= 0) problems.push('usage.outputTokens is missing');
    return { observation: { events, toolCalls, toolOutputs, text, stopReason, usage }, problems };
  },
};

/** 网关改写过的请求上游接不接受：历史里有没配对的工具调用（投影给它补一条错误结果）、同一句话的两种写法。只对 OpenAI 兼容的目标跑。 */
const gatewayRewrite: Scenario = {
  name: 'gateway-rewrite',
  applies: (target) => target.kind === 'model' && (target.spec.provider ?? 'openai-compatible') === 'openai-compatible',
  async run(target) {
    if (target.kind !== 'model') throw new Error('gateway-rewrite needs a model target.');
    const store = createMemoryStore();
    await store.append('live', [
      userEntry('My favourite number is 42. Remember it.'),
      messageEntry({ role: 'assistant', content: 'Noted: 42.' }),
      // 断在工具调用之后的一轮：没有结果的调用原样发出去，上游会拒绝。
      messageEntry({
        role: 'assistant',
        content: [{ type: 'tool-call', id: 'call-lost', name: 'lookup', input: {} }],
      }),
      userEntry('What is my favourite number? Answer with the number.'),
    ]);
    const accessToken = randomBytes(24).toString('base64url');
    const gateway = await startGateway({
      upstream: { baseUrl: target.spec.baseUrl!, ...(target.spec.apiKey ? { apiKey: target.spec.apiKey } : {}) },
      rewrite: withContext(createContext({ store, session: 'live' })),
      accessToken,
    });
    try {
      const response = await fetch(`${gateway.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({
          model: target.spec.model,
          // 调用方用分段写法重发日志里的最后一句：不该出现两遍。
          messages: [
            { role: 'user', content: [{ type: 'text', text: 'What is my favourite number? Answer with the number.' }] },
          ],
        }),
      });
      const body = (await response.json()) as { choices?: { message?: { content?: unknown } }[]; error?: unknown };
      const content = body.choices?.[0]?.message?.content;
      const problems: string[] = [];
      if (response.status !== 200) {
        problems.push(`upstream answered ${response.status} to the rewritten request: ${JSON.stringify(body.error)}`);
      } else if (typeof content !== 'string' || !content.includes('42')) {
        problems.push(`the answer does not use the history ctx put in: ${JSON.stringify(content)}`);
      }
      return {
        observation: { status: response.status, content: typeof content === 'string' ? content : null },
        problems,
      };
    } finally {
      await gateway.close();
    }
  },
};

/** 决策模型的三种问题各问一个。形状要对，方向也要对：P(是) 不能读成 P(否)。 */
const decide: Scenario = {
  name: 'decide',
  applies: (target) => target.kind === 'decision',
  async run(target, fetchImpl) {
    if (target.kind !== 'decision') throw new Error('decide needs a decision target.');
    const answers = await createDecisionModel(target.spec, { fetch: fetchImpl }).decide({
      state: 'The user said: "I am allergic to peanuts. Never put peanuts in anything you order for me."',
      questions: {
        worth: { type: 'noul', instructions: 'Does this contain a lasting personal fact worth remembering?' },
        kind: {
          type: 'choice',
          instructions: 'What is this about?',
          criteria: { health: 'health, allergies, medical needs', smalltalk: 'greetings and small talk' },
        },
        importance: {
          type: 'score',
          instructions: 'How important is it to remember this?',
          criteria: ['not important', 'somewhat important', 'critical'],
        },
      },
    });
    const problems: string[] = [];
    const worth = answers['worth'];
    if (worth?.type !== 'noul' || !unit(worth.noul))
      problems.push(`worth is not a noul answer: ${JSON.stringify(worth)}`);
    else if (worth.noul <= 0.5) problems.push(`P(yes) for an obvious yes is ${worth.noul}`);
    const kind = answers['kind'];
    if (kind?.type !== 'choice') problems.push(`kind is not a choice answer: ${JSON.stringify(kind)}`);
    else {
      const sum = Object.values(kind.probabilities).reduce((total, value) => total + value, 0);
      if (Object.keys(kind.probabilities).toSorted().join() !== 'health,smalltalk') {
        problems.push(`kind.probabilities has keys ${Object.keys(kind.probabilities).join()}`);
      }
      if (Math.abs(sum - 1) > 0.01) problems.push(`kind.probabilities sum to ${sum}`);
      if (kind.choice !== 'health') problems.push(`kind.choice is ${kind.choice}, expected health`);
      if (!unit(kind.confidence)) problems.push(`kind.confidence is ${String(kind.confidence)}`);
    }
    const importance = answers['importance'];
    if (importance?.type !== 'score' || !unit(importance.score)) {
      problems.push(`importance is not a score answer: ${JSON.stringify(importance)}`);
    } else {
      if (importance.probabilities.length !== 3) problems.push('importance.probabilities does not have 3 levels');
      if (importance.score <= 0.5) problems.push(`importance.score for a critical fact is ${importance.score}`);
    }
    return { observation: answers as unknown as JsonValue, problems };
  },
};

/** 提取模型：有的字段在、有的不在。不在的字段要给得出「不在」（`value` 是 null、`pNull` 高）。 */
const extract: Scenario = {
  name: 'extract',
  applies: (target) => target.kind === 'extraction',
  async run(target, fetchImpl) {
    if (target.kind !== 'extraction') throw new Error('extract needs an extraction target.');
    const answers = await createExtractionModel(target.spec, { fetch: fetchImpl }).extract({
      state: 'Order A-1042 was placed on 2026-03-14 for 3 keyboards and 2 mice. No delivery date has been set.',
      fields: {
        placed: { type: 'date', instructions: 'the date the order was placed' },
        quantity: { type: 'number', integer: true, instructions: 'how many keyboards were ordered' },
        items: { type: 'list', items: 'text', instructions: 'the kinds of product ordered' },
        delivery: { type: 'date', instructions: 'the delivery date' },
        colours: { type: 'list', items: 'text', instructions: 'the colours of the products' },
      },
    });
    const problems: string[] = [];
    for (const [name, answer] of Object.entries(answers)) {
      if (!unit(answer.pNull) || !unit(answer.confidence)) {
        problems.push(
          `${name}: pNull ${String(answer.pNull)} or confidence ${String(answer.confidence)} is not in 0..1`,
        );
      }
    }
    if (answers['placed']?.value !== '2026-03-14')
      problems.push(`placed is ${JSON.stringify(answers['placed']?.value)}`);
    if (answers['quantity']?.value !== 3) problems.push(`quantity is ${JSON.stringify(answers['quantity']?.value)}`);
    const items = answers['items']?.value;
    if (!Array.isArray(items) || !items.some((item) => typeof item === 'string' && /keyboard/i.test(item))) {
      problems.push(`items is ${JSON.stringify(items)}`);
    }
    const delivery = answers['delivery'];
    if (delivery?.value !== null) problems.push(`delivery is ${JSON.stringify(delivery?.value)}, expected null`);
    else if (delivery.pNull <= 0.5) problems.push(`delivery is absent but pNull is ${delivery.pNull}`);
    // `list` 字段在 Clairic 的响应里没有 `p_null`，适配器恒给 0：值是空的而 `pNull` 还是 0，这道防线在这条路径上是失效的。
    const colours = answers['colours'];
    const empty = colours?.value === null || (Array.isArray(colours?.value) && colours.value.length === 0);
    if (empty && colours.pNull <= 0.5) problems.push(`colours is absent (a list field) but pNull is ${colours.pNull}`);
    return { observation: answers as unknown as JsonValue, problems };
  },
};

/** 连一台 MCP 服务器，列工具；给了工具名就调一下。 */
const mcp: Scenario = {
  name: 'mcp',
  applies: (target) => target.kind === 'mcp',
  async run(target) {
    if (target.kind !== 'mcp') throw new Error('mcp needs an mcp target.');
    const hub = createMcpHub(
      { live: { url: target.url, ...(target.type ? { type: target.type } : {}) } },
      { timeoutMs: 30_000, callTimeoutMs: 60_000 },
    );
    try {
      const [status] = await hub.connect();
      const definitions = await hub.tools();
      const names = definitions.map((definition) => definition.name).toSorted();
      const problems: string[] = [];
      if (status?.state !== 'connected') problems.push(`the server is ${status?.state}: ${JSON.stringify(status)}`);
      if (names.length === 0) problems.push('the server lists no tools');
      const untyped = definitions.filter((definition) => definition.inputSchema === undefined);
      if (untyped.length > 0)
        problems.push(`tools without an input schema: ${untyped.map((item) => item.name).join()}`);
      let output: JsonValue = null;
      if (target.tool && problems.length === 0) {
        const name = names.find((candidate) => candidate.endsWith(target.tool!));
        if (!name) problems.push(`the server has no tool ${target.tool}; it has ${names.join(', ')}`);
        else {
          const result = await hub.execute({ id: 'live-1', name, input: target.input ?? {} }, { session: 'live' });
          output = { type: result.type };
          if (result.type === 'error') problems.push(`calling ${name} returned an error: ${JSON.stringify(result)}`);
        }
      }
      return { observation: { tools: names, output }, problems };
    } finally {
      await hub.close();
    }
  },
};

export const SCENARIOS: readonly Scenario[] = [modelToolStream, gatewayRewrite, decide, extract, mcp];

export function scenarioNamed(name: string): Scenario | undefined {
  return SCENARIOS.find((scenario) => scenario.name === name);
}
