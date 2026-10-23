import { defineConfig } from 'vite-plus';

export default defineConfig({
  pack: {
    entry: ['src/index.ts', 'src/testing.ts'],
    format: 'esm',
    platform: 'node',
    target: 'node20',
    dts: true,
    clean: true,
    fixedExtension: false,
  },
});
