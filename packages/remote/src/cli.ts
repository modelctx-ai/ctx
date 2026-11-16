#!/usr/bin/env node
/**
 * `ctx-conformance --url <地址> [--token <令牌>] [--components sessions,harness,…]`：对一个以一致性模式运行的服务
 * 跑契约测试（`node:test`，失败时退出码非 0）。令牌也可以放在环境变量 `CTX_ACCESS_TOKEN` 里。
 */
import { describe, test } from 'node:test';
import { parseArgs } from 'node:util';

import { CONFORMANCE_COMPONENTS, describeConformance, type ConformanceComponent } from './conformance.ts';

const { values } = parseArgs({
  options: {
    url: { type: 'string' },
    token: { type: 'string' },
    components: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
});

const usage = `usage: ctx-conformance --url <base url> [--token <token>] [--components ${CONFORMANCE_COMPONENTS.join(',')}]`;
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

const accessToken = values.token ?? process.env['CTX_ACCESS_TOKEN'];
describeConformance(
  values.url,
  { components: components as ConformanceComponent[], ...(accessToken ? { accessToken } : {}) },
  { describe, test },
);
