"""连 ctx 服务端（``ctx-remote``）的 HTTP 客户端：握手（``GET /protocol``）、JSON 请求、把错误转回 ``CtxError``。"""

from __future__ import annotations

import asyncio
import json
from collections.abc import Mapping
from typing import Any
from urllib.parse import quote

import httpx2

from .protocol import ENTRY_VERSION, PROTOCOL_VERSION, CtxError

_TRANSIENT_STATUS = frozenset({502, 503, 504})


def segment(value: str) -> str:
    """路径里的一段（``encodeURIComponent``）。"""
    return quote(value, safe='')


def check_protocol_info(info: Any) -> dict[str, Any]:
    """对方说的协议版本能不能对上（协议包的 ``checkProtocolInfo``）。"""
    if not isinstance(info, dict):
        raise CtxError('unsupported_version', 'The server did not describe its protocol (GET /protocol).')
    if info.get('protocol') != PROTOCOL_VERSION:
        raise CtxError(
            'unsupported_version',
            f'The server speaks ctx protocol {json.dumps(info.get("protocol"))}; this client speaks {PROTOCOL_VERSION}.',
        )
    entry_version = info.get('entryVersion')
    if not isinstance(entry_version, int) or entry_version > ENTRY_VERSION:
        raise CtxError(
            'unsupported_version',
            f'The server writes entry format {json.dumps(entry_version)}, newer than {ENTRY_VERSION}.',
        )
    if not isinstance(info.get('components'), dict):
        raise CtxError('unsupported_version', 'The server did not list its components (GET /protocol).')
    return info


def error_of(status: int, text: str) -> CtxError:
    """服务端的错误正文 ``{ error: { message, type, retryable } }`` 转成 ``CtxError``，状态码 409 是 ``conflict``。"""
    info: dict[str, Any] = {}
    try:
        body = json.loads(text)
        if isinstance(body, dict) and isinstance(body.get('error'), dict):
            info = body['error']
    except ValueError:
        pass
    message = str(info.get('message') or text.strip() or f'HTTP {status}')
    kind = info.get('type')
    if status == 409 and kind in (None, 'conflict', 'conflict_error'):
        kind = 'conflict'
    retryable = info.get('retryable')
    return CtxError(
        str(kind or 'remote_error'),
        message,
        retryable=retryable if isinstance(retryable, bool) else status in (429, *_TRANSIENT_STATUS),
        status_code=status,
    )


class Connection:
    """一个服务端地址：第一次请求之前读一次 ``GET /protocol``，读失败了下次再试。"""

    def __init__(
        self,
        base_url: str,
        *,
        access_token: str | None = None,
        headers: Mapping[str, str] | None = None,
        client: httpx2.AsyncClient | None = None,
        timeout: float = 300.0,
        retries: int = 3,
        check_protocol: bool = True,
    ) -> None:
        self.base_url = base_url.rstrip('/')
        self._headers = {**(headers or {})}
        if access_token:
            self._headers['authorization'] = f'Bearer {access_token}'
        self._own = client is None
        self._client = client or httpx2.AsyncClient(timeout=timeout)
        self._retries = max(0, retries)
        self._check = check_protocol
        self._handshake: asyncio.Task[None] | None = None

    async def aclose(self) -> None:
        if self._own:
            await self._client.aclose()

    async def _ensure_protocol(self) -> None:
        if not self._check:
            return
        task = self._handshake
        if task is None or (task.done() and (task.cancelled() or task.exception() is not None)):
            self._handshake = asyncio.ensure_future(self._read_protocol())
        await asyncio.shield(self._handshake)

    async def _read_protocol(self) -> None:
        response = await self._send('GET', '/protocol', retry=True)
        if response.status_code == 404:
            raise CtxError('unsupported_version', f'{self.base_url} has no GET /protocol: it is not a ctx server.')
        if response.status_code >= 400:
            raise error_of(response.status_code, response.text)
        check_protocol_info(response.json())

    async def _send(
        self,
        method: str,
        path: str,
        *,
        params: Mapping[str, Any] | None = None,
        body: Any = None,
        retry: bool = False,
    ) -> httpx2.Response:
        headers = dict(self._headers)
        content: bytes | None = None
        if body is not None:
            headers['content-type'] = 'application/json'
            content = json.dumps(body, ensure_ascii=False).encode('utf-8')
        query = {key: value for key, value in (params or {}).items() if value is not None}
        for attempt in range(self._retries + 1):
            try:
                response = await self._client.request(
                    method, f'{self.base_url}{path}', params=query, content=content, headers=headers
                )
            except httpx2.TransportError:
                if not retry or attempt >= self._retries:
                    raise
            else:
                if not retry or response.status_code not in _TRANSIENT_STATUS or attempt >= self._retries:
                    return response
            await asyncio.sleep(min(2.0, 0.2 * 2**attempt))
        raise AssertionError('unreachable')

    async def json(
        self,
        method: str,
        path: str,
        *,
        params: Mapping[str, Any] | None = None,
        body: Any = None,
        retry: bool | None = None,
    ) -> Any:
        """发一个请求，回 JSON 正文；4xx、5xx 和响应头之后才出的错（``{ error, status }``）抛 ``CtxError``。"""
        await self._ensure_protocol()
        response = await self._send(
            method, path, params=params, body=body, retry=method == 'GET' if retry is None else retry
        )
        if response.status_code >= 400:
            raise error_of(response.status_code, response.text)
        # 等很久才有结果的请求先发响应头、再隔一段时间写一个换行：JSON 前面的空白跳过就行。
        value = json.loads(response.text) if response.text.strip() else None
        if isinstance(value, dict) and isinstance(value.get('error'), dict) and isinstance(value.get('status'), int):
            raise error_of(value['status'], json.dumps({'error': value['error']}))
        return value
