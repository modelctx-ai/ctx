// 测试用的假 Anthropic Messages API（`@modelctx-ai/ctx-pi/testing`）：pi 的 `models.json` 里配一个提供方指过来（`models`），
// 按剧本回答。pi 的每个请求（主循环和它自己的压缩）都取剧本的下一步。
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { JsonObject } from '@modelctx-ai/ctx-protocol';

/**
 * 剧本的一步，和契约测试的 `ModelScriptStep` 同形状，多几个可选项：`delayMs` 先等一会儿再回答（测取消），`reasoning` 在文字
 * 前面先给一段推理，`error` 的 `status` 是 HTTP 状态码（缺省 500）；`tool-calls` 一条消息里先说一段话（可选）再并行调几次工具。
 */
export type FakeAnthropicStep =
  | {
      readonly type: 'text';
      readonly text: string;
      readonly truncated?: boolean;
      readonly reasoning?: string;
      readonly delayMs?: number;
    }
  | {
      readonly type: 'tool-call';
      readonly id: string;
      readonly input: JsonObject;
      /** 这一步调哪个工具，缺省是 `FakeAnthropicApiOptions.tool`。 */
      readonly tool?: string;
      readonly delayMs?: number;
    }
  | { readonly type: 'error'; readonly message: string; readonly status?: number; readonly delayMs?: number }
  | {
      readonly type: 'tool-calls';
      readonly text?: string;
      readonly calls: readonly { readonly id: string; readonly input: JsonObject; readonly tool?: string }[];
      readonly delayMs?: number;
    };

export interface FakeAnthropicApiOptions {
  readonly script: readonly FakeAnthropicStep[];
  /** `tool-call` 调哪个工具：请求里名字是它、或以 `__<它>` 结尾的那个（MCP 工具叫 `mcp__ctx__echo`），缺省 `echo`。 */
  readonly tool?: string;
}

/** 收到的一个请求。 */
export interface FakeAnthropicRequest {
  readonly model: string;
  readonly system: string;
  readonly tools: readonly string[];
  readonly messages: readonly JsonObject[];
}

export interface FakeAnthropicApi {
  readonly url: string;
  readonly requests: readonly FakeAnthropicRequest[];
  /**
   * pi 的 `models.json`（放在代理目录 `PI_CODING_AGENT_DIR` 里）：一个叫 `fake` 的提供方指到这个假接口，模型是 `fake-model`，
   * `AgentSpec.model` 写 `fake/fake-model`。
   */
  readonly models: JsonObject;
  close(): Promise<void>;
}

/** `models` 里那个模型在 `AgentSpec.model` 里的写法。 */
export const FAKE_MODEL = 'fake/fake-model';

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  try {
    const value = JSON.parse(text) as unknown;
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function systemText(system: unknown): string {
  if (typeof system === 'string') return system;
  if (!Array.isArray(system)) return '';
  return system
    .map((block) => (block as { text?: unknown }).text)
    .filter((text) => typeof text === 'string')
    .join('\n');
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) }).end(text);
}

type Block =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'thinking'; readonly thinking: string; readonly signature: string }
  | { readonly type: 'tool_use'; readonly id: string; readonly name: string; readonly input: JsonObject };

function blockEvents(block: Block, index: number): object[] {
  if (block.type === 'text') {
    return [
      { type: 'content_block_start', index, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } },
      { type: 'content_block_stop', index },
    ];
  }
  if (block.type === 'thinking') {
    return [
      { type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '', signature: '' } },
      { type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: block.thinking } },
      { type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: block.signature } },
      { type: 'content_block_stop', index },
    ];
  }
  return [
    {
      type: 'content_block_start',
      index,
      content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} },
    },
    {
      type: 'content_block_delta',
      index,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) },
    },
    { type: 'content_block_stop', index },
  ];
}

export async function createFakeAnthropicApi(options: FakeAnthropicApiOptions): Promise<FakeAnthropicApi> {
  const wanted = options.tool ?? 'echo';
  const requests: FakeAnthropicRequest[] = [];
  let next = 0;

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://fake.local');
      const body = await readJson(req);
      if (req.method !== 'POST' || !url.pathname.startsWith('/v1/messages')) {
        return json(res, 404, { type: 'error', error: { type: 'not_found_error', message: 'fake: no such route' } });
      }
      if (url.pathname.endsWith('/count_tokens')) return json(res, 200, { input_tokens: 100 });
      const tools = Array.isArray(body['tools'])
        ? (body['tools'] as { name?: unknown }[]).flatMap((tool) => (typeof tool.name === 'string' ? [tool.name] : []))
        : [];
      const model = typeof body['model'] === 'string' ? body['model'] : 'fake';
      requests.push({
        model,
        system: systemText(body['system']),
        tools,
        messages: Array.isArray(body['messages']) ? (body['messages'] as JsonObject[]) : [],
      });
      const step: FakeAnthropicStep = options.script[next++] ?? {
        type: 'error',
        message: 'The fake API script is exhausted.',
      };
      if (step.delayMs) await new Promise((resolve) => setTimeout(resolve, step.delayMs));
      if (step.type === 'error') {
        return json(res, step.status ?? 500, { type: 'error', error: { type: 'api_error', message: step.message } });
      }
      const nameOf = (tool = wanted): string =>
        tools.find((name) => name === tool || name.endsWith(`__${tool}`)) ?? tool;
      let blocks: Block[];
      if (step.type === 'tool-call') {
        blocks = [{ type: 'tool_use', id: step.id, name: nameOf(step.tool), input: step.input }];
      } else if (step.type === 'tool-calls') {
        blocks = [
          ...(step.text ? [{ type: 'text', text: step.text } as const] : []),
          ...step.calls.map(
            (call) => ({ type: 'tool_use', id: call.id, name: nameOf(call.tool), input: call.input }) as const,
          ),
        ];
      } else {
        blocks = [
          ...(step.reasoning
            ? [{ type: 'thinking', thinking: step.reasoning, signature: `sig-${next}` } as const]
            : []),
          { type: 'text', text: step.text },
        ];
      }
      const stop = blocks.some((block) => block.type === 'tool_use')
        ? 'tool_use'
        : step.type === 'text' && step.truncated
          ? 'max_tokens'
          : 'end_turn';
      const usage = { input_tokens: 20, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
      const message = {
        id: `msg_fake_${next}`,
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage,
      };
      if (body['stream'] !== true) {
        return json(res, 200, {
          ...message,
          content: blocks,
          stop_reason: stop,
          usage: { ...usage, output_tokens: 5 },
        });
      }
      const events = [
        { type: 'message_start', message },
        ...blocks.flatMap(blockEvents),
        { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 5 } },
        { type: 'message_stop' },
      ];
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      for (const event of events)
        res.write(`event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`);
      res.end();
    })().catch((error: unknown) => {
      if (!res.headersSent) json(res, 500, { type: 'error', error: { type: 'api_error', message: String(error) } });
      else res.destroy();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  return {
    url: base,
    requests,
    models: {
      providers: {
        fake: {
          baseUrl: base,
          api: 'anthropic-messages',
          apiKey: 'fake-key-not-a-real-key',
          models: [
            {
              id: 'fake-model',
              contextWindow: 200_000,
              maxTokens: 4_096,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        },
      },
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
