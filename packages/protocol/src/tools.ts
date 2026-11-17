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
  /**
   * 为一个会话准备好（起容器、建工作目录）。可以重复调：已经准备好就什么都不做。harness 在一轮里第一次把调用交给它之前调一次。
   * 满足不了 `environment`（没有那个镜像、不支持出站白名单）时抛 `invalid_request`，不静默降级。见 ADR 0009。
   */
  open?(session: string, options?: ExecutorSessionOptions): Promise<void>;
  /** 释放这个会话的资源。可以重复调；之后还能再 `open`。会话什么时候结束由应用决定。 */
  close?(session: string): Promise<void>;
}

export interface ExecutorSessionOptions {
  readonly environment?: EnvironmentSpec;
  readonly signal?: AbortSignal;
}

/**
 * 执行环境的描述，全是 JSON（`AgentSpec.environment`）。只有几项通用的，各实现按自己能做的解释，做不到就在 `open` 里报错。
 * 凭证不在这里：`env` 只是要哪些变量的名字，值由部署方给（见 ADR 0009）。
 */
export interface EnvironmentSpec {
  readonly name?: string;
  /** 镜像或模板，例如容器镜像名。 */
  readonly image?: string;
  /** 要装的包，按包管理器：`{ pip: ['pandas'], apt: ['ffmpeg'] }`。 */
  readonly packages?: Readonly<Record<string, readonly string[]>>;
  /** 出站网络：`allow` 是允许的主机名，不给是实现的缺省。 */
  readonly network?: { readonly allow?: readonly string[] };
  /** 要哪些环境变量的名字。 */
  readonly env?: readonly string[];
  /** 实现自己的配置。 */
  readonly meta?: JsonObject;
}

// ---- 和 AI SDK 互转 ----

/**
 * AI SDK 工具结果 `output` 的形状（`@ai-sdk/provider-utils` 的 `ToolResultOutput`）。协议包不依赖 `ai` 的消息类型，
 * 这里照它的结构写了一份，AI SDK 的值可以直接传进来。
 */
export type AiSdkFileData =
  | { type: 'data'; data: string | Uint8Array | ArrayBuffer }
  | { type: 'url'; url: URL; originalUrl?: string }
  | { type: 'reference'; reference: Record<string, string> }
  | { type: 'text'; text: string };

type AiSdkContentPart =
  | { type: 'text'; text: string; providerOptions?: unknown }
  | { type: 'file'; data: AiSdkFileData; mediaType: string; filename?: string; providerOptions?: unknown }
  // 下面是 AI SDK 已弃用的写法。
  | { type: 'file-data'; data: string; mediaType: string; filename?: string; providerOptions?: unknown }
  | { type: 'file-url'; url: string; mediaType?: string; providerOptions?: unknown }
  | { type: 'file-id'; fileId: string | Record<string, string>; providerOptions?: unknown }
  | { type: 'file-reference'; providerReference: Record<string, string>; providerOptions?: unknown }
  | { type: 'image-data'; data: string; mediaType: string; providerOptions?: unknown }
  | { type: 'image-url'; url: string; providerOptions?: unknown }
  | { type: 'image-file-id'; fileId: string | Record<string, string>; providerOptions?: unknown }
  | { type: 'image-file-reference'; providerReference: Record<string, string>; providerOptions?: unknown }
  // 服务商自定义分段，没有可序列化的内容。
  | { type: 'custom'; providerOptions?: unknown };

export type AiSdkToolOutput =
  | { type: 'text'; value: string; providerOptions?: unknown }
  | { type: 'json'; value: unknown; providerOptions?: unknown }
  | { type: 'execution-denied'; reason?: string; providerOptions?: unknown }
  | { type: 'error-text'; value: string; providerOptions?: unknown }
  | { type: 'error-json'; value: unknown; providerOptions?: unknown }
  | { type: 'content'; value: AiSdkContentPart[]; providerOptions?: unknown };

/** 错误带 `retryable` 或 `data` 时放进 `error-json`，只有文字时用 `error-text`。 */
interface ErrorJson {
  message: string;
  retryable?: boolean;
  data?: JsonValue;
}

/** 协议的文件数据转成 AI SDK 带标签的 `FileData`。 */
export function fileDataToAiSdk(data: ToolFileData): AiSdkFileData {
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

/** 字节转 base64，大数组分块，免得展开参数时溢出栈。 */
export function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(binary);
}

function bytesToBase64(data: string | Uint8Array | ArrayBuffer): string {
  if (typeof data === 'string') return data;
  return encodeBase64(data instanceof Uint8Array ? data : new Uint8Array(data));
}

/** AI SDK 带标签的 `FileData` 转成协议的文件数据：字节变 base64，`URL` 变字符串（保留 `originalUrl`）。 */
export function fileDataFromAiSdk(data: AiSdkFileData): ToolFileData {
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

// ---- 工具边界：输入校验和输出上限 ----

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function jsonTypeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function matchesJsonType(type: string, value: unknown): boolean {
  switch (type) {
    case 'null':
      return value === null;
    case 'array':
      return Array.isArray(value);
    case 'object':
      return isPlainObject(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'number':
      return typeof value === 'number';
    case 'string':
    case 'boolean':
      return typeof value === type;
    default:
      // 不认识的类型名不拦。
      return true;
  }
}

function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => sameJson(item, b[index]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = Object.keys(a);
    return (
      keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && sameJson(a[key], b[key]))
    );
  }
  return false;
}

function compile(pattern: unknown): RegExp | undefined {
  if (typeof pattern !== 'string') return undefined;
  try {
    return new RegExp(pattern, 'u');
  } catch {
    return undefined;
  }
}

interface SchemaCheck {
  readonly issues: string[];
  readonly limit: number;
}

function checkSchema(schema: unknown, value: unknown, path: string, check: SchemaCheck, depth: number): void {
  const { issues } = check;
  if (issues.length >= check.limit || depth > 64 || schema === true || schema === undefined) return;
  const where = path || 'input';
  if (schema === false) {
    issues.push(`${where} is not allowed`);
    return;
  }
  // 引用不解析：这一支不查。
  if (!isPlainObject(schema) || '$ref' in schema || '$dynamicRef' in schema || '$recursiveRef' in schema) return;
  if (value === null && schema['nullable'] === true) return;

  const type = schema['type'];
  const types = typeof type === 'string' ? [type] : Array.isArray(type) ? type : [];
  if (types.length > 0 && !types.some((item) => typeof item !== 'string' || matchesJsonType(item, value))) {
    issues.push(`${where} must be ${types.join(' or ')}, got ${jsonTypeOf(value)}`);
    return;
  }
  const options = schema['enum'];
  if (Array.isArray(options) && !options.some((item) => sameJson(item, value))) {
    issues.push(`${where} must be one of ${JSON.stringify(options).slice(0, 200)}`);
    return;
  }
  if ('const' in schema && !sameJson(schema['const'], value)) {
    issues.push(`${where} must be ${JSON.stringify(schema['const']).slice(0, 200)}`);
    return;
  }
  const bound = (key: string): number | undefined => (typeof schema[key] === 'number' ? schema[key] : undefined);

  if (typeof value === 'string') {
    const length = Array.from(value).length;
    const min = bound('minLength');
    const max = bound('maxLength');
    if (min !== undefined && length < min) issues.push(`${where} must be at least ${min} characters`);
    if (max !== undefined && length > max) issues.push(`${where} must be at most ${max} characters`);
    const pattern = compile(schema['pattern']);
    if (pattern && !pattern.test(value)) issues.push(`${where} must match the pattern ${String(schema['pattern'])}`);
  } else if (typeof value === 'number') {
    const min = bound('minimum');
    const max = bound('maximum');
    const above = bound('exclusiveMinimum');
    const below = bound('exclusiveMaximum');
    if (min !== undefined && value < min) issues.push(`${where} must be >= ${min}`);
    if (max !== undefined && value > max) issues.push(`${where} must be <= ${max}`);
    if (above !== undefined && value <= above) issues.push(`${where} must be > ${above}`);
    if (below !== undefined && value >= below) issues.push(`${where} must be < ${below}`);
  } else if (Array.isArray(value)) {
    const min = bound('minItems');
    const max = bound('maxItems');
    if (min !== undefined && value.length < min) issues.push(`${where} must have at least ${min} items`);
    if (max !== undefined && value.length > max) issues.push(`${where} must have at most ${max} items`);
    // 2020-12 的 `prefixItems` + `items`，和 draft-07 的数组写法 `items` + `additionalItems`。
    const items = schema['items'];
    const prefix = Array.isArray(schema['prefixItems']) ? schema['prefixItems'] : Array.isArray(items) ? items : [];
    const rest = Array.isArray(items) ? schema['additionalItems'] : items;
    value.forEach((item, index) => {
      checkSchema(index < prefix.length ? prefix[index] : rest, item, `${path}[${index}]`, check, depth + 1);
    });
  } else if (isPlainObject(value)) {
    const properties = isPlainObject(schema['properties']) ? schema['properties'] : {};
    const required = Array.isArray(schema['required']) ? schema['required'] : [];
    for (const key of required) {
      if (typeof key === 'string' && !Object.hasOwn(value, key))
        issues.push(`${path ? `${path}.` : ''}${key} is required`);
    }
    const patterns = isPlainObject(schema['patternProperties']) ? Object.entries(schema['patternProperties']) : [];
    const compiled = patterns.map(([pattern, sub]) => [compile(pattern), sub] as const);
    // 有编不出来的 pattern 时说不清哪些键算「额外的」，就不查 additionalProperties。
    const additional = compiled.every(([pattern]) => pattern) ? schema['additionalProperties'] : undefined;
    for (const [key, item] of Object.entries(value)) {
      const at = path ? `${path}.${key}` : key;
      let known = false;
      if (Object.hasOwn(properties, key)) {
        known = true;
        checkSchema(properties[key], item, at, check, depth + 1);
      }
      for (const [pattern, sub] of compiled) {
        if (!pattern?.test(key)) continue;
        known = true;
        checkSchema(sub, item, at, check, depth + 1);
      }
      if (known || additional === undefined) continue;
      if (additional === false) issues.push(`${at} is not a known property`);
      else checkSchema(additional, item, at, check, depth + 1);
    }
  }

  if (Array.isArray(schema['allOf']))
    for (const sub of schema['allOf']) checkSchema(sub, value, path, check, depth + 1);
  // `oneOf` 只查「一个都不满足」：认不全关键字时「满足了不止一个」可能是误判。
  for (const key of ['anyOf', 'oneOf']) {
    const branches = schema[key];
    if (!Array.isArray(branches) || branches.length === 0) continue;
    const failures: string[] = [];
    const matched = branches.some((sub) => {
      const attempt: SchemaCheck = { issues: [], limit: 1 };
      checkSchema(sub, value, path, attempt, depth + 1);
      if (attempt.issues[0]) failures.push(attempt.issues[0]);
      return attempt.issues.length === 0;
    });
    if (!matched) issues.push(`${where} matches none of the allowed shapes (${failures.slice(0, 3).join('; ')})`);
  }
}

/**
 * 按 JSON Schema 查一个值，返回给模型看的问题（空数组是没查出问题），最多 `limit` 条。
 *
 * 只查认识的关键字：`type`、`enum`、`const`、`required`、`properties`、`patternProperties`、`additionalProperties`、
 * `items`、`prefixItems`、长度和数值的上下限、`pattern`、`allOf`、`anyOf`、`oneOf`、OpenAPI 的 `nullable`。
 * 其余（`$ref`、`not`、`if`/`then`、`format`、`multipleOf`、`uniqueItems`……）一概放行：报出来的一定是真问题，
 * 没报不等于完全合规。要完整的校验，在执行环境里用专门的库。
 */
export function checkJsonSchema(schema: unknown, value: unknown, limit = 5): string[] {
  const check: SchemaCheck = { issues: [], limit };
  checkSchema(schema, value, '', check, 0);
  return check.issues.slice(0, limit);
}

/** 留下前 `limit` 个字符（UTF-16 码元），不把一对代理项切成两半。 */
function clipText(text: string, limit: number): string {
  let end = Math.min(Math.max(Math.floor(limit), 0), text.length);
  const last = text.charCodeAt(end - 1);
  if (end < text.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
  return text.slice(0, end);
}

function truncatedText(text: string, limit: number): string {
  const kept = clipText(text, limit);
  return `${kept}\n[… truncated ${text.length - kept.length} more characters; narrow the request (filters, paging, a smaller range) to see the rest]`;
}

/**
 * harness 对一次工具结果的长度兜底，缺省 20 万字符（大约 5 万到 20 万 token）。该截断、分页的是执行环境，它知道怎么
 * 截才有用；这一层只保证哪个执行环境忘了也不会把一次结果原样塞满上下文。`describeHarnessContract` 没给
 * `maxToolOutputChars` 时按它查。
 */
export const DEFAULT_MAX_TOOL_OUTPUT_CHARS = 200_000;

/**
 * 工具结果的长度兜底：超过 `maxChars` 个字符（UTF-16 码元）时截断并注明省略了多少，没超的原样返回（同一个对象）。
 * 文字和错误信息直接截；`json` 序列化后超了就换成截断的文字；`content` 里各段合起来算，内联的文件数据
 * （base64、文字）按字符数计，放不下的那个文件换成一句说明，超的那段文字截断、后面的文字不要了。
 * `maxChars` 没给、是 0、负数或 Infinity 都是不限。
 */
export function limitToolOutput(output: ToolOutput, maxChars: number | undefined): ToolOutput {
  if (maxChars === undefined || !Number.isFinite(maxChars) || maxChars <= 0) return output;
  const limit = Math.floor(maxChars);
  if (output.type === 'text') {
    return output.text.length <= limit ? output : { type: 'text', text: truncatedText(output.text, limit) };
  }
  if (output.type === 'error') {
    return output.message.length <= limit ? output : { ...output, message: truncatedText(output.message, limit) };
  }
  if (output.type === 'json') {
    const json = JSON.stringify(output.value) ?? 'null';
    return json.length <= limit ? output : { type: 'text', text: truncatedText(json, limit) };
  }
  const sizeOf = (part: ToolContentPart): number => {
    if (part.type === 'text') return part.text.length;
    if (part.data.type === 'data') return part.data.data.length;
    return part.data.type === 'text' ? part.data.text.length : 0;
  };
  if (output.parts.reduce((sum, part) => sum + sizeOf(part), 0) <= limit) return output;
  let left = limit;
  let cut = false;
  const parts: ToolContentPart[] = [];
  for (const part of output.parts) {
    const size = sizeOf(part);
    if (part.type === 'file') {
      if (size <= left) {
        left -= size;
        parts.push(part);
      } else {
        parts.push({
          type: 'text',
          text: `[${part.mediaType} file omitted: ${size} characters of data do not fit in the tool output limit]`,
        });
      }
    } else if (!cut) {
      if (size <= left) {
        left -= size;
        parts.push(part);
      } else {
        parts.push({ type: 'text', text: truncatedText(part.text, left) });
        left = 0;
        cut = true;
      }
    }
  }
  return { type: 'content', parts };
}
