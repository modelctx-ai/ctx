// 发布用的两个小步骤（约定见 docs/adr/0002-packages.md）：
//
//   node scripts/release.mjs version 0.4.0        # 所有包改成同一个版本；正式版本顺带改 Python 的适配器，
//                                                 # 把 CHANGELOG 的「未发布」落成这一版
//   node scripts/release.mjs version 0.4.0-next.0 # 预发布版本只改版本号，CHANGELOG 不动
//   node scripts/release.mjs check v0.4.0         # 发布工作流用：tag 和每个包的版本对得上，正式版本在 CHANGELOG 里有一节
//
// `check` 把 npm 的 dist-tag（正式版本 `latest`，带 `-` 的预发布版本 `next`）写到标准输出和 `$GITHUB_OUTPUT`。
import { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const UNRELEASED = '## 未发布';

function fail(message) {
  console.error(`release: ${message}`);
  process.exit(1);
}

function manifests() {
  return readdirSync(path.join(root, 'packages'))
    .map((name) => path.join(root, 'packages', name, 'package.json'))
    .filter((file) => existsSync(file))
    .map((file) => ({ file, text: readFileSync(file, 'utf8') }))
    .map((item) => ({ ...item, manifest: JSON.parse(item.text) }))
    .filter((item) => item.manifest.private !== true);
}

// Python 的适配器（`python/pydantic-ai`，不发 npm）跟着正式版本走：`pyproject.toml` 和 `uv.lock` 里它自己那一条。
// 预发布版本（`0.4.0-next.0`）不是 PEP 440 的写法，不动它。
const PYTHON = [
  { file: 'python/pydantic-ai/pyproject.toml', pattern: /^(version = ")([^"]*)(")/m },
  { file: 'python/pydantic-ai/uv.lock', pattern: /(\nname = "ctx-pydantic-ai"\nversion = ")([^"]*)(")/ },
];

function pythonVersions() {
  return PYTHON.map(({ file, pattern }) => {
    const text = readFileSync(path.join(root, file), 'utf8');
    const match = pattern.exec(text);
    if (!match) fail(`could not find the version in ${file}`);
    return { file, text, pattern, version: match[2] };
  });
}

function setVersion(version) {
  if (!VERSION.test(version)) fail(`"${version}" is not a version like 0.4.0 or 0.4.0-next.0`);
  for (const { file, text, manifest } of manifests()) {
    // 只换版本那一行，别的格式不动。
    const next = text.replace(/^(\s*"version":\s*")[^"]*(")/m, `$1${version}$2`);
    if (JSON.parse(next).version !== version) fail(`could not set the version in ${file}`);
    writeFileSync(file, next);
    console.log(`${manifest.name} ${manifest.version} -> ${version}`);
  }
  if (version.includes('-')) return;
  for (const { file, text, pattern, version: before } of pythonVersions()) {
    writeFileSync(path.join(root, file), text.replace(pattern, `$1${version}$3`));
    console.log(`${file} ${before} -> ${version}`);
  }

  const file = path.join(root, 'CHANGELOG.md');
  const changelog = readFileSync(file, 'utf8');
  if (changelog.includes(`\n## ${version} - `)) return;
  const at = changelog.indexOf(`\n${UNRELEASED}\n`);
  if (at === -1) fail(`CHANGELOG.md has no "${UNRELEASED}" section`);
  const start = at + UNRELEASED.length + 2;
  const end = changelog.indexOf('\n## ', start);
  if (changelog.slice(start, end === -1 ? undefined : end).trim() === '')
    fail(`"${UNRELEASED}" is empty: nothing to release`);
  const date = new Date().toISOString().slice(0, 10);
  writeFileSync(file, `${changelog.slice(0, start)}\n## ${version} - ${date}\n${changelog.slice(start)}`);
  console.log(`CHANGELOG.md: "${UNRELEASED}" -> ${version} - ${date}`);
}

function check(tag) {
  if (!tag?.startsWith('v') || !VERSION.test(tag.slice(1)))
    fail(`tag "${tag}" is not of the form v0.4.0 or v0.4.0-next.0`);
  const version = tag.slice(1);
  const wrong = manifests().filter((item) => item.manifest.version !== version);
  if (wrong.length > 0) {
    fail(
      `tag ${tag} does not match:\n${wrong.map((item) => `  ${item.manifest.name} is ${item.manifest.version}`).join('\n')}\n` +
        `run \`node scripts/release.mjs version ${version}\`, commit, and tag that commit`,
    );
  }
  const prerelease = version.includes('-');
  const stale = prerelease ? [] : pythonVersions().filter((item) => item.version !== version);
  if (stale.length > 0) {
    fail(
      `tag ${tag} does not match:\n${stale.map((item) => `  ${item.file} is ${item.version}`).join('\n')}\n` +
        `run \`node scripts/release.mjs version ${version}\`, commit, and tag that commit`,
    );
  }
  if (!prerelease && !readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8').includes(`\n## ${version} - `)) {
    fail(`CHANGELOG.md has no "## ${version} - <date>" section`);
  }
  const distTag = prerelease ? 'next' : 'latest';
  console.log(`version=${version}`);
  console.log(`dist-tag=${distTag}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\ndist-tag=${distTag}\n`);
}

const [command, argument] = process.argv.slice(2);
if (command === 'version') setVersion(argument ?? '');
else if (command === 'check') check(argument);
else fail('usage: release.mjs version <version> | check <tag>');
