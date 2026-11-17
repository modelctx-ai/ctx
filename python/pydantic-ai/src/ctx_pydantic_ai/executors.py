"""执行环境：工具调用真正发生的地方。``RemoteExecutor`` 连 ``ctx-remote`` 的执行环境入口，``FunctionExecutor`` 是进程内的函数。

语义同协议的 ``Executor``：执行出错返回 ``{ type: 'error' }`` 而不是抛，模型要看到错误才能接着做；抛出表示执行环境本身坏了。
"""

from __future__ import annotations

import asyncio
import inspect
from collections.abc import Awaitable, Callable, Mapping
from typing import Any, Protocol, runtime_checkable

import httpx2

from .protocol import CtxError, Json, error_output
from .wire import Connection, segment

ToolFunction = Callable[[Json, Mapping[str, Any]], Awaitable[dict[str, Any]] | dict[str, Any]]


@runtime_checkable
class Executor(Protocol):
    name: str

    async def tools(self) -> list[dict[str, Any]]: ...

    async def execute(self, call: Mapping[str, Any], context: Mapping[str, Any]) -> dict[str, Any]: ...


class FunctionExecutor:
    """进程内的函数：``register(definition, fn)``，``fn(input, context)`` 返回 ``ToolOutput``。"""

    def __init__(self, name: str = 'local') -> None:
        self.name = name
        self._table: dict[str, tuple[dict[str, Any], ToolFunction]] = {}

    def register(self, definition: Mapping[str, Any], fn: ToolFunction) -> FunctionExecutor:
        self._table[definition['name']] = ({**definition, 'executor': self.name}, fn)
        return self

    async def tools(self) -> list[dict[str, Any]]:
        return [dict(definition) for definition, _ in self._table.values()]

    async def execute(self, call: Mapping[str, Any], context: Mapping[str, Any]) -> dict[str, Any]:
        found = self._table.get(call.get('name', ''))
        if found is None:
            return error_output(f'Unknown tool "{call.get("name")}" on executor "{self.name}".')
        result = found[1](call.get('input'), context)
        return await result if inspect.isawaitable(result) else result


class RemoteExecutor:
    """``ctx-remote`` 的一个执行环境（``/executors/:name``）。"""

    def __init__(
        self,
        base_url: str,
        name: str,
        *,
        access_token: str | None = None,
        headers: Mapping[str, str] | None = None,
        client: httpx2.AsyncClient | None = None,
        timeout: float = 600.0,
    ) -> None:
        self.name = name
        self._base = f'/executors/{segment(name)}'
        self._connection = Connection(
            base_url, access_token=access_token, headers=headers, client=client, timeout=timeout
        )

    async def aclose(self) -> None:
        await self._connection.aclose()

    async def tools(self) -> list[dict[str, Any]]:
        body = await self._connection.json('GET', f'{self._base}/tools')
        return [{**tool, 'executor': self.name} for tool in body.get('tools') or []]

    async def open(self, session: str, environment: Mapping[str, Any] | None = None) -> None:
        await self._connection.json(
            'POST',
            f'{self._base}/sessions/{segment(session)}/open',
            body={'environment': environment} if environment else {},
            retry=True,
        )

    async def execute(self, call: Mapping[str, Any], context: Mapping[str, Any]) -> dict[str, Any]:
        wire_context = {'session': context['session']}
        if context.get('runId') is not None:
            wire_context['runId'] = context['runId']
        try:
            body = await self._connection.json(
                'POST', f'{self._base}/execute', body={'call': dict(call), 'context': wire_context}, retry=False
            )
        except asyncio.CancelledError:
            raise
        except CtxError as error:
            return error_output(
                f'Remote executor "{self.name}" at {self._connection.base_url} refused tool "{call.get("name")}" '
                f'(HTTP {error.status_code}): {error.message}',
                retryable=bool(error.status_code and (error.status_code >= 500 or error.status_code == 429)),
            )
        except httpx2.HTTPError as error:
            return error_output(
                f'Could not reach remote executor "{self.name}" at {self._connection.base_url}: {error}. '
                f'Tool "{call.get("name")}" may not have run; retry if it is safe to run twice.',
                retryable=True,
            )
        output = body.get('output') if isinstance(body, dict) else None
        if not isinstance(output, dict):
            return error_output(f'Remote executor "{self.name}" answered without an output.')
        return output
