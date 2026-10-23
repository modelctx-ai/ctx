# @modelctx-ai/ctx-gateway

本机的 OpenAI 兼容网关。转发 `POST /v1/chat/completions` 时把调用方带来的历史换成 ctx 管理的上下文，其余请求原样转发，流式响应边收边转。给只会说 OpenAI 协议、自己截断历史的客户端用，例如 dsh-pet 的右键对话。

## 安装

```sh
pnpm add @modelctx-ai/ctx-gateway @modelctx-ai/ctx zod
```

Node ≥22。

## 用法

```ts
import { randomBytes } from 'node:crypto';

import { createContext, createMemoryStore } from '@modelctx-ai/ctx';
import { startGateway, withContext } from '@modelctx-ai/ctx-gateway';

const context = createContext({ store: createMemoryStore(), thread: 'pet:main' });
const accessToken = randomBytes(24).toString('base64url');

// 缺省只听 127.0.0.1、随机端口；只认本机的 Host，带 Origin 的浏览器请求一律 403
const gateway = await startGateway({
  upstream: { baseUrl: 'https://api.deepseek.com/v1', apiKey: process.env.DEEPSEEK_API_KEY },
  rewrite: withContext(context),
  accessToken,
});

// 客户端：接口地址填 gateway.baseUrl，密钥填 accessToken；真密钥只留在这个进程里
console.log(gateway.baseUrl);
```

挂到已有的 HTTP 服务上，换完历史再固定模型。处理函数不知道监听的端口，要自己给 `allowedHosts`：

```ts
import { createServer } from 'node:http';

import { createContext, createMemoryStore } from '@modelctx-ai/ctx';
import { createGatewayHandler, withContext, type Rewrite } from '@modelctx-ai/ctx-gateway';

const context = createContext({ store: createMemoryStore(), thread: 'pet:main' });
const history = withContext(context, { keepSystem: false });
const rewrite: Rewrite = async (request) => ({ ...(await history(request)), model: 'deepseek-chat' });

const handle = createGatewayHandler({
  upstream: { baseUrl: 'https://api.deepseek.com/v1', apiKey: process.env.DEEPSEEK_API_KEY },
  rewrite,
  basePath: '/llm/v1',
  allowedHosts: ['127.0.0.1:8080', 'localhost:8080'],
});

createServer((req, res) => void handle(req, res)).listen(8080, '127.0.0.1');
```

## 请求怎么处理

按顺序检查：

| 请求                                                                          | 处理                                                                          |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `Host` 不在 `allowedHosts` 里                                                 | 403                                                                           |
| 带 `Origin` 头，又不在 `allowedOrigins` 里（缺省一个都不放）                  | 403                                                                           |
| 路径不在 `basePath`（缺省 `/v1`）下                                           | 404                                                                           |
| 设了 `accessToken`，`Authorization: Bearer` 没带或不对（`Bearer` 不分大小写） | 401                                                                           |
| 请求体超过 `maxBodyBytes`（缺省 4 MiB）                                       | 413                                                                           |
| `POST <basePath>/chat/completions`，设了 `rewrite`                            | 请求体不是 JSON，或不是带 `messages` 数组的对象：400；否则 `rewrite` 以后转发 |
| 其他                                                                          | 原样转发：方法、路径、查询串、请求体                                          |
| 上游连不上                                                                    | 502                                                                           |

- `startGateway` 缺省只认监听地址的 `Host`（`host:port`，不分大小写），挡 DNS rebinding；监听本机时 `localhost`、`127.0.0.1`、`[::1]` 加端口都认。`createGatewayHandler` 没给 `allowedHosts` 就不查 `Host`，`Origin` 照查。
- 转发时只带调用方的 `content-type`、`accept`，加上 `upstream.headers`；有 `upstream.apiKey` 时设 `Authorization: Bearer <apiKey>`。
- 响应状态码和头原样转回（去掉逐跳头和 `content-encoding`、`content-length`），正文边收边转；调用方中途断开时取消上游请求，不算出错。
- 错误正文是 OpenAI 的形状 `{ "error": { "message", "type" } }`，`type` 是 `authentication_error`（401）、`permission_error`（403）或 `gateway_error`。
- `replaceHistory` 保留调用方的 `system` / `developer` 消息（`keepSystem: false` 时去掉），中间换成 `history()` 给的全文，再接上调用方从最后一句用户话起的尾巴：这句话和它之后的工具调用、工具结果、预填的助手话。全文最后一条和这句用户话内容完全相同（图片也比）时，这句不重复带。
- 网关不写日志：调用方的问答要由应用另外并进上下文。

## 导出

| 导出                                                                                                                                                          | 说明                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `startGateway(options)`                                                                                                                                       | 起一个网关，返回 `{ origin, baseUrl, close() }`             |
| `createGatewayHandler(options)`                                                                                                                               | 返回 `(req, res) => Promise<void>`，挂到已有的 HTTP 服务上  |
| `replaceHistory(history, options?)`                                                                                                                           | 生成改写函数，历史换成 `history()` 给的全文                 |
| `withContext(context, options?)`                                                                                                                              | 用 ctx 上下文的 `view()` 作为历史                           |
| `toChatMessages(messages)`                                                                                                                                    | AI SDK 消息转成 Chat Completions 消息：工具调用和结果、图片 |
| `chatText(content)`                                                                                                                                           | Chat Completions 消息里的纯文字                             |
| `GatewayOptions`、`UpstreamOptions`、`Gateway`、`Rewrite`、`ReplaceHistoryOptions`、`ChatCompletionRequest`、`ChatMessage`、`ChatContentPart`、`ChatToolCall` | 类型                                                        |

`GatewayOptions`：

| 选项             | 说明                                                                                             |
| ---------------- | ------------------------------------------------------------------------------------------------ |
| `upstream`       | `{ baseUrl, apiKey?, headers? }`，`baseUrl` 写到 `/v1` 为止                                      |
| `rewrite`        | 只作用于 `POST <basePath>/chat/completions`                                                      |
| `accessToken`    | 要求调用方带 `Authorization: Bearer <accessToken>`                                               |
| `host`、`port`   | 缺省 `127.0.0.1`、`0`（随机端口）                                                                |
| `basePath`       | 对外的路径前缀，缺省 `/v1`；`''` 或 `/` 挂在根上                                                 |
| `allowedHosts`   | 只接受这些 `Host`（`host:port`）。`startGateway` 缺省用监听地址，`createGatewayHandler` 缺省不查 |
| `allowedOrigins` | 带 `Origin` 头的请求只放行这些来源，缺省一个都不放                                               |
| `maxBodyBytes`   | 请求体上限，缺省 4 MiB                                                                           |
| `fetch`          | 换掉转发用的 `fetch`                                                                             |
| `onError`        | 转发出错时的回调                                                                                 |
