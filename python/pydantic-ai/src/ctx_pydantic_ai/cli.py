"""``ctx-pydantic-ai``：起服务端。

- ``ctx-pydantic-ai serve --remote <ctx-remote 地址> [--remote-token T] [--executor 名字 …] [--model 名字 …]``：
  harness 挂在 ``POST /runs``，日志写进那个 ``ctx-remote`` 的会话存储，工具交给它的执行环境（不给 ``--executor`` 就是
  ``GET /executors`` 列出的全部）。模型名按 pydantic-ai 的写法（``openai:gpt-5`` 这类），凭证照它自己的环境变量。
- ``ctx-pydantic-ai conformance``：一致性模式（``POST /conformance/instances``），给 ``ctx-conformance --url`` 测。

两个都打印一行 ``ctx-pydantic-ai listening on http://<host>:<port>`` 再开始服务；``--port 0`` 时端口由系统挑。
缺省只听本机；``--host`` 不是本机地址时必须给 ``--token``。``Host`` 头只认监听地址，带 ``Origin`` 的请求一律 403。
令牌也可以放在 ``CTX_ACCESS_TOKEN``（这个服务的）和 ``CTX_REMOTE_TOKEN``（``ctx-remote`` 的）里。
"""

from __future__ import annotations

import argparse
import asyncio
import os
import socket
import sys
from collections.abc import Awaitable, Callable
from typing import Any

import pydantic_ai
import uvicorn

from .executors import RemoteExecutor
from .harness import PydanticAIHarness
from .server import create_app, create_conformance_app, default_hosts, is_loopback
from .store import RemoteSessionStore
from .wire import Connection


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog='ctx-pydantic-ai', description=__doc__.split('\n\n')[0])
    commands = parser.add_subparsers(dest='command', required=True)
    for name in ('serve', 'conformance'):
        command = commands.add_parser(name)
        command.add_argument('--host', default='127.0.0.1')
        command.add_argument('--port', type=int, default=8090)
        command.add_argument('--token', default=os.environ.get('CTX_ACCESS_TOKEN'), help='这个服务要的令牌')
    serve = commands.choices['serve']
    serve.add_argument('--remote', required=True, help='ctx-remote 的地址：会话存储和执行环境都在那里')
    serve.add_argument('--remote-token', default=os.environ.get('CTX_REMOTE_TOKEN'))
    serve.add_argument('--executor', action='append', default=None, help='用哪些执行环境，可以给多次')
    serve.add_argument('--model', action='append', default=None, help='只收这些模型名，可以给多次')
    return parser


async def _serve(make_app: Callable[[list[str]], Awaitable[Any]], host: str, port: int) -> None:
    # 先占好端口再建应用、再打印：`--port 0` 时 Host 头要认真正的端口，调用方也从这一行读到它。
    sock = socket.socket(socket.AF_INET6 if ':' in host else socket.AF_INET, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind((host, port))
    bound = sock.getsockname()[1]
    app = await make_app(default_hosts(host, bound))
    server = uvicorn.Server(uvicorn.Config(app, log_level='warning', lifespan='off'))
    print(f'ctx-pydantic-ai listening on http://{f"[{host}]" if ":" in host else host}:{bound}', flush=True)
    await server.serve(sockets=[sock])


async def _remote_app(args: argparse.Namespace, hosts: list[str]) -> Any:
    store = RemoteSessionStore(args.remote, access_token=args.remote_token)
    names = args.executor
    if not names:
        listing = await Connection(args.remote, access_token=args.remote_token).json('GET', '/executors')
        names = list(listing.get('executors') or [])
    executors = [RemoteExecutor(args.remote, name, access_token=args.remote_token) for name in names]
    harness = PydanticAIHarness(store=store, executors=executors)
    return create_app(harness, access_token=args.token, allowed_models=args.model, allowed_hosts=hosts)


def main(argv: list[str] | None = None) -> None:
    args = _parser().parse_args(argv)
    pydantic_ai.BANNER_ENABLED = False  # type: ignore[attr-defined]
    os.environ.setdefault('PYDANTIC_AI_NO_BANNER', '1')

    if not is_loopback(args.host) and not args.token:
        sys.exit(
            f'ctx-pydantic-ai: refusing to listen on {args.host} without --token (or CTX_ACCESS_TOKEN): '
            'anyone who can reach it could run models on your credentials and call your tools.'
        )

    async def make_app(hosts: list[str]) -> Any:
        if args.command == 'conformance':
            return create_conformance_app(access_token=args.token, allowed_hosts=hosts)
        return await _remote_app(args, hosts)

    async def run() -> None:
        await _serve(make_app, args.host, args.port)

    try:
        asyncio.run(run())
    except KeyboardInterrupt:
        sys.exit(130)


if __name__ == '__main__':
    main()
