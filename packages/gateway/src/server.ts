import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';

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
  /**
   * 转发哪些请求，写成 `'<方法> <basePath 之后的路径>'`，缺省 `DEFAULT_ROUTES`（`POST /chat/completions`、`GET /models`）；
   * `'*'` 是全部。别的回 404、不转发：调用方的令牌不该等于上游密钥的全部权限（文件、微调、删除）。
   */
  readonly routes?: readonly string[] | '*';
  /**
   * 要求调用方带 `Authorization: Bearer <accessToken>`。真密钥只留在网关里。不给就不查；空串（或全是空白）直接抛错，
   * 免得 `process.env.X ?? ''` 这类写法悄悄变成不鉴权。
   */
  readonly accessToken?: string;
  /** 缺省 `127.0.0.1`。不是本机地址时必须给 `accessToken`，或者写明 `allowUnauthenticated: true`。 */
  readonly host?: string;
  /** 听在非本机地址上又不要鉴权（前面另有一层在管）时写 `true`；不写就拒绝启动。只有 `startGateway` 看它。 */
  readonly allowUnauthenticated?: boolean;
  /** 缺省 0：随机端口。 */
  readonly port?: number;
  /** 对外的路径前缀，缺省 `/v1`；`''` 或 `/` 表示挂在根上。 */
  readonly basePath?: string;
  /**
   * 只接受这些 Host 头（`host:port`，不分大小写），别的回 403，挡 DNS rebinding。`startGateway` 缺省用监听地址，
   * 监听本机时再加 `localhost`、`127.0.0.1`、`[::1]`；`createGatewayHandler` 不知道端口，不给就不查。
   */
  readonly allowedHosts?: readonly string[];
  /** 带 `Origin` 头的请求只放行这些来源，缺省一个都不放：浏览器网页发来的请求一律 403。 */
  readonly allowedOrigins?: readonly string[];
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

/** 缺省转发的请求：聊天补全和模型列表。 */
export const DEFAULT_ROUTES: readonly string[] = ['POST /chat/completions', 'GET /models'];

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
  const type = status === 401 ? 'authentication_error' : status === 403 ? 'permission_error' : 'gateway_error';
  res.end(JSON.stringify({ error: { message, type } }));
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
  // 认证方案不分大小写（RFC 9110）。
  const given = Buffer.from(/^bearer\s+(.+)$/i.exec(req.headers.authorization ?? '')?.[1] ?? '');
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** 去掉结尾的 `/`；挂在根上时是 `''`。 */
function normalizePath(path: string): string {
  const trimmed = path.trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

function lowered(values: readonly string[]): Set<string> {
  return new Set(values.map((value) => value.trim().toLowerCase().replace(/\/+$/, '')));
}

function isChatRequest(value: unknown): value is ChatCompletionRequest {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Array.isArray((value as { messages?: unknown }).messages)
  );
}

const LOOPBACK = ['localhost', '127.0.0.1', '::1'];

function isLoopback(host: string): boolean {
  return LOOPBACK.includes(host) || host.startsWith('127.');
}

/** 给了 `accessToken` 却是空的：当成配置写错，不当成「不要鉴权」。 */
function checkAccessToken(token: string | undefined): void {
  if (token !== undefined && !token.trim()) {
    throw new Error('`accessToken` is empty. Leave it out to run without authentication, or pass a real token.');
  }
}

/** `'post  /models/'` 这样的写法也认：方法大写，路径去掉结尾的 `/`。 */
function routeSet(routes: readonly string[]): Set<string> {
  return new Set(
    routes.map((route) => {
      const [method = '', ...path] = route.trim().split(/\s+/);
      return `${method.toUpperCase()} ${normalizePath(path.join(' '))}`;
    }),
  );
}

/** 监听地址本身；监听本机（或所有地址）时，本机的几种写法都认。 */
function defaultHosts(host: string, port: number): string[] {
  const local = isLoopback(host) || host === '0.0.0.0' || host === '::';
  const names = local ? [host, ...LOOPBACK] : [host];
  return names.flatMap((name) => {
    const bare = name.includes(':') ? `[${name}]` : name;
    return port === 80 ? [`${bare}:80`, bare] : [`${bare}:${port}`];
  });
}

/** 可以挂到已有 HTTP 服务上的处理函数。 */
export function createGatewayHandler(
  options: GatewayOptions,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  checkAccessToken(options.accessToken);
  const upstream = options.upstream.baseUrl.replace(/\/+$/, '');
  const basePath = normalizePath(options.basePath ?? '/v1');
  const routes = options.routes === '*' ? undefined : routeSet(options.routes ?? DEFAULT_ROUTES);
  const limit = options.maxBodyBytes ?? 4 * 1024 * 1024;
  const fetcher = options.fetch ?? fetch;
  const hosts = options.allowedHosts ? lowered(options.allowedHosts) : undefined;
  const origins = lowered(options.allowedOrigins ?? []);

  return async (req, res) => {
    if (hosts && !hosts.has(req.headers.host?.toLowerCase() ?? '')) {
      sendError(res, 403, 'host not allowed');
      return;
    }
    const origin = req.headers.origin;
    if (origin !== undefined && !origins.has(origin.toLowerCase())) {
      sendError(res, 403, 'origin not allowed');
      return;
    }
    const url = new URL(req.url ?? '/', 'http://gateway.local');
    if (basePath && url.pathname !== basePath && !url.pathname.startsWith(`${basePath}/`)) {
      sendError(res, 404, 'not found');
      return;
    }
    if (!authorized(req, options.accessToken)) {
      sendError(res, 401, 'unauthorized');
      return;
    }
    const rest = url.pathname.slice(basePath.length);
    if (routes && !routes.has(`${(req.method ?? 'GET').toUpperCase()} ${normalizePath(rest)}`)) {
      sendError(res, 404, 'not found');
      return;
    }
    const controller = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) controller.abort();
    });

    try {
      const method = req.method ?? 'GET';
      let body: Buffer | string | undefined =
        method === 'GET' || method === 'HEAD' ? undefined : await readBody(req, limit);
      if (method === 'POST' && rest === '/chat/completions' && options.rewrite && body !== undefined) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(body.toString('utf8'));
        } catch {
          throw new HttpError(400, 'request body is not valid JSON');
        }
        if (!isChatRequest(parsed)) throw new HttpError(400, 'request body must be a JSON object with messages');
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
      const stream = Readable.fromWeb(response.body);
      stream.on('error', (error) => {
        // 调用方自己断开时上游请求被中止，这不算出错。
        if (controller.signal.aborted) {
          res.destroy();
          return;
        }
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

/**
 * 起一个网关，缺省只听本机。Host 头缺省只认监听地址（见 `allowedHosts`）。
 * 听在非本机地址上而没有 `accessToken` 时拒绝启动，除非写明 `allowUnauthenticated: true`。
 */
export async function startGateway(options: GatewayOptions): Promise<Gateway> {
  const host = options.host ?? '127.0.0.1';
  checkAccessToken(options.accessToken);
  if (!isLoopback(host) && !options.accessToken && options.allowUnauthenticated !== true) {
    throw new Error(
      `Refusing to listen on ${host} without \`accessToken\`: anyone who can reach it could spend the upstream key. ` +
        'Pass `accessToken`, or `allowUnauthenticated: true` if something in front of it authenticates.',
    );
  }
  const basePath = normalizePath(options.basePath ?? '/v1');
  // 端口要等监听上才知道，处理函数到那时再建。
  let handler: ((req: IncomingMessage, res: ServerResponse) => Promise<void>) | undefined;
  const server = createServer((req, res) => {
    if (handler) void handler(req, res);
    else sendError(res, 503, 'gateway is starting');
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, host, () => {
      server.off('error', reject);
      const { port } = server.address() as AddressInfo;
      handler = createGatewayHandler({ ...options, allowedHosts: options.allowedHosts ?? defaultHosts(host, port) });
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
