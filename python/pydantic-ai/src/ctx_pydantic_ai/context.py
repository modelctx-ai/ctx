"""从日志投影出上下文、收集事实，和 token 的估算、截短：协议包 ``context.ts`` 的 ``project``、``collectFacts`` 和
``tokens.ts`` 的移植。

投影：按 ``(at, seq)`` 排，``covers`` 最大的摘要代替它盖住的条目、固定在最前（缺省渲染成一条用户消息），消息条目可以改写或
过滤，事件按规则渲染（没有规则的不进上下文，``fold`` 的同类事件连在一起时合成一组），带工具调用的助手消息和紧跟的工具结果是
一组，组里的调用和结果按 ``id`` 配对（没有调用的结果去掉，没有结果的调用补一条错误结果）。有窗口时从最旧的组裁起，至少留最后
一组，裁过之后开头不留助手消息（前面有摘要时除外）；``truncate`` 时先给单条消息封顶，裁到只剩最后一组还超就接着截短。

估算不分词：中日韩文字一个字算 1，ASCII 4 个字符算 1，其余文字 2 个字符算 1，补充平面的字符算 2；附件按
``estimate_file_tokens``。长度、切点按 UTF-16 码元算，和 TypeScript 的字符串一样。
"""

from __future__ import annotations

import asyncio
import inspect
import json
import logging
import math
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass, field, replace
from typing import TYPE_CHECKING, Any

from .protocol import Json, error_output

if TYPE_CHECKING:
    from .harness import AbortSignal

_log = logging.getLogger(__name__)

#: 日志里有调用、没有结果的工具调用补的结果（协议包投影的 ``MISSING_RESULT``）。
MISSING_RESULT = 'No result was recorded for this tool call.'
#: 摘要渲染成的用户消息的开头（协议包的 ``defaultSummaryMessage``）。
SUMMARY_PREFIX = 'Summary of the earlier conversation:\n'

#: 每条消息的格式开销，按常见聊天模板粗估。
_MESSAGE_OVERHEAD = 4
#: 大小不知道的附件（地址、服务商的文件引用）和小图，按一张小图粗估。
_ATTACHMENT_TOKENS = 256
_LARGE_IMAGE_TOKENS = 1600
_LARGE_IMAGE_BYTES = 64 * 1024
_DOCUMENT_BYTES_PER_TOKEN = 20
#: 一条消息最少留这么多 token：再截就只剩说明了。
_MIN_TRUNCATED_TOKENS = 32

Message = dict[str, Any]


# ---- 估算 ----


def _is_wide(code: int) -> bool:
    return (
        0x1100 <= code <= 0x115F
        or 0x2E80 <= code <= 0xA4CF
        or 0xAC00 <= code <= 0xD7A3
        or 0xF900 <= code <= 0xFAFF
        or 0xFE30 <= code <= 0xFE4F
        or 0xFF00 <= code <= 0xFF60
        or 0xFFE0 <= code <= 0xFFE6
        or 0x20000 <= code <= 0x3FFFD
    )


def _ceil_div(value: int, by: int) -> int:
    return -(-value // by)


def estimate_text_tokens(text: str) -> int:
    """一段文字的估算 token（协议包的 ``estimateTextTokens``）。"""
    wide = ascii_chars = other = 0
    for char in text:
        code = ord(char)
        if _is_wide(code):
            wide += 1
        elif code < 0x80:
            ascii_chars += 1
        else:
            other += 4 if code > 0xFFFF else 1
    return wide + _ceil_div(ascii_chars, 4) + _ceil_div(other, 2)


def estimate_file_tokens(media_type: str, data: Mapping[str, Any]) -> int:
    """附件的估算（协议包的 ``estimateFileTokens``）：内联文字按字数，base64 按解出来的大小，地址和服务商引用按一张小图。"""
    kind = data.get('type')
    if kind == 'text':
        return estimate_text_tokens(str(data.get('text', '')))
    if kind != 'data':
        return _ATTACHMENT_TOKENS
    encoded = str(data.get('data', ''))
    padding = 2 if encoded.endswith('==') else 1 if encoded.endswith('=') else 0
    size = max(0, (len(encoded) * 3) // 4 - padding)
    lowered = media_type.lower()
    if lowered.startswith('image'):
        return _LARGE_IMAGE_TOKENS if size > _LARGE_IMAGE_BYTES else _ATTACHMENT_TOKENS
    if lowered.startswith('text/') or 'json' in lowered or 'xml' in lowered:
        return _ceil_div(size, 4)
    return max(_ATTACHMENT_TOKENS, _ceil_div(size, _DOCUMENT_BYTES_PER_TOKEN))


def _js_like(value: Json) -> Json:
    """整数值的浮点数写成整数：``JSON.stringify(1.0)`` 是 ``1``，估算的字数跟着一样。"""
    if isinstance(value, float) and value.is_integer() and abs(value) < 1e21:
        return int(value)
    if isinstance(value, dict):
        return {key: _js_like(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_js_like(item) for item in value]
    return value


def json_text(value: Json) -> str:
    """``JSON.stringify`` 的写法：不加空格，不转义非 ASCII。"""
    return json.dumps(_js_like(value), ensure_ascii=False, separators=(',', ':'))


def _estimate_value(container: Mapping[str, Any], key: str) -> int:
    # 没有这个字段是 0，``null`` 照 JSON 算：和 TypeScript 里 ``undefined``、``null`` 的区别一样。
    if key not in container:
        return 0
    value = container[key]
    return estimate_text_tokens(value) if isinstance(value, str) else estimate_text_tokens(json_text(value))


def _estimate_output(output: Mapping[str, Any]) -> int:
    kind = output.get('type')
    if kind == 'text':
        return estimate_text_tokens(str(output.get('text', '')))
    if kind == 'json':
        return _estimate_value(output, 'value')
    if kind == 'error':
        return estimate_text_tokens(str(output.get('message', ''))) + _estimate_value(output, 'data')
    total = 0
    for part in output.get('parts') or []:
        if part.get('type') == 'text':
            total += estimate_text_tokens(str(part.get('text', '')))
        else:
            total += estimate_file_tokens(str(part.get('mediaType', '')), part.get('data') or {})
    return total


def estimate_tokens(message: Mapping[str, Any]) -> int:
    """一条消息的估算 token（协议包的 ``estimateTokens``）。"""
    content = message.get('content')
    if isinstance(content, str):
        return _MESSAGE_OVERHEAD + estimate_text_tokens(content)
    total = _MESSAGE_OVERHEAD
    for part in content or []:
        kind = part.get('type')
        if kind in ('text', 'reasoning'):
            total += estimate_text_tokens(str(part.get('text', '')))
        elif kind == 'tool-call':
            total += estimate_text_tokens(str(part.get('name', ''))) + _estimate_value(part, 'input')
        elif kind == 'tool-result':
            total += estimate_text_tokens(str(part.get('name', ''))) + _estimate_output(part.get('output') or {})
        elif kind in ('file', 'reasoning-file'):
            total += estimate_file_tokens(str(part.get('mediaType', '')), part.get('data') or {})
        else:
            total += _ATTACHMENT_TOKENS
    return total


# ---- 截短 ----


def _omission_note(omitted: int) -> str:
    return f'\n[… {omitted} characters omitted to fit the context window …]\n'


def _units(text: str) -> bytes:
    return text.encode('utf-16-le', 'surrogatepass')


def _text(units: bytes) -> str:
    return units.decode('utf-16-le', 'surrogatepass')


def _clip_middle(units: bytes, keep: int) -> str:
    """留头和尾各一段（共 ``keep`` 个 UTF-16 码元），中间换成说明；不把一对代理项切成两半。"""
    length = len(units) // 2
    head = _ceil_div(keep * 2, 3)
    tail = length - (keep - head)

    def unit(index: int) -> int:
        return int.from_bytes(units[2 * index : 2 * index + 2], 'little')

    if head > 0 and 0xD800 <= unit(head - 1) <= 0xDBFF:
        head -= 1
    if tail < length and 0xDC00 <= unit(tail) <= 0xDFFF:
        tail += 1
    return f'{_text(units[: 2 * head])}{_omission_note(tail - head)}{_text(units[2 * tail :])}'


def truncate_text(text: str, max_tokens: float, estimate: Callable[[str], int] = estimate_text_tokens) -> str:
    """把一段文字截到估算不超过 ``max_tokens``（协议包的 ``truncateText``）：留头（约三分之二）和尾，中间换成一句写明
    省略了多少字符的说明。没超的原样返回；预算小到连说明都放不下时只剩说明，结果仍可能超。"""
    if estimate(text) <= max_tokens:
        return text
    units = _units(text)
    low, high = 0, max(0, len(units) // 2 - 1)
    while low < high:
        middle = _ceil_div(low + high, 2)
        if estimate(_clip_middle(units, middle)) <= max_tokens:
            low = middle
        else:
            high = middle - 1
    return _clip_middle(units, low)


def _omitted_file(media_type: str) -> str:
    return f'[{media_type} file omitted: too large for the context window]'


def _is_inline_file(data: Mapping[str, Any]) -> bool:
    return data.get('type') in ('data', 'text')


def _shrinkable(part: Mapping[str, Any]) -> int:
    kind = part.get('type')
    if kind == 'text':
        return estimate_text_tokens(str(part.get('text', '')))
    if kind == 'file':
        data = part.get('data') or {}
        return estimate_file_tokens(str(part.get('mediaType', '')), data) if _is_inline_file(data) else 0
    if kind == 'tool-result':
        return _estimate_output(part.get('output') or {})
    return 0


def _without_inline_files(parts: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
    return [
        {'type': 'text', 'text': _omitted_file(str(part.get('mediaType', '')))}
        if part.get('type') == 'file' and _is_inline_file(part.get('data') or {})
        else dict(part)
        for part in parts
    ]


def _output_as_text(output: Mapping[str, Any]) -> str:
    kind = output.get('type')
    if kind == 'text':
        return str(output.get('text', ''))
    if kind == 'json':
        return json_text(output.get('value'))
    if kind == 'error':
        return str(output.get('message', ''))
    return '\n'.join(
        str(part.get('text', '')) if part.get('type') == 'text' else f'[{part.get("mediaType")} file]'
        for part in _without_inline_files(output.get('parts') or [])
    )


def truncate_message(
    message: Message, max_tokens: float, estimate: Callable[[Mapping[str, Any]], int] = estimate_tokens
) -> Message:
    """把一条消息截到估算不超过 ``max_tokens``，尽力而为（协议包的 ``truncateMessage``）：从最大的部件截起，文字留头尾，
    工具结果先把内联的文件换成说明、再写成文字截短（错误结果只截信息、去掉 ``data``），内联的文件换成一句说明。推理、
    工具调用的输入、服务商自定义内容不动，所以结果仍可能超。没超的原样返回（同一个对象）。"""
    if estimate(message) <= max_tokens:
        return message
    content = message.get('content')
    if isinstance(content, str):
        return {
            **message,
            'content': truncate_text(content, max_tokens, lambda text: estimate({**message, 'content': text})),
        }
    parts: list[Any] = list(content or [])
    done: set[int] = set()
    while estimate({**message, 'content': parts}) > max_tokens:
        index, size = -1, 0
        for at, candidate in enumerate(parts):
            shrink = 0 if at in done else _shrinkable(candidate)
            if shrink > size:
                index, size = at, shrink
        if index < 0:
            break
        done.add(index)
        part = parts[index]

        def replaced(next_part: Mapping[str, Any], index: int = index) -> int:
            copy = list(parts)
            copy[index] = next_part
            return estimate({**message, 'content': copy})

        kind = part.get('type')
        if kind == 'text':
            parts[index] = {
                **part,
                'text': truncate_text(
                    str(part.get('text', '')), max_tokens, lambda text, part=part: replaced({**part, 'text': text})
                ),
            }
        elif kind == 'file':
            parts[index] = {'type': 'text', 'text': _omitted_file(str(part.get('mediaType', '')))}
        elif kind == 'tool-result':
            output = part.get('output') or {}
            if output.get('type') == 'content':
                # 先只去掉内联的文件：够了就不动文字。
                lighter = {'type': 'content', 'parts': _without_inline_files(output.get('parts') or [])}
                if replaced({**part, 'output': lighter}) <= max_tokens:
                    parts[index] = {**part, 'output': lighter}
                    continue

            def wrap(text: str, output: Mapping[str, Any] = output) -> dict[str, Any]:
                if output.get('type') != 'error':
                    return {'type': 'text', 'text': text}
                return error_output(text, retryable=output.get('retryable'))

            text = truncate_text(
                _output_as_text(output),
                max_tokens,
                lambda candidate, part=part: replaced({**part, 'output': wrap(candidate)}),
            )
            parts[index] = {**part, 'output': wrap(text)}
    return {**message, 'content': parts}


# ---- 来源和事实 ----

#: 单个来源缺省最多等多久（毫秒），超时就当它这次没有内容（协议包 ``collectFacts`` 的缺省）。
DEFAULT_SOURCE_TIMEOUT_MS = 2_000


@dataclass(frozen=True)
class ContextSource:
    """生成那一刻才去取的上下文，例如当前任务、天气（协议包的 ``ContextSource``）：``collect(context)`` 返回文字，可以是
    协程；``context`` 是 ``{ session, signal? }``。文字只在这一次调用里出现，不写进日志。"""

    name: str
    collect: Callable[[Mapping[str, Any]], Awaitable[str | None] | str | None]


def js_number(value: float) -> str:
    """数字在 JavaScript 里的写法：整数值不带 ``.0``。"""
    return str(int(value)) if float(value).is_integer() else str(value)


async def _within(work: Awaitable[Any], timeout_ms: float, name: str) -> Any:
    """等 ``work`` 最多 ``timeout_ms`` 毫秒，到点就取消它、抛错。"""
    task = asyncio.ensure_future(work)
    try:
        done, _ = await asyncio.wait({task}, timeout=None if math.isinf(timeout_ms) else max(0.0, timeout_ms) / 1000)
    finally:
        if not task.done():
            task.cancel()
    if not done:
        raise TimeoutError(f'context source "{name}" timed out after {js_number(timeout_ms)}ms')
    return task.result()


async def collect_facts(
    sources: Sequence[ContextSource],
    *,
    session: str,
    signal: AbortSignal | None = None,
    timeout_ms: float = DEFAULT_SOURCE_TIMEOUT_MS,
    only: Sequence[str] | None = None,
) -> list[dict[str, str]]:
    """并行收集事实（协议包的 ``collectFacts``）：``{ source, text }`` 的列表，顺序按 ``sources``，文字去掉两头的空白，空的
    不要。某个来源出错或超过 ``timeout_ms`` 只影响它自己，记一条告警。``only`` 只收这些名字的来源（``FactsSpec.sources``），
    里面有没注册的名字也记一条告警。"""
    chosen = list(sources)
    if only is not None:
        wanted = dict.fromkeys(only)
        chosen = [source for source in chosen if source.name in wanted]
        registered = {source.name for source in sources}
        for name in wanted:
            if name not in registered:
                _log.warning('context source "%s" is not registered', name)
    context: dict[str, Any] = {'session': session}
    if signal is not None:
        context['signal'] = signal

    async def one(source: ContextSource) -> dict[str, str] | None:
        try:
            text = source.collect(context)
            if inspect.isawaitable(text):
                text = await _within(text, timeout_ms, source.name)
        except Exception as error:  # noqa: BLE001 - 一个来源坏了只影响它自己
            _log.warning('context source "%s" failed: %s', source.name, error)
            return None
        trimmed = text.strip() if isinstance(text, str) else ''
        return {'source': source.name, 'text': trimmed} if trimmed else None

    return [fact for fact in await asyncio.gather(*(one(source) for source in chosen)) if fact is not None]


def render_facts(facts: Sequence[Mapping[str, Any]], heading: str | None = None) -> str:
    """事实写成一段文字（协议包的 ``renderFacts``）：一条一行，给了 ``heading`` 就放在第一行。"""
    lines = [str(fact.get('text', '')) for fact in facts]
    return '\n'.join([heading, *lines] if heading else lines)


# ---- 投影 ----

#: 事件规则渲染出的东西：一条消息、几条，或 ``None``（丢掉）。
Rendered = Message | Sequence[Message] | None


@dataclass(frozen=True)
class EventRule:
    """一种事件怎么进入模型上下文（协议包的 ``EventRule``）：``render(events)`` 把一条事件（``fold`` 时是连在一起的同类
    事件合成的一组）渲染成消息，返回 ``None`` 就丢掉。没有规则的事件不进上下文，也不打断前后同类事件的合并。"""

    render: Callable[[list[Mapping[str, Any]]], Rendered]
    fold: bool = False


@dataclass(frozen=True)
class ProjectionOptions:
    """一套投影配置（协议包的 ``ProjectionOptions``）：

    - ``events``：事件规则，按 ``kind``。
    - ``summary``：摘要条目渲染成哪条消息，缺省一条用户消息（``default_summary_message``）。
    - ``message``：改写或过滤消息条目，返回 ``None`` 就丢掉。
    - ``window``：缺省的窗口（``WindowOptions``）；``AgentSpec.window`` 给了就整个换掉它。
    - ``estimate``：一条消息的 token 怎么估（接了分词器时），缺省 ``estimate_tokens``。给了就不按上一轮的用量校准。
    """

    events: Mapping[str, EventRule] = field(default_factory=dict)
    summary: Callable[[Mapping[str, Any]], Message] | None = None
    message: Callable[[Mapping[str, Any]], Message | None] | None = None
    window: Mapping[str, Any] | None = None
    estimate: Callable[[Mapping[str, Any]], int] | None = None

    def project(self, entries: Sequence[Mapping[str, Any]], window: Mapping[str, Any] | None = None) -> Projection:
        """按这套规则投影；窗口用 ``window``，不是 ``self.window``：用哪个窗口由调用方定。"""
        return project(
            entries, window, events=self.events, summary=self.summary, message=self.message, estimate=self.estimate
        )


@dataclass(eq=False)
class ProjectedMessage:
    """投影里的一条消息：来自的条目里最小和最大的 ``seq``、最晚的 ``at``，摘要固定在最前（``pinned``），估算的 token。"""

    message: Message
    first: int
    last: int
    at: int
    pinned: bool
    tokens: int


@dataclass
class Projection:
    """协议包的 ``Projection``：交给模型的消息、各项、估算的 token、被窗口丢掉和截短的条数、生效的摘要。"""

    messages: list[Message]
    items: list[ProjectedMessage]
    tokens: int
    dropped: int
    truncated: int
    summary: Mapping[str, Any] | None = None


Estimate = Callable[[Mapping[str, Any]], int]


def default_summary_message(entry: Mapping[str, Any]) -> Message:
    """摘要缺省渲染成的消息（协议包的 ``defaultSummaryMessage``）：一条用户消息。"""
    return {'role': 'user', 'content': f'{SUMMARY_PREFIX}{entry.get("text", "")}'}


def latest_summary(entries: Sequence[Mapping[str, Any]]) -> Mapping[str, Any] | None:
    """生效的摘要：``covers`` 最大的那一条，``covers`` 相同时 ``seq`` 大的（后写的）。"""
    found: Mapping[str, Any] | None = None
    for entry in entries:
        if entry.get('type') != 'summary':
            continue
        if (
            found is None
            or entry['covers'] > found['covers']
            or (entry['covers'] == found['covers'] and entry['seq'] > found['seq'])
        ):
            found = entry
    return found


def _item(
    message: Message, first: int, last: int, at: int, estimate: Estimate, pinned: bool = False
) -> ProjectedMessage:
    return ProjectedMessage(message, first, last, at, pinned, estimate(message))


def _blocks(items: Sequence[ProjectedMessage]) -> list[list[ProjectedMessage]]:
    """带工具调用的助手消息和紧跟的工具结果是一组，裁剪时一起留或一起丢。"""
    out: list[list[ProjectedMessage]] = []
    for item in items:
        if item.message.get('role') == 'tool' and out:
            out[-1].append(item)
        else:
            out.append([item])
    return out


def _paired(group: list[ProjectedMessage], estimate: Estimate) -> list[ProjectedMessage]:
    """一组里的工具调用和结果按 ``id`` 配对：结果找不到同组的调用就去掉，调用找不到结果就补一条错误结果。
    服务商自己执行的调用（``providerExecuted``）不补。"""
    first, *results = group
    calls: dict[str, Any] = {}
    answered: set[str] = set()
    content = first.message.get('content')
    if first.message.get('role') == 'assistant' and isinstance(content, list):
        for part in content:
            if part.get('type') == 'tool-call' and part.get('providerExecuted') is not True:
                calls[str(part.get('id'))] = part.get('name')
            if part.get('type') == 'tool-result':
                answered.add(str(part.get('id')))
    out = [first]
    for item in results:
        parts = item.message.get('content')
        if item.message.get('role') != 'tool' or isinstance(parts, str):
            out.append(item)
            continue
        kept = [part for part in parts or [] if part.get('type') != 'tool-result' or str(part.get('id')) in calls]
        answered.update(str(part.get('id')) for part in kept if part.get('type') == 'tool-result')
        if len(kept) == len(parts or []):
            out.append(item)
        elif kept:
            trimmed = {**item.message, 'content': kept}
            out.append(replace(item, message=trimmed, tokens=estimate(trimmed)))
    missing = [(call_id, name) for call_id, name in calls.items() if call_id not in answered]
    if missing:
        message = {
            'role': 'tool',
            'content': [
                {'type': 'tool-result', 'id': call_id, 'name': name, 'output': error_output(MISSING_RESULT)}
                for call_id, name in missing
            ],
        }
        out.append(_item(message, first.first, first.last, first.at, estimate))
    return out


def _starts_with_user(group: Sequence[ProjectedMessage]) -> bool:
    return bool(group) and group[0].message.get('role') == 'user'


def _shortened(
    item: ProjectedMessage, max_tokens: float, cut: set[ProjectedMessage], estimate: Estimate
) -> ProjectedMessage:
    """把 ``item`` 截到 ``max_tokens`` 以内；截不动（或没变小）就原样返回。截过的记进 ``cut``。"""
    message = truncate_message(item.message, max_tokens, estimate)
    tokens = estimate(message)
    if message is item.message or tokens >= item.tokens:
        return item
    shorter = replace(item, message=message, tokens=tokens)
    cut.discard(item)
    cut.add(shorter)
    return shorter


def _capped(
    groups: list[list[ProjectedMessage]], budget: float, cut: set[ProjectedMessage], estimate: Estimate
) -> None:
    """单条消息封顶：超过历史预算一半的截到一半。从最新的一组往回做，累计超过预算就停。就地改 ``groups``。"""
    cap = max(_MIN_TRUNCATED_TOKENS, math.floor(budget / 2))
    total = 0
    index = len(groups) - 1
    while index >= 0 and total <= budget:
        group = groups[index]
        for at, item in enumerate(group):
            if item.tokens > cap:
                group[at] = _shortened(item, cap, cut, estimate)
            total += group[at].tokens
        index -= 1


def _fitted(kept: list[ProjectedMessage], excess: float, cut: set[ProjectedMessage], estimate: Estimate) -> None:
    """裁到不能再裁还超 ``excess`` 个 token：从最大的消息截起，摘要最后才动。就地改 ``kept``。"""
    order = sorted(range(len(kept)), key=lambda at: (kept[at].pinned, -kept[at].tokens))
    left = excess
    for at in order:
        if left <= 0:
            break
        item = kept[at]
        if item.tokens <= _MIN_TRUNCATED_TOKENS:
            continue
        shorter = _shortened(item, max(_MIN_TRUNCATED_TOKENS, item.tokens - left), cut, estimate)
        left -= item.tokens - shorter.tokens
        kept[at] = shorter


def _windowed(
    pinned: list[ProjectedMessage],
    rest: list[ProjectedMessage],
    window: Mapping[str, Any] | None,
    estimate: Estimate,
) -> tuple[list[ProjectedMessage], int, int]:
    max_messages = None if window is None else window.get('maxMessages')
    max_tokens = None if window is None else window.get('maxTokens')
    dropped = 0
    groups: list[list[ProjectedMessage]] = []
    for group in _blocks(rest):
        # 开头是工具结果的组：它的调用不在视图里（被摘要盖住了），整组不要。
        if group[0].message.get('role') == 'tool':
            dropped += len(group)
            continue
        groups.append(_paired(group, estimate))
    if max_messages is None and max_tokens is None:
        return [*pinned, *(item for group in groups for item in group)], dropped, 0

    pinned_tokens = sum(item.tokens for item in pinned)
    cut: set[ProjectedMessage] = set()
    truncating = window is not None and window.get('truncate') is True and max_tokens is not None
    if truncating:
        _capped(groups, max_tokens - pinned_tokens, cut, estimate)
    count = sum(len(group) for group in groups)
    tokens = pinned_tokens + sum(item.tokens for group in groups for item in group)

    def over() -> bool:
        return (max_messages is not None and count > max_messages) or (max_tokens is not None and tokens > max_tokens)

    start = 0

    def drop() -> None:
        nonlocal start, count, tokens, dropped
        group = groups[start]
        start += 1
        count -= len(group)
        tokens -= sum(item.tokens for item in group)
        dropped += len(group)

    before = dropped
    # 至少留下最后一组，宁可超预算也不交一份空上下文。
    while len(groups) - start > 1 and over():
        drop()
    # 裁过之后开头落在助手消息上、前面又没有摘要垫着：接着裁到下一条用户消息（后面一条都没有时不动）。
    if dropped > before and not pinned and any(_starts_with_user(group) for group in groups[start:]):
        while not _starts_with_user(groups[start]):
            drop()
    kept = [*pinned, *(item for group in groups[start:] for item in group)]
    if truncating and tokens > max_tokens:
        _fitted(kept, tokens - max_tokens, cut, estimate)
    return kept, dropped, sum(1 for item in kept if item in cut)


def without_approvals(message: Mapping[str, Any]) -> dict[str, Any] | None:
    """工具确认的两个部件（``tool-approval-request``、``tool-approval-response``）只给应用看，投影时去掉（协议包的
    ``withoutApprovals``）：确认了的调用由 harness 执行、写下结果。去掉之后空了的消息不要。"""
    content = message.get('content')
    if not isinstance(content, list) or message.get('role') not in ('assistant', 'tool'):
        return dict(message)
    kept = [part for part in content if part.get('type') not in ('tool-approval-request', 'tool-approval-response')]
    if len(kept) == len(content):
        return dict(message)
    return {**message, 'content': kept} if kept else None


def _as_list(rendered: Rendered) -> list[Message]:
    if not rendered:
        return []
    return [rendered] if isinstance(rendered, Mapping) else list(rendered)


def project(
    entries: Sequence[Mapping[str, Any]],
    window: Mapping[str, Any] | None = None,
    *,
    events: Mapping[str, EventRule] | None = None,
    summary: Callable[[Mapping[str, Any]], Message] | None = None,
    message: Callable[[Mapping[str, Any]], Message | None] | None = None,
    estimate: Estimate | None = None,
) -> Projection:
    """日志 → 这一次交给模型的消息（协议包的 ``project``）。``window`` 是 ``WindowOptions``（``maxMessages``、``maxTokens``、
    ``truncate``），不给或 ``{}`` 不裁剪。``events``、``summary``、``message``、``estimate`` 同 ``ProjectionOptions``；都不给
    就是缺省规则：事件不进上下文，摘要渲染成一条用户消息。"""
    measure = estimate or estimate_tokens
    ordered = sorted(entries, key=lambda entry: (entry.get('at', 0), entry.get('seq', 0)))
    found = latest_summary(ordered)
    pinned: list[ProjectedMessage] = []
    if found is not None:
        rendered = (summary or default_summary_message)(found)
        pinned.append(_item(rendered, found['covers'], found['covers'], found.get('at', 0), measure, pinned=True))
    rules = events or {}
    # 没有规则的事件对模型不可见，也不打断前后同类事件的合并。
    shown = [
        entry
        for entry in ordered
        if (found is None or entry['seq'] > found['covers'])
        and (entry.get('type') == 'message' or (entry.get('type') == 'event' and entry.get('kind') in rules))
    ]
    rest: list[ProjectedMessage] = []
    index = 0
    while index < len(shown):
        entry = shown[index]
        index += 1
        if entry.get('type') == 'message':
            rewritten = entry['message'] if message is None else message(entry)
            visible = without_approvals(rewritten) if rewritten else None
            if visible is not None:
                rest.append(_item(visible, entry['seq'], entry['seq'], entry.get('at', 0), measure))
            continue
        rule = rules[entry['kind']]
        group = [entry]
        if rule.fold:
            while index < len(shown) and shown[index].get('type') == 'event' and shown[index]['kind'] == entry['kind']:
                group.append(shown[index])
                index += 1
        first = min(member['seq'] for member in group)
        last = max(member['seq'] for member in group)
        # 一组按 `at` 排好了，最后一条的 `at` 最晚。
        at = group[-1].get('at', 0)
        rest.extend(_item(one, first, last, at, measure) for one in _as_list(rule.render(group)))
    kept, dropped, truncated = _windowed(pinned, rest, window, measure)
    return Projection(
        messages=[item.message for item in kept],
        items=kept,
        tokens=sum(item.tokens for item in kept),
        dropped=dropped,
        truncated=truncated,
        summary=found,
    )


# ---- 预算 ----

#: 校准最多收紧这么多倍（参考实现 builder 的 ``MAX_CALIBRATION``）。
MAX_CALIBRATION = 4
#: 找校准样本时最多往回看多少条消息：上一轮的第一步要在这里面。
_CALIBRATION_LOOKBACK = 64


def _number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def step_meta_of(entry: Mapping[str, Any]) -> Mapping[str, Any] | None:
    """条目的 ``meta.step``（协议包的 ``stepMetaOf``）：要有字符串的 ``runId`` 和数字的 ``step``。"""
    step = (entry.get('meta') or {}).get('step')
    if not isinstance(step, dict) or not isinstance(step.get('runId'), str) or not _number(step.get('step')):
        return None
    return step


def calibration_of(entries: Sequence[Mapping[str, Any]]) -> float:
    """上一轮第一步实际计的输入 token 比估算多的倍数，在 1 和 ``MAX_CALIBRATION`` 之间，找不到样本是 1（同参考实现的
    builder）。样本里记着当时已经乘上的倍数，换算回没校准的估算再比，下一轮不会来回摆。``entries`` 按 ``seq`` 排好。"""
    recent = [entry for entry in entries if entry.get('type') == 'message'][-_CALIBRATION_LOOKBACK:]
    for entry in reversed(recent):
        meta = step_meta_of(entry)
        if meta is None or meta.get('step') != 0:
            continue
        estimated = meta.get('estimatedInputTokens')
        actual = (meta.get('usage') or {}).get('inputTokens')
        if not (_number(estimated) and _number(actual) and estimated > 0 and actual > 0):
            return 1
        applied = meta.get('calibration')
        factor = actual / estimated * (applied if _number(applied) and applied >= 1 else 1)
        if not math.isfinite(factor):
            return 1
        # 和 `Math.round` 一样四舍五入（Python 的 `round` 是银行家舍入）。
        return math.floor(min(MAX_CALIBRATION, max(1, factor)) * 1000 + 0.5) / 1000
    return 1


def window_of(limits: Mapping[str, Any] | None, reserve: int = 0, calibration: float = 1) -> dict[str, Any]:
    """这一次投影用的窗口：``maxTokens`` 先按校准收紧，再扣掉历史之外已经占掉的 ``reserve``（同参考实现的 ``windowOf``）。"""
    limits = limits or {}
    out: dict[str, Any] = {}
    if limits.get('maxMessages') is not None:
        out['maxMessages'] = limits['maxMessages']
    if limits.get('maxTokens') is not None:
        out['maxTokens'] = max(0, math.floor(limits['maxTokens'] / calibration) - reserve)
    if limits.get('truncate') is not None:
        out['truncate'] = limits['truncate']
    return out
