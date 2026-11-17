import { execFileSync } from 'node:child_process';
import { lstat, mkdtemp, mkdir, readFile, rename, rm, symlink, truncate, writeFile } from 'node:fs/promises';
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

const posix = process.platform !== 'win32';

/** 工作目录外面的一个临时目录，用完删掉。 */
async function withOutside(body: (outside: string) => Promise<void>): Promise<void> {
  const outside = await mkdtemp(join(tmpdir(), 'ctx-exec-outside-'));
  try {
    await body(outside);
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
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

describeExecutorContract(
  'process（sessionCwd）',
  () => ({
    executor: createProcessExecutor({
      cwd: root,
      sessionCwd: true,
      commands: { echo: { command: (input) => ['echo', String((input as { text?: unknown }).text)] } },
    }),
    echo: 'echo',
  }),
  api,
);

describe('sessionCwd：每个会话一个工作目录', () => {
  test('两个会话各在自己的目录里，互相看不到；close 删掉目录，之后还能再用', async () => {
    const box = executor({ sessionCwd: true });
    const a = { session: 'tenant-a/1' };
    const b = { session: 'tenant-b/1' };
    await box.open!(a.session);
    expect(box.sessionCwd(a.session)).not.toBe(box.sessionCwd(b.session));
    expect(box.sessionCwd(a.session).startsWith(root)).toBe(true);
    await box.execute({ id: 'w', name: 'write_file', input: { path: 'note.txt', content: 'a 的' } }, a);
    expect(text(await box.execute({ id: 'r', name: 'read_file', input: { path: 'note.txt' } }, a))).toBe('a 的');
    expect(error(await box.execute({ id: 'r', name: 'read_file', input: { path: 'note.txt' } }, b))).toMatch(
      /File not found/,
    );
    const pwd = text(await box.execute({ id: 'p', name: 'run_command', input: { command: 'pwd' } }, b));
    expect(pwd).toContain(box.sessionCwd(b.session).split(/[\\/]/).at(-1));
    expect(error(await box.execute({ id: 'x', name: 'read_file', input: { path: '../note.txt' } }, b))).toMatch(
      /outside/i,
    );
    await box.close!(a.session);
    await expect(lstat(box.sessionCwd(a.session))).rejects.toThrow(/ENOENT/);
    await box.close!(a.session);
    await box.execute({ id: 'w', name: 'write_file', input: { path: 'again.txt', content: '再来' } }, a);
    expect(text(await box.execute({ id: 'l', name: 'list_dir', input: {} }, a))).toBe('again.txt');
    await box.close!(a.session);
    await box.close!(b.session);
  });

  test('不按会话时没有 open、close，sessionCwd 就是 cwd', () => {
    const box = executor();
    expect('open' in box).toBe(false);
    expect('close' in box).toBe(false);
    expect(box.sessionCwd('s')).toBe(box.cwd);
  });

  test('open 满足不了 environment 时抛 invalid_request，不静默降级', async () => {
    const box = executor({ sessionCwd: true, env: { API_BASE: 'https://example.test' } });
    await expect(box.open!('s', { environment: { image: 'python:3.12' } })).rejects.toMatchObject({
      type: 'invalid_request',
    });
    await expect(box.open!('s', { environment: { network: { allow: ['pypi.org'] } } })).rejects.toThrow(
      /network.allow/,
    );
    await expect(box.open!('s', { environment: { env: ['API_BASE', 'MISSING_KEY'] } })).rejects.toThrow(/MISSING_KEY/);
    await box.open!('s', { environment: { name: 'plain', env: ['API_BASE'] } });
    await box.close!('s');
  });
});

describe('run_command', () => {
  test('报四个工具，绑定自己的名字', async () => {
    const tools = await executor({ name: 'box' }).tools();
    expect(tools.map((tool) => tool.name)).toEqual(['run_command', 'read_file', 'write_file', 'list_dir']);
    expect(tools.every((tool) => tool.executor === 'box')).toBe(true);
    expect(tools[0]?.description).toContain(root);
    expect((await executor({ files: false }).tools()).map((tool) => tool.name)).toEqual(['run_command']);
  });

  test('runCommand: false 时不报也不跑 run_command，别的工具照旧', async () => {
    const exec = executor({
      runCommand: false,
      commands: { hello: { command: () => ['echo', 'hello'] } },
    });
    expect((await exec.tools()).map((tool) => tool.name)).toEqual(['read_file', 'write_file', 'list_dir', 'hello']);
    const refused = error(
      await exec.execute({ id: 'c', name: 'run_command', input: { command: 'touch run-command-off' } }, context),
    );
    expect(refused).toMatch(/run_command is turned off/);
    expect(refused).toContain('Available tools: read_file, write_file, list_dir, hello.');
    await expect(readFile(join(root, 'run-command-off'))).rejects.toThrow(/ENOENT/);
    expect(text(await exec.execute({ id: 'c', name: 'hello', input: {} }, context))).toContain('hello');
    expect(text(await exec.execute({ id: 'c', name: 'list_dir', input: {} }, context))).toBeTypeOf('string');
    // 说明和截断提示里不再让模型去找 run_command。
    expect(JSON.stringify(await exec.tools())).not.toContain('run_command');
    await writeFile(join(root, 'no-shell.txt'), 'x'.repeat(20));
    const cut = text(await exec.execute({ id: 'c', name: 'read_file', input: { path: 'no-shell.txt' } }, context));
    expect(cut).toBe('x'.repeat(20));
    expect(
      text(await call('read_file', { path: 'no-shell.txt' }, { runCommand: false, maxOutputBytes: 5 })),
    ).not.toContain('run_command');
    // run_command 这个名字始终留给内置工具。
    expect(() =>
      createProcessExecutor({ runCommand: false, commands: { run_command: { command: () => 'ls' } } }),
    ).toThrow(/taken/);
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

  test.skipIf(!posix)('留下后台进程的命令在 shell 退出后就返回，不算超时，也不杀后台进程', async () => {
    const started = Date.now();
    // 后台的子 shell 继承了 stdout、stderr，管道要等它结束才关。
    const output = await run('(sleep 2; echo done > background.txt) & echo started', { timeoutMs: 10_000 });
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(text(output)).toBe('<exit_code>0</exit_code>\n<stdout>\nstarted\n</stdout>');
    await expect(readFile(join(root, 'background.txt'))).rejects.toThrow(/ENOENT/);
    await expect
      .poll(() => readFile(join(root, 'background.txt'), 'utf8').catch(() => ''), { timeout: 8_000 })
      .toBe('done\n');
  });

  test.skipIf(!posix)('后台进程占着管道时，超时短于它也不误报', async () => {
    const output = await run('sleep 2 & echo started; exit 4', { timeoutMs: 600 });
    expect(text(output)).toBe('<exit_code>4</exit_code>\n<stdout>\nstarted\n</stdout>');
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

  test('allow 只管命令，管不到文件工具', async () => {
    const options: ProcessExecutorOptions = { allow: () => false };
    expect(text(await call('write_file', { path: 'allow-only.txt', content: 'x' }, options))).toMatch(/Wrote 1 bytes/);
    expect(text(await call('read_file', { path: 'allow-only.txt' }, options))).toBe('x');
    expect(text(await call('list_dir', {}, options))).toContain('allow-only.txt');
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

  test.skipIf(!posix)('悬空的符号链接不当成还不存在的文件：写不出去', async () => {
    await withOutside(async (outside) => {
      await symlink(join(outside, 'x.txt'), join(root, 'dangling'));
      await symlink(join(outside, 'newdir'), join(root, 'dangling-dir'));
      await symlink('loop-b', join(root, 'loop-a'));
      await symlink('loop-a', join(root, 'loop-b'));
      for (const [name, input] of [
        ['write_file', { path: 'dangling', content: 'x' }],
        ['write_file', { path: 'dangling', content: 'x', append: true }],
        ['read_file', { path: 'dangling' }],
        ['write_file', { path: 'dangling-dir/x.txt', content: 'x' }],
        ['list_dir', { path: 'dangling-dir' }],
        ['write_file', { path: 'loop-a', content: 'x' }],
      ] as const) {
        expect(error(await call(name, input)), `${name} ${JSON.stringify(input)}`).toMatch(
          /symbolic link that cannot be resolved/,
        );
      }
      await expect(readFile(join(outside, 'x.txt'))).rejects.toThrow(/ENOENT/);
      await expect(lstat(join(outside, 'newdir'))).rejects.toThrow(/ENOENT/);
      expect((await lstat(join(root, 'dangling'))).isSymbolicLink()).toBe(true);
    });
  });

  test.skipIf(!posix)('指向外面文件的符号链接：读写都拒绝', async () => {
    await withOutside(async (outside) => {
      await writeFile(join(outside, 'secret.txt'), 'secret');
      await symlink(join(outside, 'secret.txt'), join(root, 'out-file'));
      for (const [name, input] of [
        ['read_file', { path: 'out-file' }],
        ['write_file', { path: 'out-file', content: 'x' }],
        ['write_file', { path: 'out-file', content: 'x', append: true }],
      ] as const) {
        expect(error(await call(name, input)), `${name} ${JSON.stringify(input)}`).toMatch(
          /outside the working directory/,
        );
      }
      expect(await readFile(join(outside, 'secret.txt'), 'utf8')).toBe('secret');
    });
  });

  test.skipIf(!posix)('指向里面的符号链接照常能用', async () => {
    await mkdir(join(root, 'real-dir'), { recursive: true });
    await writeFile(join(root, 'real-dir', 'target.txt'), 'one');
    await symlink(join('real-dir', 'target.txt'), join(root, 'in-file'));
    await symlink('real-dir', join(root, 'in-dir'));
    expect(text(await call('read_file', { path: 'in-file' }))).toBe('one');
    expect(text(await call('write_file', { path: 'in-file', content: 'two' }))).toBe('Wrote 3 bytes to in-file.');
    expect(text(await call('write_file', { path: 'in-dir/target.txt', content: '!', append: true }))).toBe(
      'Appended 1 bytes to in-dir/target.txt.',
    );
    expect(await readFile(join(root, 'real-dir', 'target.txt'), 'utf8')).toBe('two!');
    // 写的是链接指向的文件，链接还是链接。
    expect((await lstat(join(root, 'in-file'))).isSymbolicLink()).toBe(true);
    expect(text(await call('write_file', { path: 'in-dir/sub/new.txt', content: 'n' }))).toMatch(/Wrote 1 bytes/);
    expect(await readFile(join(root, 'real-dir', 'sub', 'new.txt'), 'utf8')).toBe('n');
    expect(text(await call('list_dir', { path: 'in-dir' }))).toBe('sub/\ntarget.txt');
    expect(text(await run('pwd', {}, { cwd: 'in-dir' }))).toMatch(/real-dir\n<\/stdout>/);
  });

  // 检查和打开之间路径被换掉：`allowFile` 正好在两者之间调用，用它把竞态做成确定的。
  test.skipIf(!posix)('检查之后文件被换成指出去的符号链接：不跟过去', async () => {
    await withOutside(async (outside) => {
      await writeFile(join(outside, 'secret.txt'), 'secret');
      const swap = async (): Promise<boolean> => {
        await rm(join(root, 'swapped.txt'), { force: true });
        await symlink(join(outside, 'secret.txt'), join(root, 'swapped.txt'));
        return true;
      };
      for (const [name, input] of [
        ['read_file', { path: 'swapped.txt' }],
        ['write_file', { path: 'swapped.txt', content: 'x' }],
        ['write_file', { path: 'swapped.txt', content: 'x', append: true }],
      ] as const) {
        await rm(join(root, 'swapped.txt'), { force: true });
        await writeFile(join(root, 'swapped.txt'), 'inside');
        expect(error(await call(name, input, { allowFile: swap })), `${name} ${JSON.stringify(input)}`).toMatch(
          /changed while it was being opened/,
        );
      }
      expect(await readFile(join(outside, 'secret.txt'), 'utf8')).toBe('secret');
    });
  });

  test.skipIf(!posix)('检查之后父目录被换成指出去的符号链接：复核时拒绝', async () => {
    await withOutside(async (outside) => {
      await writeFile(join(outside, 'secret.txt'), 'secret');
      const swap = async (): Promise<boolean> => {
        await rename(join(root, 'swapped-dir'), join(root, 'swapped-dir-old'));
        await symlink(outside, join(root, 'swapped-dir'));
        return true;
      };
      for (const [name, input] of [
        ['read_file', { path: 'swapped-dir/secret.txt' }],
        ['write_file', { path: 'swapped-dir/secret.txt', content: 'x' }],
        ['list_dir', { path: 'swapped-dir' }],
      ] as const) {
        await rm(join(root, 'swapped-dir'), { recursive: true, force: true });
        await rm(join(root, 'swapped-dir-old'), { recursive: true, force: true });
        await mkdir(join(root, 'swapped-dir'));
        await writeFile(join(root, 'swapped-dir', 'secret.txt'), 'inside');
        expect(error(await call(name, input, { allowFile: swap })), `${name} ${JSON.stringify(input)}`).toMatch(
          /changed while it was being opened/,
        );
      }
      expect(await readFile(join(outside, 'secret.txt'), 'utf8')).toBe('secret');
      await rm(join(root, 'swapped-dir'), { force: true });
    });
  });

  test.skipIf(!posix)(
    'FIFO 不是普通文件：马上拒绝，不挂住',
    async () => {
      execFileSync('mkfifo', [join(root, 'pipe')]);
      const started = Date.now();
      expect(error(await call('read_file', { path: 'pipe' }))).toMatch(
        /pipe is a FIFO \(named pipe\), not a regular file/,
      );
      expect(error(await call('write_file', { path: 'pipe', content: 'x' }))).toMatch(/pipe is not a regular file/);
      expect(Date.now() - started).toBeLessThan(2_000);
      await rm(join(root, 'pipe'));
    },
    5_000,
  );

  test.skipIf(!posix)('超过 2 GiB 的文件只读开头，照样截断', async () => {
    const size = 3 * 1024 ** 3;
    // 稀疏文件：只有长度，不占磁盘。
    await writeFile(join(root, 'huge.bin'), 'head');
    await truncate(join(root, 'huge.bin'), size);
    try {
      expect(text(await call('read_file', { path: 'huge.bin' }, { maxOutputBytes: 10 }))).toBe(
        `head${'\0'.repeat(6)}\n[… truncated ${size - 10} more bytes; read the rest with run_command (sed -n, tail)]`,
      );
      const whole = text(await call('read_file', { path: 'huge.bin' }));
      expect(whole.slice(0, 4)).toBe('head');
      expect(whole).toContain(`[… truncated ${size - 64 * 1024} more bytes;`);
    } finally {
      await rm(join(root, 'huge.bin'));
    }
  });

  test('正好到上限的文件不算截断，跨多块的也读全', async () => {
    await writeFile(join(root, 'exact.txt'), 'y'.repeat(10));
    expect(text(await call('read_file', { path: 'exact.txt' }, { maxOutputBytes: 10 }))).toBe('y'.repeat(10));
    const long = 'z'.repeat(200_000);
    await writeFile(join(root, 'long.txt'), long);
    expect(text(await call('read_file', { path: 'long.txt' }, { maxOutputBytes: 1_000_000 }))).toBe(long);
    expect(text(await call('read_file', { path: 'long.txt' }, { maxOutputBytes: 150_000 }))).toBe(
      `${'z'.repeat(150_000)}\n[… truncated 50000 more bytes; read the rest with run_command (sed -n, tail)]`,
    );
    await writeFile(join(root, 'empty.txt'), '');
    expect(text(await call('read_file', { path: 'empty.txt' }))).toBe('');
  });

  test('read_file 认 signal', async () => {
    const controller = new AbortController();
    const output = await executor({
      // 路径检查过了、还没开始读的时候中止。
      allowFile: () => {
        controller.abort();
        return true;
      },
    }).execute({ id: 'c', name: 'read_file', input: { path: 'big.txt' } }, { ...context, signal: controller.signal });
    expect(error(output)).toMatch(/read_file was cancelled.*big\.txt/);
  });

  test('allowFile 拒绝时不读不写不列', async () => {
    await mkdir(join(root, 'guarded'), { recursive: true });
    await writeFile(join(root, 'guarded', 'keep.txt'), 'keep');
    const seen: unknown[] = [];
    const options: ProcessExecutorOptions = {
      allowFile: (access) => {
        seen.push(access);
        return false;
      },
    };
    expect(error(await call('read_file', { path: 'guarded/keep.txt' }, options))).toMatch(
      /File access not allowed.*read_file guarded\/keep\.txt.*did not run/,
    );
    expect(error(await call('write_file', { path: 'guarded/keep.txt', content: 'x' }, options))).toMatch(
      /not allowed.*write_file/,
    );
    expect(error(await call('write_file', { path: './guarded/sub/../new.txt', content: 'x' }, options))).toMatch(
      /not allowed/,
    );
    expect(error(await call('list_dir', {}, options))).toMatch(/not allowed.*list_dir/);
    expect(seen).toEqual([
      { tool: 'read_file', path: join('guarded', 'keep.txt'), mode: 'read' },
      { tool: 'write_file', path: join('guarded', 'keep.txt'), mode: 'write' },
      { tool: 'write_file', path: join('guarded', 'new.txt'), mode: 'write' },
      { tool: 'list_dir', path: '.', mode: 'read' },
    ]);
    expect(await readFile(join(root, 'guarded', 'keep.txt'), 'utf8')).toBe('keep');
    await expect(readFile(join(root, 'guarded', 'new.txt'))).rejects.toThrow(/ENOENT/);
    // 越界的路径先被拒绝，不问 allowFile；命令也不问它。
    expect(error(await call('read_file', { path: '../x' }, options))).toMatch(/outside the working directory/);
    expect(text(await run('echo ok', options))).toContain('ok');
    expect(seen).toHaveLength(4);
  });

  test.skipIf(!posix)('allowFile 看到的是解析过符号链接的路径，可以是异步的', async () => {
    await symlink('guarded', join(root, 'guarded-link'));
    const options: ProcessExecutorOptions = {
      allowFile: async ({ path, mode }) => mode === 'read' && !path.startsWith('guarded'),
    };
    expect(error(await call('read_file', { path: 'guarded-link/keep.txt' }, options))).toMatch(/not allowed/);
    expect(text(await call('read_file', { path: 'big.txt' }, options))).toContain('x');
    expect(error(await call('write_file', { path: 'big.txt', content: 'y' }, options))).toMatch(/not allowed/);
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
