"""把 pydantic-ai 的 ``Agent`` 接成 ctx 的 harness：循环是 pydantic-ai 的（``Agent.iter``），日志、工具、历史是 ctx 的。

一轮：``ctx.run.started`` → 记输入 → 从日志投影出历史交给 pydantic-ai → 每一步模型回答收齐就写助手消息（工具执行之前）、
这一步的工具结果到齐就写 → ``ctx.run.ended``。工具调用落在 ctx 的执行环境上（``Executor.execute``），输入按 ``inputSchema``
查、结果按上限截断，和参考实现同一套规则。``ask`` 的和外部执行环境的工具不在这里执行：pydantic-ai 记下调用（``CallDeferred``），
这一步走完就以 ``requires_action`` 结束。pydantic-ai 不存对话：每一轮的历史都从 ctx 的日志来。
"""

from __future__ import annotations

import asyncio
import logging
import math
import time
from collections.abc import AsyncIterator, Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

import jsonschema
import pydantic_ai
from pydantic_ai import (
    Agent,
    CallDeferred,
    CancellationToken,
    DeferredToolRequests,
    RunCancelled,
    RunContext,
    RunTimedOut,
    StructuredDict,
    Tool,
    ToolFailed,
    ToolOutput,
)
from pydantic_ai.direct import model_request
from pydantic_ai.exceptions import (
    ModelAPIError,
    ModelContextWindowExceededError,
    ModelHTTPError,
    UnexpectedModelBehavior,
    UserError,
)
from pydantic_ai.messages import (
    FunctionToolCallEvent,
    FunctionToolResultEvent,
    ModelRequest,
    ModelResponse,
    PartDeltaEvent,
    PartStartEvent,
    RetryFeedbackPart,
    RetryPromptPart,
    TextPart,
    TextPartDelta,
    ThinkingPart,
    ThinkingPartDelta,
    ToolReturnPart,
    UserPromptPart,
)
from pydantic_ai.models import Model, infer_model
from pydantic_ai.settings import ModelSettings
from pydantic_ai.usage import UsageLimits

from .compact import Summarize, compact_session
from .context import (
    calibration_of,
    estimate_text_tokens,
    estimate_tokens,
    json_text,
    project,
    window_of,
)
from .executors import Executor
from .messages import (
    add_usage,
    assistant_message,
    finish_reason_of,
    retry_text,
    text_of,
    to_model_messages,
    tool_return_content,
    usage_of,
    user_content,
)
from .protocol import (
    CTX_ERROR,
    DEFAULT_MAX_TOOL_OUTPUT_CHARS,
    RUN_ENDED,
    RUN_STARTED,
    CtxError,
    Entry,
    Json,
    after_conflict,
    agent_spec_to_json,
    approval_denied_output,
    compact,
    ended_in_failure,
    error_output,
    event_entry,
    head_seq,
    is_context_overflow_text,
    is_event,
    limit_tool_output,
    message_entry,
    new_id,
    pending_tool_calls,
    repeats_failed_input,
    run_parent_problem,
    select_tools,
    tool_permission,
    tool_result_entry,
)
from .store import SessionStore

#: 写进 ``ctx.run.started`` 的 ``harness.name``。
HARNESS_NAME = 'pydantic-ai'
#: 适配器写的事件的 ``kind``：pydantic-ai 让模型改了再答时补给它的那段话（回答没按输出的要求；对工具调用的那种是调用的结果）。
RETRY_EVENT = 'pydantic-ai.retry'
#: 结构化输出时交给 pydantic-ai 的输出工具的名字：日志里它的调用记成它交的 JSON 文字。
OUTPUT_TOOL = 'final_result'
#: 工具调用没等到结果这一轮就结束了：补给它的错误结果（和参考实现的说法一样）。
INTERRUPTED = 'The run ended before this tool call returned; its result is unknown.'

_log = logging.getLogger(__name__)

#: 认重试、找上一轮时最多往回读这么多条。
_SCAN = 64
#: 写入冲突后最多重试几次。
_MAX_CONFLICTS = 20

#: ``AgentSpec.settings`` → pydantic-ai 的 ``ModelSettings``。``timeoutMs`` 是整轮的，交给 ``Agent.iter(timeout=)``。
_SETTINGS = {
    'temperature': 'temperature',
    'maxOutputTokens': 'max_tokens',
    'topP': 'top_p',
    'topK': 'top_k',
    'presencePenalty': 'presence_penalty',
    'frequencyPenalty': 'frequency_penalty',
    'seed': 'seed',
    'stopSequences': 'stop_sequences',
    'maxRetries': 'max_retries',
    'headers': 'extra_headers',
}

ModelResolver = Callable[[str], 'Model | str'] | Mapping[str, 'Model | str']


class AbortSignal:
    """取消一轮（对应协议的 ``RunRequest.signal``）：``abort()`` 之后 ``aborted`` 为真，挂着的回调各调一次。"""

    def __init__(self) -> None:
        self._aborted = False
        self._listeners: list[Callable[[], None]] = []

    @property
    def aborted(self) -> bool:
        return self._aborted

    def abort(self) -> None:
        if self._aborted:
            return
        self._aborted = True
        listeners, self._listeners = self._listeners, []
        for listener in listeners:
            listener()

    def add_listener(self, listener: Callable[[], None]) -> Callable[[], None]:
        """挂一个回调，返回摘掉它的函数。已经取消了就马上调。"""
        if self._aborted:
            listener()
            return lambda: None
        self._listeners.append(listener)

        def remove() -> None:
            if listener in self._listeners:
                self._listeners.remove(listener)

        return remove


@dataclass
class _Prepared:
    """这一轮交给模型的历史（ctx 消息）、整次调用的估算 token（校准过的话乘上了倍数）、校准的倍数。"""

    messages: list[dict[str, Any]]
    tokens: int
    calibration: float


class _WriteFailed(Exception):
    """写日志失败：不当成模型的错误，原样抛给调用方。"""

    def __init__(self, cause: BaseException) -> None:
        super().__init__(str(cause))
        self.cause = cause


@dataclass
class _Run:
    request: Mapping[str, Any]
    run_id: str
    record: bool
    emit: Callable[[dict[str, Any]], None]
    signal: AbortSignal | None
    recorded: list[Entry] = field(default_factory=list)
    messages: list[dict[str, Any]] = field(default_factory=list)
    head: int | None = None
    #: 这一轮的 ``ctx.run.started`` 的 ``seq``：围栏认它。
    started: int | None = None
    fenced: bool = False
    #: 写下了调用、还没有结果的工具调用：``id`` → 名字。
    open: dict[str, str] = field(default_factory=dict)
    #: 工具函数交出的 ctx 结果（截断过的）：``id`` → ``ToolOutput``。
    outputs: dict[str, dict[str, Any]] = field(default_factory=dict)
    #: 工具结果条目的 ``source``：执行它的执行环境。
    sources: dict[str, str] = field(default_factory=dict)
    #: 交给别处执行的调用（``ask`` 的、外部执行环境的）的 ``id``：pydantic-ai 记下它们，不执行。
    deferred: set[str] = field(default_factory=set)
    #: 步骤走完时还等着别处执行的调用（``ToolCall``）：这一轮以 ``requires_action`` 结束时就是 ``pending``。
    pending: list[dict[str, Any]] = field(default_factory=list)
    #: 这一轮发出的确认请求（``ask`` 的调用）：调用的 ``id`` → ``ToolApproval``。
    approvals: dict[str, dict[str, Any]] = field(default_factory=dict)
    #: 上一轮以 ``requires_action`` 结束时，它的 ``ctx.run.started`` 的 ``seq``：这一轮开头先处理它留下的确认。
    waiting: int | None = None


async def _waited(previous: asyncio.Future[None], signal: AbortSignal | None) -> bool:
    """排队：等前一个结束。等的时候 ``signal`` 取消了返回 ``False``。"""
    if signal is None:
        await asyncio.shield(previous)
        return True
    aborted: asyncio.Future[None] = asyncio.get_running_loop().create_future()
    remove = signal.add_listener(lambda: aborted.done() or aborted.set_result(None))
    try:
        await asyncio.wait([previous, aborted], return_when=asyncio.FIRST_COMPLETED)
    finally:
        remove()
    return not signal.aborted


def _skipped(request: Mapping[str, Any], emit: Callable[[dict[str, Any]], None]) -> dict[str, Any]:
    """排队时取消的一轮：以 ``aborted`` 结束，什么都没写。流里照样先 ``run.started`` 后 ``run.ended``。"""
    run_id = str(request.get('runId') or new_id())
    emit({'type': 'run.started', 'runId': run_id, 'session': request.get('session')})
    emit({'type': 'run.ended', 'runId': run_id, 'result': {'runId': run_id, 'text': '', 'stopReason': 'aborted'}})
    return {'runId': run_id, 'text': '', 'messages': [], 'recorded': [], 'stopReason': 'aborted'}


def _empty(content: Json) -> bool:
    return content is None or (isinstance(content, (str, list)) and len(content) == 0)


def _number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _window_problem(window: Any) -> str | None:
    if not isinstance(window, dict):
        return 'AgentSpec.window must be an object.'
    for key in ('maxMessages', 'maxTokens'):
        if window.get(key) is not None and not _number(window[key]):
            return f'AgentSpec.window.{key} must be a number.'
    if window.get('truncate') is not None and not isinstance(window['truncate'], bool):
        return 'AgentSpec.window.truncate must be a boolean.'
    return None


def _compact_problem(options: Any) -> str | None:
    """``AgentSpec.context.overflow.compact``：``OverflowCompactSpec`` 的几项，类型不对就当请求不对。"""
    if not isinstance(options, dict):
        return 'AgentSpec.context.overflow.compact must be an object.'
    for key in ('keep', 'minimum', 'maxInputTokens', 'maxOutputTokens', 'timeoutMs'):
        if options.get(key) is not None and not _number(options[key]):
            return f'AgentSpec.context.overflow.compact.{key} must be a number.'
    if options.get('instructions') is not None and not isinstance(options['instructions'], str):
        return 'AgentSpec.context.overflow.compact.instructions must be a string.'
    return None


def _context_problem(context: Any) -> str | None:
    # 说法同参考实现（`fit`、`checkLineage`）：配置可能是线上来的 JSON，不对就当请求不对，不猜。
    if not isinstance(context, dict):
        return 'AgentSpec.context must be an object.'
    facts = context.get('facts')
    if facts is not None and not isinstance(facts, (bool, dict)):
        return 'AgentSpec.context.facts must be a boolean or an object.'
    if context.get('projection') is not None and not isinstance(context['projection'], str):
        return 'AgentSpec.context.projection must be a string.'
    overflow = context.get('overflow')
    if overflow is not None:
        limit = overflow.get('maxTokens') if isinstance(overflow, dict) else None
        if not (_number(limit) and math.isfinite(limit) and limit > 0):
            return 'AgentSpec.context.overflow.maxTokens must be a positive number.'
        if overflow.get('strategy') is not None and overflow['strategy'] not in ('compact', 'trim', 'error'):
            return 'AgentSpec.context.overflow.strategy must be "compact", "trim" or "error".'
        if overflow.get('compact') is not None:
            problem = _compact_problem(overflow['compact'])
            if problem is not None:
                return problem
    inherit = context.get('inherit')
    if inherit is not None:
        session = inherit.get('session') if isinstance(inherit, dict) else None
        if not isinstance(session, str) or session == '':
            return 'AgentSpec.context.inherit.session must be a non-empty string.'
        upto = inherit.get('upTo')
        if upto is not None and not (isinstance(upto, int) and not isinstance(upto, bool) and upto >= 0):
            return 'AgentSpec.context.inherit.upTo must be a non-negative integer (a seq).'
    return None


def _permissions_problem(spec: Mapping[str, Any]) -> str | None:
    permissions = spec.get('permissions') or {}
    values = [permissions.get('default'), *(permissions.get('tools') or {}).values()]
    if any(value is not None and value not in ('allow', 'ask', 'deny') for value in values):
        return 'AgentSpec.permissions values must be "allow", "ask" or "deny".'
    return None


def spec_problem(spec: Mapping[str, Any]) -> str | None:
    """映射不了的 ``AgentSpec`` 字段：有就以 ``invalid_request`` 结束，不静默忽略。"""
    model = spec.get('model')
    if not isinstance(model, str) or model == '':
        return 'AgentSpec.model must be a model name: the pydantic-ai adapter resolves models by name.'
    if spec.get('window') is not None:
        problem = _window_problem(spec['window'])
        if problem is not None:
            return problem
    if spec.get('context') is not None:
        problem = _context_problem(spec['context'])
        if problem is not None:
            return problem
    choice = spec.get('toolChoice')
    if choice is not None and choice not in ('auto', 'none', 'required'):
        if not (isinstance(choice, dict) and isinstance(choice.get('tool'), str)):
            return 'AgentSpec.toolChoice must be "auto", "none", "required" or { tool }.'
    settings = spec.get('settings') or {}
    if not isinstance(settings, dict):
        return 'AgentSpec.settings must be an object.'
    unsupported = [key for key in settings if key not in _SETTINGS and key != 'timeoutMs']
    if unsupported:
        return f'AgentSpec.settings.{", ".join(unsupported)} not supported by the pydantic-ai adapter.'
    timeout = settings.get('timeoutMs')
    if timeout is not None and not (isinstance(timeout, (int, float)) and timeout > 0):
        return 'AgentSpec.settings.timeoutMs must be a positive number.'
    problem = _permissions_problem(spec)
    if problem is not None:
        return problem
    for key, value in (spec.get('budget') or {}).items():
        if not isinstance(value, (int, float)) or isinstance(value, bool) or not value > 0:
            return f'AgentSpec.budget.{key} must be a positive number.'
    steps = spec.get('maxSteps')
    if steps is not None and not (isinstance(steps, int) and not isinstance(steps, bool) and steps > 0):
        return 'AgentSpec.maxSteps must be a positive integer.'
    output = spec.get('output')
    if output is not None and not (isinstance(output, dict) and isinstance(output.get('schema'), dict)):
        return 'AgentSpec.output.schema must be a JSON Schema object.'
    return None


def model_settings_of(spec: Mapping[str, Any]) -> dict[str, Any]:
    settings = {_SETTINGS[key]: value for key, value in (spec.get('settings') or {}).items() if key in _SETTINGS}
    choice = spec.get('toolChoice')
    if choice in ('none', 'required'):
        settings['tool_choice'] = choice
    elif isinstance(choice, dict):
        settings['tool_choice'] = [choice['tool']]
    return settings


def schema_problem(validator: Any, value: Json) -> str | None:
    """按编译好的 JSON Schema 查一个值，不合时说明哪里不对。"""
    if validator is None:
        return None
    error = jsonschema.exceptions.best_match(validator.iter_errors(value))
    if error is None:
        return None
    where = '/'.join(str(part) for part in error.absolute_path)
    return f'{"/" + where if where else "(root)"}: {error.message}'


def compile_schema(schema: Mapping[str, Any]) -> Any:
    """编译一个 JSON Schema；它自己不合法就不查（交给执行环境）。"""
    try:
        cls = jsonschema.validators.validator_for(schema)
        cls.check_schema(schema)
        return cls(schema)
    except jsonschema.exceptions.SchemaError:
        return None


def error_info_of(error: BaseException) -> dict[str, Any]:
    """模型调用的异常 → ``ErrorInfo``：上下文过长是 ``context_overflow``，HTTP 错误是 ``api_call``（带 ``statusCode``）。"""
    message = str(error) or type(error).__name__
    if isinstance(error, ModelContextWindowExceededError):
        return {'message': message, 'type': 'context_overflow', 'retryable': False}
    if isinstance(error, ModelHTTPError):
        status = error.status_code
        body = '' if error.body is None else str(error.body)
        if is_context_overflow_text(f'{message}\n{body}', status):
            return {'message': message, 'type': 'context_overflow', 'retryable': False, 'statusCode': status}
        return compact(
            {
                'message': message,
                'type': 'api_call',
                'retryable': status in (408, 409, 429) or status >= 500,
                'statusCode': status,
                'responseBody': body[:2000] or None,
            }
        )
    if isinstance(error, ModelAPIError):
        if is_context_overflow_text(message):
            return {'message': message, 'type': 'context_overflow', 'retryable': False}
        return {'message': message, 'type': 'api_call'}
    if isinstance(error, UserError):
        return {'message': message, 'type': 'invalid_request'}
    if isinstance(error, CtxError):
        return error.info()
    return {'message': message, 'type': 'pydantic_ai'}


async def _until_aborted(request: Awaitable[ModelResponse], signal: AbortSignal | None) -> ModelResponse:
    """等一次模型调用；``signal`` 取消了就取消它，抛 ``CtxError('aborted')``。"""
    if signal is None:
        return await request
    task = asyncio.ensure_future(request)
    remove = signal.add_listener(task.cancel)
    try:
        return await task
    except asyncio.CancelledError:
        current = asyncio.current_task()
        if signal.aborted and (current is None or current.cancelling() == 0):
            raise CtxError('aborted', 'The run was aborted while compacting.') from None
        raise
    finally:
        remove()


def _summarizer(model: Model, signal: AbortSignal | None) -> Summarize:
    """摘要模型的一次调用：``model_request``（不经 ``Agent``，没有工具），温度 0，输出上限是 ``max_tokens``，还剩的时间是
    ``request_timeout``。上下文过长（认法同模型调用的错误）换成 ``CtxError('context_overflow')``。"""

    async def summarize(
        instructions: str, prompt: str, max_output_tokens: int, timeout_ms: float | None
    ) -> tuple[str, str | None]:
        settings: ModelSettings = {'temperature': 0, 'max_tokens': max_output_tokens}
        if timeout_ms is not None:
            settings['request_timeout'] = timeout_ms / 1000
        request = ModelRequest(parts=[UserPromptPart(prompt)], instructions=instructions)
        try:
            response = await _until_aborted(model_request(model, [request], model_settings=settings), signal)
        except CtxError:
            raise
        except Exception as error:
            info = error_info_of(error)
            if info['type'] == 'context_overflow':
                raise CtxError('context_overflow', info['message'], retryable=False) from error
            raise
        text = ''.join(part.content for part in response.parts if isinstance(part, TextPart))
        return text, response.finish_reason

    return summarize


class PydanticAIHarness:
    """协议的 ``Harness``：``run`` 返回 ``RunResult``，``stream`` 给出 ``RunEvent``（都是线上形状的 ``dict``）。

    - ``store``：会话日志（``RemoteSessionStore`` 连 ``ctx-remote``，或任何有 ``append``、``list`` 的存储）。
    - ``executors``：ctx 的执行环境，工具调用由它们执行。
    - ``tools``：工具目录（``ToolDefinition`` 的列表），``AgentSpec.tools`` 从这里挑；不给就是各执行环境 ``tools()`` 报的全部。
    - ``models``：模型名 → pydantic-ai 的模型（函数或映射）；不给就按 pydantic-ai 的写法（``openai:gpt-5`` 这类）推。
    - ``max_tool_output_chars``：一次工具结果最多多少字符。
    - ``source``：输入条目的 ``source``。
    - ``external``：在别处执行的执行环境的名字。绑定到它们的工具交给模型，但不在这里执行：模型调用了它们，这一轮写下调用后
      以 ``requires_action`` 结束（``pending`` 列出这些调用），执行方把结果追加进日志（``tool_result_entry``），下一轮不带输入
      接着跑。``permissions`` 是 ``ask`` 的工具也这样，应用确认了再让执行方执行。它们的工具定义要在 ``tools`` 里。
    - ``summary_model``：超窗兜底压缩时写摘要的模型，名字（按 ``models`` 找）或 pydantic-ai 的模型；不给就用这一轮的模型。
    """

    def __init__(
        self,
        *,
        store: SessionStore,
        executors: Sequence[Executor] | Mapping[str, Executor] = (),
        tools: Sequence[Mapping[str, Any]] | None = None,
        models: ModelResolver | None = None,
        max_tool_output_chars: int = DEFAULT_MAX_TOOL_OUTPUT_CHARS,
        source: str | None = None,
        external: Sequence[str] = (),
        summary_model: Model | str | None = None,
    ) -> None:
        self._store = store
        self._executors: dict[str, Executor] = (
            dict(executors) if isinstance(executors, Mapping) else {executor.name: executor for executor in executors}
        )
        self._tools = [dict(tool) for tool in tools] if tools is not None else None
        self._models = models
        self._max_output = max_tool_output_chars
        self._source = source
        self._external = frozenset(external)
        self._summary_model = summary_model
        self._tails: dict[str, asyncio.Future[None]] = {}

    # ---- 对外 ----

    async def run(self, request: Mapping[str, Any], *, signal: AbortSignal | None = None) -> dict[str, Any]:
        return await self._queued(request, lambda event: None, signal)

    async def stream(
        self, request: Mapping[str, Any], *, signal: AbortSignal | None = None
    ) -> AsyncIterator[dict[str, Any]]:
        """流式的一轮：消费方提前不读了就取消这一轮。"""
        own = AbortSignal()
        remove = signal.add_listener(own.abort) if signal is not None else None
        events: asyncio.Queue[dict[str, Any] | None] = asyncio.Queue()

        async def work() -> None:
            try:
                await self._queued(request, events.put_nowait, own)
            finally:
                events.put_nowait(None)

        task = asyncio.ensure_future(work())
        try:
            while True:
                event = await events.get()
                if event is None:
                    break
                yield event
            await task
        finally:
            if remove is not None:
                remove()
            if not task.done():
                own.abort()
                try:
                    await task
                except Exception:  # noqa: BLE001 - 消费方已经不读了
                    pass

    # ---- 排队 ----

    async def _queued(
        self, request: Mapping[str, Any], emit: Callable[[dict[str, Any]], None], signal: AbortSignal | None
    ) -> dict[str, Any]:
        """同一个实例里同一会话的记录型运行一个接一个（同参考实现），``session_busy`` 只出现在跨进程的时候。排队时
        ``signal`` 取消了，这一轮以 ``aborted`` 结束，什么都不写。
        """
        if request.get('record') is False:
            return await self._unwrapped(request, emit, signal)
        session = str(request.get('session'))
        previous = self._tails.get(session)
        mine: asyncio.Future[None] = asyncio.get_running_loop().create_future()
        self._tails[session] = mine
        try:
            if previous is not None and not await _waited(previous, signal):
                return _skipped(request, emit)
            return await self._unwrapped(request, emit, signal)
        finally:
            # 前一个还没结束（这一个在排队时被取消）就等它结束再放行后面的，队尾也到那时才摘：
            # 早摘了，后来的看不到前一个还在跑，会和它同时开始。
            def release(_: object = None) -> None:
                if not mine.done():
                    mine.set_result(None)
                if self._tails.get(session) is mine:
                    del self._tails[session]

            if previous is None or previous.done():
                release()
            else:
                previous.add_done_callback(release)

    async def _unwrapped(
        self, request: Mapping[str, Any], emit: Callable[[dict[str, Any]], None], signal: AbortSignal | None
    ) -> dict[str, Any]:
        try:
            return await self._execute(request, emit, signal)
        except _WriteFailed as failure:
            raise failure.cause from None

    # ---- 日志 ----

    async def _write(self, state: _Run, entries: Sequence[Mapping[str, Any]]) -> list[Entry]:
        """带着读到的末尾写；中间别人写了就接在新的末尾后面，被围栏（``after_conflict``）就不再写。"""
        if not state.record or not entries or state.fenced:
            return []
        session = str(state.request['session'])
        for conflicts in range(_MAX_CONFLICTS + 1):
            try:
                written = await self._store.append(session, entries, expect_seq=state.head)
            except CtxError as error:
                if error.type != 'conflict' or conflicts >= _MAX_CONFLICTS:
                    raise _WriteFailed(error) from error
                try:
                    head = await after_conflict(
                        self._store, session, state.run_id, started=state.started, recorded=state.recorded
                    )
                except Exception as cause:
                    raise _WriteFailed(cause) from cause
                if head is None:
                    state.fenced = True
                    return []
                state.head = head
                continue
            except Exception as error:
                raise _WriteFailed(error) from error
            state.recorded.extend(written)
            if written:
                state.head = written[-1]['seq']
            return written
        return []

    async def _repeats_failed_input(self, session: str, content: Json, key: str | None) -> bool:
        """这一轮的输入是不是上一轮失败时留下的那句（``repeats_failed_input``，同参考实现）：这个适配器写的事件也跳过。"""
        tail = await self._store.list(session, last=_SCAN)
        return repeats_failed_input(tail, content, key=key, harness=HARNESS_NAME)

    async def _start(self, state: _Run) -> bool | None:
        """查会话忙不忙、认重试，带着读到的末尾写 ``ctx.run.started``，冲突就重来。忙时返回 ``None``，否则返回输入要不要跳过。"""
        request = state.request
        session = str(request['session'])
        content = request.get('input')
        key = request.get('inputKey')
        for conflicts in range(_MAX_CONFLICTS + 1):
            try:
                head = await head_seq(self._store, session)
                lifecycle = await self._store.list(session, kinds=[RUN_STARTED, RUN_ENDED], last=_SCAN)
            except Exception as error:
                raise _WriteFailed(error) from error
            last = lifecycle[-1] if lifecycle else None
            if state.record and is_event(last, RUN_STARTED):
                return None
            if not state.record:
                return False
            # 上一轮停下等结果或确认：记下它从哪开始，这一轮开头先处理应用追加的确认。
            state.waiting = None
            if is_event(last, RUN_ENDED) and (last.get('data') or {}).get('stopReason') == 'requires_action':
                try:
                    starts = await self._store.list(session, kinds=[RUN_STARTED], last=1)
                except Exception as error:
                    raise _WriteFailed(error) from error
                state.waiting = starts[-1]['seq'] if starts else None
            repeated = (
                not _empty(content)
                and ended_in_failure(lifecycle)
                and await self._repeats_failed_input(session, content, key)
            )
            parent = request.get('parent')
            started = event_entry(
                RUN_STARTED,
                data=compact(
                    {
                        'runId': state.run_id,
                        'agent': agent_spec_to_json(request['agent']),
                        'owner': request.get('owner'),
                        'parent': dict(parent) if parent is not None and run_parent_problem(parent) is None else None,
                        'harness': {'name': HARNESS_NAME, 'version': pydantic_ai.__version__},
                    }
                ),
                source='harness',
            )
            try:
                written = await self._store.append(session, [started], expect_seq=head)
            except CtxError as error:
                if error.type != 'conflict' or conflicts >= _MAX_CONFLICTS:
                    raise _WriteFailed(error) from error
                continue
            except Exception as error:
                raise _WriteFailed(error) from error
            state.recorded.extend(written)
            state.started = written[-1]['seq'] if written else None
            state.head = written[-1]['seq'] if written else head
            return repeated and key is None
        return None

    # ---- 一轮 ----

    async def _execute(
        self, request: Mapping[str, Any], emit: Callable[[dict[str, Any]], None], signal: AbortSignal | None
    ) -> dict[str, Any]:
        state = _Run(
            request=request,
            run_id=str(request.get('runId') or new_id()),
            record=request.get('record') is not False,
            emit=emit,
            signal=signal,
        )
        repeated = await self._start(state)
        if repeated is None:
            error = {
                'message': f'Session "{request.get("session")}" already has a run in progress.',
                'type': 'session_busy',
                'retryable': True,
            }
            emit(
                {
                    'type': 'run.ended',
                    'runId': state.run_id,
                    'result': {'runId': state.run_id, 'text': '', 'stopReason': 'error', 'error': error},
                }
            )
            return {
                'runId': state.run_id,
                'text': '',
                'messages': [],
                'recorded': [],
                'stopReason': 'error',
                'error': error,
            }
        emit(compact({'type': 'run.started', 'runId': state.run_id, 'session': request['session'], 'seq': state.head}))
        spec = request['agent']
        problem = await self._resolve_approvals(state)
        if problem is not None:
            return await self._end(state, 'error', error={'message': problem, 'type': 'invalid_request'})
        content = request.get('input')
        in_log = False
        if state.record and not _empty(content):
            if not repeated:
                await self._write(
                    state,
                    [
                        message_entry(
                            {'role': 'user', 'content': content}, source=self._source, key=request.get('inputKey')
                        )
                    ],
                )
            in_log = True

        problem = run_parent_problem(request.get('parent'))
        if problem is not None:
            return await self._end(state, 'error', error={'message': f'{problem}.', 'type': 'invalid_request'})
        problem = spec_problem(spec)
        if problem is not None:
            return await self._end(state, 'error', error={'message': problem, 'type': 'invalid_request'})
        try:
            definitions = select_tools(await self._catalog(), spec.get('tools', True))
            model = self._model(str(spec['model']))
        except CtxError as error:
            return await self._end(state, 'error', error=error.info())
        choice = spec.get('toolChoice')
        if isinstance(choice, dict) and choice['tool'] not in {definition['name'] for definition in definitions}:
            return await self._end(
                state,
                'error',
                error={
                    'message': f'AgentSpec.toolChoice names tool "{choice["tool"]}", which is not offered.',
                    'type': 'invalid_request',
                },
            )
        if signal is not None and signal.aborted:
            return await self._end(state, 'aborted')
        context = spec.get('context') or {}
        projection = context.get('projection')
        if projection is not None and projection != 'default':
            # 只有缺省的投影（同参考实现：不认识的名字以 `not_found` 失败，不回退）。
            error = {'message': f'Unknown projection "{projection}". Registered: default.', 'type': 'not_found'}
            return await self._end(state, 'error', error=error)

        # 输入已经在日志里时它在历史里；不写日志时它和 `prompt` 一样接在最后，都算进历史之外的预算。
        extra = None if in_log else content
        try:
            prepared = await self._prepare(state, spec, definitions, extra, spec.get('window'))
            if context.get('overflow') is not None:
                prepared = await self._fit(state, spec, definitions, extra, context['overflow'], prepared, model)
        except CtxError as error:
            return await self._end(state, 'error', error=error.info())
        # 压缩要调模型，可能等了一阵：这时取消了就不再调这一轮的模型。
        if signal is not None and signal.aborted:
            return await self._end(state, 'aborted')
        history = to_model_messages(prepared.messages)
        prompt = _prompt_of(request.get('prompt')) if in_log else _prompt_of(content, request.get('prompt'))
        if prompt is None and (not history or isinstance(history[-1], ModelResponse)):
            return await self._end(
                state,
                'error',
                error={'message': 'Nothing to answer: give RunRequest.input or prompt.', 'type': 'invalid_request'},
            )
        return await self._converse(state, spec, definitions, model, history, prompt, prepared)

    async def _resolve_approvals(self, state: _Run) -> str | None:
        """上一轮停下等确认（``state.waiting``）：记这一轮的输入之前，先把应用追加的决定落成结果（同参考实现）。确认了的、
        在这里执行的调用照常执行（``deny`` 仍然优先），拒绝的写上 ``approval_denied_output``；确认了、绑到外部执行环境的
        留给执行方，还没决定的不动。每个结果一条 ``tool_result_entry``，一次写下，按调用发 ``tool.returned``。权限的值
        不对时返回问题，不执行。"""
        if state.waiting is None or not state.record:
            return None
        session = str(state.request['session'])
        spec = state.request['agent']
        try:
            entries = await self._store.list(session, after=state.waiting - 1)
        except Exception as error:
            raise _WriteFailed(error) from error
        decided = [item for item in pending_tool_calls(entries) if 'decision' in (item.get('approval') or {})]
        if not decided:
            return None
        problem = _permissions_problem(spec)
        if problem is not None:
            return problem
        catalog = {str(tool['name']): tool for tool in await self._catalog()}
        opened: dict[str, asyncio.Task[None]] = {}

        async def settle(call: dict[str, Any], decision: Mapping[str, Any]) -> dict[str, Any] | None:
            name = str(call['name'])
            if not decision.get('approved'):
                return approval_denied_output(call, decision.get('reason'))
            definition = catalog.get(name)
            if definition is None:
                return error_output(f'Tool "{name}" is not available.')
            if tool_permission(spec.get('permissions'), name) == 'deny':
                return error_output(f'Tool call "{name}" was denied by the agent\'s permissions.')
            if str(definition.get('executor', '')) in self._external:
                return None
            problem = schema_problem(compile_schema(definition.get('inputSchema') or {'type': 'object'}), call['input'])
            if problem is not None:
                return error_output(f'Invalid input for tool "{name}": {problem}')
            executor = self._executors.get(str(definition.get('executor', '')))
            if executor is None:
                return error_output(f'Tool "{name}" has no executor "{definition.get("executor")}" in this harness.')
            output = await self._execute_tool(executor, session, spec, opened, dict(call), state)
            return limit_tool_output(output, self._max_output)

        try:
            outputs = await asyncio.gather(*(settle(item['call'], item['approval']['decision']) for item in decided))
        finally:
            for task in opened.values():
                task.cancel()
        results = [(item['call'], output) for item, output in zip(decided, outputs, strict=True) if output is not None]
        await self._write(state, [tool_result_entry(call, output, source='harness') for call, output in results])
        for call, output in results:
            state.emit({'type': 'tool.returned', 'runId': state.run_id, 'callId': call['id'], 'output': output})
        return None

    async def _prepare(
        self,
        state: _Run,
        spec: Mapping[str, Any],
        definitions: list[dict[str, Any]],
        extra: Json,
        window: Mapping[str, Any] | None,
    ) -> _Prepared:
        """组装这一轮的历史，同参考实现 builder 的 ``build``：窗口的 ``maxTokens`` 是整次调用的预算，指令、工具定义、
        这一轮没进日志的输入和 ``prompt`` 先占掉一部分，剩下的才给历史；按上一轮的真实用量校准（只往小里收）。
        ``context.inherit`` 的会话投影接在前面，用本会话剩下的预算。没有事实来源：不收事实。"""
        request = state.request
        inherit = (spec.get('context') or {}).get('inherit')
        try:
            entries = await self._store.list(str(request['session']), types=['message', 'summary'])
            parent = (
                await self._store.list(str(inherit['session']), types=['message', 'summary'])
                if inherit is not None
                else None
            )
        except Exception as error:
            raise _WriteFailed(error) from error
        reserve = (
            estimate_text_tokens(spec.get('instructions') or '')
            + (estimate_text_tokens(json_text(definitions)) if definitions else 0)
            + _sized(extra)
            + _sized(request.get('prompt'))
        )
        calibration = calibration_of(entries)
        own = project(entries, window_of(window, reserve, calibration))
        messages, tokens = own.messages, own.tokens
        if parent is not None:
            upto = inherit.get('upTo')
            if upto is not None:
                parent = [entry for entry in parent if entry['seq'] <= upto]
            inherited = project(parent, window_of(window, reserve + own.tokens, calibration))
            messages, tokens = [*inherited.messages, *own.messages], inherited.tokens + own.tokens
        total = reserve + tokens
        if calibration > 1:
            total = math.ceil(total * calibration)
        return _Prepared(messages=messages, tokens=total, calibration=calibration)

    async def _fit(
        self,
        state: _Run,
        spec: Mapping[str, Any],
        definitions: list[dict[str, Any]],
        extra: Json,
        overflow: Mapping[str, Any],
        prepared: _Prepared,
        model: Model,
    ) -> _Prepared:
        """超窗兜底（``AgentSpec.context.overflow``），同参考实现的 ``fit``：整次调用的估算超过 ``maxTokens`` 时，``compact``
        （缺省）先压缩，写下了摘要就重新组装；压完还超、压缩没做成，再裁剪（带 ``truncate`` 重新组装）。``trim`` 只裁剪，
        ``error`` 什么都不做。还超就以 ``context_overflow`` 结束、不调模型。不写日志的运行（``record`` 是 false）不压缩：
        压缩要追加摘要，而它一条都不该写。"""
        limit = overflow['maxTokens']
        strategy = overflow.get('strategy') or 'compact'
        if prepared.tokens <= limit:
            return prepared
        if strategy == 'compact' and state.record:
            written = False
            try:
                written = await self._compact(state, overflow.get('compact') or {}, model)
            except Exception as error:  # noqa: BLE001 - 压缩没做成（摘要模型出错、超时）不拦这一轮：接着裁剪
                if state.signal is not None and state.signal.aborted:
                    return prepared
                _log.warning('compaction failed while the context is over its limit; trimming instead: %s', error)
            if written:
                prepared = await self._prepare(state, spec, definitions, extra, spec.get('window'))
        if strategy != 'error' and prepared.tokens > limit:
            window = dict(spec.get('window') or {})
            window['maxTokens'] = min(window['maxTokens'] if window.get('maxTokens') is not None else math.inf, limit)
            window['truncate'] = True
            prepared = await self._prepare(state, spec, definitions, extra, window)
        if prepared.tokens > limit:
            raise CtxError(
                'context_overflow',
                f'The prepared call is estimated at {prepared.tokens} tokens, over the limit of {limit}'
                + ('.' if strategy == 'error' else ' even after compaction and trimming.'),
                retryable=False,
            )
        return prepared

    async def _compact(self, state: _Run, options: Mapping[str, Any], model: Model) -> bool:
        """压缩一次（``compact_session``），返回有没有写下摘要。摘要模型是 ``summary_model``，不给就用这一轮的模型。
        ``keep`` 至少是 1：这一轮刚记下的输入不能进摘要，模型要原样看到它。"""
        chosen = dict(options)
        if chosen.get('keep') is not None:
            chosen['keep'] = max(1, chosen['keep'])
        chosen_model = self._summary_model
        if chosen_model is None:
            chosen_model = model
        elif isinstance(chosen_model, str):
            chosen_model = self._model(chosen_model)
        summarize = _summarizer(chosen_model, state.signal)
        session = str(state.request['session'])
        result = await compact_session(self._store, session, summarize, chosen, signal=state.signal)
        return 'summary' in result

    async def _catalog(self) -> list[dict[str, Any]]:
        if self._tools is not None:
            return [dict(tool) for tool in self._tools]
        seen: set[str] = set()
        out: list[dict[str, Any]] = []
        for executor in self._executors.values():
            for tool in await executor.tools():
                if tool['name'] in seen:
                    continue
                seen.add(tool['name'])
                out.append({**tool, 'executor': tool.get('executor') or executor.name})
        return out

    def _model(self, name: str) -> Model:
        resolved: Model | str
        if self._models is None:
            resolved = name
        elif isinstance(self._models, Mapping):
            if name not in self._models:
                raise CtxError('not_found', f'Model "{name}" is not served by this harness.')
            resolved = self._models[name]
        else:
            resolved = self._models(name)
        if not isinstance(resolved, str):
            return resolved
        try:
            return infer_model(resolved)
        except Exception as error:  # 不认识的服务商、缺凭证
            raise CtxError('invalid_request', f'pydantic-ai cannot make model "{resolved}": {error}') from error

    def _ask(self, state: _Run, spec: Mapping[str, Any], names: set[str], message: dict[str, Any]) -> None:
        """``ask`` 的调用要等人确认：确认请求（``tool-approval-request``）接在这次调用的助手消息里，同参考实现。"""
        content = message.get('content')
        if not isinstance(content, list):
            return
        for part in list(content):
            if part.get('type') != 'tool-call' or part.get('name') not in names:
                continue
            if tool_permission(spec.get('permissions'), str(part['name'])) != 'ask':
                continue
            approval = {'approvalId': new_id(), 'callId': part['id']}
            state.approvals[part['id']] = approval
            content.append({'type': 'tool-approval-request', **approval})

    def _defers(self, spec: Mapping[str, Any], definition: Mapping[str, Any]) -> bool:
        """这个工具交给别处执行：``ask`` 的，或者绑到外部执行环境、没有被 ``deny`` 的（``deny`` 优先，同参考实现）。"""
        permission = tool_permission(spec.get('permissions'), str(definition['name']))
        return permission == 'ask' or (permission != 'deny' and str(definition.get('executor', '')) in self._external)

    def _tool(self, state: _Run, definition: Mapping[str, Any], opened: dict[str, asyncio.Task[None]]) -> Tool[Any]:
        """一个 ctx 工具交给 pydantic-ai：输入先按 ``inputSchema`` 查（``deny`` 的直接拒绝），调用落在它的执行环境上。
        交给别处执行的不查输入、不执行（同参考实现，由执行方处理），只让 pydantic-ai 记下这次调用。"""
        name = str(definition['name'])
        schema = definition.get('inputSchema') or {'type': 'object'}
        validator = compile_schema(schema)
        executor = self._executors.get(str(definition.get('executor', '')))
        source = executor.name if executor is not None else 'harness'
        session = str(state.request['session'])
        spec = state.request['agent']
        denied = tool_permission(spec.get('permissions'), name) == 'deny'
        deferred = self._defers(spec, definition)

        def refuse(call_id: str, message: str) -> None:
            # 执行前拦下的：模型看到的是失败的工具结果（不占 pydantic-ai 的重试次数），日志里是 `{ type: 'error' }`。
            state.outputs[call_id] = error_output(message)
            state.sources[call_id] = source
            raise ToolFailed(message)

        async def validate(run: RunContext[Any], /, **args: Any) -> None:
            call_id = run.tool_call_id or ''
            if denied:
                refuse(call_id, f'Tool call "{name}" was denied by the agent\'s permissions.')
            if deferred:
                return
            problem = schema_problem(validator, args)
            if problem is not None:
                refuse(call_id, f'Invalid input for tool "{name}": {problem}')

        async def call(run: RunContext[Any], /, **args: Any) -> Any:
            call_id = run.tool_call_id or new_id()
            if deferred:
                state.deferred.add(call_id)
                raise CallDeferred()
            state.sources[call_id] = source
            if executor is None:
                output = error_output(f'Tool "{name}" has no executor "{definition.get("executor")}" in this harness.')
            else:
                output = await self._execute_tool(
                    executor, session, spec, opened, {'id': call_id, 'name': name, 'input': args}, state
                )
            output = limit_tool_output(output, self._max_output)
            state.outputs[call_id] = output
            if output.get('type') == 'error':
                raise ToolFailed(str(output.get('message', '')))
            return tool_return_content(output)

        return Tool.from_schema(
            call,
            name=name,
            description=definition.get('description'),
            json_schema=dict(schema),
            takes_ctx=True,
            args_validator=validate,
        )

    async def _execute_tool(
        self,
        executor: Executor,
        session: str,
        spec: Mapping[str, Any],
        opened: dict[str, asyncio.Task[None]],
        call: dict[str, Any],
        state: _Run,
    ) -> dict[str, Any]:
        # 一轮里第一次交给某个执行环境之前 `open` 这个会话（ADR 0009）；打不开时这个执行环境的调用都回错误。
        open_session = getattr(executor, 'open', None)
        if callable(open_session):
            task = opened.get(executor.name)
            if task is None:
                task = asyncio.ensure_future(open_session(session, spec.get('environment')))
                opened[executor.name] = task
            try:
                await asyncio.shield(task)
            except asyncio.CancelledError:
                raise
            except Exception as error:  # noqa: BLE001
                return error_output(
                    f'Executor "{executor.name}" could not prepare session "{session}" for tool "{call["name"]}": {error}'
                )
        try:
            return await executor.execute(call, {'session': session, 'runId': state.run_id})
        except asyncio.CancelledError:
            raise
        except Exception as error:  # noqa: BLE001 - 执行环境本身坏了：模型看得到原因
            return error_output(f'Executor "{executor.name}" failed running tool "{call["name"]}": {error}')

    async def _converse(
        self,
        state: _Run,
        spec: Mapping[str, Any],
        definitions: list[dict[str, Any]],
        model: Model,
        history: list[Any],
        prompt: Any,
        prepared: _Prepared,
    ) -> dict[str, Any]:
        names = {str(definition['name']) for definition in definitions}
        output_spec = spec.get('output')
        structured = output_spec is not None
        opened: dict[str, asyncio.Task[None]] = {}
        tools = [self._tool(state, definition, opened) for definition in definitions]
        output_type: Any = (
            ToolOutput(
                StructuredDict(
                    output_spec['schema'], name=output_spec.get('name'), description=output_spec.get('description')
                ),
                name=OUTPUT_TOOL,
            )
            if structured
            else str
        )
        # 有交给别处执行的工具时 pydantic-ai 要 `DeferredToolRequests` 在输出类型里，才会在那一步之后停下；模型看到的不变。
        if any(self._defers(spec, definition) for definition in definitions):
            output_type = [output_type, DeferredToolRequests]
        agent: Agent[None, Any] = Agent(
            model,
            output_type=output_type,
            instructions=spec.get('instructions'),
            tools=tools,
            name=spec.get('name'),
        )
        settings = model_settings_of(spec)
        timeout_ms = (spec.get('settings') or {}).get('timeoutMs')
        max_steps = int(spec.get('maxSteps') or (5 if definitions else 1))
        budget = spec.get('budget') or {}
        started_at = time.monotonic()
        token = CancellationToken()
        remove = state.signal.add_listener(token.cancel) if state.signal is not None else None

        step = 0
        usage: dict[str, int] | None = None
        text = ''
        final: Any = None
        finish: str | None = None
        stop: str | None = None
        error: dict[str, Any] | None = None
        try:
            async with agent.iter(
                prompt,
                message_history=history,
                model_settings=settings or None,  # type: ignore[arg-type]
                usage_limits=UsageLimits(request_limit=None),
                cancellation_token=token,
                timeout=None if timeout_ms is None else timeout_ms / 1000,
            ) as run:
                async for node in run:
                    if Agent.is_model_request_node(node):
                        retries = await self._note_retries(state, node.request.parts, structured)
                        if step >= max_steps:
                            # 最后一个回答不合输出的要求、步数又用完了：和参考实现一样是 `invalid_output`。
                            if structured and retries:
                                stop = 'error'
                                error = {
                                    'message': f'The final answer does not match AgentSpec.output.schema: {retries[0]}',
                                    'type': 'invalid_output',
                                }
                            else:
                                stop = 'max_steps'
                            break
                        if _over_budget(budget, usage, started_at):
                            stop = 'max_budget'
                            break
                        state.emit({'type': 'model.started', 'runId': state.run_id, 'step': step})
                        async with node.stream(run.ctx) as events:
                            async for event in events:
                                self._delta(state, event)
                    elif Agent.is_call_tools_node(node):
                        response = node.model_response
                        step_usage = usage_of(response.usage)
                        usage = add_usage(usage, step_usage)
                        finish = response.finish_reason
                        message = assistant_message(response, names, OUTPUT_TOOL if structured else None)
                        self._ask(state, spec, names, message)
                        # 估算只对第一步的请求成立：之后几步的请求里多了这一轮的工具调用和结果。
                        first = step == 0
                        meta = {
                            'step': compact(
                                {
                                    'runId': state.run_id,
                                    'step': step,
                                    'provider': response.provider_name,
                                    'modelId': response.model_name,
                                    'finishReason': finish_reason_of(response),
                                    'usage': step_usage,
                                    'estimatedInputTokens': prepared.tokens if first else None,
                                    'calibration': prepared.calibration if first and prepared.calibration > 1 else None,
                                }
                            )
                        }
                        await self._write(state, [message_entry(message, source='model', meta=meta)])
                        state.messages.append(message)
                        text = text_of(message)
                        calls = [part for part in message['content'] if part.get('type') == 'tool-call']
                        for part in calls:
                            state.open[part['id']] = part['name']
                        if calls:
                            await self._run_tools(state, node, run, calls)
                        state.emit(
                            compact(
                                {
                                    'type': 'model.ended',
                                    'runId': state.run_id,
                                    'step': step,
                                    'usage': step_usage,
                                    'seq': state.head if state.record else None,
                                }
                            )
                        )
                        step += 1
                    elif Agent.is_end_node(node):
                        # 停下来等别处执行的结果：调用在 `state.pending` 里，没有回答可解析。
                        final = None if isinstance(node.data.output, DeferredToolRequests) else node.data.output
        except _WriteFailed:
            raise
        except RunTimedOut:
            stop, error = 'error', {'message': 'The run exceeded AgentSpec.settings.timeoutMs.', 'type': 'timeout'}
        except RunCancelled:
            stop = 'aborted'
        except UnexpectedModelBehavior as caught:
            stop = 'error'
            error = {'message': str(caught), 'type': 'invalid_output' if structured else 'pydantic_ai'}
        except Exception as caught:  # noqa: BLE001 - 模型和 pydantic-ai 的错误：照常结束这一轮
            stop, error = 'error', error_info_of(caught)
        finally:
            if remove is not None:
                remove()
            for task in opened.values():
                task.cancel()

        output: Any = None
        # 同参考实现：有等着别处执行的调用就是 `requires_action`（同一步交了结构化输出也一样），只在 `end_turn` 时解析回答。
        if stop is None and state.pending:
            stop = 'requires_action'
        if stop is None:
            stop = 'max_tokens' if finish == 'length' else 'end_turn'
            if structured and stop == 'end_turn':
                problem = None if final is None else schema_problem(compile_schema(output_spec['schema']), final)
                if final is None or problem is not None:
                    stop = 'error'
                    error = {
                        'message': 'The final answer is not valid JSON for AgentSpec.output.'
                        if final is None
                        else f'The final answer does not match AgentSpec.output.schema: {problem}.',
                        'type': 'invalid_output',
                    }
                else:
                    output = final
        pending = state.pending if stop == 'requires_action' else None
        return await self._end(
            state,
            stop,
            text=text,
            error=error,
            usage=usage,
            output=output,
            pending=pending,
            executors=self._bound(spec, definitions, pending),
        )

    def _bound(
        self, spec: Mapping[str, Any], definitions: list[dict[str, Any]], pending: list[dict[str, Any]] | None
    ) -> dict[str, str] | None:
        """留给外部执行环境的调用归谁执行（``ctx.run.ended`` 的 ``executors``，同参考实现）：调用 ``id`` → 执行环境的名字。
        在这里执行的调用（包括等确认的）不记，``deny`` 的不会留下。执行方据此按名字领工作。"""
        offered = {str(definition['name']): definition for definition in definitions}
        bound: dict[str, str] = {}
        for call in pending or []:
            definition = offered.get(str(call['name']))
            executor = str(definition.get('executor', '')) if definition is not None else ''
            if executor in self._external and tool_permission(spec.get('permissions'), str(call['name'])) != 'deny':
                bound[call['id']] = executor
        return bound or None

    async def _run_tools(self, state: _Run, node: Any, run: Any, calls: list[dict[str, Any]]) -> None:
        """跑这一步的工具：调用、结果按事件发出，结果到齐了按调用的顺序、按执行方分组写进日志。"""
        results: dict[str, dict[str, Any]] = {}
        ids = {call['id'] for call in calls}
        async with node.stream(run.ctx) as events:
            async for event in events:
                # 同一步里结构化输出的调用不是 ctx 的工具调用：日志里它是文字，这里也不发事件。
                if getattr(getattr(event, 'part', None), 'tool_call_id', None) not in ids:
                    continue
                if isinstance(event, FunctionToolCallEvent):
                    part = event.part
                    try:
                        value: Json = part.args_as_dict()
                    except Exception:  # noqa: BLE001
                        value = part.args
                    state.emit(
                        {
                            'type': 'tool.called',
                            'runId': state.run_id,
                            'call': {'id': part.tool_call_id, 'name': part.tool_name, 'input': value},
                        }
                    )
                elif isinstance(event, FunctionToolResultEvent):
                    part = event.part
                    output = state.outputs.pop(part.tool_call_id, None)
                    if output is None:
                        output = (
                            error_output(retry_text(part))
                            if isinstance(part, RetryPromptPart)
                            else _output_of_return(part)
                        )
                    results[part.tool_call_id] = output
                    state.emit(
                        {'type': 'tool.returned', 'runId': state.run_id, 'callId': part.tool_call_id, 'output': output}
                    )
        groups: dict[str, list[dict[str, Any]]] = {}
        for call in calls:
            if call['id'] not in results:
                # 交给别处执行的：这一步走完了还没有结果，不补「结果未知」，等执行方追加（同参考实现）。
                if call['id'] in state.deferred:
                    state.open.pop(call['id'], None)
                    state.pending.append({'id': call['id'], 'name': call['name'], 'input': call.get('input')})
                continue
            source = state.sources.get(call['id'], 'harness')
            groups.setdefault(source, []).append(
                {'type': 'tool-result', 'id': call['id'], 'name': call['name'], 'output': results[call['id']]}
            )
            state.open.pop(call['id'], None)
        entries = []
        for source, parts in groups.items():
            message = {'role': 'tool', 'content': parts}
            state.messages.append(message)
            entries.append(message_entry(message, source=source))
        await self._write(state, entries)

    async def _note_retries(self, state: _Run, parts: Sequence[Any], structured: bool) -> list[str]:
        """pydantic-ai 补给模型、让它改了再答的话（``RetryFeedbackPart``：整个回答用不了，比如该交结构化输出时给了文字；
        还有结构化输出那次调用被退回）。记成适配器的事件，不记成用户消息；返回这些话。对 ctx 工具调用的那种已经是
        那次调用的错误结果。"""
        texts = [
            retry_text(part)
            for part in parts
            if isinstance(part, RetryFeedbackPart)
            or (isinstance(part, RetryPromptPart) and part.tool_name is None)
            or (
                structured
                and isinstance(part, ToolReturnPart)
                and part.tool_name == OUTPUT_TOOL
                and part.outcome == 'retried'
            )
        ]
        await self._write(state, [event_entry(RETRY_EVENT, text=text, source='harness') for text in texts])
        return texts

    def _delta(self, state: _Run, event: Any) -> None:
        if isinstance(event, PartStartEvent):
            part = event.part
            if isinstance(part, TextPart) and part.content:
                state.emit({'type': 'text.delta', 'runId': state.run_id, 'text': part.content})
            elif isinstance(part, ThinkingPart) and part.content:
                state.emit({'type': 'reasoning.delta', 'runId': state.run_id, 'text': part.content})
        elif isinstance(event, PartDeltaEvent):
            delta = event.delta
            if isinstance(delta, TextPartDelta) and delta.content_delta:
                state.emit({'type': 'text.delta', 'runId': state.run_id, 'text': delta.content_delta})
            elif isinstance(delta, ThinkingPartDelta) and delta.content_delta:
                state.emit({'type': 'reasoning.delta', 'runId': state.run_id, 'text': delta.content_delta})

    async def _end(
        self,
        state: _Run,
        stop: str,
        *,
        text: str = '',
        error: dict[str, Any] | None = None,
        usage: dict[str, int] | None = None,
        output: Any = None,
        pending: list[dict[str, Any]] | None = None,
        executors: dict[str, str] | None = None,
    ) -> dict[str, Any]:
        """收尾：没等到结果的工具调用补错误结果，出错写 ``ctx.error``，最后写 ``ctx.run.ended``（等着的调用归哪个外部执行环境
        记在它的 ``executors`` 里）。等着别处执行的调用不补，放在 ``pending`` 里。"""
        entries: list[dict[str, Any]] = []
        if state.open:
            message = {
                'role': 'tool',
                'content': [
                    {'type': 'tool-result', 'id': call_id, 'name': name, 'output': error_output(INTERRUPTED)}
                    for call_id, name in state.open.items()
                ],
            }
            state.open.clear()
            state.messages.append(message)
            entries.append(message_entry(message, source='harness'))
        if error is not None:
            state.emit({'type': 'error', 'runId': state.run_id, 'message': error['message']})
            entries.append(
                event_entry(
                    CTX_ERROR,
                    data=compact({'runId': state.run_id, 'message': error['message'], 'type': error.get('type')}),
                    source='harness',
                )
            )
        entries.append(
            event_entry(
                RUN_ENDED,
                data=compact({'runId': state.run_id, 'stopReason': stop, 'usage': usage, 'executors': executors}),
                source='harness',
            )
        )
        await self._write(state, entries)
        if state.fenced:
            return {
                'runId': state.run_id,
                'text': '',
                'messages': state.messages,
                'recorded': state.recorded,
                'stopReason': 'aborted',
            }
        approvals = [state.approvals[call['id']] for call in pending or [] if call['id'] in state.approvals]
        summary = compact(
            {
                'runId': state.run_id,
                'text': text,
                'stopReason': stop,
                'usage': usage,
                'output': output,
                'pending': pending or None,
                'approvals': approvals or None,
                'error': error,
            }
        )
        state.emit(
            compact(
                {
                    'type': 'run.ended',
                    'runId': state.run_id,
                    'result': summary,
                    'seq': state.head if state.record else None,
                }
            )
        )
        return {**summary, 'messages': state.messages, 'recorded': state.recorded}


def _sized(content: Json) -> int:
    return 0 if _empty(content) else estimate_tokens({'role': 'user', 'content': content})


def _prompt_of(*contents: Json) -> Any:
    """几段 ``MessageContent`` 合成交给 pydantic-ai 的用户内容；都空就是 ``None``。"""
    parts: list[Any] = []
    for content in contents:
        if _empty(content):
            continue
        converted = user_content(content)
        parts.extend([converted] if isinstance(converted, str) else converted)
    if not parts:
        return None
    return parts[0] if len(parts) == 1 and isinstance(parts[0], str) else parts


def _output_of_return(part: ToolReturnPart) -> dict[str, Any]:
    content = part.content
    # `retried`：pydantic-ai 退回的调用（不存在的工具这类），模型看到的是让它改了再来的话。
    if part.outcome in ('failed', 'retried'):
        return error_output(str(content))
    if isinstance(content, str):
        return {'type': 'text', 'text': content}
    return {'type': 'json', 'value': content}


def _over_budget(budget: Mapping[str, Any], usage: Mapping[str, int] | None, started_at: float) -> bool:
    # 同参考实现：用到了上限就停（`>=`），只在步骤之间看。
    tokens = budget.get('maxTotalTokens')
    if tokens is not None and usage is not None and usage.get('totalTokens', 0) >= tokens:
        return True
    duration = budget.get('maxDurationMs')
    return duration is not None and (time.monotonic() - started_at) * 1000 >= duration
