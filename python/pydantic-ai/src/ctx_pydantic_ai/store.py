"""会话存储：只追加的日志。``RemoteSessionStore`` 连 ``ctx-remote`` 的会话入口，``MemorySessionStore`` 在进程内（测试和一致性模式用）。

语义同协议的 ``SessionStore``：``append`` 一批是原子的，``id``（全局）或 ``key``（同一会话）重复的那一条静默跳过；给了
``expect_seq`` 时会话末尾的 ``seq`` 不等于它就整批不写，抛 ``conflict``。
"""

from __future__ import annotations

import asyncio
import copy
from collections.abc import Callable, Mapping, Sequence
from typing import Any, Protocol

import httpx2

from .protocol import ENTRY_VERSION, CtxError, Entry, new_id, now_ms
from .wire import Connection, segment

_ENTRY_TYPES = ('message', 'event', 'summary')
#: ``append`` 重试之后回头找自己写的条目时，至少看会话末尾这么多条（同 ``ctx-remote`` 的客户端）。
_APPEND_LOOKBACK = 200


class SessionStore(Protocol):
    async def append(
        self, session: str, entries: Sequence[Mapping[str, Any]], *, expect_seq: int | None = None
    ) -> list[Entry]: ...

    async def list(
        self,
        session: str,
        *,
        after: int | None = None,
        last: int | None = None,
        limit: int | None = None,
        types: Sequence[str] | None = None,
        kinds: Sequence[str] | None = None,
    ) -> list[Entry]: ...


def _filter(
    entries: Sequence[Entry],
    *,
    after: int | None,
    last: int | None,
    limit: int | None,
    types: Sequence[str] | None,
    kinds: Sequence[str] | None,
    at_after: float | None = None,
) -> list[Entry]:
    """``ListOptions`` 的语义：先按条件筛，再取 ``last``，再取 ``limit``。"""
    if last is not None and int(last) <= 0:
        return []
    if limit is not None and int(limit) <= 0:
        return []
    out = [
        entry
        for entry in entries
        if (after is None or entry['seq'] > after)
        and (types is None or entry['type'] in types)
        and (kinds is None or (entry['type'] == 'event' and entry.get('kind') in kinds))
        and (at_after is None or entry['at'] > at_after)
    ]
    if last is not None:
        out = out[-int(last) :]
    if limit is not None:
        out = out[: int(limit)]
    return out


class MemorySessionStore:
    """进程内的会话存储。"""

    def __init__(self, *, now: Callable[[], float] | None = None) -> None:
        self._now = now or now_ms
        self._sessions: dict[str, list[Entry]] = {}
        self._heads: dict[str, int] = {}
        self._ids: set[str] = set()
        self._lock = asyncio.Lock()

    async def append(
        self, session: str, entries: Sequence[Mapping[str, Any]], *, expect_seq: int | None = None
    ) -> list[Entry]:
        if not isinstance(session, str) or session == '':
            raise CtxError('invalid_request', 'A session name must be a non-empty string.')
        for draft in entries:
            if draft.get('type') not in _ENTRY_TYPES:
                raise CtxError('invalid_request', f'Unknown entry type {draft.get("type")!r}.')
        async with self._lock:
            log = self._sessions.setdefault(session, [])
            head = self._heads.get(session, 0)
            if expect_seq is not None and expect_seq != head:
                raise CtxError('conflict', f'Session "{session}" ends at seq {head}, not {expect_seq}.', retryable=True)
            keys = {entry['key'] for entry in log if entry.get('key') is not None}
            written: list[Entry] = []
            for draft in entries:
                entry_id = draft.get('id') or new_id()
                key = draft.get('key')
                if entry_id in self._ids or (key is not None and key in keys):
                    continue
                head += 1
                entry = {
                    **{name: copy.deepcopy(value) for name, value in draft.items() if value is not None},
                    'id': entry_id,
                    'session': session,
                    'seq': head,
                    'at': draft.get('at') if isinstance(draft.get('at'), (int, float)) else self._now(),
                    'v': ENTRY_VERSION,
                }
                self._ids.add(entry_id)
                if key is not None:
                    keys.add(key)
                log.append(entry)
                written.append(copy.deepcopy(entry))
            self._heads[session] = head
            return written

    async def list(
        self,
        session: str,
        *,
        after: int | None = None,
        last: int | None = None,
        limit: int | None = None,
        types: Sequence[str] | None = None,
        kinds: Sequence[str] | None = None,
        at_after: float | None = None,
    ) -> list[Entry]:
        found = _filter(
            self._sessions.get(session, []),
            after=after,
            last=last,
            limit=limit,
            types=types,
            kinds=kinds,
            at_after=at_after,
        )
        return copy.deepcopy(found)

    async def sessions(self, *, prefix: str = '', after: str | None = None, limit: int | None = None) -> list[str]:
        names = sorted(name for name, log in self._sessions.items() if log and name.startswith(prefix))
        if after is not None:
            names = [name for name in names if name > after]
        return names if limit is None else names[: max(0, int(limit))]


class RemoteSessionStore:
    """``ctx-remote`` 的会话入口（``/sessions/:session/entries``）。"""

    def __init__(
        self,
        base_url: str,
        *,
        access_token: str | None = None,
        headers: Mapping[str, str] | None = None,
        client: httpx2.AsyncClient | None = None,
        timeout: float = 60.0,
    ) -> None:
        self._connection = Connection(
            base_url, access_token=access_token, headers=headers, client=client, timeout=timeout
        )

    async def aclose(self) -> None:
        await self._connection.aclose()

    def _path(self, session: str) -> str:
        if not isinstance(session, str) or session == '':
            raise CtxError('invalid_request', 'A session name must be a non-empty string.')
        return f'/sessions/{segment(session)}/entries'

    async def append(
        self, session: str, entries: Sequence[Mapping[str, Any]], *, expect_seq: int | None = None
    ) -> list[Entry]:
        # 发出前给每条补上 `id`：响应丢了再发一遍时，存储按 `id` 去重，不会记两遍。
        batch = [dict(entry) if entry.get('id') else {**entry, 'id': new_id()} for entry in entries]
        body: dict[str, Any] = {'entries': batch}
        if expect_seq is not None:
            body['expectSeq'] = expect_seq
        try:
            response = await self._connection.json('POST', self._path(session), body=body, retry=True)
        except CtxError as error:
            # 前面有一次没拿到响应、其实写成功了：前提就对不上了。从会话末尾找回自己写的条目。
            if error.type != 'conflict':
                raise
            ids = {entry['id'] for entry in batch}
            tail = await self.list(session, last=max(_APPEND_LOOKBACK, len(batch) * 2))
            mine = [entry for entry in tail if entry.get('id') in ids]
            if len(mine) == len(batch):
                return mine
            raise
        return list(response.get('entries') or [])

    async def list(
        self,
        session: str,
        *,
        after: int | None = None,
        last: int | None = None,
        limit: int | None = None,
        types: Sequence[str] | None = None,
        kinds: Sequence[str] | None = None,
    ) -> list[Entry]:
        if kinds is not None and any(',' in kind for kind in kinds):
            raise ValueError('An entry kind cannot contain a comma.')
        if (limit is not None and int(limit) <= 0) or (last is not None and int(last) <= 0):
            return []
        # 服务端一次只回一页（`more: true` 表示后面还有）：接着用 `after` 读，直到读完或够了 `limit`。
        out: list[Entry] = []
        tail_n = None if last is None else int(last)
        cursor = after
        while True:
            body = await self._connection.json(
                'GET',
                self._path(session),
                params={
                    'after': None if cursor is None else str(cursor),
                    'last': None if tail_n is None else str(tail_n),
                    'limit': None if limit is None else str(int(limit) - len(out)),
                    'types': None if types is None else ','.join(types),
                    'kinds': None if kinds is None else ','.join(kinds),
                },
            )
            page = list(body.get('entries') or [])
            for entry in page:
                version = entry.get('v')
                if not isinstance(version, int) or version > ENTRY_VERSION:
                    raise CtxError(
                        'unsupported_version', f'Entry format version {version!r} is newer than this client.'
                    )
            out.extend(page)
            if not body.get('more') or not page:
                return out[-int(last) :] if last is not None and limit is None else out
            cursor = page[-1]['seq']
            tail_n = None
