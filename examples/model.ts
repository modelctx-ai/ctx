import { fileURLToPath } from 'node:url';

import type { LanguageModel } from '@modelctx-ai/ctx';
import { createScriptedModel, type ModelScriptStep } from '@modelctx-ai/ctx/testing';
import { createModel } from '@modelctx-ai/ctx-models';

/**
 * 例子用的模型。设了环境变量就用真的服务（任何 OpenAI 兼容的地址）：
 *
 *   CTX_EXAMPLE_BASE_URL=https://api.deepseek.com/v1 CTX_EXAMPLE_API_KEY=… CTX_EXAMPLE_MODEL=deepseek-chat
 *
 * 没设就按 `script` 回答（协议包的剧本模型），不用联网、不用密钥，CI 里跑的就是这一种。
 * `tool` 是剧本里的工具调用要调的工具名。
 */
export function exampleModel(script: readonly ModelScriptStep[], tool?: string): LanguageModel {
  const { CTX_EXAMPLE_BASE_URL: baseUrl, CTX_EXAMPLE_API_KEY: apiKey, CTX_EXAMPLE_MODEL: model } = process.env;
  if (baseUrl && model) return createModel({ baseUrl, model, ...(apiKey ? { apiKey } : {}) });
  return createScriptedModel(script, tool ? { tool } : {});
}

/** 这个文件是不是被 `node <文件>` 直接跑的（而不是被测试或别的例子 import）。 */
export function isMain(url: string): boolean {
  return process.argv[1] !== undefined && fileURLToPath(url) === process.argv[1];
}

export type Log = (line: string) => void;
