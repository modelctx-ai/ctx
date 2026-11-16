#!/usr/bin/env node
/**
 * `ctx-conformance --url <地址> [--token <令牌>] [--components sessions,harness,…] [--harness-levels trace,execute,…]
 * [--max-tool-output-chars <字符数>]`：对一个以一致性模式运行的服务
 * 跑契约测试（`node:test`，失败时退出码非 0）。令牌也可以放在环境变量 `CTX_ACCESS_TOKEN` 里。
 */
import { describe, test } from 'node:test';
import { parseArgs } from 'node:util';

import { HARNESS_LEVELS, type HarnessLevel } from '@modelctx-ai/ctx-protocol/testing';

import { CONFORMANCE_COMPONENTS, describeConformance, type ConformanceComponent } from './conformance.ts';

const { values } = parseArgs({
  options: {
    url: { type: 'string' },
    token: { type: 'string' },
    components: { type: 'string' },
    'harness-levels': { type: 'string' },
    'max-tool-output-chars': { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
});

const usage =
  `usage: ctx-conformance --url <base url> [--token <token>] [--components ${CONFORMANCE_COMPONENTS.join(',')}]` +
  ` [--harness-levels ${HARNESS_LEVELS.join(',')}] [--max-tool-output-chars <chars>]`;
if (values.help || !values.url) {
  console.error(usage);
  process.exit(values.help ? 0 : 2);
}

const components = values.components?.split(',').map((name) => name.trim()) ?? [...CONFORMANCE_COMPONENTS];
const unknown = components.filter((name) => !CONFORMANCE_COMPONENTS.includes(name as ConformanceComponent));
if (unknown.length > 0) {
  console.error(`unknown components: ${unknown.join(', ')}\n${usage}`);
  process.exit(2);
}

const harnessLevels = values['harness-levels']?.split(',').map((name) => name.trim());
const unknownLevels = (harnessLevels ?? []).filter((name) => !HARNESS_LEVELS.includes(name as HarnessLevel));
if (unknownLevels.length > 0) {
  console.error(`unknown harness levels: ${unknownLevels.join(', ')}\n${usage}`);
  process.exit(2);
}

const maxChars = values['max-tool-output-chars'];
const maxToolOutputChars = maxChars === undefined ? undefined : Number(maxChars);
if (maxToolOutputChars !== undefined && (!Number.isSafeInteger(maxToolOutputChars) || maxToolOutputChars <= 0)) {
  console.error(`--max-tool-output-chars must be a positive integer, got ${maxChars}\n${usage}`);
  process.exit(2);
}

const accessToken = values.token ?? process.env['CTX_ACCESS_TOKEN'];
describeConformance(
  values.url,
  {
    components: components as ConformanceComponent[],
    ...(harnessLevels ? { harnessLevels: harnessLevels as HarnessLevel[] } : {}),
    ...(maxToolOutputChars !== undefined ? { maxToolOutputChars } : {}),
    ...(accessToken ? { accessToken } : {}),
  },
  { describe, test },
);
