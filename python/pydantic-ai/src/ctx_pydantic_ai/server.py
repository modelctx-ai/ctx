"""ctx 的线上形态（``docs/protocol.md`` 的「线上形态」）里 harness 的那一部分，外加一致性模式。

- ``GET /protocol``：版本和挂了的组件。
- ``POST /runs``：``RunRequest``（去掉 ``signal``，可带 ``aborted: true``）→ ``RunResult``。结果出来之前先发 200 的响应头，
  隔一段时间写一个换行当心跳；头发出去之后才出的错，正文是 ``{ error, status }``。``?stream=1`` 时是 NDJSON 的 ``RunEvent``。
  断开即中止。
- ``DELETE /runs/:runId``：取消一轮；请求还没到就记下来，到了以已中止开始。

``create_conformance_app`` 多一个 ``POST /conformance/instances``：每个用例一个隔离的实例（进程内的会话存储、按剧本回答的
模型、回显工具），实例的会话入口只有 ``append`` 和 ``list``，只给测试用。
"""

from __future__ import annotations

import asyncio
import contextlib
import hmac
import json
import time
from collections.abc import AsyncIterator, Callable, Mapping, Sequence
from typing import Any

from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse, Response, StreamingResponse
from starlette.routing import Route
from starlette.types import ASGIApp, Receive, Scope, Send

from .harness import AbortSignal, PydanticAIHarness
from .protocol import (
    DEFAULT_ALLOWED_SETTINGS,
    DEFAULT_MAX_TOOL_OUTPUT_CHARS,
    ENTRY_VERSION,
    PROTOCOL_VERSION,
    CtxError,
    new_id,
    run_parent_problem,
)
from .store import MemorySessionStore
from .testing import ScriptedModel, echo_executor

#: 一致性模式的入口（``ctx-remote`` 的 ``CONFORMANCE_PATH``）。
CONFORMANCE_PATH = '/conformance/instances'

_ERROR_TYPES = {
    400: 'invalid_request_error',
    401: 'authentication_error',
    403: 'permission_error',
    404: 'not_found_error',
    405: 'method_not_allowed',
    409: 'conflict_error',
    413: 'request_too_large',
    429: 'rate_limit_error',
}
#: 取消请求先于运行到达时记多久。
_PENDING_CANCEL_SECONDS = 60.0
#: 本机的几种写法（同 ``ctx-remote``）。
LOOPBACK = ('localhost', '127.0.0.1', '::1')


def is_loopback(host: str) -> bool:
    return host in LOOPBACK or host.startswith('127.')


def default_hosts(host: str, port: int) -> list[str]:
    """``Host`` 头缺省认的值（同 ``ctx-remote`` 的 ``startRemote``）：监听地址本身；听本机或所有地址时本机的几种写法都认。"""
    local = is_loopback(host) or host in ('0.0.0.0', '::')
    out: list[str] = []
    for name in [host, *LOOPBACK] if local else [host]:
        bare = f'[{name}]' if ':' in name else name
        out.extend([f'{bare}:80', bare] if port == 80 else [f'{bare}:{port}'])
    return out


def check_access_token(token: str | None) -> None:
    """给了令牌却是空的：当成配置写错，不当成「不要鉴权」（同 ``ctx-remote``）。"""
    if token is not None and not token.strip():
        raise ValueError('access_token is empty. Leave it out to run without authentication, or pass a real token.')


class _Gate:
    """在路由之前挡掉 ``Host`` 不对的请求（DNS rebinding）和浏览器网页发来的请求（带 ``Origin`` 的），同 ``ctx-remote``。"""

    def __init__(self, app: ASGIApp, hosts: Sequence[str] | None, origins: Sequence[str]) -> None:
        self._app = app
        self._hosts = None if hosts is None else {host.lower() for host in hosts}
        self._origins = {origin.lower() for origin in origins}

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope['type'] == 'http':
            headers = {
                key.decode('latin-1').lower(): value.decode('latin-1') for key, value in scope.get('headers', [])
            }
            problem = None
            if self._hosts is not None and headers.get('host', '').lower() not in self._hosts:
                problem = 'host not allowed'
            elif 'origin' in headers and headers['origin'].lower() not in self._origins:
                problem = 'origin not allowed'
            if problem is not None:
                response = JSONResponse({'error': {'message': problem, 'type': 'permission_error'}}, status_code=403)
                await response(scope, receive, send)
                return
        await self._app(scope, receive, send)


def _dumps(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'))


class _Failure(Exception):
    def __init__(self, status: int, message: str, *, type: str | None = None, retryable: bool | None = None) -> None:  # noqa: A002
        super().__init__(message)
        self.status = status
        self.info: dict[str, Any] = {'message': message, 'type': type or _ERROR_TYPES.get(status, 'server_error')}
        if retryable is not None:
            self.info['retryable'] = retryable


def _error_response(failure: _Failure) -> JSONResponse:
    return JSONResponse({'error': failure.info}, status_code=failure.status)


def _authorized(request: Request, token: str | None) -> bool:
    if not token:
        return True
    header = request.headers.get('authorization', '')
    return header.startswith('Bearer ') and hmac.compare_digest(header[7:].encode(), token.encode())


async def _body(request: Request, limit: int) -> Any:
    declared = request.headers.get('content-length')
    if declared is not None and declared.isdigit() and int(declared) > limit:
        raise _Failure(413, f'request body exceeds {limit} bytes')
    raw = await request.body()
    if len(raw) > limit:
        raise _Failure(413, f'request body exceeds {limit} bytes')
    if not raw.strip():
        return None
    try:
        return json.loads(raw)
    except ValueError as error:
        raise _Failure(400, f'request body is not JSON: {error}') from error


def _run_request_of(body: Any, allowed_models: set[str] | None, allowed_settings: set[str]) -> dict[str, Any]:
    """同 ``ctx-remote`` 服务端的 ``runRequestOf``：形状不对是 400。"""
    if not isinstance(body, dict):
        raise _Failure(400, 'request body must be a RunRequest object')
    if not isinstance(body.get('session'), str) or not body['session']:
        raise _Failure(400, 'RunRequest.session must be a string')
    agent = body.get('agent')
    if not isinstance(agent, dict):
        raise _Failure(400, 'RunRequest.agent must be an object')
    model = agent.get('model')
    if not isinstance(model, str) or not model:
        raise _Failure(
            400, 'RunRequest.agent.model must be a model name string; model objects cannot cross the boundary'
        )
    if allowed_models is not None and model not in allowed_models:
        raise _Failure(400, f'model "{model}" is not allowed by this server')
    settings = agent.get('settings')
    if settings is not None:
        if not isinstance(settings, dict):
            raise _Failure(400, 'RunRequest.agent.settings must be an object')
        refused = [key for key in settings if key not in allowed_settings]
        if refused:
            raise _Failure(
                400,
                f'RunRequest.agent.settings.{", ".join(refused)} {"are" if len(refused) > 1 else "is"} not accepted '
                'by this server (the server operator can allow it with `allowed_settings`)',
            )
    if body.get('runId') is not None and not isinstance(body['runId'], str):
        raise _Failure(400, 'RunRequest.runId must be a string')
    problem = run_parent_problem(body.get('parent'))
    if problem is not None:
        raise _Failure(400, problem)
    return body


class _Runs:
    """正在跑的运行：``DELETE /runs/:id`` 和断开都会中止它。"""

    def __init__(self, limit: int) -> None:
        self.limit = limit
        self.active: dict[str, AbortSignal] = {}
        self.pending: dict[str, float] = {}

    def cancel_later(self, run_id: str) -> None:
        now = time.monotonic()
        self.pending = {key: at for key, at in self.pending.items() if now - at < _PENDING_CANCEL_SECONDS}
        self.pending[run_id] = now

    def take_pending(self, run_id: str) -> bool:
        at = self.pending.pop(run_id, None)
        return at is not None and time.monotonic() - at < _PENDING_CANCEL_SECONDS


async def _watch_disconnect(receive: Callable[[], Any], signal: AbortSignal) -> None:
    """请求体读完之后，``receive`` 只会等到断开。"""
    while True:
        message = await receive()
        if message['type'] == 'http.disconnect':
            signal.abort()
            return


def create_app(
    harness: PydanticAIHarness,
    *,
    access_token: str | None = None,
    heartbeat_seconds: float = 15.0,
    max_runs: int = 32,
    max_body_bytes: int = 4 * 1024 * 1024,
    allowed_models: Sequence[str] | None = None,
    allowed_settings: Sequence[str] = DEFAULT_ALLOWED_SETTINGS,
    allowed_hosts: Sequence[str] | None = None,
    allowed_origins: Sequence[str] = (),
    store: MemorySessionStore | None = None,
) -> ASGIApp:
    """把一个 harness 挂成 ctx 的服务端（``POST /runs``）。``store`` 给了就另挂它的会话入口（一致性模式用）。

    ``allowed_hosts`` 给了就只认这些 ``Host`` 头（``host:port``），``allowed_origins`` 之外带 ``Origin`` 的请求一律 403。
    """
    check_access_token(access_token)
    runs = _Runs(max_runs)
    models = set(allowed_models) if allowed_models is not None else None
    settings = set(allowed_settings)

    def guard(handler: Callable[[Request], Any]) -> Callable[[Request], Any]:
        async def wrapped(request: Request) -> Response:
            if not _authorized(request, access_token):
                return JSONResponse({'error': {'message': 'unauthorized', 'type': 'authentication_error'}}, 401)
            try:
                return await handler(request)
            except _Failure as failure:
                return _error_response(failure)
            except CtxError as error:
                status = 409 if error.type == 'conflict' else 400 if error.type == 'invalid_request' else 500
                return JSONResponse({'error': error.info()}, status_code=status)

        return wrapped

    async def protocol(request: Request) -> Response:
        components: dict[str, Any] = {'harness': {'stream': True}}
        if store is not None:
            components['sessions'] = {'watch': False}
        return JSONResponse({'protocol': PROTOCOL_VERSION, 'entryVersion': ENTRY_VERSION, 'components': components})

    async def post_run(request: Request) -> Response:
        body = _run_request_of(await _body(request, max_body_bytes), models, settings)
        aborted = body.pop('aborted', False) is True
        run_id = body.get('runId') or new_id()
        body['runId'] = run_id
        if run_id in runs.active:
            raise _Failure(409, f'run "{run_id}" is already running')
        if len(runs.active) >= runs.limit:
            raise _Failure(429, f'this server is already handling {runs.limit} runs; retry later', retryable=True)
        signal = AbortSignal()
        if aborted or runs.take_pending(run_id):
            signal.abort()
        runs.active[run_id] = signal
        watcher = asyncio.ensure_future(_watch_disconnect(request.receive, signal))
        if request.query_params.get('stream') == '1':
            return StreamingResponse(
                _stream_run(harness, body, signal, runs, run_id, watcher, heartbeat_seconds),
                media_type='application/x-ndjson; charset=utf-8',
                headers={'cache-control': 'no-store', 'x-accel-buffering': 'no'},
            )
        task = asyncio.ensure_future(harness.run(body, signal=signal))

        def finish(_: Any) -> None:
            runs.active.pop(run_id, None)
            watcher.cancel()

        task.add_done_callback(finish)
        done, _ = await asyncio.wait({task}, timeout=heartbeat_seconds if heartbeat_seconds > 0 else None)
        if done:
            return _result_response(task)
        return StreamingResponse(
            _heartbeat_then_result(task, heartbeat_seconds),
            media_type='application/json; charset=utf-8',
            headers={'cache-control': 'no-store', 'x-accel-buffering': 'no'},
        )

    async def delete_run(request: Request) -> Response:
        run_id = request.path_params['run_id']
        signal = runs.active.get(run_id)
        if signal is not None and not signal.aborted:
            signal.abort()
            return JSONResponse({'cancelled': True})
        if signal is None:
            runs.cancel_later(run_id)
        return JSONResponse({'cancelled': False})

    routes = [
        Route('/protocol', guard(protocol), methods=['GET']),
        Route('/runs', guard(post_run), methods=['POST']),
        Route('/runs/{run_id}', guard(delete_run), methods=['DELETE']),
    ]
    if store is not None:
        routes.extend(_session_routes(store, guard, max_body_bytes))
    return _Gate(Starlette(routes=routes), allowed_hosts, allowed_origins)


def _result_response(task: asyncio.Task[dict[str, Any]]) -> Response:
    error = task.exception()
    if error is None:
        return Response(_dumps(task.result()), media_type='application/json; charset=utf-8')
    info = (
        error.info()
        if isinstance(error, CtxError)
        else {'message': f'remote run failed: {error}', 'type': 'harness_error'}
    )
    return JSONResponse({'error': info}, status_code=409 if info.get('type') == 'conflict' else 500)


async def _heartbeat_then_result(task: asyncio.Task[dict[str, Any]], seconds: float) -> AsyncIterator[bytes]:
    """头已经发出去了：等结果的时候隔一段时间写一个换行，最后写正文；出错写 ``{ error, status }``。"""
    while not task.done():
        done, _ = await asyncio.wait({task}, timeout=seconds)
        if not done:
            yield b'\n'
    error = task.exception()
    if error is None:
        yield _dumps(task.result()).encode()
        return
    info = (
        error.info()
        if isinstance(error, CtxError)
        else {'message': f'remote run failed: {error}', 'type': 'harness_error'}
    )
    yield _dumps({'error': info, 'status': 409 if info.get('type') == 'conflict' else 500}).encode()


async def _stream_run(
    harness: PydanticAIHarness,
    body: dict[str, Any],
    signal: AbortSignal,
    runs: _Runs,
    run_id: str,
    watcher: asyncio.Future[None],
    heartbeat: float,
) -> AsyncIterator[bytes]:
    """NDJSON：每行一个 ``RunEvent``，空闲时写空行当心跳。消费方断开（生成器被取消）时中止这一轮。"""
    events = harness.stream(body, signal=signal)
    iterator = events.__aiter__()
    pending: asyncio.Task[Any] | None = None
    try:
        while True:
            pending = pending or asyncio.ensure_future(iterator.__anext__())
            done, _ = await asyncio.wait({pending}, timeout=heartbeat if heartbeat > 0 else None)
            if not done:
                yield b'\n'
                continue
            task, pending = pending, None
            try:
                event = task.result()
            except StopAsyncIteration:
                break
            except Exception as error:  # noqa: BLE001 - 写日志失败：流里给出错误
                info = error.info() if isinstance(error, CtxError) else {'message': str(error), 'type': 'harness_error'}
                yield (_dumps({'error': info}) + '\n').encode()
                break
            yield (_dumps(event) + '\n').encode()
    finally:
        # 没读完就停了（消费方断开、生成器被取消）：中止这一轮，等它写完 `ctx.run.ended`。
        if pending is not None:
            signal.abort()
            pending.cancel()
            with contextlib.suppress(BaseException):
                await pending
        with contextlib.suppress(Exception):
            await iterator.aclose()
        runs.active.pop(run_id, None)
        watcher.cancel()


def _session_routes(store: MemorySessionStore, guard: Callable[..., Any], limit: int) -> list[Route]:
    """一致性实例的会话入口：``append``、``list``、``sessions``。"""

    def session_of(request: Request) -> str:
        # ASGI 的 `path` 已经解码过。
        return str(request.path_params['session'])

    def number(request: Request, name: str) -> float | None:
        raw = request.query_params.get(name)
        if raw is None:
            return None
        try:
            return float(raw)
        except ValueError as error:
            raise _Failure(400, f'{name} must be a number') from error

    async def entries(request: Request) -> Response:
        session = session_of(request)
        if request.method == 'POST':
            body = await _body(request, limit)
            if not isinstance(body, dict) or not isinstance(body.get('entries'), list):
                raise _Failure(400, 'request body must be { entries, expectSeq? }')
            expect = body.get('expectSeq')
            if expect is not None and not isinstance(expect, int):
                raise _Failure(400, 'expectSeq must be a number')
            try:
                written = await store.append(session, body['entries'], expect_seq=expect)
            except CtxError as error:
                if error.type == 'conflict':
                    raise _Failure(409, error.message, type='conflict', retryable=True) from error
                raise _Failure(400, error.message) from error
            return Response(_dumps({'entries': written}), media_type='application/json; charset=utf-8')
        types = request.query_params.get('types')
        kinds = request.query_params.get('kinds')
        after, last, count = number(request, 'after'), number(request, 'last'), number(request, 'limit')
        found = await store.list(
            session,
            after=None if after is None else int(after),
            last=None if last is None else int(last),
            limit=None if count is None else int(count),
            types=None if types is None else types.split(','),
            kinds=None if kinds is None else kinds.split(','),
            at_after=number(request, 'atAfter'),
        )
        return Response(_dumps({'entries': found}), media_type='application/json; charset=utf-8')

    async def sessions(request: Request) -> Response:
        count = number(request, 'limit')
        names = await store.sessions(
            prefix=request.query_params.get('prefix', ''),
            after=request.query_params.get('after'),
            limit=None if count is None else int(count),
        )
        return JSONResponse({'sessions': names})

    return [
        # `path`：ASGI 的路径已经解码，会话名里编码过的 `/` 到这里是真的斜杠。
        Route('/sessions/{session:path}/entries', guard(entries), methods=['GET', 'POST']),
        Route('/sessions', guard(sessions), methods=['GET']),
    ]


class _Instances:
    """``/conformance/instances/<id>/…`` 交给那个实例的应用。"""

    def __init__(self, root: ASGIApp, apps: Mapping[str, ASGIApp]) -> None:
        self._root = root
        self._apps = apps

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        path = scope.get('path', '')
        prefix = f'{CONFORMANCE_PATH}/'
        if scope['type'] == 'http' and path.startswith(prefix):
            instance, _, rest = path[len(prefix) :].partition('/')
            app = self._apps.get(instance)
            if app is not None and rest:
                inner = dict(scope)
                inner['path'] = f'/{rest}'
                inner['raw_path'] = f'/{rest}'.encode()
                await app(inner, receive, send)
                return
        await self._root(scope, receive, send)


def create_conformance_app(
    *,
    access_token: str | None = None,
    max_instances: int = 2_000,
    max_tool_output_chars: int = DEFAULT_MAX_TOOL_OUTPUT_CHARS,
    allowed_hosts: Sequence[str] | None = None,
) -> ASGIApp:
    """一致性模式：``POST /conformance/instances`` 收 ``ConformanceSetup``，给每个用例一个隔离的实例。

    只测 ``harness``：实例上的 ``/sessions`` 只有追加和读，给 harness 契约读写日志，不是完整的会话存储，所以不单独给
    ``sessions``（``ctx-conformance --components harness``）。模型名是 ``scripted``，回显工具 ``echo`` 在执行环境 ``local`` 上。
    """
    apps: dict[str, ASGIApp] = {}

    async def create(request: Request) -> Response:
        if not _authorized(request, access_token):
            return JSONResponse({'error': {'message': 'unauthorized', 'type': 'authentication_error'}}, 401)
        try:
            setup = await _body(request, 4 * 1024 * 1024)
            if not isinstance(setup, dict) or not isinstance(setup.get('components'), list):
                raise _Failure(400, 'request body must be a ConformanceSetup { components, script?, delayMs?, clock? }')
            unknown = [name for name in setup['components'] if name not in ('sessions', 'harness')]
            if unknown:
                raise _Failure(400, f'this server does not serve: {", ".join(map(str, unknown))}')
            if 'harness' not in setup['components']:
                raise _Failure(
                    400,
                    'this server tests the harness only: its /sessions routes append and list entries for the harness '
                    'contract, they are not a full session store',
                )
            clock = setup.get('clock')
            now: Callable[[], float] | None = None
            if isinstance(clock, dict):
                at, step = clock.get('at'), clock.get('step')
                if not isinstance(at, (int, float)) or not isinstance(step, (int, float)):
                    raise _Failure(400, 'clock must be { at, step } or "real"')
                ticks = iter(range(10**12))
                now = lambda: at + step * next(ticks)  # noqa: E731
            elif clock not in (None, 'real'):
                raise _Failure(400, 'clock must be { at, step } or "real"')
            if len(apps) >= max_instances:
                raise _Failure(429, 'too many conformance instances', retryable=True)
        except _Failure as failure:
            return _error_response(failure)
        store = MemorySessionStore(now=now)
        model = ScriptedModel(list(setup.get('script') or []), delay_ms=float(setup.get('delayMs') or 0))
        harness = PydanticAIHarness(
            store=store,
            executors=[echo_executor('local')],
            models={'scripted': model},
            max_tool_output_chars=max_tool_output_chars,
        )
        instance = new_id()
        apps[instance] = create_app(harness, access_token=access_token, store=store)
        return JSONResponse(
            {
                'baseUrl': f'{CONFORMANCE_PATH}/{instance}',
                'agent': {'model': 'scripted'},
                'executor': {'name': 'local', 'echo': 'echo'},
            }
        )

    async def protocol(request: Request) -> Response:
        return JSONResponse(
            {
                'protocol': PROTOCOL_VERSION,
                'entryVersion': ENTRY_VERSION,
                'components': {'harness': {'stream': True}, 'sessions': {'watch': False}},
            }
        )

    root = Starlette(
        routes=[Route(CONFORMANCE_PATH, create, methods=['POST']), Route('/protocol', protocol, methods=['GET'])]
    )
    return _Gate(_Instances(root, apps), allowed_hosts, ())
