// 把一次场景里的 HTTP 往来录下来，之后不联网重放。
//
// 录的是请求的方法、地址、正文和响应的状态、类型、正文；请求头一律不录，密钥和账号在地址、正文里出现的地方
// 换成 `REDACTED`。重放时按录的顺序给响应，地址对不上就报错——请求打到了别的地方，本身就是映射变了。
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { JsonValue } from '@modelctx-ai/ctx';

export interface Exchange {
  readonly request: { readonly method: string; readonly url: string; readonly body?: string };
  readonly response: { readonly status: number; readonly contentType: string; readonly body: string };
}

/** 一次场景录下来的全部：怎么重建目标、往来、当时看到的结果。 */
export interface Fixture {
  readonly scenario: string;
  /** 目标的配置，密钥和账号已经换成 `REDACTED`。 */
  readonly target: JsonValue;
  readonly recordedAt: string;
  readonly exchanges: readonly Exchange[];
  readonly observation: JsonValue;
}

export const REDACTED = 'REDACTED';

/** 把 `secrets` 里的每个值换成 `REDACTED`。太短的不换（会误伤正文），调用方不该传。 */
export function scrub(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) if (secret.length >= 6) out = out.replaceAll(secret, REDACTED);
  return out;
}

/** 本机地址不录也不重放：场景自己起的服务（网关）走真的 `fetch`。 */
function isLoopback(url: string): boolean {
  const { hostname } = new URL(url);
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]';
}

function describeRequest(input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]) {
  const request = input instanceof Request ? input : undefined;
  const url = request?.url ?? (input instanceof URL ? input.href : (input as string));
  const method = (init?.method ?? request?.method ?? 'GET').toUpperCase();
  const body = typeof init?.body === 'string' ? init.body : undefined;
  return { url, method, body };
}

export interface Recorder {
  readonly fetch: typeof fetch;
  /** 等所有响应读完（流式的要等流结束），返回录下的往来。 */
  finish(): Promise<Exchange[]>;
}

export function recordingFetch(inner: typeof fetch, secrets: readonly string[]): Recorder {
  const pending: Promise<Exchange>[] = [];
  const recorder: typeof fetch = async (input, init) => {
    const { url, method, body } = describeRequest(input, init);
    const response = await inner(input, init);
    if (isLoopback(url)) return response;
    // 另读一份：调用方照常消费原来的流。
    const copy = response.clone();
    pending.push(
      copy.text().then((text) => ({
        request: { method, url: scrub(url, secrets), ...(body === undefined ? {} : { body: scrub(body, secrets) }) },
        response: {
          status: response.status,
          contentType: response.headers.get('content-type') ?? '',
          body: scrub(text, secrets),
        },
      })),
    );
    return response;
  };
  return { fetch: recorder, finish: () => Promise.all(pending) };
}

/** 按顺序重放。请求的方法或地址和录的不一样、或者请求比录的多，都抛错。 */
export function replayFetch(exchanges: readonly Exchange[], inner: typeof fetch = globalThis.fetch): typeof fetch {
  let next = 0;
  return async (input, init) => {
    const { url, method } = describeRequest(input, init);
    if (isLoopback(url)) return inner(input, init);
    const exchange = exchanges[next];
    if (!exchange) throw new Error(`Replay: unexpected request ${method} ${url} after ${exchanges.length} recorded.`);
    next += 1;
    if (exchange.request.method !== method || exchange.request.url !== url) {
      throw new Error(
        `Replay: request ${next} is ${method} ${url}, but ${exchange.request.method} ${exchange.request.url} was recorded.`,
      );
    }
    return new Response(exchange.response.body, {
      status: exchange.response.status,
      headers: exchange.response.contentType ? { 'content-type': exchange.response.contentType } : {},
    });
  };
}

/** 场景里用到全局 `fetch` 的库（AI SDK 的服务商、MCP 客户端）没有注入口，跑的时候把全局的换掉，跑完换回来。 */
export async function withFetch<T>(replacement: typeof fetch, work: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = replacement;
  try {
    return await work();
  } finally {
    globalThis.fetch = original;
  }
}

export function fixtureFile(directory: string, target: string, scenario: string): string {
  return path.join(directory, `${target}.${scenario}.json`);
}

export function writeFixture(file: string, fixture: Fixture): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(fixture, null, 2)}\n`);
}

export function readFixtures(directory: string): { readonly file: string; readonly fixture: Fixture }[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .toSorted()
    .map((name) => ({
      file: name,
      fixture: JSON.parse(readFileSync(path.join(directory, name), 'utf8')) as Fixture,
    }));
}
