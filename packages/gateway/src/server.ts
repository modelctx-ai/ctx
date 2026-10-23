import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';

import type { ChatCompletionRequest } from './messages.ts';
import type { Rewrite } from './rewrite.ts';

export interface UpstreamOptions {
  /** 上游接口根地址，写到 `/v1` 为止。 */
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface GatewayOptions {
  readonly upstream: UpstreamOptions;
  /** 只作用于 `POST <basePath>/chat/completions`，其余路径原样转发。 */
  readonly rewrite?: Rewrite;
  /** 要求调用方带 `Authorization: Bearer <accessToken>`。真密钥只留在网关里。 */
  readonly accessToken?: string;
  /** 缺省 `127.0.0.1`。 */
  readonly host?: string;
  /** 缺省 0：随机端口。 */
  readonly port?: number;
  /** 对外的路径前缀，缺省 `/v1`。 */
  readonly basePath?: string;
  /** 请求体上限，缺省 4 MiB。 */
  readonly maxBodyBytes?: number;
  readonly fetch?: typeof fetch;
  readonly onError?: (error: unknown) => void;
}

export interface Gateway {
  /** 例如 `http://127.0.0.1:53001`。 */
  readonly origin: string;
  /** 给调用方填的接口地址：`origin + basePath`。 */
  readonly baseUrl: string;
  close(): Promise<void>;
}

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** 逐跳头和长度、压缩相关的头不转发：fetch 已经解压过正文，长度也会变。 */
const DROPPED_RESPONSE_HEADERS = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'content-encoding',
  'content-length',
  'upgrade',
]);

function sendError(res: ServerResponse, status: number, message: string): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ error: { message, type: status === 401 ? 'authentication_error' : 'gateway_error' } }));
}

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(413, `request body exceeds ${limit} bytes`);
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

function authorized(req: IncomingMessage, token: string | undefined): boolean {
  if (!token) return true;
  const header = req.headers.authorization ?? '';
  const given = Buffer.from(header.startsWith('Bearer ') ? header.slice(7) : '');
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

function normalizePath(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

/** 可以挂到已有 HTTP 服务上的处理函数。 */
export function createGatewayHandler(
  options: GatewayOptions,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const upstream = options.upstream.baseUrl.replace(/\/+$/, '');
  const basePath = normalizePath(options.basePath ?? '/v1');
  const limit = options.maxBodyBytes ?? 4 * 1024 * 1024;
  const fetcher = options.fetch ?? fetch;

  return async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://gateway.local');
    if (url.pathname !== basePath && !url.pathname.startsWith(`${basePath}/`)) {
      sendError(res, 404, 'not found');
      return;
    }
    if (!authorized(req, options.accessToken)) {
      sendError(res, 401, 'unauthorized');
      return;
    }
    const rest = url.pathname.slice(basePath.length);
    const controller = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) controller.abort();
    });

    try {
      const method = req.method ?? 'GET';
      let body: Buffer | string | undefined =
        method === 'GET' || method === 'HEAD' ? undefined : await readBody(req, limit);
      if (method === 'POST' && rest === '/chat/completions' && options.rewrite && body !== undefined) {
        let parsed: ChatCompletionRequest;
        try {
          parsed = JSON.parse(body.toString('utf8')) as ChatCompletionRequest;
        } catch {
          throw new HttpError(400, 'request body is not valid JSON');
        }
        body = JSON.stringify(await options.rewrite(parsed));
      }

      const headers = new Headers({ ...options.upstream.headers });
      for (const name of ['content-type', 'accept']) {
        const value = req.headers[name];
        if (typeof value === 'string') headers.set(name, value);
      }
      if (options.upstream.apiKey) headers.set('authorization', `Bearer ${options.upstream.apiKey}`);

      const response = await fetcher(`${upstream}${rest}${url.search}`, {
        method,
        headers,
        ...(body !== undefined ? { body } : {}),
        signal: controller.signal,
      });
      const outgoing: Record<string, string> = {};
      response.headers.forEach((value, name) => {
        if (!DROPPED_RESPONSE_HEADERS.has(name.toLowerCase())) outgoing[name] = value;
      });
      res.writeHead(response.status, outgoing);
      if (!response.body) {
        res.end();
        return;
      }
      const stream = Readable.fromWeb(response.body as unknown as NodeReadableStream);
      stream.on('error', (error) => {
        options.onError?.(error);
        res.destroy(error);
      });
      stream.pipe(res);
    } catch (error) {
      if (controller.signal.aborted) return;
      options.onError?.(error);
      if (error instanceof HttpError) sendError(res, error.status, error.message);
      else sendError(res, 502, error instanceof Error ? error.message : 'upstream request failed');
    }
  };
}

/** 起一个只听本机的网关。 */
export function startGateway(options: GatewayOptions): Promise<Gateway> {
  const handler = createGatewayHandler(options);
  const server = createServer((req, res) => {
    void handler(req, res);
  });
  const host = options.host ?? '127.0.0.1';
  const basePath = normalizePath(options.basePath ?? '/v1');
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, host, () => {
      server.off('error', reject);
      const { port } = server.address() as AddressInfo;
      const origin = `http://${host.includes(':') ? `[${host}]` : host}:${port}`;
      resolve({
        origin,
        baseUrl: `${origin}${basePath}`,
        close: () =>
          new Promise<void>((done, fail) => {
            server.close((error) => (error ? fail(error) : done()));
            server.closeAllConnections();
          }),
      });
    });
  });
}
