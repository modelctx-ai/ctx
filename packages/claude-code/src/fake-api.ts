// 测试用的假 Anthropic Messages API（`@modelctx-ai/ctx-claude-code/testing`）：Claude Code 的 `ANTHROPIC_BASE_URL` 指过来，
// 按剧本回答。每个带工具的请求（Claude Code 的主循环和它自己的压缩）取剧本的下一步；不带工具的（标题这类后台请求，`--bare`
// 时没有）回一句话，不占剧本。
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { JsonObject } from '@modelctx-ai/ctx-protocol';

/**
 * 剧本的一步，和契约测试的 `ModelScriptStep` 同形状，多两个可选项：`delayMs` 先等一会儿再回答（测取消），
 * `status` 是 `error` 的 HTTP 状态码（缺省 500：Claude Code 在 `CLAUDE_CODE_MAX_RETRIES=0` 时不重试 5xx）。
 */
export type FakeAnthropicStep =
  | { readonly type: 'text'; readonly text: string; readonly truncated?: boolean; readonly delayMs?: number }
  | {
      readonly type: 'tool-call';
      readonly id: string;
      readonly input: JsonObject;
      /** 这一步调哪个工具，缺省是 `FakeAnthropicApiOptions.tool`。 */
      readonly tool?: string;
      readonly delayMs?: number;
    }
  | { readonly type: 'error'; readonly message: string; readonly status?: number; readonly delayMs?: number }
  /** 一条消息里先说一段话（可选），再并行调几次工具。 */
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

/** 收到的一个主循环请求。 */
export interface FakeAnthropicRequest {
  readonly model: string;
  readonly system: string;
  readonly tools: readonly string[];
  readonly messages: readonly JsonObject[];
}

export interface FakeAnthropicApi {
  /** 给 `ANTHROPIC_BASE_URL`。 */
  readonly url: string;
  readonly requests: readonly FakeAnthropicRequest[];
  close(): Promise<void>;
}

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
  | { readonly type: 'tool_use'; readonly id: string; readonly name: string; readonly input: JsonObject };

function blockEvents(block: Block, index: number): object[] {
  if (block.type === 'text') {
    return [
      { type: 'content_block_start', index, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } },
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

function parsedObject(text: string): JsonObject | undefined {
  try {
    const value = JSON.parse(text) as unknown;
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as JsonObject) : undefined;
  } catch {
    return undefined;
  }
}

export async function createFakeAnthropicApi(options: FakeAnthropicApiOptions): Promise<FakeAnthropicApi> {
  const wanted = options.tool ?? 'echo';
  const requests: FakeAnthropicRequest[] = [];
  let next = 0;
  let messages = 0;

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
      let step: FakeAnthropicStep;
      if (tools.length === 0) step = { type: 'text', text: 'ok' };
      else {
        requests.push({
          model,
          system: systemText(body['system']),
          tools,
          messages: Array.isArray(body['messages']) ? (body['messages'] as JsonObject[]) : [],
        });
        step = options.script[next++] ?? { type: 'error', message: 'The fake API script is exhausted.' };
      }
      if (step.delayMs) await new Promise((resolve) => setTimeout(resolve, step.delayMs));
      if (step.type === 'error') {
        return json(res, step.status ?? 500, { type: 'error', error: { type: 'api_error', message: step.message } });
      }
      let blocks: Block[];
      const nameOf = (tool = wanted): string =>
        tools.find((name) => name === tool || name.endsWith(`__${tool}`)) ?? tool;
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
        // 要了结构化输出（`--json-schema`），Claude Code 会给一个 `StructuredOutput` 工具：剧本里的 JSON 交给它。
        const structured = tools.includes('StructuredOutput') ? parsedObject(step.text) : undefined;
        blocks = structured
          ? [{ type: 'tool_use', id: `toolu_structured_${next}`, name: 'StructuredOutput', input: structured }]
          : [{ type: 'text', text: step.text }];
      }
      const stop = blocks.some((block) => block.type === 'tool_use')
        ? 'tool_use'
        : step.type === 'text' && step.truncated
          ? 'max_tokens'
          : 'end_turn';
      messages += 1;
      const usage = { input_tokens: 20, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
      const message = {
        id: `msg_fake_${messages}`,
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
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
