import { defaultServerConditions, defineConfig } from 'vite-plus';

export default defineConfig({
  // 测试跑在 Vitest 的 node 环境（Vite 的 ssr 环境）里；加上源码条件，各包互相引用时读 src/*.ts，
  // 不用先构建 dist/。见 docs/adr/0002-packages.md。
  ssr: { resolve: { conditions: ['@modelctx-ai/source', ...defaultServerConditions] } },

  test: {
    include: ['packages/*/src/**/*.test.ts'],
  },

  lint: {
    plugins: ['typescript', 'unicorn', 'oxc', 'import', 'node', 'promise', 'vitest'],
    // Vite+ 自带的规则：测试 API 从 vite-plus/test 引，不直接引 vitest。
    jsPlugins: [{ name: 'vite-plus', specifier: 'vite-plus/oxlint-plugin' }],
    categories: {
      correctness: 'error',
      suspicious: 'warn',
    },
    env: { node: true, es2024: true },
    ignorePatterns: ['**/dist/**'],
    // typeAware：带类型信息的规则；typeCheck：顺带做完整的 TypeScript 类型检查（tsgolint，TS 7），
    // 按各文件所属的 tsconfig，包括 customConditions。`vp check` 因此同时覆盖格式、lint 和类型。
    options: { typeAware: true, typeCheck: true },
    rules: {
      // 断言都落在类型信息本来就断开的边界上：JSON.parse、SQLite 行、server.address()、测试里取工具字段。
      // 换成运行时校验只会重复 zod 或存储层已经做过的事。
      'typescript/no-unsafe-type-assertion': 'off',
      'vite-plus/prefer-vite-plus-imports': 'error',
    },
  },

  fmt: {
    singleQuote: true,
    printWidth: 120,
    trailingComma: 'all',
    // 保持 package.json 现有的键顺序（exports 等不动）。
    sortPackageJson: false,
    ignorePatterns: ['**/dist/**', 'pnpm-lock.yaml'],
  },
});
