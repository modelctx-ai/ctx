import { defineConfig } from 'vite-plus';

export default defineConfig({
  pack: {
    // 主入口是客户端（只用 fetch，任何运行时），`/server` 是 node:http 的服务端，`/conformance` 对一个地址跑契约测试，
    // `cli` 是 `ctx-conformance` 命令。
    entry: ['src/index.ts', 'src/server.ts', 'src/conformance.ts', 'src/cli.ts'],
    format: 'esm',
    platform: 'node',
    target: 'node22',
    dts: true,
    clean: true,
    fixedExtension: false,
  },
});
