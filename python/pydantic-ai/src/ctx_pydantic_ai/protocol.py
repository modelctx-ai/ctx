"""ctx 线上协议在 Python 这边用到的部分：版本、错误、条目、工具结果的截断、上下文过长的认法、工具筛选、
等着别处执行的工具调用。

形状以 ``docs/protocol.md`` 为准，字段名和线上一样（驼峰）。这里的函数和协议包（``@modelctx-ai/ctx-protocol``）里同名的
TypeScript 函数一一对应。
"""

from __future__ import annotations

import json
import math
import re
import time
import uuid
from collections.abc import Mapping, Sequence
from typing import Any

#: 线上协议的版本（协议包的 ``PROTOCOL_VERSION``）。``GET /protocol`` 报它，两边不同就连不上。
PROTOCOL_VERSION = '0.3'
#: 条目的格式版本（协议包的 ``ENTRY_VERSION``）。
ENTRY_VERSION = 1
#: 一次工具结果最多多少字符（UTF-16 码元），协议包的 ``DEFAULT_MAX_TOOL_OUTPUT_CHARS``。
DEFAULT_MAX_TOOL_OUTPUT_CHARS = 200_000

RUN_STARTED = 'ctx.run.started'
RUN_ENDED = 'ctx.run.ended'
CTX_ERROR = 'ctx.error'
CTX_ERASED = 'ctx.erased'

#: 远端的 ``agent.settings`` 缺省收的键（``ctx-remote`` 的 ``DEFAULT_ALLOWED_SETTINGS``）。
DEFAULT_ALLOWED_SETTINGS = (
    'temperature',
    'maxOutputTokens',
    'topP',
    'topK',
    'presencePenalty',
    'frequencyPenalty',
    'seed',
    'stopSequences',
    'maxRetries',
    'timeoutMs',
)

#: 记进日志时，请求头的值换成这个（协议包的 ``REDACTED_HEADER``）。
REDACTED_HEADER = '[redacted]'

Json = Any
Entry = dict[str, Any]


class CtxError(Exception):
    """协议认得的错误：``type`` 是机器可读的类别（``conflict``、``session_busy``、``invalid_request`` ……）。"""

    def __init__(
        self,
        type: str,  # noqa: A002 - 和协议的字段同名
        message: str,
        *,
        retryable: bool | None = None,
        status_code: int | None = None,
    ) -> None:
        super().__init__(message)
        self.type = type
        self.message = message
        self.retryable = retryable
        self.status_code = status_code

    def info(self) -> dict[str, Any]:
        """``ErrorInfo``。"""
        out: dict[str, Any] = {'message': self.message, 'type': self.type}
        if self.retryable is not None:
            out['retryable'] = self.retryable
        if self.status_code is not None:
            out['statusCode'] = self.status_code
        return out


def now_ms() -> int:
    return int(time.time() * 1000)


def new_id() -> str:
    return str(uuid.uuid4())


def is_object(value: Any) -> bool:
    return isinstance(value, dict)


def compact(values: Mapping[str, Any]) -> dict[str, Any]:
    """去掉值是 ``None`` 的键：可选字段不给时不出现在 JSON 里。"""
    return {key: value for key, value in values.items() if value is not None}


def is_framework_kind(kind: str) -> bool:
    return kind.startswith('ctx.')


# ---- 错误 ----

_OVERFLOW_PATTERNS = [
    re.compile(pattern, re.IGNORECASE)
    for pattern in (
        r'context[_ ]length[_ ]exceeded',
        r'context[_ ]?window[_ ]?exceeded',
        r'maximum context length',
        r'exceed(s|ed|ing)?\b[^.\n]{0,60}\bcontext[ _](window|length|size|limit)',
        r'context[ _](window|length|size|limit)[^.\n]{0,60}\bexceed',
        r'prompt is too long',
        r'input is too long',
        r'input token count[^.\n]{0,40}exceeds',
        r'maximum prompt length',
        r'too many (input )?tokens',
        r'reduce the length of (the|your) (messages|prompt|input)',
        r'request_too_large',
    )
]
_NOT_OVERFLOW_STATUS = frozenset({401, 403, 404, 429})


def is_context_overflow_text(text: str, status: int | None = None) -> bool:
    """上游的报错文字（和状态码）是不是在说上下文超过了模型的窗口（协议包的 ``isContextOverflowText``）。"""
    if status is not None and status in _NOT_OVERFLOW_STATUS:
        return False
    if status == 413:
        return True
    return any(pattern.search(text) for pattern in _OVERFLOW_PATTERNS)


def error_output(message: str, *, retryable: bool | None = None, data: Json = None) -> dict[str, Any]:
    """``{ type: 'error' }`` 的工具结果。"""
    return compact({'type': 'error', 'message': message, 'retryable': retryable, 'data': data})


# ---- 工具结果的截断 ----


def _units(char: str) -> int:
    return 2 if ord(char) > 0xFFFF else 1


def utf16_length(text: str) -> int:
    """按 UTF-16 码元数（和 TypeScript 的 ``length`` 一样）。"""
    return sum(_units(char) for char in text)


def _clip(text: str, limit: int) -> str:
    """留下前 ``limit`` 个 UTF-16 码元，不把一个字符切成两半。"""
    used = 0
    for index, char in enumerate(text):
        used += _units(char)
        if used > limit:
            return text[:index]
    return text


def _truncated_text(text: str, limit: int) -> str:
    kept = _clip(text, limit)
    omitted = utf16_length(text) - utf16_length(kept)
    return (
        f'{kept}\n[… truncated {omitted} more characters; narrow the request (filters, paging, a smaller range) '
        'to see the rest]'
    )


def _json_text(value: Json) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'))


def limit_tool_output(output: dict[str, Any], max_chars: int | None) -> dict[str, Any]:
    """工具结果的长度兜底（协议包的 ``limitToolOutput``）：超过 ``max_chars`` 时截断并注明省略了多少，没超的原样返回。"""
    if max_chars is None or not math.isfinite(max_chars) or max_chars <= 0:
        return output
    limit = int(max_chars)
    kind = output.get('type')
    if kind == 'text':
        text = str(output.get('text', ''))
        return output if utf16_length(text) <= limit else {'type': 'text', 'text': _truncated_text(text, limit)}
    if kind == 'error':
        message = str(output.get('message', ''))
        return output if utf16_length(message) <= limit else {**output, 'message': _truncated_text(message, limit)}
    if kind == 'json':
        text = _json_text(output.get('value'))
        return output if utf16_length(text) <= limit else {'type': 'text', 'text': _truncated_text(text, limit)}
    parts = output.get('parts') or []

    def size_of(part: Mapping[str, Any]) -> int:
        if part.get('type') == 'text':
            return utf16_length(str(part.get('text', '')))
        data = part.get('data') or {}
        if data.get('type') == 'data':
            return len(str(data.get('data', '')))
        return utf16_length(str(data.get('text', ''))) if data.get('type') == 'text' else 0

    if sum(size_of(part) for part in parts) <= limit:
        return output
    left = limit
    cut = False
    kept: list[dict[str, Any]] = []
    for part in parts:
        size = size_of(part)
        if part.get('type') == 'file':
            if size <= left:
                left -= size
                kept.append(part)
            else:
                kept.append(
                    {
                        'type': 'text',
                        'text': f'[{part.get("mediaType")} file omitted: {size} characters of data do not fit in the '
                        'tool output limit]',
                    }
                )
        elif not cut:
            if size <= left:
                left -= size
                kept.append(part)
            else:
                kept.append({'type': 'text', 'text': _truncated_text(str(part.get('text', '')), left)})
                left = 0
                cut = True
    return {'type': 'content', 'parts': kept}


# ---- 工具 ----

_TOOL_NAME = re.compile(r'^[a-zA-Z0-9_-]{1,64}$')


def is_valid_tool_name(name: str) -> bool:
    return bool(_TOOL_NAME.match(name))


def _matches(tool: Mapping[str, Any], selection: Json) -> bool:
    if isinstance(selection, bool):
        return selection
    if isinstance(selection, list):
        return tool.get('name') in selection
    if not isinstance(selection, dict):
        return False
    names, tags, sources = selection.get('names'), selection.get('tags'), selection.get('sources')
    if names is not None and tool.get('name') not in names:
        return False
    if tags is not None and not any(tag in (tool.get('tags') or []) for tag in tags):
        return False
    return not (sources is not None and tool.get('source') not in sources)


def select_tools(tools: Sequence[Mapping[str, Any]], selection: Json = True) -> list[dict[str, Any]]:
    """按 ``ToolSelection`` 挑工具，保持原来的顺序（协议包的 ``selectTools``）。"""
    if selection is False:
        return []
    return [dict(tool) for tool in tools if _matches(tool, selection)]


def tool_permission(permissions: Mapping[str, Any] | None, tool: str) -> str:
    """``allow``、``ask`` 或 ``deny``（协议包的 ``toolPermission``）。"""
    if not permissions:
        return 'allow'
    return (permissions.get('tools') or {}).get(tool) or permissions.get('default') or 'allow'


# ---- 运行 ----


def run_parent_problem(parent: Json) -> str | None:
    """``RunRequest.parent`` 的形状不对时说明哪里不对（协议包的 ``runParentProblem``）。"""
    if parent is None:
        return None
    if not isinstance(parent, dict):
        return 'RunRequest.parent must be an object'
    session, run_id, call = parent.get('session'), parent.get('runId'), parent.get('toolCallId')
    if not isinstance(session, str) or session == '':
        return 'RunRequest.parent.session must be a non-empty string'
    if not isinstance(run_id, str) or run_id == '':
        return 'RunRequest.parent.runId must be a non-empty string'
    if call is not None and not isinstance(call, str):
        return 'RunRequest.parent.toolCallId must be a string'
    return None


_SPEC_KEYS = (
    'name',
    'instructions',
    'tools',
    'maxSteps',
    'window',
    'context',
    'version',
    'output',
    'toolChoice',
    'permissions',
    'budget',
    'environment',
)


def agent_spec_to_json(spec: Mapping[str, Any]) -> dict[str, Any]:
    """``ctx.run.started`` 的 ``data.agent``（协议包的 ``agentSpecToJson``）：请求头只留名字。"""
    out: dict[str, Any] = {'model': spec.get('model')}
    for key in _SPEC_KEYS:
        if spec.get(key) is not None:
            out[key] = spec[key]
    settings = spec.get('settings')
    if isinstance(settings, dict):
        headers = settings.get('headers')
        out['settings'] = (
            {**settings, 'headers': {name: REDACTED_HEADER for name in headers}}
            if isinstance(headers, dict)
            else dict(settings)
        )
    return out


# ---- 条目 ----


def message_entry(
    message: Mapping[str, Any],
    *,
    source: str | None = None,
    key: str | None = None,
    meta: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    return compact({'type': 'message', 'message': dict(message), 'source': source, 'key': key, 'meta': meta})


def event_entry(
    kind: str,
    *,
    data: Json = None,
    text: str | None = None,
    source: str | None = None,
    meta: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    return compact({'type': 'event', 'kind': kind, 'text': text, 'data': data, 'source': source, 'meta': meta})


def is_event(entry: Mapping[str, Any] | None, kind: str) -> bool:
    return entry is not None and entry.get('type') == 'event' and entry.get('kind') == kind


def run_id_of(entry: Mapping[str, Any]) -> Json:
    data = entry.get('data')
    return data.get('runId') if entry.get('type') == 'event' and isinstance(data, dict) else None


# ---- 写日志：围栏 ----


def _number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _erased_data(entry: Mapping[str, Any]) -> Mapping[str, Any] | None:
    """``ctx.erased`` 的 ``data``（协议包的 ``ctxEventData(entry, CTX_EVENTS.erased)``）：``op``、``count`` 不对时没有。"""
    data = entry.get('data')
    if not is_event(entry, CTX_ERASED) or not isinstance(data, dict):
        return None
    if data.get('op') not in ('truncate', 'remove', 'redact') or not _number(data.get('count')):
        return None
    return data


def is_erased(data: Mapping[str, Any], seq: int) -> bool:
    """一条擦除记录动没动 ``seq`` 这一条（协议包的 ``isErased``）：``truncate`` 看 ``upTo``，``remove``、``redact`` 看 ``seqs``。"""
    if data.get('op') == 'truncate':
        up_to = data.get('upTo')
        return _number(up_to) and seq <= up_to
    seqs = data.get('seqs')
    return isinstance(seqs, list) and all(_number(item) for item in seqs) and seq in seqs


def is_fenced(
    lifecycle: Sequence[Mapping[str, Any]],
    run_id: str,
    *,
    started: int | None,
    recorded: Sequence[Mapping[str, Any]],
) -> bool:
    """围栏（协议包的 ``isFenced``）：``lifecycle`` 是这一轮的 ``ctx.run.started`` 起的生命周期事件和擦除记录。自己的
    ``runId`` 已经有 ``ctx.run.ended``、自己的 ``ctx.run.started`` 不在了、有 ``ctx.erased`` 动了这一轮写的条目，都是被围栏。
    """
    mine = [entry for entry in lifecycle if run_id_of(entry) == run_id]
    if any(is_event(entry, RUN_ENDED) for entry in mine):
        return True
    if started is not None and not any(entry['seq'] == started for entry in mine):
        return True
    for entry in lifecycle:
        data = _erased_data(entry)
        if data is not None and any(is_erased(data, written['seq']) for written in recorded):
            return True
    return False


async def head_seq(store: Any, session: str) -> int:
    """会话最后一条的 ``seq``，空会话是 0（协议包的 ``headSeq``）。"""
    tail = await store.list(session, last=1)
    return int(tail[-1]['seq']) if tail else 0


async def after_conflict(
    store: Any,
    session: str,
    run_id: str,
    *,
    started: int | None,
    recorded: Sequence[Mapping[str, Any]],
) -> int | None:
    """带 ``expect_seq`` 的写入冲突之后（协议包的 ``afterConflict``）：先读末尾，再读这一轮的 ``ctx.run.started`` 起的生命周期
    事件和擦除记录。被围栏返回 ``None``，否则返回新的末尾。``started`` 还没有时只读末尾。
    """
    head = await head_seq(store, session)
    if started is None:
        return head
    lifecycle = await store.list(session, after=started - 1, kinds=[RUN_STARTED, RUN_ENDED, CTX_ERASED])
    return None if is_fenced(lifecycle, run_id, started=started, recorded=recorded) else head


# ---- 失败的重试 ----


def ended_in_failure(lifecycle: Sequence[Mapping[str, Any]]) -> bool:
    """上一轮失败了（协议包的 ``endedInFailure``）：生命周期事件的最后一条是停在 ``error`` 或 ``aborted`` 的 ``ctx.run.ended``。"""
    last = lifecycle[-1] if lifecycle else None
    if not is_event(last, RUN_ENDED):
        return False
    data = last.get('data')  # type: ignore[union-attr]
    return (
        isinstance(data, dict) and isinstance(data.get('runId'), str) and data.get('stopReason') in ('error', 'aborted')
    )


def repeats_failed_input(
    tail: Sequence[Mapping[str, Any]], content: Json, *, key: str | None = None, harness: str | None = None
) -> bool:
    """这一轮的输入是不是失败那一轮留下的那句（协议包的 ``repeatsFailedInput``）：``tail`` 是会话末尾的若干条，从末尾往回
    跳过框架事件、``harness`` 自己的事件（``<harness>.*``）和没盖住它的摘要，第一条别的条目是内容一样的用户消息才算。
    给了 ``key`` 只看有没有这个键的条目。
    """
    if key is not None:
        return any(entry.get('key') == key for entry in tail)
    own = None if harness is None else f'{harness}.'
    covered = 0
    for entry in reversed(tail):
        kind = entry.get('kind')
        if entry['type'] == 'event' and (is_framework_kind(kind) or (own is not None and kind.startswith(own))):
            continue
        if entry['type'] == 'summary':
            covered = max(covered, int(entry['covers']))
            continue
        return (
            entry['type'] == 'message'
            and entry['message'].get('role') == 'user'
            and entry['seq'] > covered
            and entry['message'].get('content') == content
        )
    return False


# ---- 工具调用经日志往返 ----

#: ``tool_result_entry`` 的幂等键前缀（协议包的 ``TOOL_RESULT_KEY_PREFIX``）：同一次调用的结果只记一次。
TOOL_RESULT_KEY_PREFIX = 'ctx.tool-result:'


def tool_result_entry(
    call: Mapping[str, Any],
    output: Mapping[str, Any],
    *,
    source: str | None = None,
    meta: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """别处执行完一次工具调用，追加回会话的 ``tool`` 消息（协议包的 ``toolResultEntry``），带幂等键 ``ctx.tool-result:<id>``。"""
    part = {'type': 'tool-result', 'id': call['id'], 'name': call['name'], 'output': dict(output)}
    return message_entry(
        {'role': 'tool', 'content': [part]}, source=source, key=f'{TOOL_RESULT_KEY_PREFIX}{call["id"]}', meta=meta
    )


def pending_tool_calls(entries: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
    """等着别处执行、还没有结果的工具调用（协议包的 ``pendingToolCalls``），每个是 ``{ call, runId, seq }``：以
    ``requires_action`` 结束的那一轮留下的调用，去掉后面已经追加了结果的。之后又有运行以别的原因结束，之前留下的就不再算。
    条目按 ``seq`` 排好；服务商执行的调用不算。"""
    waiting: dict[str, dict[str, Any]] = {}
    run_id: str | None = None
    calls: dict[str, dict[str, Any]] = {}
    for entry in entries:
        if entry.get('type') == 'event' and entry.get('kind') in (RUN_STARTED, RUN_ENDED):
            data = entry.get('data')
            data = data if isinstance(data, dict) else {}
            if not isinstance(data.get('runId'), str):
                continue
            if entry['kind'] == RUN_STARTED:
                run_id, calls = data['runId'], {}
                continue
            # 这一轮停下来等结果：它留下的调用等待中；别的结束方式让之前等着的都作废。
            waiting = dict(calls) if data.get('stopReason') == 'requires_action' and run_id == data['runId'] else {}
            run_id, calls = None, {}
            continue
        content = entry['message'].get('content') if entry.get('type') == 'message' else None
        if not isinstance(content, list):
            continue
        for part in content:
            if part.get('type') == 'tool-call' and part.get('providerExecuted') is not True and run_id is not None:
                call = {'id': part['id'], 'name': part['name'], 'input': part.get('input')}
                calls[part['id']] = {'call': call, 'runId': run_id, 'seq': entry['seq']}
            elif part.get('type') == 'tool-result':
                waiting.pop(part['id'], None)
                calls.pop(part['id'], None)
    return list(waiting.values())
