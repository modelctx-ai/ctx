import type { IncomingMessage, ServerResponse } from 'node:http';

import type { AgentSpec, Awaitable } from '@modelctx-ai/ctx-protocol';

import {
  CONFORMANCE_COMPONENTS,
  CONFORMANCE_PATH,
  type ConformanceComponent,
  type ConformanceInstance,
  type ConformanceSetup,
} from './conformance-wire.ts';
import { createRemoteHandler, type RemoteHandler, type RemoteHandlerOptions } from './server.ts';
import { parse, stringify } from './wire.ts';

/** `create` 给出的一个实例：挂哪些组件（和 `createRemoteHandler` 的选项一样），以及给一致性测试的 agent、回显工具。 */
export interface ConformanceInstanceOptions extends Omit<
  RemoteHandlerOptions,
  'basePath' | 'accessToken' | 'authenticate'
> {
  /** harness、编排器的契约用的 agent：模型名对着按 `setup.script` 回答的模型。 */
  readonly agent?: Pick<AgentSpec, 'model'> & Partial<AgentSpec>;
  /** 执行环境的契约用：哪个执行环境、它的回显工具叫什么。 */
  readonly executor?: { readonly name: string; readonly echo: string };
}

export interface ConformanceHandlerOptions {
  /** 每个用例一个新实例：空的存储，按 `setup.script` 回答的模型，按 `setup.clock` 走的钟。 */
  readonly create: (setup: ConformanceSetup) => Awaitable<ConformanceInstanceOptions>;
  readonly accessToken?: string;
  /** 最多同时留多少个实例，缺省 256；再多就丢最早的。 */
  readonly maxInstances?: number;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(stringify(body));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  return text === '' ? {} : parse(text);
}

function setupOf(body: unknown): ConformanceSetup | string {
  if (typeof body !== 'object' || body === null) return 'body must be a ConformanceSetup object';
  const { components, script, clock } = body as Record<string, unknown>;
  if (!Array.isArray(components) || components.some((name) => !CONFORMANCE_COMPONENTS.includes(name as never))) {
    return `components must be some of ${CONFORMANCE_COMPONENTS.join(', ')}`;
  }
  if (script !== undefined && !Array.isArray(script)) return 'script must be an array of ModelScriptStep';
  const { delayMs } = body as { delayMs?: unknown };
  if (delayMs !== undefined && (typeof delayMs !== 'number' || delayMs < 0))
    return 'delayMs must be a non-negative number';
  if (clock !== undefined && clock !== 'real') {
    const { at, step } = (clock ?? {}) as Record<string, unknown>;
    if (typeof at !== 'number' || typeof step !== 'number') return 'clock must be "real" or { at, step }';
  }
  return body as ConformanceSetup;
}

/**
 * 一致性模式的服务：`POST /conformance/instances` 按请求建一个隔离的实例，回 `{ baseUrl }`（相对这个服务的路径），
 * 实例的线上形态和 `createRemoteHandler` 一样，挂在那个路径下。只给一致性测试用：每个实例都是新的内存组件，
 * 不该对外开放。别的语言实现的服务端提供同样的入口，就能用 `ctx-conformance` 对它跑契约测试。
 */
export function createConformanceHandler(options: ConformanceHandlerOptions): RemoteHandler {
  const instances = new Map<string, RemoteHandler>();
  const max = Math.max(1, options.maxInstances ?? 256);
  return async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const method = req.method ?? 'GET';
    if (url.pathname === CONFORMANCE_PATH) {
      if (method !== 'POST') return send(res, 405, { error: { message: `use POST ${CONFORMANCE_PATH}` } });
      if (options.accessToken && req.headers.authorization !== `Bearer ${options.accessToken}`) {
        return send(res, 401, { error: { message: 'unauthorized', type: 'authentication_error' } });
      }
      const setup = setupOf(await readBody(req));
      if (typeof setup === 'string') return send(res, 400, { error: { message: setup, type: 'invalid_request' } });
      const id = crypto.randomUUID();
      const basePath = `${CONFORMANCE_PATH}/${id}`;
      const { agent, executor, ...mounted } = await options.create(setup);
      instances.set(
        id,
        createRemoteHandler({
          ...mounted,
          basePath,
          ...(options.accessToken ? { accessToken: options.accessToken } : {}),
        }),
      );
      for (const oldest of instances.keys()) {
        if (instances.size <= max) break;
        instances.delete(oldest);
      }
      const instance: ConformanceInstance = {
        baseUrl: basePath,
        ...(agent ? { agent } : {}),
        ...(executor ? { executor } : {}),
      };
      return send(res, 200, instance);
    }
    const prefix = `${CONFORMANCE_PATH}/`;
    const id = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length).split('/')[0] : undefined;
    const handler = id ? instances.get(id) : undefined;
    if (!handler) return send(res, 404, { error: { message: `not found: ${url.pathname}`, type: 'not_found_error' } });
    await handler(req, res);
  };
}

export type { ConformanceComponent, ConformanceInstance, ConformanceSetup };
