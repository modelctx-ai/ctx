import type { ToolResultPart } from 'ai';

import type { JsonObject, JsonValue } from './types.ts';

// ---- 工具目录 ----

/**
 * 工具的定义：给模型看的名字、说明和输入结构，加上由哪个执行环境执行。目录里只有定义，没有函数。
 * 命名按服务和资源加前缀（MCP 工具是 `<server>__<tool>`），说明写给新同事看。
 */
export interface ToolDefinition {
  /** `[a-zA-Z0-9_-]{1,64}`，各家接口对函数名的共同限制。 */
  readonly name: string;
  readonly description?: string;
  /** JSON Schema 对象，例如 `{ type: 'object', properties: { … }, required: [ … ] }`。 */
  readonly inputSchema: JsonObject;
  /** 执行它的执行环境的名字。 */
  readonly executor: string;
  /** 工具从哪来：`local`、`mcp:<server>`、`process` 之类。 */
  readonly source?: string;
  readonly tags?: readonly string[];
}

/**
 * 能序列化的工具筛选，`AgentSpec.tools` 用它。`true` 全部、`false` 不要、名字列表，
 * 或按名字、标签、来源筛：每一项里任一个命中即可，给了的几项都要命中。
 */
export type ToolSelection =
  | boolean
  | readonly string[]
  | {
      readonly names?: readonly string[];
      readonly tags?: readonly string[];
      readonly sources?: readonly string[];
    };

/** 进程内还可以用函数筛。 */
export type ToolFilter = ToolSelection | ((tool: ToolDefinition) => boolean);

export function matchesTool(tool: ToolDefinition, filter: ToolFilter = true): boolean {
  if (typeof filter === 'boolean') return filter;
  if (typeof filter === 'function') return filter(tool);
  if (Array.isArray(filter)) return filter.includes(tool.name);
  const { names, tags, sources } = filter as Exclude<ToolSelection, boolean | readonly string[]>;
  if (names && !names.includes(tool.name)) return false;
  if (tags && !tags.some((tag) => tool.tags?.includes(tag))) return false;
  if (sources && (tool.source === undefined || !sources.includes(tool.source))) return false;
  return true;
}

/** 按筛选挑工具，保持原来的顺序。`ToolRegistry.select` 的语义就是它。 */
export function selectTools(tools: readonly ToolDefinition[], filter: ToolFilter = true): ToolDefinition[] {
  if (filter === false) return [];
  return tools.filter((tool) => matchesTool(tool, filter));
}

const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

export function isValidToolName(name: string): boolean {
  return TOOL_NAME.test(name);
}

export interface AddToolOptions {
  /** 同名时替换，而不是报错。 */
  readonly replace?: boolean;
}

/** 工具目录。本地工具、MCP 工具、子进程工具放在一处，每次调用按需挑一部分交给模型。 */
export interface ToolRegistry {
  readonly size: number;
  /** 名字不合法、或同名已存在且没给 `replace` 时抛错。 */
  add(definition: ToolDefinition, options?: AddToolOptions): ToolRegistry;
  remove(name: string): boolean;
  /** 删掉某个来源的全部工具，返回条数。 */
  removeSource(source: string): number;
  has(name: string): boolean;
  get(name: string): ToolDefinition | undefined;
  /** 按加入的顺序。 */
  list(): ToolDefinition[];
  /** 同 `selectTools(list(), filter)`，缺省全部。 */
  select(filter?: ToolFilter): ToolDefinition[];
}

// ---- 执行 ----

export interface ToolCall {
  /** 模型给的调用 id，结果按它对回去。 */
  readonly id: string;
  readonly name: string;
  readonly input: JsonValue;
}

/** 文件内容：base64 数据、地址、服务商的文件引用，或内联文字。 */
export type ToolFileData =
  | { readonly type: 'data'; readonly data: string }
  | { readonly type: 'url'; readonly url: string }
  | { readonly type: 'reference'; readonly reference: Readonly<Record<string, string>> }
  | { readonly type: 'text'; readonly text: string };

export type ToolContentPart =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'file'; readonly mediaType: string; readonly data: ToolFileData; readonly filename?: string };

/**
 * 一次工具调用的结果，能 `JSON.stringify`。和 AI SDK 工具结果的 `output` 互转见
 * `toolOutputToAiSdk` / `toolOutputFromAiSdk`。
 */
export type ToolOutput =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'json'; readonly value: JsonValue }
  | { readonly type: 'content'; readonly parts: readonly ToolContentPart[] }
  | {
      readonly type: 'error';
      /** 写给模型看、能照着做的错误（「文件不存在：/a/b，当前目录有 …」），不是错误码。 */
      readonly message: string;
      readonly retryable?: boolean;
      readonly data?: JsonValue;
    };

export function errorOutput(message: string, options?: { retryable?: boolean; data?: JsonValue }): ToolOutput {
  return {
    type: 'error',
    message,
    ...(options?.retryable !== undefined ? { retryable: options.retryable } : {}),
    ...(options?.data !== undefined ? { data: options.data } : {}),
  };
}

/** 一次工具调用附带的环境。 */
export interface ExecutionContext {
  readonly session: string;
  readonly runId?: string;
  readonly signal?: AbortSignal;
}

/**
 * 执行环境：工具调用真正发生的地方。进程内函数、子进程、MCP 服务器、容器、远端服务都是它。
 * 执行出错返回 `{ type: 'error' }` 而不是抛：模型要看到错误才能接着做；抛出表示执行环境本身坏了。
 */
export interface Executor {
  readonly name: string;
  /** 它能执行哪些工具。MCP、子进程这类执行环境自己报；函数执行环境报注册进来的。 */
  tools?(): Promise<ToolDefinition[]>;
  /** 不认识的工具、`signal` 已中止都返回 `{ type: 'error' }`。 */
  execute(call: ToolCall, context: ExecutionContext): Promise<ToolOutput>;
  /** 准备（起进程、连服务器）。可以重复调。 */
  provision?(): Promise<void>;
  /** 释放。之后不再执行。 */
  dispose?(): Promise<void>;
}

// ---- 和 AI SDK 互转 ----

export type AiSdkToolOutput = ToolResultPart['output'];
type AiSdkContentPart = Extract<AiSdkToolOutput, { type: 'content' }>['value'][number];
type AiSdkFileData = Extract<AiSdkContentPart, { type: 'file' }>['data'];

/** 错误带 `retryable` 或 `data` 时放进 `error-json`，只有文字时用 `error-text`。 */
interface ErrorJson {
  message: string;
  retryable?: boolean;
  data?: JsonValue;
}

function fileDataToAiSdk(data: ToolFileData): AiSdkFileData {
  switch (data.type) {
    case 'data':
      return { type: 'data', data: data.data };
    case 'url': {
      const url = new URL(data.url);
      // URL 会规范化写法，原样的字符串放进 originalUrl，转回来不变。
      return url.href === data.url ? { type: 'url', url } : { type: 'url', url, originalUrl: data.url };
    }
    case 'reference':
      return { type: 'reference', reference: { ...data.reference } };
    default:
      return { type: 'text', text: data.text };
  }
}

/** 协议的工具结果转成 AI SDK 的 `output`。不丢信息：`toolOutputFromAiSdk` 能原样转回来。 */
export function toolOutputToAiSdk(output: ToolOutput): AiSdkToolOutput {
  switch (output.type) {
    case 'text':
      return { type: 'text', value: output.text };
    case 'json':
      return { type: 'json', value: output.value };
    case 'content':
      return {
        type: 'content',
        value: output.parts.map((part): AiSdkContentPart => {
          if (part.type === 'text') return { type: 'text', text: part.text };
          return {
            type: 'file',
            mediaType: part.mediaType,
            data: fileDataToAiSdk(part.data),
            ...(part.filename !== undefined ? { filename: part.filename } : {}),
          };
        }),
      };
    default: {
      if (output.retryable === undefined && output.data === undefined)
        return { type: 'error-text', value: output.message };
      const value: ErrorJson = { message: output.message };
      if (output.retryable !== undefined) value.retryable = output.retryable;
      if (output.data !== undefined) value.data = output.data;
      return { type: 'error-json', value: value as unknown as JsonObject };
    }
  }
}

function base64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(binary);
}

function bytesToBase64(data: string | Uint8Array | ArrayBuffer): string {
  if (typeof data === 'string') return data;
  return base64(data instanceof Uint8Array ? data : new Uint8Array(data));
}

function fileDataFromAiSdk(data: AiSdkFileData): ToolFileData {
  switch (data.type) {
    case 'data':
      return { type: 'data', data: bytesToBase64(data.data) };
    case 'url':
      return { type: 'url', url: data.originalUrl ?? data.url.href };
    case 'reference':
      return { type: 'reference', reference: { ...data.reference } };
    default:
      return { type: 'text', text: data.text };
  }
}

function referenceOf(fileId: string | Record<string, string>): Record<string, string> {
  return typeof fileId === 'string' ? { default: fileId } : { ...fileId };
}

function contentPartFromAiSdk(part: AiSdkContentPart): ToolContentPart | undefined {
  switch (part.type) {
    case 'text':
      return { type: 'text', text: part.text };
    case 'file':
      return {
        type: 'file',
        mediaType: part.mediaType,
        data: fileDataFromAiSdk(part.data),
        ...(part.filename !== undefined ? { filename: part.filename } : {}),
      };
    // 下面是 AI SDK 已弃用的写法，统一换成 `file`。
    case 'file-data':
      return {
        type: 'file',
        mediaType: part.mediaType,
        data: { type: 'data', data: part.data },
        ...(part.filename !== undefined ? { filename: part.filename } : {}),
      };
    case 'file-url':
      return {
        type: 'file',
        mediaType: part.mediaType ?? 'application/octet-stream',
        data: { type: 'url', url: part.url },
      };
    case 'file-id':
      return {
        type: 'file',
        mediaType: 'application/octet-stream',
        data: { type: 'reference', reference: referenceOf(part.fileId) },
      };
    case 'file-reference':
      return {
        type: 'file',
        mediaType: 'application/octet-stream',
        data: { type: 'reference', reference: { ...part.providerReference } },
      };
    case 'image-data':
      return { type: 'file', mediaType: part.mediaType, data: { type: 'data', data: part.data } };
    case 'image-url':
      return { type: 'file', mediaType: 'image', data: { type: 'url', url: part.url } };
    case 'image-file-id':
      return { type: 'file', mediaType: 'image', data: { type: 'reference', reference: referenceOf(part.fileId) } };
    case 'image-file-reference':
      return {
        type: 'file',
        mediaType: 'image',
        data: { type: 'reference', reference: { ...part.providerReference } },
      };
    // 服务商自定义分段没有可序列化的内容，丢掉。
    default:
      return undefined;
  }
}

function isErrorJson(value: JsonValue): value is JsonObject & ErrorJson {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  if (typeof value['message'] !== 'string') return false;
  if (value['retryable'] !== undefined && typeof value['retryable'] !== 'boolean') return false;
  return Object.keys(value).every((key) => key === 'message' || key === 'retryable' || key === 'data');
}

/**
 * AI SDK 的 `output` 转成协议的工具结果。`text`、`json`、`error-text`、新式 `content` 原样对应；
 * `error-json` 是 `{ message, retryable?, data? }` 时拆开，否则整个放进 `data`；`execution-denied` 变成错误；
 * 已弃用的内容分段换成 `file`；`providerOptions` 和 `custom` 分段丢掉（它们不能序列化或只对某家有效）。
 */
export function toolOutputFromAiSdk(output: AiSdkToolOutput): ToolOutput {
  switch (output.type) {
    case 'text':
      return { type: 'text', text: output.value };
    case 'json':
      return { type: 'json', value: output.value as JsonValue };
    case 'error-text':
      return { type: 'error', message: output.value };
    case 'error-json': {
      const value = output.value as JsonValue;
      if (isErrorJson(value)) return errorOutput(value.message, value);
      return { type: 'error', message: JSON.stringify(value), data: value };
    }
    case 'execution-denied':
      return { type: 'error', message: output.reason ?? 'Tool execution was denied.' };
    default: {
      const parts: ToolContentPart[] = [];
      for (const part of output.value) {
        const converted = contentPartFromAiSdk(part);
        if (converted) parts.push(converted);
      }
      return { type: 'content', parts };
    }
  }
}
