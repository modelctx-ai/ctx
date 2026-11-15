// 冒烟测试打哪些服务，由环境变量决定。一组变量齐了才有那个目标，不齐就跳过，不算失败。
import type { JsonValue } from '@modelctx-ai/ctx';
import type { ModelSpec, SystemOneSpec } from '@modelctx-ai/ctx-models';

export type Target =
  | { readonly kind: 'model'; readonly name: string; readonly spec: ModelSpec }
  | { readonly kind: 'decision'; readonly name: string; readonly spec: SystemOneSpec }
  | { readonly kind: 'extraction'; readonly name: string; readonly spec: SystemOneSpec }
  | {
      readonly kind: 'mcp';
      readonly name: string;
      readonly url: string;
      readonly type?: 'http' | 'sse';
      /** 要调一下的工具（服务器上的原名）和输入；不给就只列工具。 */
      readonly tool?: string;
      readonly input?: JsonValue;
    };

export interface TargetGroup {
  readonly name: string;
  /** 这一组要的环境变量；`optional` 的可以不给。 */
  readonly needs: readonly string[];
  readonly optional?: readonly string[];
  build(env: Readonly<Record<string, string | undefined>>): Target[];
}

type Env = Readonly<Record<string, string | undefined>>;

export const TARGET_GROUPS: readonly TargetGroup[] = [
  {
    name: 'openai-compatible',
    needs: ['CTX_LIVE_OPENAI_BASE_URL', 'CTX_LIVE_OPENAI_MODEL'],
    optional: ['CTX_LIVE_OPENAI_API_KEY'],
    build: (env) => [
      {
        kind: 'model',
        name: 'openai-compatible',
        spec: {
          provider: 'openai-compatible',
          baseUrl: env['CTX_LIVE_OPENAI_BASE_URL']!,
          model: env['CTX_LIVE_OPENAI_MODEL']!,
          ...(env['CTX_LIVE_OPENAI_API_KEY'] ? { apiKey: env['CTX_LIVE_OPENAI_API_KEY'] } : {}),
        },
      },
    ],
  },
  {
    name: 'anthropic',
    needs: ['CTX_LIVE_ANTHROPIC_API_KEY', 'CTX_LIVE_ANTHROPIC_MODEL'],
    optional: ['CTX_LIVE_ANTHROPIC_BASE_URL'],
    build: (env) => [
      {
        kind: 'model',
        name: 'anthropic',
        spec: {
          provider: 'anthropic',
          apiKey: env['CTX_LIVE_ANTHROPIC_API_KEY']!,
          model: env['CTX_LIVE_ANTHROPIC_MODEL']!,
          ...(env['CTX_LIVE_ANTHROPIC_BASE_URL'] ? { baseUrl: env['CTX_LIVE_ANTHROPIC_BASE_URL'] } : {}),
        },
      },
    ],
  },
  {
    name: 'cloudflare',
    needs: ['CTX_LIVE_CLOUDFLARE_ACCOUNT_ID', 'CTX_LIVE_CLOUDFLARE_API_TOKEN'],
    optional: ['CTX_LIVE_CLOUDFLARE_DECISION_MODEL', 'CTX_LIVE_CLOUDFLARE_EXTRACTION_MODEL'],
    build: (env) => {
      const common = {
        provider: 'cloudflare',
        accountId: env['CTX_LIVE_CLOUDFLARE_ACCOUNT_ID']!,
        apiKey: env['CTX_LIVE_CLOUDFLARE_API_TOKEN']!,
      };
      return [
        {
          kind: 'decision',
          name: 'cloudflare-decision',
          spec: { ...common, model: env['CTX_LIVE_CLOUDFLARE_DECISION_MODEL'] ?? 'clef' },
        },
        {
          kind: 'extraction',
          name: 'cloudflare-extraction',
          spec: { ...common, model: env['CTX_LIVE_CLOUDFLARE_EXTRACTION_MODEL'] ?? 'clairic' },
        },
      ];
    },
  },
  {
    name: 'typesafe',
    needs: ['CTX_LIVE_TYPESAFE_API_KEY'],
    optional: ['CTX_LIVE_TYPESAFE_MODEL'],
    build: (env) => [
      {
        kind: 'decision',
        name: 'typesafe-decision',
        spec: {
          provider: 'typesafe',
          apiKey: env['CTX_LIVE_TYPESAFE_API_KEY']!,
          model: env['CTX_LIVE_TYPESAFE_MODEL'] ?? 'jev-latest',
        },
      },
    ],
  },
  {
    name: 'mcp',
    needs: ['CTX_LIVE_MCP_URL'],
    optional: ['CTX_LIVE_MCP_TYPE', 'CTX_LIVE_MCP_TOOL', 'CTX_LIVE_MCP_INPUT'],
    build: (env) => [
      {
        kind: 'mcp',
        name: 'mcp',
        url: env['CTX_LIVE_MCP_URL']!,
        ...(env['CTX_LIVE_MCP_TYPE'] === 'sse' ? { type: 'sse' as const } : {}),
        ...(env['CTX_LIVE_MCP_TOOL'] ? { tool: env['CTX_LIVE_MCP_TOOL'] } : {}),
        ...(env['CTX_LIVE_MCP_INPUT'] ? { input: JSON.parse(env['CTX_LIVE_MCP_INPUT']) as JsonValue } : {}),
      },
    ],
  },
];

/** 环境里配齐了的目标，和没配齐的组（缺哪些变量）。 */
export function targetsFromEnv(env: Env): {
  readonly targets: Target[];
  readonly skipped: { readonly name: string; readonly missing: string[] }[];
} {
  const targets: Target[] = [];
  const skipped: { name: string; missing: string[] }[] = [];
  for (const group of TARGET_GROUPS) {
    const missing = group.needs.filter((name) => !env[name]?.trim());
    if (missing.length > 0) skipped.push({ name: group.name, missing });
    else targets.push(...group.build(env));
  }
  return { targets, skipped };
}

/** 目标里不能进夹具的值：密钥、账号。 */
export function secretsOf(target: Target): string[] {
  if (target.kind === 'mcp') return [];
  const account = 'accountId' in target.spec ? target.spec.accountId : undefined;
  return [target.spec.apiKey, account].filter((value): value is string => typeof value === 'string' && value !== '');
}

/** 写进夹具的目标：密钥、账号换成 `REDACTED`，重放时用它重建目标，请求的地址和录的时候一样。 */
export function redactTarget(target: Target): Target {
  if (target.kind === 'mcp') return target;
  const spec = {
    ...target.spec,
    ...(target.spec.apiKey ? { apiKey: 'REDACTED' } : {}),
    ...('accountId' in target.spec && target.spec.accountId ? { accountId: 'REDACTED' } : {}),
  };
  return { ...target, spec } as Target;
}
