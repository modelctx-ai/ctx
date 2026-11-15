// 打包冒烟检查：把每个包 `pnpm pack` 出来，在一个干净目录里装上，按使用方的方式读一遍。
//
//   node scripts/pack-smoke.mjs                      # 全部：打包、查内容、安装、类型、导入
//   node scripts/pack-smoke.mjs --dir <目录>         # 用指定的目录（留着给下一步）
//   node scripts/pack-smoke.mjs --dir <目录> --run-only   # 只做导入那一步（换一个 Node 版本再跑）
//
// 查的是发布出去的东西，不是仓库里的源码：`workspace:^` 换成了版本号，`exports` 指的文件都在包里，
// 包里没有 `src/`，不打开 `@modelctx-ai/source` 条件时每个入口都能 `import`、类型能解析。
// 导入那一步按各包自己的 `engines.node` 决定跑不跑，所以在最低支持的 Node 上跑一遍就核对了 `engines`。
//
// 特意写成 `.mjs`：`--run-only` 要能在不认 `.ts` 的 Node（22.0）上跑。
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const runOnly = args.includes('--run-only');
const dirArg = args.includes('--dir') ? args[args.indexOf('--dir') + 1] : undefined;
if (runOnly && !dirArg) fail('--run-only needs --dir <the directory an earlier run prepared>');
const dir = dirArg ? path.resolve(dirArg) : mkdtempSync(path.join(tmpdir(), 'ctx-pack-smoke-'));
const tarballs = path.join(dir, 'tarballs');
const app = path.join(dir, 'app');

function fail(message) {
  console.error(`pack-smoke: ${message}`);
  process.exit(1);
}

function run(command, commandArgs, cwd) {
  try {
    return execFileSync(command, commandArgs, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  } catch (error) {
    // 检查工具（tsc）把问题写在标准输出里。
    if (typeof error.stdout === 'string' && error.stdout.trim()) console.error(error.stdout.trim());
    return fail(`\`${path.basename(command)} ${commandArgs.slice(0, 2).join(' ')}\` failed in ${cwd}`);
  }
}

/** `packages/*` 里要发布的包：目录、`package.json`。 */
function workspacePackages() {
  return readdirSync(path.join(root, 'packages'))
    .map((name) => path.join(root, 'packages', name))
    .filter((directory) => existsSync(path.join(directory, 'package.json')))
    .map((directory) => ({
      directory,
      manifest: JSON.parse(readFileSync(path.join(directory, 'package.json'), 'utf8')),
    }))
    .filter((item) => item.manifest.private !== true)
    .toSorted((a, b) => a.manifest.name.localeCompare(b.manifest.name));
}

/** `exports` 里每个条件指向的文件，`./package.json` 这种字符串入口也算。 */
function exportTargets(exports) {
  const targets = [];
  for (const [entry, value] of Object.entries(exports)) {
    if (typeof value === 'string') targets.push({ entry, condition: 'default', file: value });
    else for (const [condition, file] of Object.entries(value)) targets.push({ entry, condition, file });
  }
  return targets;
}

function prepare() {
  rmSync(tarballs, { recursive: true, force: true });
  rmSync(app, { recursive: true, force: true });
  mkdirSync(tarballs, { recursive: true });
  mkdirSync(app, { recursive: true });

  const packed = [];
  for (const { directory, manifest } of workspacePackages()) {
    if (!existsSync(path.join(directory, 'dist'))) fail(`${manifest.name} has no dist/; run \`pnpm build\` first`);
    const before = new Set(readdirSync(tarballs));
    run('pnpm', ['pack', '--pack-destination', tarballs], directory);
    const file = readdirSync(tarballs).find((name) => !before.has(name));
    if (!file) fail(`pnpm pack produced nothing for ${manifest.name}`);
    const tarball = path.join(tarballs, file);

    const files = new Set(run('tar', ['-tzf', tarball]).split('\n').filter(Boolean));
    const published = JSON.parse(run('tar', ['-xzOf', tarball, 'package/package.json']));
    const problems = [];
    for (const required of ['package/package.json', 'package/README.md', 'package/LICENSE']) {
      if (!files.has(required)) problems.push(`missing ${required}`);
    }
    for (const name of files) {
      if (name.startsWith('package/src/')) problems.push(`ships source: ${name}`);
      if (/\.test\.(js|d\.ts)$/.test(name)) problems.push(`ships a test: ${name}`);
    }
    if (JSON.stringify(published).includes('workspace:')) problems.push('package.json still has a workspace: range');
    if (published.version !== manifest.version) problems.push(`version ${published.version} != ${manifest.version}`);
    if (!published.engines?.node) problems.push('no engines.node');
    if (published.publishConfig?.access !== 'public') problems.push('publishConfig.access is not public');
    for (const { entry, condition, file: target } of exportTargets(published.exports ?? {})) {
      // 源码条件指向的文件不发布（ADR 0002），别的都得在包里。
      if (condition === '@modelctx-ai/source') continue;
      if (!files.has(path.posix.join('package', target)))
        problems.push(`exports["${entry}"].${condition} -> ${target} is not in the tarball`);
    }
    if (problems.length > 0) fail(`${manifest.name}:\n  - ${problems.join('\n  - ')}`);
    packed.push({
      name: published.name,
      version: published.version,
      engines: published.engines.node,
      tarball,
      exports: published.exports,
    });
    console.log(`packed ${published.name}@${published.version} (${files.size} files)`);
  }

  const rootManifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  const dev = rootManifest.devDependencies;
  writeFileSync(
    path.join(app, 'package.json'),
    `${JSON.stringify({ name: 'ctx-pack-smoke', private: true, type: 'module' }, null, 2)}\n`,
  );
  // 所有包一次装：互相之间的 peer 依赖由一起给的 tarball 满足，不去 registry 找还没发布的版本。
  run(
    'npm',
    [
      'install',
      '--no-audit',
      '--no-fund',
      '--loglevel=error',
      ...packed.map((item) => item.tarball),
      'ai@^7',
      'zod@^4',
      `typescript@${dev.typescript}`,
      `@types/node@${dev['@types/node']}`,
      // `@ai-sdk/provider` 的声明文件引了 `json-schema` 的类型却没把它列成依赖；不跳过库检查就得补上。
      '@types/json-schema',
    ],
    app,
  );

  const entries = packed.flatMap((item) =>
    Object.keys(item.exports)
      .filter((entry) => entry !== './package.json')
      .map((entry) => ({ name: item.name, engines: item.engines, specifier: path.posix.join(item.name, entry) })),
  );
  writeFileSync(path.join(app, 'entries.json'), `${JSON.stringify(entries, null, 2)}\n`);

  // 类型：每个入口都引一遍，不跳过库的声明文件（`skipLibCheck: false`），这样我们自己的 `.d.ts` 里引不到的东西会报出来。
  const lines = entries.map((entry, index) => `import * as m${index} from '${entry.specifier}';`);
  lines.push(`export const all = [${entries.map((_, index) => `m${index}`).join(', ')}];`, '');
  lines.push(
    "import type { SessionStore } from '@modelctx-ai/ctx-protocol';",
    "import { createMemoryStore } from '@modelctx-ai/ctx';",
    '// 解析不到类型时这里是 any，赋给 never 才会通过——所以这一行通过说明类型是真的。',
    'type IsAny<T> = 0 extends 1 & T ? true : false;',
    'export const typed: IsAny<SessionStore> = false;',
    'export const store: SessionStore = createMemoryStore();',
    '',
  );
  writeFileSync(path.join(app, 'types.ts'), lines.join('\n'));
  writeFileSync(
    path.join(app, 'tsconfig.json'),
    `${JSON.stringify(
      {
        compilerOptions: {
          target: 'es2024',
          module: 'nodenext',
          moduleResolution: 'nodenext',
          strict: true,
          noEmit: true,
          skipLibCheck: false,
          types: ['node'],
        },
        files: ['types.ts'],
      },
      null,
      2,
    )}\n`,
  );
  run(path.join(app, 'node_modules', '.bin', 'tsc'), ['-p', '.'], app);
  console.log(`types resolve for ${entries.length} entries`);
}

/** `>=a.b.c` 这一种写法就够了：仓库里的 `engines.node` 都是它。 */
function satisfies(range) {
  const match = /^>=\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(range.trim());
  if (!match) fail(`engines.node "${range}" is not of the form >=x.y.z`);
  const wanted = [match[1], match[2] ?? '0', match[3] ?? '0'].map(Number);
  const actual = process.versions.node.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (actual[index] !== wanted[index]) return actual[index] > wanted[index];
  }
  return true;
}

async function importAll() {
  if (!existsSync(path.join(app, 'entries.json'))) fail(`${app} is not prepared; run without --run-only first`);
  const entries = JSON.parse(readFileSync(path.join(app, 'entries.json'), 'utf8'));
  // 从 app 目录解析，和使用方自己的文件 import 时一样。
  const { createRequire } = await import('node:module');
  const resolveFrom = createRequire(path.join(app, 'index.js'));
  const { pathToFileURL } = await import('node:url');
  const loaded = new Map();
  let skipped = 0;
  for (const entry of entries) {
    if (!satisfies(entry.engines)) {
      console.log(`skip   ${entry.specifier} (needs node ${entry.engines})`);
      skipped += 1;
      continue;
    }
    const file = resolveFrom.resolve(entry.specifier);
    if (!file.includes(`${path.sep}dist${path.sep}`)) fail(`${entry.specifier} resolved to ${file}, not dist/`);
    const module = await import(pathToFileURL(file).href);
    if (Object.keys(module).length === 0) fail(`${entry.specifier} has no exports`);
    loaded.set(entry.specifier, module);
    console.log(`import ${entry.specifier} (${Object.keys(module).length} exports)`);
  }

  // 真的用一下：内存存储写读；`node:sqlite` 在这个 Node 上能开库（包的 `engines` 说能的话）。
  const core = loaded.get('@modelctx-ai/ctx');
  if (core) await roundTrip('@modelctx-ai/ctx', core.createMemoryStore());
  const sqlite = loaded.get('@modelctx-ai/ctx-sqlite');
  if (sqlite) {
    const store = sqlite.createSqliteStore({ path: ':memory:' });
    await roundTrip('@modelctx-ai/ctx-sqlite', store);
    store.close?.();
  }
  console.log(`node ${process.versions.node}: ${loaded.size} entries imported, ${skipped} skipped`);
}

async function roundTrip(name, store) {
  await store.append('smoke', [{ type: 'event', kind: 'smoke.checked', data: { ok: true } }]);
  const entries = await store.list('smoke');
  if (entries.length !== 1 || entries[0].kind !== 'smoke.checked') fail(`${name}: append/list round trip failed`);
  console.log(`use    ${name}: append/list ok`);
}

if (!runOnly) prepare();
await importAll();
if (!dirArg) rmSync(dir, { recursive: true, force: true });
