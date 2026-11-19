"""压缩：把较早的历史写成摘要追加进日志，参考实现 builder 的 ``compactDetailed`` 的移植（切点、记录的写法、分段滚动摘要、
检查点），测试对同一组输入和它比结果。

切点：摘要之外、``at`` 不在未来的消息里，最近 ``keep`` 条（缺省 12）原样留着，工具结果不和它的调用分到两边；切点之前不到
``minimum`` 条（缺省 8）就不压。``covers`` 是留下的消息里最小的 ``seq`` 减 1，``seq`` 在它之内的都进摘要。

进摘要的消息写成纯文本的记录：``角色: 文字``，工具调用是 ``角色 called 名字(输入的 JSON)``，工具结果是 ``名字 returned 输出``，
工具的输入、输出各最多 ``COMPACT_TOOL_TOKENS`` 估算 token（留头尾），图片、文件只写占位。消息按缺省投影的规则来（事件
规则、消息的改写、摘要的渲染、换掉的估算），同参考实现。记录按 ``maxInputTokens``（缺省 ``DEFAULT_COMPACT_INPUT_TOKENS``）
分段，每段连同到目前为止的摘要交给模型，得到的新摘要带进下一段；能落检查点的地方每段写一条 ``summary`` 和一条
``ctx.compacted``，中途出错、超时或被截断，已经压好的不丢。摘要模型报上下文过长时预算减半再试；摘要被 ``maxOutputTokens``
截断或没有文字，那一段不写，停在那里。
"""

from __future__ import annotations

import logging
import math
import re
from collections.abc import Awaitable, Callable, Mapping, Sequence
from typing import TYPE_CHECKING, Any

from .context import (
    ProjectedMessage,
    ProjectionOptions,
    default_summary_message,
    estimate_text_tokens,
    js_number,
    json_text,
    truncate_text,
)
from .protocol import ENTRY_VERSION, CtxError, event_entry, new_id, now_ms
from .store import SessionStore

if TYPE_CHECKING:
    from .harness import AbortSignal

_log = logging.getLogger(__name__)

#: 摘要模型的缺省指令（参考实现 builder 的 ``DEFAULT_SUMMARY_INSTRUCTIONS``）。
DEFAULT_SUMMARY_INSTRUCTIONS = (
    'You compress conversation history. Summarize the transcript you are given so the conversation can continue '
    'without it. Keep facts, decisions, commitments, open questions, preferences, names and numbers. '
    'Do not invent anything. Use the language of the conversation. Output only the summary.'
)
#: 一次交给摘要模型的输入（指令、已有的摘要、一段记录）缺省最多这么多估算 token。
DEFAULT_COMPACT_INPUT_TOKENS = 24_000
#: 一条工具调用的输入、一条工具结果进记录时最多留这么多估算 token。
COMPACT_TOOL_TOKENS = 1_000
#: 一段里留给记录的地方少于这么多估算 token 就算放不下。
MIN_CHUNK_TOKENS = 200
#: ``keep``、``minimum``、``maxOutputTokens`` 的缺省。
DEFAULT_KEEP = 12
DEFAULT_MINIMUM = 8
DEFAULT_MAX_OUTPUT_TOKENS = 1024
#: 压缩写下的事件的 ``kind``（协议的 ``CTX_EVENTS.compacted``）。
COMPACTED = 'ctx.compacted'

#: 调一次摘要模型：``(指令, 记录, 输出上限, 还剩多少毫秒)`` → ``(文字, finish_reason)``。还剩的时间是 ``None`` 时不限；
#: 模型说输入太长时抛 ``CtxError('context_overflow')``，这一段减半再试。
Summarize = Callable[[str, str, int, float | None], Awaitable[tuple[str, str | None]]]

_IMAGE_TYPE = re.compile(r'image(?:/|\Z)', re.IGNORECASE)


def _placeholder(part: Mapping[str, Any]) -> str:
    """图片、文件只写一个占位，例如 ``[image image/png]``，数据不进记录。"""
    media_type = part.get('mediaType') if isinstance(part.get('mediaType'), str) else ''
    image = str(part.get('type', '')).startswith('image') or _IMAGE_TYPE.match(media_type) is not None
    kind = 'image' if image else 'file'
    return f'[{kind} {media_type}]' if media_type else f'[{kind}]'


def _output_text(output: Mapping[str, Any]) -> str:
    kind = output.get('type')
    if kind == 'text':
        return str(output.get('text', ''))
    if kind == 'json':
        return json_text(output.get('value'))
    if kind == 'error':
        return str(output.get('message', ''))
    return ' '.join(
        str(part.get('text', '')) if part.get('type') == 'text' else _placeholder(part)
        for part in output.get('parts') or []
    )


def _text_of(parts: Sequence[Mapping[str, Any]]) -> str:
    return ''.join(str(part.get('text', '')) for part in parts if part.get('type') == 'text')


TokensOf = Callable[[str], int]


def _transcribe(
    message: Mapping[str, Any], tool_tokens: float = math.inf, tokens_of: TokensOf = estimate_text_tokens
) -> tuple[str, bool]:
    """一条消息在记录里的写法（可能有几行，没有可写的是空串），和工具的输入或输出有没有被截短。超过 ``tool_tokens``（按
    ``tokens_of`` 估）的工具输入、输出截短：留头尾，中间注明省略了多少。"""
    role = message.get('role')
    content = message.get('content')
    if isinstance(content, str):
        return f'{role}: {content}', False
    parts = list(content or [])
    lines: list[str] = []
    cut = False

    def capped(text: str) -> str:
        nonlocal cut
        short = truncate_text(text, tool_tokens, tokens_of)
        if short != text:
            cut = True
        return short

    attachments = [_placeholder(part) for part in parts if part.get('type') == 'file']
    text = ' '.join(piece for piece in (_text_of(parts), *attachments) if piece)
    if text:
        lines.append(f'{role}: {text}')
    for part in parts:
        if part.get('type') == 'tool-call':
            lines.append(f'{role} called {part.get("name")}({capped(json_text(part.get("input")))})')
        if part.get('type') == 'tool-result':
            lines.append(f'{part.get("name")} returned {capped(_output_text(part.get("output") or {}))}')
    return '\n'.join(lines), cut


def _checkpoints(older: Sequence[ProjectedMessage], covers: int) -> Callable[[int], int | None]:
    """分段时哪里能落检查点：前 ``count`` 条进了摘要、后面的还没有时，要求前面的 ``seq`` 全在新的 ``covers`` 之内、后面的全在
    它之外（补写的旧记录让投影顺序和 ``seq`` 顺序不一致时不一定成立），而且后面不以工具结果开头。不成立是 ``None``：
    摘要带在内存里进下一段。"""
    least = [math.inf] * (len(older) + 1)
    most = [0] * (len(older) + 1)
    for index in range(len(older) - 1, -1, -1):
        least[index] = min(older[index].first, least[index + 1])
    for index, item in enumerate(older):
        most[index + 1] = max(item.last, most[index])

    def at(count: int) -> int | None:
        if count >= len(older):
            return covers
        if older[count].message.get('role') == 'tool':
            return None
        boundary = least[count] - 1
        return int(boundary) if most[count] <= boundary else None

    return at


async def compact_session(
    store: SessionStore,
    session: str,
    summarize: Summarize,
    options: Mapping[str, Any] | None = None,
    *,
    signal: AbortSignal | None = None,
    now: Callable[[], float] = now_ms,
    projection: ProjectionOptions | None = None,
) -> dict[str, Any]:
    """把 ``session`` 较早的历史压成摘要追加进日志，返回 ``CompactResult``（``status``、``summary``、``calls``、
    ``compacted``、``remaining``、``shortened``）。``options`` 是 ``CompactOptions`` 能过线的那部分：``keep``、``minimum``、
    ``instructions``、``maxInputTokens``、``maxOutputTokens``、``timeoutMs``。``now`` 认出 ``at`` 还在未来的条目、算
    ``timeoutMs`` 还剩多少，存储换了钟时给同一个。``projection`` 是缺省投影的规则：消息按它渲染（不裁剪），记录的长短按它的
    ``estimate`` 估（当成一条用户消息）。"""
    options = options or {}
    rules = projection or ProjectionOptions()
    # 没有事件规则时事件都不可见，不用读。
    full = rules.project(await store.list(session, types=None if rules.events else ['message', 'summary']))
    rest = [item for item in full.items if not item.pinned]
    # `at` 还在未来的条目（把到期时间当 `at` 的提醒）一直排在最后，不算进「最近 keep 条」：写在切点之前的进摘要，
    # 写在切点之后的照常留着。
    moment = now()
    present = [item for item in rest if item.at <= moment]
    keep = options.get('keep')
    cut = len(present) - max(0, math.floor(DEFAULT_KEEP if keep is None else keep))
    # 不把工具结果和它的调用切到两边。
    while 0 < cut < len(present) and present[cut].message.get('role') == 'tool':
        cut -= 1
    nothing: dict[str, Any] = {'status': 'not_needed', 'calls': 0, 'compacted': 0, 'remaining': 0, 'shortened': 0}
    minimum = options.get('minimum')
    if cut <= 0 or cut < (DEFAULT_MINIMUM if minimum is None else minimum):
        return nothing
    # 切点按日志顺序定：留下的条目里最小的 seq 减 1。补写的旧记录按 `at` 排在前面、seq 在后面，不进这次的摘要。
    kept = {id(item) for item in present[cut:]}
    candidates = [item for item in rest if id(item) not in kept]
    if kept:
        covers = min(item.first for item in present[cut:]) - 1
    else:
        covers = max((item.last for item in rest), default=0)
    # `fold` 合并的事件组可能混进补写的旧记录：组的 seq 范围横跨切点（first ≤ covers < last）时，整组进摘要会让
    # seq > covers 的成员留在视图里重复，整组留下又会让 seq ≤ covers 的成员被盖住。只能把 covers 退到这一组的第一条之前，
    # 让整组都留在视图里。退一次可能让别的组横跨，所以退到不再有为止。
    moved = True
    while moved:
        moved = False
        for item in candidates:
            if item.first <= covers < item.last:
                covers = item.first - 1
                moved = True
    older = [item for item in candidates if item.last <= covers]
    if not older:
        return nothing
    return await _roll(
        store,
        session,
        summarize,
        options,
        full.summary,
        [item.message for item in older],
        _checkpoints(older, covers),
        signal=signal,
        now=now,
        rules=rules,
    )


async def _record(store: SessionStore, session: str, text: str, covers: int) -> dict[str, Any] | None:
    summary_id = new_id()
    written = await store.append(
        session,
        [
            {'type': 'summary', 'text': text, 'covers': covers, 'id': summary_id, 'source': 'model'},
            event_entry(COMPACTED, data={'covers': covers, 'summaryId': summary_id}, source='context'),
        ],
    )
    return written[0] if written and written[0].get('type') == 'summary' else None


async def _roll(
    store: SessionStore,
    session: str,
    summarize: Summarize,
    options: Mapping[str, Any],
    carry: Mapping[str, Any] | None,
    messages: Sequence[Mapping[str, Any]],
    covers_at: Callable[[int], int | None],
    *,
    signal: AbortSignal | None,
    now: Callable[[], float],
    rules: ProjectionOptions,
) -> dict[str, Any]:
    """滚动摘要：把记录按预算分段，每段连同到目前为止的摘要交给模型，能落检查点的地方写下来。"""
    custom = rules.estimate
    tokens_of: TokensOf = (
        (lambda text: custom({'role': 'user', 'content': text})) if custom is not None else estimate_text_tokens
    )
    render = rules.summary or default_summary_message
    # 还没写下的摘要也要渲染成一行带进下一段：借已有摘要的壳，只换文字。
    shell: Mapping[str, Any] = carry or {
        'type': 'summary',
        'id': '',
        'session': session,
        'seq': 0,
        'at': now(),
        'v': ENTRY_VERSION,
        'text': '',
        'covers': 0,
    }
    instructions = options.get('instructions')
    if instructions is None:
        instructions = DEFAULT_SUMMARY_INSTRUCTIONS
    max_output = options.get('maxOutputTokens')
    if max_output is None:
        max_output = DEFAULT_MAX_OUTPUT_TOKENS
    timeout_ms = options.get('timeoutMs')
    deadline = None if timeout_ms is None else now() + timeout_ms
    overhead = tokens_of(instructions)
    max_input = options.get('maxInputTokens')
    budget = max(1, math.floor(DEFAULT_COMPACT_INPUT_TOKENS if max_input is None else max_input))
    # 到目前为止的摘要：已有的那条，或者这次刚得到、还没写下的。
    carried = carry
    written: dict[str, Any] | None = None
    done = saved = calls = shortened = 0

    def result(status: str) -> dict[str, Any]:
        out: dict[str, Any] = {'status': status}
        if written is not None:
            out['summary'] = written
        out.update(calls=calls, compacted=saved, remaining=len(messages) - saved, shortened=shortened)
        return out

    while done < len(messages):
        before = '' if carried is None else _transcribe(render(carried), math.inf, tokens_of)[0]
        # 每行另算 1：行与行之间的换行，和各行分别取整的零头。
        room = budget - overhead - (tokens_of(before) + 1 if before else 0)
        if room < MIN_CHUNK_TOKENS:
            return result('input_too_long')
        tool_tokens = min(COMPACT_TOOL_TOKENS, room // 4)
        lines: list[str] = []
        used = cuts = 0
        index = done
        while index < len(messages):
            text, cut = _transcribe(messages[index], tool_tokens, tokens_of)
            if not text:
                index += 1
                continue
            cost = tokens_of(text) + 1
            if used + cost > room:
                if lines:
                    break
                # 单条就超过一段的预算：截短它，不然永远过不去。
                text = truncate_text(text, room - 1, tokens_of)
                cost = tokens_of(text) + 1
                cut = True
            lines.append(text)
            used += cost
            if cut:
                cuts += 1
            index += 1
        # 这一段的消息都没有可写的内容（空消息）：不用调模型。
        if not lines:
            break
        remaining = None if deadline is None else deadline - now()
        if remaining is not None and remaining <= 0:
            raise CtxError('timeout', f'compact() timed out after {js_number(timeout_ms)}ms.', retryable=True)
        calls += 1
        try:
            text, finish = await summarize(
                instructions, '\n'.join([before, *lines] if before else lines), max_output, remaining
            )
        except CtxError as error:
            # 摘要模型自己说放不下（上限配得比它的窗口大，或者估算偏小）：这一段减半再试。
            if error.type != 'context_overflow' or (signal is not None and signal.aborted):
                raise
            budget //= 2
            _log.warning('summary model rejected the input as too long; retrying with maxInputTokens %d', budget)
            continue
        # 被 maxOutputTokens 截断的摘要会丢事实，宁可这一段不压。
        if finish == 'length':
            _log.warning('summary hit maxOutputTokens (%d); history not compacted', max_output)
            return result('truncated')
        summary = text.strip()
        if not summary:
            return result('empty')
        done = index
        shortened += cuts
        covers = covers_at(done)
        entry = None if covers is None else await _record(store, session, summary, covers)
        if entry is not None:
            written, saved = entry, done
        carried = entry if entry is not None else {**(carried or shell), 'text': summary}
    return result('compacted' if written is not None else 'not_needed')
