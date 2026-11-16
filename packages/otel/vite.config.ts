import { defineConfig } from 'vite-plus';

export default defineConfig({
  pack: {
    entry: ['src/index.ts'],
    format: 'esm',
    platform: 'neutral',
    target: 'node22',
    dts: true,
    clean: true,
    fixedExtension: false,
  },
});
