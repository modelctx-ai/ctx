"""把 pydantic-ai 的 ``Agent`` 接成 ctx 的 harness：循环是 pydantic-ai 的（``Agent.iter``），日志、工具、历史是 ctx 的。

一轮：``ctx.run.started`` → 记输入 → 从日志投影出历史交给 pydantic-ai → 每一步模型回答收齐就写助手消息（工具执行之前）、
这一步的工具结果到齐就写 → ``ctx.run.ended``。工具调用落在 ctx 的执行环境上（``Executor.execute``），输入按 ``inputSchema``
查、结果按上限截断，和参考实现同一套规则。``ask`` 的和外部执行环境的工具不在这里执行：pydantic-ai 记下调用（``CallDeferred``），
这一步走完就以 ``requires_action`` 结束。pydantic-ai 不存对话：每一轮的历史都从 ctx 的日志来。
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import AsyncIterator, Callable, Mapping, Sequence
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
)
from pydantic_ai.models import Model, infer_model
from pydantic_ai.usage import UsageLimits

from .executors import Executor
from .messages import (
    add_usage,
    assistant_message,
    finish_reason_of,
    project,
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
    agent_spec_to_json,
    compact,
    error_output,
    event_entry,
    is_context_overflow_text,
    is_event,
    is_framework_kind,
    limit_tool_output,
    message_entry,
    new_id,
    run_id_of,
    run_parent_problem,
    select_tools,
    tool_permission,
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


def _empty(content: Json) -> bool:
    return content is None or (isinstance(content, (str, list)) and len(content) == 0)


def _ended_in_failure(entry: Mapping[str, Any] | None) -> bool:
    if not is_event(entry, RUN_ENDED) or not isinstance(entry.get('data'), dict):  # type: ignore[union-attr]
        return False
    return entry['data'].get('stopReason') in ('error', 'aborted')  # type: ignore[index]


def spec_problem(spec: Mapping[str, Any]) -> str | None:
    """映射不了的 ``AgentSpec`` 字段：有就以 ``invalid_request`` 结束，不静默忽略。"""
    model = spec.get('model')
    if not isinstance(model, str) or model == '':
        return 'AgentSpec.model must be a model name: the pydantic-ai adapter resolves models by name.'
    if spec.get('window') is not None or spec.get('context') is not None:
        return (
            'AgentSpec.window and AgentSpec.context are not supported by the pydantic-ai adapter: '
            'it sends the whole projected log.'
        )
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
    permissions = spec.get('permissions') or {}
    values = [permissions.get('default'), *(permissions.get('tools') or {}).values()]
    if any(value is not None and value not in ('allow', 'ask', 'deny') for value in values):
        return 'AgentSpec.permissions values must be "allow", "ask" or "deny".'
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
        """同一个实例里同一会话的记录型运行一个接一个（同参考实现），``session_busy`` 只出现在跨进程的时候。"""
        if request.get('record') is False:
            return await self._unwrapped(request, emit, signal)
        session = str(request.get('session'))
        previous = self._tails.get(session)
        mine: asyncio.Future[None] = asyncio.get_running_loop().create_future()
        self._tails[session] = mine
        try:
            if previous is not None:
                await asyncio.shield(previous)
            return await self._unwrapped(request, emit, signal)
        finally:
            # 前一个还没结束（这一个在排队时被取消）就等它结束再放行后面的。
            if previous is None or previous.done():
                mine.set_result(None)
            else:
                previous.add_done_callback(lambda _: mine.done() or mine.set_result(None))
            if self._tails.get(session) is mine:
                del self._tails[session]

    async def _unwrapped(
        self, request: Mapping[str, Any], emit: Callable[[dict[str, Any]], None], signal: AbortSignal | None
    ) -> dict[str, Any]:
        try:
            return await self._execute(request, emit, signal)
        except _WriteFailed as failure:
            raise failure.cause from None

    # ---- 日志 ----

    async def _write(self, state: _Run, entries: Sequence[Mapping[str, Any]]) -> list[Entry]:
        """带着读到的末尾写；中间别人写了就接在新的末尾后面，给这一轮写了 ended（被围栏）就不再写。"""
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
                    after = await self._store.list(session, after=state.head or 0)
                except Exception as cause:
                    raise _WriteFailed(cause) from cause
                if any(is_event(entry, RUN_ENDED) and run_id_of(entry) == state.run_id for entry in after):
                    state.fenced = True
                    return []
                if after:
                    state.head = after[-1]['seq']
                continue
            except Exception as error:
                raise _WriteFailed(error) from error
            state.recorded.extend(written)
            if written:
                state.head = written[-1]['seq']
            return written
        return []

    async def _head(self, session: str) -> int:
        tail = await self._store.list(session, last=1)
        return int(tail[-1]['seq']) if tail else 0

    async def _repeats_failed_input(self, session: str, content: Json, key: str | None) -> bool:
        """这一轮的输入是不是上一轮失败时留下的那句（同参考实现）：它之后只有框架和这个适配器写的事件、没盖住它的摘要。"""
        tail = await self._store.list(session, last=_SCAN)
        if key is not None:
            return any(entry.get('key') == key for entry in tail)
        covered = 0
        for entry in reversed(tail):
            if entry['type'] == 'event' and (
                is_framework_kind(entry['kind']) or entry['kind'].startswith(f'{HARNESS_NAME}.')
            ):
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

    async def _start(self, state: _Run) -> bool | None:
        """查会话忙不忙、认重试，带着读到的末尾写 ``ctx.run.started``，冲突就重来。忙时返回 ``None``，否则返回输入要不要跳过。"""
        request = state.request
        session = str(request['session'])
        content = request.get('input')
        key = request.get('inputKey')
        for conflicts in range(_MAX_CONFLICTS + 1):
            try:
                head = await self._head(session)
                lifecycle = await self._store.list(session, kinds=[RUN_STARTED, RUN_ENDED], last=_SCAN)
            except Exception as error:
                raise _WriteFailed(error) from error
            last = lifecycle[-1] if lifecycle else None
            if state.record and is_event(last, RUN_STARTED):
                return None
            if not state.record:
                return False
            repeated = (
                not _empty(content)
                and _ended_in_failure(last)
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

        try:
            entries = await self._store.list(str(request['session']), types=['message', 'summary'])
        except Exception as error:
            raise _WriteFailed(error) from error
        history = to_model_messages(project(entries))
        prompt = _prompt_of(request.get('prompt')) if in_log else _prompt_of(content, request.get('prompt'))
        if prompt is None and (not history or isinstance(history[-1], ModelResponse)):
            return await self._end(
                state,
                'error',
                error={'message': 'Nothing to answer: give RunRequest.input or prompt.', 'type': 'invalid_request'},
            )
        return await self._converse(state, spec, definitions, model, history, prompt)

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
                        meta = {
                            'step': compact(
                                {
                                    'runId': state.run_id,
                                    'step': step,
                                    'provider': response.provider_name,
                                    'modelId': response.model_name,
                                    'finishReason': finish_reason_of(response),
                                    'usage': step_usage,
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
        return await self._end(state, stop, text=text, error=error, usage=usage, output=output, pending=pending)

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
    ) -> dict[str, Any]:
        """收尾：没等到结果的工具调用补错误结果，出错写 ``ctx.error``，最后写 ``ctx.run.ended``。等着别处执行的调用不补，
        放在 ``pending`` 里。"""
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
                RUN_ENDED, data=compact({'runId': state.run_id, 'stopReason': stop, 'usage': usage}), source='harness'
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
        summary = compact(
            {
                'runId': state.run_id,
                'text': text,
                'stopReason': stop,
                'usage': usage,
                'output': output,
                'pending': pending or None,
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
