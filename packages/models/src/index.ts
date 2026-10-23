import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';

/** 一份可以写进配置文件的模型描述。 */
export interface ModelSpec {
  /** 服务商协议，缺省 `openai-compatible`。 */
  readonly provider?: string;
  readonly model: string;
  /**
   * 接口根地址。openai-compatible 写到 `/v1` 为止；anthropic 写服务根（例如 `https://api.deepseek.com/anthropic`），
   * 不以 `/v1` 结尾时自动补上，不写就用官方地址（不读 `ANTHROPIC_BASE_URL`）。
   */
  readonly baseUrl?: string;
  readonly apiKey?: string;
  readonly headers?: Readonly<Record<string, string>>;
  /** 出现在日志和遥测里的服务商名字。 */
  readonly name?: string;
}

export type ModelFactory = (spec: ModelSpec) => LanguageModel;

export interface ModelRegistry {
  register(provider: string, factory: ModelFactory): ModelRegistry;
  create(spec: ModelSpec): LanguageModel;
  providers(): string[];
}

export const DEFAULT_PROVIDER = 'openai-compatible';

function trimBase(url: string | undefined): string | undefined {
  const trimmed = url?.trim().replace(/\/+$/, '');
  return trimmed ? trimmed : undefined;
}

function headersOf(spec: ModelSpec): Record<string, string> | undefined {
  return spec.headers ? { ...spec.headers } : undefined;
}

export const openAICompatible: ModelFactory = (spec) => {
  const baseURL = trimBase(spec.baseUrl);
  if (!baseURL) throw new Error('openai-compatible models need `baseUrl`.');
  const headers = headersOf(spec);
  const provider = createOpenAICompatible({
    name: spec.name ?? 'openai-compatible',
    baseURL,
    ...(spec.apiKey ? { apiKey: spec.apiKey } : {}),
    ...(headers ? { headers } : {}),
  });
  return provider.chatModel(spec.model);
};

const ANTHROPIC_DEFAULT_BASE = 'https://api.anthropic.com/v1';

/** 和 dsh-pet 一样：baseUrl 是服务根，请求打到 `<baseUrl>/v1/messages`。 */
function anthropicBase(url: string | undefined): string {
  const base = trimBase(url);
  if (!base) return ANTHROPIC_DEFAULT_BASE;
  return /\/v1$/.test(base) ? base : `${base}/v1`;
}

export const anthropic: ModelFactory = (spec) => {
  const headers = headersOf(spec);
  // 总是显式给地址，环境里的 ANTHROPIC_BASE_URL 不会悄悄把请求改到别处。
  const provider = createAnthropic({
    baseURL: anthropicBase(spec.baseUrl),
    ...(spec.apiKey ? { apiKey: spec.apiKey } : {}),
    ...(headers ? { headers } : {}),
  });
  return provider(spec.model);
};

/** 带内置服务商的注册表。别的服务商（openai、google……）用 `register` 加进来。 */
export function createModelRegistry(factories: Readonly<Record<string, ModelFactory>> = {}): ModelRegistry {
  const table = new Map<string, ModelFactory>([
    ['openai-compatible', openAICompatible],
    ['anthropic', anthropic],
    ...Object.entries(factories),
  ]);
  const registry: ModelRegistry = {
    register(provider, factory) {
      table.set(provider, factory);
      return registry;
    },
    create(spec) {
      if (!spec.model?.trim()) throw new Error('Model spec needs `model`.');
      const provider = spec.provider ?? DEFAULT_PROVIDER;
      const factory = table.get(provider);
      if (!factory) throw new Error(`Unknown model provider "${provider}". Known: ${[...table.keys()].join(', ')}.`);
      return factory(spec);
    },
    providers() {
      return [...table.keys()];
    },
  };
  return registry;
}

const defaults: ModelRegistry = createModelRegistry();

export function createModel(spec: ModelSpec): LanguageModel {
  return defaults.create(spec);
}
