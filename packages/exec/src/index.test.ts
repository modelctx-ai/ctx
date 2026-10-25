import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { JsonObject, ToolOutput } from '@modelctx-ai/ctx-protocol';
import { describeExecutorContract } from '@modelctx-ai/ctx-protocol/testing';
import { afterAll, beforeAll, describe, expect, test } from 'vite-plus/test';

import { createProcessExecutor, type ProcessExecutorOptions } from './index.ts';

const api = { describe, test };
const context = { session: 's', runId: 'r' };

let root = '';
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'ctx-exec-'));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

function executor(options: ProcessExecutorOptions = {}) {
  return createProcessExecutor({ cwd: root, ...options });
}

function run(command: string, options: ProcessExecutorOptions = {}, extra: JsonObject = {}) {
  return executor(options).execute({ id: 'c', name: 'run_command', input: { command, ...extra } }, context);
}

function text(output: ToolOutput): string {
  if (output.type === 'text') return output.text;
  throw new Error(`expected text, got ${JSON.stringify(output)}`);
}

function error(output: ToolOutput): string {
  if (output.type === 'error') return output.message;
  throw new Error(`expected error, got ${JSON.stringify(output)}`);
}

// 回显工具：固定命令工具 echo，不经 shell 把输入原样交给 /bin/echo。
describeExecutorContract(
  'process',
  () => ({
    executor: createProcessExecutor({
      commands: {
        echo: {
          description: 'Echo the text back.',
          inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
          command: (input) => ['echo', String((input as { text?: unknown }).text)],
        },
      },
    }),
    echo: 'echo',
  }),
  api,
);

describeExecutorContract(
  'process（run_command 经 shell）',
  () => ({
    executor: createProcessExecutor({
      commands: { shell_echo: { command: (input) => `echo '${String((input as { text?: unknown }).text)}'` } },
    }),
    echo: 'shell_echo',
  }),
  api,
);

describe('run_command', () => {
  test('报四个工具，绑定自己的名字', async () => {
    const tools = await executor({ name: 'box' }).tools();
    expect(tools.map((tool) => tool.name)).toEqual(['run_command', 'read_file', 'write_file', 'list_dir']);
    expect(tools.every((tool) => tool.executor === 'box')).toBe(true);
    expect(tools[0]?.description).toContain(root);
    expect((await executor({ files: false }).tools()).map((tool) => tool.name)).toEqual(['run_command']);
  });

  test('在 cwd 里跑，返回退出码和 stdout', async () => {
    const output = text(await run('echo hello && pwd'));
    expect(output).toContain('<exit_code>0</exit_code>');
    expect(output).toContain('hello');
    expect(output).toContain(root.split('/').at(-1));
  });

  test('非零退出码不算错误，stderr 照给', async () => {
    const output = text(await run('echo oops >&2; exit 3'));
    expect(output).toContain('<exit_code>3</exit_code>');
    expect(output).toMatch(/<stderr>\noops\n<\/stderr>/);
  });

  test('不继承整份环境，只带基础变量和 env', async () => {
    process.env['CTX_EXEC_SECRET'] = 'leak';
    try {
      const output = text(await run('echo "[$CTX_EXEC_SECRET][$EXTRA][${PATH:+path}]"', { env: { EXTRA: 'x' } }));
      expect(output).toContain('[][x][path]');
    } finally {
      delete process.env['CTX_EXEC_SECRET'];
    }
  });

  test('超时：杀掉进程，返回错误，带已有的输出', async () => {
    const started = Date.now();
    const output = await run('echo before; sleep 5; echo after', { timeoutMs: 200 });
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(error(output)).toMatch(/timed out after 200 ms/);
    expect(JSON.stringify(output.type === 'error' && output.data)).toContain('before');
    expect(JSON.stringify(output.type === 'error' && output.data)).not.toContain('after');
  });

  test('调用时的 timeoutMs 覆盖缺省值，但不超过上限', async () => {
    const output = await run('sleep 5', { timeoutMs: 10_000, maxTimeoutMs: 10_000 }, { timeoutMs: 150 });
    expect(error(output)).toMatch(/timed out after 150 ms/);
  });

  test('signal 中止时杀掉进程', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const started = Date.now();
    const output = await executor().execute(
      { id: 'c', name: 'run_command', input: { command: 'sleep 5' } },
      { ...context, signal: controller.signal },
    );
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(error(output)).toMatch(/cancelled/);
  });

  test('输出超过上限时截断，末尾注明截掉多少', async () => {
    const output = text(
      await run('i=0; while [ $i -lt 100 ]; do echo 0123456789; i=$((i+1)); done', { maxOutputBytes: 50 }),
    );
    expect(output).toContain(`${'0123456789\n'.repeat(4)}012345\n[… truncated 1050 more bytes`);
  });

  test('allow 拒绝时不跑', async () => {
    const seen: string[] = [];
    const output = await run('touch should-not-exist', {
      allow: (command) => {
        seen.push(command);
        return !command.startsWith('touch');
      },
    });
    expect(error(output)).toMatch(/not allowed.*touch should-not-exist/);
    expect(seen).toEqual(['touch should-not-exist']);
    await expect(readFile(join(root, 'should-not-exist'))).rejects.toThrow(/ENOENT/);
    expect(text(await run('echo ok', { allow: () => true }))).toContain('ok');
  });

  test('起不来进程是错误，信息能照着做', async () => {
    const output = await run('echo hi', { shell: ['/no/such/shell', '-c'] });
    expect(error(output)).toMatch(/Could not start "\/no\/such\/shell"/);
  });

  test('cwd 输入只能在工作目录里', async () => {
    await mkdir(join(root, 'sub'), { recursive: true });
    expect(text(await run('pwd', {}, { cwd: 'sub' }))).toMatch(/sub\n<\/stdout>/);
    expect(error(await run('pwd', {}, { cwd: '..' }))).toMatch(/outside the working directory/);
  });

  test('缺 command、不认识的工具、dispose 之后都返回错误', async () => {
    const exec = executor();
    expect(error(await exec.execute({ id: 'c', name: 'run_command', input: {} }, context))).toMatch(/command/);
    expect(error(await exec.execute({ id: 'c', name: 'nope', input: {} }, context))).toMatch(
      /Available tools: run_command/,
    );
    await exec.dispose?.();
    expect(error(await exec.execute({ id: 'c', name: 'run_command', input: { command: 'echo' } }, context))).toMatch(
      /disposed/,
    );
  });

  test('固定命令工具不能和内置工具同名', () => {
    expect(() => createProcessExecutor({ commands: { read_file: { command: () => 'cat' } } })).toThrow(/taken/);
  });
});

function call(name: string, input: JsonObject, options: ProcessExecutorOptions = {}) {
  return executor(options).execute({ id: 'c', name, input }, context);
}

describe('文件工具', () => {
  test('写、读、列', async () => {
    expect(text(await call('write_file', { path: 'notes/a.txt', content: '你好' }))).toBe(
      'Wrote 6 bytes to notes/a.txt.',
    );
    expect(text(await call('write_file', { path: 'notes/a.txt', content: '!', append: true }))).toMatch(/Appended 1/);
    expect(text(await call('read_file', { path: 'notes/a.txt' }))).toBe('你好!');
    await writeFile(join(root, 'notes', 'b.txt'), 'b');
    expect(text(await call('list_dir', { path: 'notes' }))).toBe('a.txt\nb.txt');
    expect(text(await call('list_dir', {}))).toContain('notes/');
  });

  test('大文件截断', async () => {
    await writeFile(join(root, 'big.txt'), 'x'.repeat(100));
    expect(text(await call('read_file', { path: 'big.txt' }, { maxOutputBytes: 10 }))).toBe(
      `${'x'.repeat(10)}\n[… truncated 90 more bytes; read the rest with run_command (sed -n, tail)]`,
    );
  });

  test('拒绝越界：..、绝对路径、指出去的符号链接', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'ctx-exec-outside-'));
    try {
      await writeFile(join(outside, 'secret.txt'), 'secret');
      await symlink(outside, join(root, 'link'));
      for (const [name, input] of [
        ['read_file', { path: '../secret.txt' }],
        ['read_file', { path: join(outside, 'secret.txt') }],
        ['read_file', { path: 'link/secret.txt' }],
        ['write_file', { path: '../escape.txt', content: 'x' }],
        ['write_file', { path: 'link/new.txt', content: 'x' }],
        ['list_dir', { path: '..' }],
        ['list_dir', { path: 'link' }],
      ] as const) {
        expect(error(await call(name, input)), `${name} ${JSON.stringify(input)}`).toMatch(
          /outside the working directory/,
        );
      }
      await expect(readFile(join(outside, 'new.txt'))).rejects.toThrow(/ENOENT/);
      // 工作目录里的绝对路径可以。
      expect(text(await call('read_file', { path: join(root, 'big.txt') }))).toContain('x');
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  test('不存在的文件给出下一步', async () => {
    expect(error(await call('read_file', { path: 'missing.txt' }))).toMatch(/File not found: missing.txt.*list_dir/);
    expect(error(await call('list_dir', { path: 'missing' }))).toMatch(/Directory not found/);
    expect(error(await call('read_file', { path: 'notes' }))).toMatch(/directory/);
  });

  test('files: false 时没有文件工具', async () => {
    expect(error(await call('read_file', { path: 'big.txt' }, { files: false }))).toMatch(/Unknown tool/);
  });
});
