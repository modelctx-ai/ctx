"""测试的公共部分：对照 TypeScript 参考实现的 node 脚本（``ctx_ts.mjs``）、起 ``ctx-remote``、起这个包的服务端。

要 node 的用例在没有 node 22.18 以上、或者仓库根没 ``pnpm install`` 时跳过；``CTX_TEST_PYDANTIC_AI=required`` 时不跳，
直接失败（CI 这样跑）。子进程只拿到最少的环境变量。
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from collections.abc import Callable, Iterator, Mapping, Sequence
from pathlib import Path
from typing import Any

import pytest

from ctx_pydantic_ai.context import ContextSource, EventRule, ProjectionOptions, estimate_tokens, json_text

os.environ.setdefault('PYDANTIC_AI_NO_BANNER', '1')

PACKAGE = Path(__file__).resolve().parents[1]
REPO = PACKAGE.parents[1]
HELPER = Path(__file__).with_name('ctx_ts.mjs')
SOURCE_CONDITION = '--conditions=@modelctx-ai/source'


def child_env() -> dict[str, str]:
    """子进程的环境：只有找程序、找家目录要的几个。"""
    env = {'PATH': os.environ.get('PATH', ''), 'HOME': os.environ.get('HOME', ''), 'NODE_NO_WARNINGS': '1'}
    env['PYDANTIC_AI_NO_BANNER'] = '1'
    return env


def _node_problem() -> str | None:
    node = shutil.which('node')
    if node is None:
        return 'node is not on PATH'
    version = subprocess.run([node, '--version'], capture_output=True, text=True, check=False).stdout.strip()
    match = re.match(r'v(\d+)\.(\d+)', version)
    if match is None or (int(match[1]), int(match[2])) < (22, 18):
        return f'node {version} cannot run .ts files directly (needs 22.18 or later)'
    if not (REPO / 'packages/remote/node_modules').is_dir():
        return 'run `pnpm install` at the repository root first'
    return None


@pytest.fixture(scope='session')
def node() -> str:
    problem = _node_problem()
    if problem is not None:
        if os.environ.get('CTX_TEST_PYDANTIC_AI') == 'required':
            pytest.fail(problem)
        pytest.skip(problem)
    return str(shutil.which('node'))


Evaluate = Callable[[Sequence[tuple[str, Sequence[Any]]]], list[Any]]


@pytest.fixture(scope='session')
def ts(node: str) -> Evaluate:
    """``ts([(函数名, 参数), …])``：在 TypeScript 的协议包里调这些函数，返回各自的结果。"""

    def evaluate(calls: Sequence[tuple[str, Sequence[Any]]]) -> list[Any]:
        # 转义非 ASCII：参数里可以有落单的代理项（UTF-8 写不出来，JSON 的 \u 写得出来）。
        payload = json.dumps([{'fn': fn, 'args': list(args)} for fn, args in calls])
        done = subprocess.run(
            [node, SOURCE_CONDITION, str(HELPER), 'eval'],
            input=payload,
            capture_output=True,
            text=True,
            encoding='utf-8',
            cwd=REPO,
            env=child_env(),
            timeout=120,
            check=False,
        )
        if done.returncode != 0:
            raise AssertionError(f'ctx_ts.mjs eval failed:\n{done.stderr}')
        return json.loads(done.stdout)

    return evaluate


def _ts_command(node: str, command: str, payload: Any) -> Any:
    done = subprocess.run(
        [node, SOURCE_CONDITION, str(HELPER), command],
        input=json.dumps(payload, ensure_ascii=False),
        capture_output=True,
        text=True,
        encoding='utf-8',
        cwd=REPO,
        env=child_env(),
        timeout=120,
        check=False,
    )
    if done.returncode != 0:
        raise AssertionError(f'ctx_ts.mjs {command} failed:\n{done.stderr}')
    return json.loads(done.stdout)


def ts_run(node: str, payload: dict[str, Any]) -> dict[str, Any]:
    """用 TypeScript 的 ``createRemoteHarness`` 跑一轮（见 ``ctx_ts.mjs run``）。"""
    return _ts_command(node, 'run', payload)


def ts_pending(node: str, payload: dict[str, Any]) -> dict[str, Any]:
    """用 TypeScript 的 ``runPendingTools`` 执行等着的调用、追加结果（见 ``ctx_ts.mjs pending``）。"""
    return _ts_command(node, 'pending', payload)


def ts_claim(node: str, payload: dict[str, Any]) -> dict[str, Any]:
    """用 TypeScript 的 ``createRemoteWorker`` 按执行环境的名字领一次工作、执行、追加结果（见 ``ctx_ts.mjs claim``）。"""
    return _ts_command(node, 'claim', payload)


def ts_compact(node: str, cases: Sequence[dict[str, Any]]) -> list[dict[str, Any]]:
    """用 TypeScript 的 builder 把每一组条目压一次（见 ``ctx_ts.mjs compact``）。"""
    return _ts_command(node, 'compact', list(cases))


def ts_build(node: str, cases: Sequence[dict[str, Any]]) -> list[dict[str, Any]]:
    """用 TypeScript 的 builder 给每一组条目组装一次调用（见 ``ctx_ts.mjs build``）。"""
    return _ts_command(node, 'build', list(cases))


# ---- 配方：函数过不了进程边界，两边按名字各实现一遍（同 ``ctx_ts.mjs`` 的 ``projectionOf``、``sourcesOf``） ----


def _line(events: Sequence[Mapping[str, Any]]) -> str:
    return '\n'.join(f'{event["kind"]} {json_text(event.get("data"))}' for event in events)


_RENDERERS: dict[str, Callable[[list[Mapping[str, Any]]], Any]] = {
    'user': lambda events: {'role': 'user', 'content': _line(events)},
    'system': lambda events: {'role': 'system', 'content': _line(events)},
    'pair': lambda events: [{'role': 'user', 'content': _line(events)}, {'role': 'assistant', 'content': 'noted'}],
    'none': lambda events: None,
}
_SUMMARIES: dict[str, Callable[[Mapping[str, Any]], dict[str, Any]]] = {
    'system': lambda entry: {'role': 'system', 'content': f'Earlier: {entry["text"]}'},
    'assistant': lambda entry: {'role': 'assistant', 'content': entry['text']},
    'covers': lambda entry: {'role': 'user', 'content': f'Up to {entry["covers"]}: {entry["text"]}'},
}


def _redact(entry: Mapping[str, Any]) -> dict[str, Any] | None:
    message = entry['message']
    if 'secret' in json_text(message):
        return None
    if message.get('role') == 'user' and isinstance(message.get('content'), str):
        return {**message, 'content': f'> {message["content"]}'}
    return message


def projection_of(recipe: Mapping[str, Any] | None) -> ProjectionOptions | None:
    """投影配置的配方 → ``ProjectionOptions``，规则见 ``ctx_ts.mjs`` 的 ``projectionOf``。"""
    if recipe is None:
        return None
    events = {
        kind: EventRule(render=_RENDERERS[rule['render']], fold=rule.get('fold', False))
        for kind, rule in (recipe.get('events') or {}).items()
    }
    return ProjectionOptions(
        events=events,
        summary=_SUMMARIES[recipe['summary']] if recipe.get('summary') else None,
        message=_redact if recipe.get('message') == 'redact' else None,
        window=recipe.get('window'),
        estimate=(lambda message: 2 * estimate_tokens(message)) if recipe.get('estimate') == 'double' else None,
    )


def sources_of(recipes: Sequence[Mapping[str, Any]] | None) -> list[ContextSource]:
    """上下文来源的配方 ``{ name, text?, delayMs?, error? }`` → ``ContextSource``，同 ``ctx_ts.mjs`` 的 ``sourcesOf``。"""

    def source(recipe: Mapping[str, Any]) -> ContextSource:
        async def collect(context: Mapping[str, Any]) -> str | None:
            if recipe.get('delayMs'):
                await asyncio.sleep(recipe['delayMs'] / 1000)
            if recipe.get('error'):
                raise RuntimeError(recipe['error'])
            return recipe.get('text')

        return ContextSource(recipe['name'], collect)

    return [source(recipe) for recipe in recipes or []]


class Process:
    """一个先打印一行就绪信息、再一直服务的子进程。``by_stdin`` 时关掉它的 stdin 让它自己退出，否则发 SIGTERM。"""

    def __init__(self, args: Sequence[str], *, cwd: Path, ready: str, by_stdin: bool = False) -> None:
        self._by_stdin = by_stdin
        self._errors = tempfile.TemporaryFile(mode='w+', encoding='utf-8')
        self.popen = subprocess.Popen(
            list(args),
            cwd=cwd,
            env=child_env(),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=self._errors,
            text=True,
            encoding='utf-8',
        )
        assert self.popen.stdout is not None
        line = self.popen.stdout.readline()
        if ready not in line:
            self.popen.kill()
            self.popen.wait(timeout=5)
            errors = self.stderr()
            self.stop()
            raise AssertionError(f'{args[0]} did not start: {line!r}\n{errors}')
        self.line = line.strip()
        self.url = line.strip().rsplit(' ', 1)[-1]

    def stderr(self) -> str:
        self._errors.seek(0)
        return self._errors.read()

    def stop(self) -> None:
        if self.popen.poll() is None:
            if self._by_stdin and self.popen.stdin is not None:
                self.popen.stdin.close()
            else:
                self.popen.terminate()
            try:
                self.popen.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.popen.kill()
                self.popen.wait(timeout=5)
        for stream in (self.popen.stdin, self.popen.stdout):
            if stream is not None and not stream.closed:
                stream.close()
        self._errors.close()


@pytest.fixture(scope='module')
def ctx_remote(node: str) -> Iterator[dict[str, Any]]:
    """一个真的 ``ctx-remote``（TypeScript）：``{ baseUrl, token }``。一页最多 5 条，好测翻页。"""
    process = Process(
        [node, SOURCE_CONDITION, str(HELPER), 'remote', '--max-list', '5'], cwd=REPO, ready='baseUrl', by_stdin=True
    )
    try:
        yield json.loads(process.line)
    finally:
        process.stop()


def serve(*args: str) -> Process:
    """起这个包的 ``ctx-pydantic-ai``（``--port 0``），``process.url`` 是它打印的地址。"""
    return Process([sys.executable, '-m', 'ctx_pydantic_ai', *args, '--port', '0'], cwd=PACKAGE, ready='listening on')
