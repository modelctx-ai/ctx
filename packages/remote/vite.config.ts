import { defineConfig } from 'vite-plus';

export default defineConfig({
  pack: {
    // 两个入口：主入口是客户端（只用 fetch，任何运行时），`/server` 是 node:http 的服务端。
    entry: ['src/index.ts', 'src/server.ts'],
    format: 'esm',
    platform: 'node',
    target: 'node22',
    dts: true,
    clean: true,
    fixedExtension: false,
  },
});
