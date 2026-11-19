"""进程内的 harness：内存存储、按剧本回答的模型。契约测试（``test_conformance.py``）之外的语义在这里查。"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from collections.abc import AsyncIterator, Callable, Coroutine, Mapping
from typing import Any

import pydantic_ai
import pytest
from pydantic_ai.messages import ModelRequest, ModelResponse, TextPart, UserPromptPart
from pydantic_ai.models.function import AgentInfo, DeltaToolCall, FunctionModel

from ctx_pydantic_ai import (
    HARNESS_NAME,
    INTERRUPTED,
    RETRY_EVENT,
    TOOL_RESULT_KEY_PREFIX,
    AbortSignal,
    FunctionExecutor,
    MemorySessionStore,
    PydanticAIHarness,
    pending_tool_calls,
    tool_approval_entry,
    tool_result_entry,
)
from ctx_pydantic_ai.compact import DEFAULT_SUMMARY_INSTRUCTIONS
from ctx_pydantic_ai.context import MISSING_RESULT, SUMMARY_PREFIX
from ctx_pydantic_ai.messages import text_of
from ctx_pydantic_ai.testing import ECHO_TOOL, ScriptedModel, echo_executor

AGENT = {'model': 'scripted'}


def run(coroutine: Callable[[], Coroutine[Any, Any, None]]) -> None:
    asyncio.run(coroutine())


def setup(
    script: list[dict[str, Any]], *, executors: list[Any] | None = None, delay_ms: float = 0, **options: Any
) -> tuple[PydanticAIHarness, MemorySessionStore, ScriptedModel]:
    store = MemorySessionStore()
    model = ScriptedModel(script, delay_ms=delay_ms)
    harness = PydanticAIHarness(
        store=store,
        executors=[echo_executor()] if executors is None else executors,
        models={'scripted': model},
        **options,
    )
    return harness, store, model


def shape(entry: Mapping[str, Any]) -> tuple[Any, ...]:
    if entry['type'] == 'event':
        return ('event', entry['kind'], entry.get('source'))
    if entry['type'] == 'summary':
        return ('summary', entry['covers'])
    return ('message', entry['message']['role'], entry.get('source'))


def texts(request: list[Any]) -> list[str]:
    """一次模型调用收到的历史里的文字（用户和模型两边）。"""
    out = []
    for message in request:
        for part in message.parts:
            if isinstance(message, ModelRequest) and isinstance(part, UserPromptPart):
                out.append(f'user:{part.content}')
            elif isinstance(message, ModelResponse) and isinstance(part, TextPart):
                out.append(f'model:{part.content}')
    return out


def test_records_a_round_as_it_goes() -> None:
    async def main() -> None:
        harness, store, _ = setup(
            [{'type': 'tool-call', 'id': 'c1', 'input': {'text': 'hi'}}, {'type': 'text', 'text': '好了'}]
        )
        result = await harness.run(
            {'session': 's', 'agent': AGENT, 'input': '回显 hi', 'inputKey': 'k1', 'owner': 'o1'}
        )
        log = await store.list('s')
        assert [shape(entry) for entry in log] == [
            ('event', 'ctx.run.started', 'harness'),
            ('message', 'user', None),
            ('message', 'assistant', 'model'),
            ('message', 'tool', 'local'),
            ('message', 'assistant', 'model'),
            ('event', 'ctx.run.ended', 'harness'),
        ]
        started, user, call, tool, answer, ended = log
        assert started['data']['runId'] == result['runId']
        assert started['data']['owner'] == 'o1'
        assert started['data']['agent'] == {'model': 'scripted'}
        assert started['data']['harness'] == {'name': HARNESS_NAME, 'version': pydantic_ai.__version__}
        assert user['key'] == 'k1'
        assert call['message']['content'] == [
            {'type': 'tool-call', 'id': 'c1', 'name': 'echo', 'input': {'text': 'hi'}}
        ]
        assert call['meta']['step']['step'] == 0
        assert call['meta']['step']['finishReason'] == 'tool-calls'
        assert answer['meta']['step']['step'] == 1
        assert tool['message']['content'] == [
            {'type': 'tool-result', 'id': 'c1', 'name': 'echo', 'output': {'type': 'json', 'value': {'text': 'hi'}}}
        ]
        assert ended['data']['stopReason'] == 'end_turn'
        assert ended['data']['usage'] == result['usage']
        assert result['text'] == '好了'
        assert result['stopReason'] == 'end_turn'
        assert [entry['id'] for entry in result['recorded']] == [entry['id'] for entry in log]
        assert [message['role'] for message in result['messages']] == ['assistant', 'tool', 'assistant']

    run(main)


def test_history_comes_from_the_log() -> None:
    async def main() -> None:
        harness, store, model = setup([{'type': 'text', 'text': 'A'}, {'type': 'text', 'text': 'B'}])
        await harness.run({'session': 's', 'agent': AGENT, 'input': '一'})
        await harness.run({'session': 's', 'agent': AGENT, 'input': '二', 'prompt': '（临时）'})
        assert texts(model.requests[1]) == ['user:一', 'model:A', 'user:二', 'user:（临时）']
        # 临时的 prompt 不写进日志。
        log = await store.list('s', types=['message'])
        assert [text_of(entry['message']) for entry in log] == ['一', 'A', '二', 'B']

    run(main)


def test_a_summary_replaces_what_it_covers() -> None:
    async def main() -> None:
        harness, store, model = setup([{'type': 'text', 'text': 'A'}, {'type': 'text', 'text': 'B'}])
        await harness.run({'session': 's', 'agent': AGENT, 'input': '一'})
        head = (await store.list('s', last=1))[0]['seq']
        await store.append('s', [{'type': 'summary', 'text': '前面说了一', 'covers': head}])
        await harness.run({'session': 's', 'agent': AGENT, 'input': '二'})
        assert texts(model.requests[1]) == ['user:Summary of the earlier conversation:\n前面说了一', 'user:二']

    run(main)


def test_a_retried_input_is_recorded_once() -> None:
    async def main() -> None:
        harness, store, _ = setup(
            [
                {'type': 'error', 'message': 'overloaded'},
                {'type': 'text', 'text': 'ok'},
                {'type': 'error', 'message': 'x'},
            ]
        )
        first = await harness.run({'session': 's', 'agent': AGENT, 'input': '再来'})
        assert first['stopReason'] == 'error'
        assert first['error']['type'] == 'api_call'
        second = await harness.run({'session': 's', 'agent': AGENT, 'input': '再来'})
        assert second['stopReason'] == 'end_turn'
        users = [entry for entry in await store.list('s', types=['message']) if entry['message']['role'] == 'user']
        assert len(users) == 1
        # 带 inputKey 的：日志里有这个键就不再写，内容不同也一样。
        await harness.run({'session': 'k', 'agent': AGENT, 'input': '甲', 'inputKey': 'same'})
        await harness.run({'session': 'k', 'agent': AGENT, 'input': '乙', 'inputKey': 'same'})
        keyed = await store.list('k', types=['message'])
        assert [entry['message']['content'] for entry in keyed if entry['message']['role'] == 'user'] == ['甲']

    run(main)


def test_a_busy_session_is_left_alone() -> None:
    async def main() -> None:
        harness, store, model = setup([{'type': 'text', 'text': 'never'}])
        await store.append('s', [{'type': 'event', 'kind': 'ctx.run.started', 'data': {'runId': 'other'}}])
        result = await harness.run({'session': 's', 'agent': AGENT, 'input': 'hi'})
        assert result['stopReason'] == 'error'
        assert result['error'] == {
            'message': 'Session "s" already has a run in progress.',
            'type': 'session_busy',
            'retryable': True,
        }
        assert len(await store.list('s')) == 1
        assert model.requests == []
        # 不记录的运行不看忙不忙，也什么都不写。
        quiet = await harness.run({'session': 's', 'agent': AGENT, 'input': 'hi', 'record': False})
        assert quiet['text'] == 'never'
        assert len(await store.list('s')) == 1

    run(main)


def test_runs_of_one_session_queue_up_in_one_instance() -> None:
    async def main() -> None:
        harness, store, _ = setup([{'type': 'text', 'text': 'A'}, {'type': 'text', 'text': 'B'}], delay_ms=20)
        results = await asyncio.gather(
            harness.run({'session': 's', 'agent': AGENT, 'input': '一'}),
            harness.run({'session': 's', 'agent': AGENT, 'input': '二'}),
        )
        assert [result['stopReason'] for result in results] == ['end_turn', 'end_turn']
        kinds = [entry.get('kind') for entry in await store.list('s', types=['event'])]
        assert kinds == ['ctx.run.started', 'ctx.run.ended', 'ctx.run.started', 'ctx.run.ended']

    run(main)


def test_a_run_aborted_while_queued_writes_nothing_and_does_not_block_the_next() -> None:
    async def main() -> None:
        harness, store, _ = setup([{'type': 'text', 'text': 'A'}, {'type': 'text', 'text': 'C'}], delay_ms=20)
        signal = AbortSignal()
        first = asyncio.ensure_future(harness.run({'session': 's', 'agent': AGENT, 'input': '一'}))
        await asyncio.sleep(0)
        queued = asyncio.ensure_future(harness.run({'session': 's', 'agent': AGENT, 'input': '二'}, signal=signal))
        third = asyncio.ensure_future(harness.run({'session': 's', 'agent': AGENT, 'input': '三'}))
        await asyncio.sleep(0)
        signal.abort()
        skipped = await queued
        assert skipped['stopReason'] == 'aborted'
        assert skipped['recorded'] == []
        assert [(await first)['text'], (await third)['text']] == ['A', 'C']
        users = [entry['message']['content'] for entry in await store.list('s', types=['message'])]
        assert [content for content in users if content in ('一', '二', '三')] == ['一', '三']
        started = [entry for entry in await store.list('s', types=['event']) if entry['kind'] == 'ctx.run.started']
        assert len(started) == 2

    run(main)


def test_a_run_after_one_aborted_while_queued_still_waits_for_the_running_one() -> None:
    async def main() -> None:
        harness, _, _ = setup([{'type': 'text', 'text': 'A'}, {'type': 'text', 'text': 'C'}], delay_ms=100)
        signal = AbortSignal()

        async def queued() -> list[dict[str, Any]]:
            request = {'session': 's', 'agent': AGENT, 'input': '二'}
            return [event async for event in harness.stream(request, signal=signal)]

        first = asyncio.ensure_future(harness.run({'session': 's', 'agent': AGENT, 'input': '一'}))
        await asyncio.sleep(0)
        streamed = asyncio.ensure_future(queued())
        await asyncio.sleep(0)
        signal.abort()
        events = await streamed
        assert [event['type'] for event in events] == ['run.started', 'run.ended']
        assert events[-1]['result']['stopReason'] == 'aborted'
        assert not first.done(), '第一个还在跑'
        late = await harness.run({'session': 's', 'agent': AGENT, 'input': '三'})
        assert [(await first)['text'], late['text']] == ['A', 'C']

    run(main)


def test_a_fenced_run_stops_writing() -> None:
    async def main() -> None:
        store = MemorySessionStore()
        runs: list[str] = []

        async def fence(value: Any, context: Mapping[str, Any]) -> dict[str, Any]:
            # 别处（编排器的 recover）认定这一轮已经死了，替它写了 ended。
            runs.append(context['runId'])
            await store.append(
                context['session'],
                [
                    {
                        'type': 'event',
                        'kind': 'ctx.run.ended',
                        'data': {'runId': context['runId'], 'stopReason': 'aborted'},
                    }
                ],
            )
            return {'type': 'text', 'text': 'late'}

        executor = FunctionExecutor('local').register(ECHO_TOOL, fence)
        model = ScriptedModel(
            [{'type': 'tool-call', 'id': 'c1', 'input': {'text': 'x'}}, {'type': 'text', 'text': 'no'}]
        )
        harness = PydanticAIHarness(store=store, executors=[executor], models={'scripted': model})
        result = await harness.run({'session': 's', 'agent': AGENT, 'input': 'go'})
        assert result['stopReason'] == 'aborted'
        log = await store.list('s')
        assert [shape(entry) for entry in log][-1] == ('event', 'ctx.run.ended', None)
        assert not any(entry['type'] == 'message' and entry['message']['role'] == 'tool' for entry in log)
        assert runs == [result['runId']]

    run(main)


def _erase(store: MemorySessionStore, how: str, before: int) -> Any:
    """``clear``、``truncate`` 的样子：删掉条目，``truncate`` 追加一条擦除记录。末尾是最后一条还在的条目，清空了就是 0。"""

    async def erase() -> None:
        log = store._sessions['s']
        if how == 'clear':
            log.clear()
            store._heads['s'] = 0
            return
        up_to = log[-1]['seq'] if how == 'truncate' else before
        count = sum(1 for entry in log if entry['seq'] <= up_to)
        log[:] = [entry for entry in log if entry['seq'] > up_to]
        await store.append(
            's',
            [
                {
                    'type': 'event',
                    'kind': 'ctx.erased',
                    'source': 'store',
                    'data': {'op': 'truncate', 'upTo': up_to, 'count': count},
                }
            ],
        )

    return erase


@pytest.mark.parametrize(('how', 'stop'), [('clear', 'aborted'), ('truncate', 'aborted'), ('earlier', 'end_turn')])
def test_erasing_this_run_while_it_runs_fences_it(how: str, stop: str) -> None:
    async def main() -> None:
        store = MemorySessionStore()
        erase: list[Any] = []

        async def wipe(value: Any, context: Mapping[str, Any]) -> dict[str, Any]:
            # 别处在这一轮中途清掉了会话，或者删到了这一轮写的条目；只删更早的历史不算。
            await erase[0]()
            return {'type': 'text', 'text': '删掉了'}

        executor = FunctionExecutor('local').register(ECHO_TOOL, wipe)
        model = ScriptedModel(
            [
                {'type': 'text', 'text': '上一轮'},
                {'type': 'tool-call', 'id': 'c1', 'input': {'text': 'x'}},
                {'type': 'text', 'text': '好了'},
            ]
        )
        harness = PydanticAIHarness(store=store, executors=[executor], models={'scripted': model})
        first = await harness.run({'session': 's', 'agent': AGENT, 'input': '先说一句'})
        erase.append(_erase(store, how, first['recorded'][-1]['seq']))
        result = await harness.run({'session': 's', 'agent': AGENT, 'input': '删掉'})
        assert result['stopReason'] == stop
        kinds = [entry.get('kind', entry['type']) for entry in await store.list('s')]
        if how == 'clear':
            assert kinds == []
        elif how == 'truncate':
            assert kinds == ['ctx.erased']
        else:
            assert kinds[-1] == 'ctx.run.ended'

    run(main)


def test_abort_while_a_tool_runs() -> None:
    async def main() -> None:
        entered = asyncio.Event()

        async def hang(value: Any, context: Mapping[str, Any]) -> dict[str, Any]:
            entered.set()
            await asyncio.Event().wait()
            return {'type': 'text', 'text': 'never'}

        harness, store, _ = setup(
            [{'type': 'tool-call', 'id': 'c1', 'input': {'text': 'x'}}],
            executors=[FunctionExecutor('local').register(ECHO_TOOL, hang)],
        )
        signal = AbortSignal()
        task = asyncio.ensure_future(harness.run({'session': 's', 'agent': AGENT, 'input': 'go'}, signal=signal))
        await asyncio.wait_for(entered.wait(), 5)
        signal.abort()
        result = await asyncio.wait_for(task, 5)
        assert result['stopReason'] == 'aborted'
        assert 'error' not in result
        log = await store.list('s')
        assert [shape(entry) for entry in log] == [
            ('event', 'ctx.run.started', 'harness'),
            ('message', 'user', None),
            ('message', 'assistant', 'model'),
            ('message', 'tool', 'harness'),
            ('event', 'ctx.run.ended', 'harness'),
        ]
        assert log[3]['message']['content'][0]['output'] == {'type': 'error', 'message': INTERRUPTED}
        assert log[-1]['data']['stopReason'] == 'aborted'

    run(main)


def test_abort_before_the_first_step() -> None:
    async def main() -> None:
        harness, store, model = setup([{'type': 'text', 'text': 'never'}])
        signal = AbortSignal()
        signal.abort()
        result = await harness.run({'session': 's', 'agent': AGENT, 'input': 'go'}, signal=signal)
        assert result['stopReason'] == 'aborted'
        assert [shape(entry)[1] for entry in await store.list('s')] == ['ctx.run.started', 'user', 'ctx.run.ended']
        assert model.requests == []

    run(main)


def test_stream_gives_events_in_order() -> None:
    async def main() -> None:
        harness, _, _ = setup(
            [{'type': 'tool-call', 'id': 'c1', 'input': {'text': 'hi'}}, {'type': 'text', 'text': '好'}]
        )
        events = [event async for event in harness.stream({'session': 's', 'agent': AGENT, 'input': 'go'})]
        kinds = [event['type'] for event in events]
        assert kinds == [
            'run.started',
            'model.started',
            'model.ended',
            'tool.called',
            'tool.returned',
            'model.started',
            'text.delta',
            'model.ended',
            'run.ended',
        ] or kinds == [
            'run.started',
            'model.started',
            'tool.called',
            'tool.returned',
            'model.ended',
            'model.started',
            'text.delta',
            'model.ended',
            'run.ended',
        ]
        assert events[-1]['result']['text'] == '好'
        assert events[-1]['seq'] == events[-2]['seq'] + 1

    run(main)


def test_a_stream_left_early_is_aborted() -> None:
    async def main() -> None:
        harness, store, _ = setup([{'type': 'text', 'text': 'slow'}], delay_ms=5000)
        events = harness.stream({'session': 's', 'agent': AGENT, 'input': 'go'})
        async with contextlib.aclosing(events):
            async for event in events:
                assert event['type'] == 'run.started'
                break
        last = (await store.list('s', last=1))[0]
        assert last['kind'] == 'ctx.run.ended'
        assert last['data']['stopReason'] == 'aborted'

    run(main)


UNMAPPED = [
    ({'window': 'big'}, 'AgentSpec.window must be an object.'),
    ({'window': {'maxTokens': '1k'}}, 'AgentSpec.window.maxTokens must be a number.'),
    ({'context': {'overflow': {'maxTokens': 0}}}, 'AgentSpec.context.overflow.maxTokens must be a positive number.'),
    ({'context': {'overflow': {'maxTokens': 9, 'strategy': 'drop'}}}, 'AgentSpec.context.overflow.strategy must be'),
    (
        {'context': {'overflow': {'maxTokens': 9, 'compact': 4}}},
        'AgentSpec.context.overflow.compact must be an object.',
    ),
    (
        {'context': {'overflow': {'maxTokens': 9, 'compact': {'keep': 'all'}}}},
        'AgentSpec.context.overflow.compact.keep must be a number.',
    ),
    (
        {'context': {'overflow': {'maxTokens': 9, 'compact': {'instructions': ['短']}}}},
        'AgentSpec.context.overflow.compact.instructions must be a string.',
    ),
    ({'context': {'inherit': {'session': ''}}}, 'AgentSpec.context.inherit.session must be a non-empty string.'),
    ({'context': {'inherit': {'session': 'p', 'upTo': -1}}}, 'AgentSpec.context.inherit.upTo must be a non-negative'),
    ({'settings': {'providerOptions': {'openai': {}}}}, 'AgentSpec.settings.providerOptions not supported'),
    ({'settings': {'timeoutMs': 0}}, 'AgentSpec.settings.timeoutMs must be a positive number.'),
    ({'permissions': {'tools': {'echo': 'maybe'}}}, 'AgentSpec.permissions values must be'),
    ({'toolChoice': {'tool': 'nope'}}, 'AgentSpec.toolChoice names tool "nope", which is not offered.'),
    ({'toolChoice': 'sometimes'}, 'AgentSpec.toolChoice must be'),
    ({'maxSteps': 0}, 'AgentSpec.maxSteps must be a positive integer.'),
    ({'budget': {'maxTotalTokens': -1}}, 'AgentSpec.budget.maxTotalTokens must be a positive number.'),
    ({'output': {'schema': 'object'}}, 'AgentSpec.output.schema must be a JSON Schema object.'),
    ({'model': {'provider': 'openai', 'modelId': 'gpt-5'}}, 'AgentSpec.model must be a model name'),
]


@pytest.mark.parametrize(('extra', 'message'), UNMAPPED)
def test_what_cannot_be_mapped_is_invalid_request(extra: dict[str, Any], message: str) -> None:
    async def main() -> None:
        harness, store, model = setup([{'type': 'text', 'text': 'never'}])
        result = await harness.run({'session': 's', 'agent': {**AGENT, **extra}, 'input': 'hi'})
        assert result['stopReason'] == 'error'
        assert result['error']['type'] == 'invalid_request'
        assert result['error']['message'].startswith(message)
        log = await store.list('s')
        assert [shape(entry)[1] for entry in log][-2:] == ['ctx.error', 'ctx.run.ended']
        assert model.requests == []

    run(main)


def test_an_unknown_model_name_is_not_found() -> None:
    async def main() -> None:
        harness, _, _ = setup([])
        result = await harness.run({'session': 's', 'agent': {'model': 'gpt-zero'}, 'input': 'hi'})
        assert result['error'] == {'message': 'Model "gpt-zero" is not served by this harness.', 'type': 'not_found'}
        # 不给 models 时按 pydantic-ai 的写法推：推不出来是 invalid_request。
        free = PydanticAIHarness(store=MemorySessionStore())
        result = await free.run({'session': 's', 'agent': {'model': 'no-such-provider:x'}, 'input': 'hi'})
        assert result['error']['type'] == 'invalid_request'
        assert result['error']['message'].startswith('pydantic-ai cannot make model "no-such-provider:x"')

    run(main)


class Capture(FunctionModel):
    """记下每次调用拿到的设置和工具。"""

    def __init__(self) -> None:
        self.calls: list[AgentInfo] = []
        super().__init__(self._respond, stream_function=self._stream, model_name='capture')

    async def _respond(self, messages: list[Any], info: AgentInfo) -> ModelResponse:
        self.calls.append(info)
        return ModelResponse(parts=[TextPart('ok')])

    async def _stream(self, messages: list[Any], info: AgentInfo) -> AsyncIterator[str]:
        self.calls.append(info)
        yield 'ok'


def test_spec_fields_reach_pydantic_ai() -> None:
    async def main() -> None:
        model = Capture()
        store = MemorySessionStore()
        other = FunctionExecutor('other').register({**ECHO_TOOL, 'name': 'other'}, lambda value, context: value)
        harness = PydanticAIHarness(store=store, executors=[echo_executor(), other], models={'capture': model})
        spec = {
            'model': 'capture',
            'instructions': '简短回答',
            'tools': ['echo'],
            'toolChoice': 'none',
            'settings': {
                'temperature': 0.3,
                'maxOutputTokens': 64,
                'topP': 0.9,
                'topK': 5,
                'presencePenalty': 0.1,
                'frequencyPenalty': 0.2,
                'seed': 7,
                'stopSequences': ['END'],
                'maxRetries': 2,
                'headers': {'x-team': 'a'},
                'timeoutMs': 5000,
            },
        }
        result = await harness.run({'session': 's', 'agent': spec, 'input': 'hi'})
        assert result['stopReason'] == 'end_turn'
        [info] = model.calls
        assert info.model_settings == {
            'temperature': 0.3,
            'max_tokens': 64,
            'top_p': 0.9,
            'top_k': 5,
            'presence_penalty': 0.1,
            'frequency_penalty': 0.2,
            'seed': 7,
            'stop_sequences': ['END'],
            'max_retries': 2,
            'extra_headers': {'x-team': 'a'},
            'tool_choice': 'none',
        }
        assert [tool.name for tool in info.function_tools] == ['echo']
        assert info.instructions == '简短回答'
        started = (await store.list('s', kinds=['ctx.run.started']))[0]
        assert started['data']['agent']['settings']['headers'] == {'x-team': '[redacted]'}

    run(main)


def test_timeout_ends_the_run() -> None:
    async def main() -> None:
        harness, _, _ = setup([{'type': 'text', 'text': 'late'}], delay_ms=5000)
        result = await harness.run({'session': 's', 'agent': {**AGENT, 'settings': {'timeoutMs': 50}}, 'input': 'hi'})
        assert result['stopReason'] == 'error'
        assert result['error']['type'] == 'timeout'

    run(main)


def test_denied_and_invalid_calls_never_reach_the_executor() -> None:
    async def main() -> None:
        calls: list[Any] = []
        executor = FunctionExecutor('local').register(ECHO_TOOL, lambda value, context: calls.append(value) or value)
        harness, store, _ = setup(
            [
                {'type': 'tool-call', 'id': 'c1', 'input': {'text': 'x'}},
                {'type': 'text', 'text': 'denied'},
                {'type': 'tool-call', 'id': 'c2', 'input': {'text': 42}},
                {'type': 'text', 'text': 'invalid'},
            ],
            executors=[executor],
        )
        denied = {**AGENT, 'permissions': {'tools': {'echo': 'deny'}}}
        assert (await harness.run({'session': 'a', 'agent': denied, 'input': 'go'}))['text'] == 'denied'
        assert (await harness.run({'session': 'b', 'agent': AGENT, 'input': 'go'}))['text'] == 'invalid'
        assert calls == []
        [refused] = await store.list('a', types=['message'], last=2, limit=1)
        assert refused['source'] == 'local'
        assert refused['message']['content'][0]['output'] == {
            'type': 'error',
            'message': 'Tool call "echo" was denied by the agent\'s permissions.',
        }
        [invalid] = await store.list('b', types=['message'], last=2, limit=1)
        assert invalid['message']['content'][0]['output']['message'].startswith(
            'Invalid input for tool "echo": /text: '
        )

    run(main)


def test_parallel_calls_are_grouped_by_executor() -> None:
    async def main() -> None:
        alpha = FunctionExecutor('a').register(
            {**ECHO_TOOL, 'name': 'alpha'}, lambda value, context: {'type': 'text', 'text': 'A'}
        )
        beta = FunctionExecutor('b').register(
            {**ECHO_TOOL, 'name': 'beta'}, lambda value, context: {'type': 'text', 'text': 'B'}
        )
        harness, store, _ = setup(
            [
                {
                    'type': 'tool-calls',
                    'calls': [
                        {'id': '1', 'tool': 'alpha', 'input': {}},
                        {'id': '2', 'tool': 'beta', 'input': {}},
                        {'id': '3', 'tool': 'alpha', 'input': {}},
                    ],
                },
                {'type': 'text', 'text': 'done'},
            ],
            executors=[alpha, beta],
        )
        await harness.run({'session': 's', 'agent': AGENT, 'input': 'go'})
        tools = [entry for entry in await store.list('s', types=['message']) if entry['message']['role'] == 'tool']
        assert [(entry['source'], [part['id'] for part in entry['message']['content']]) for entry in tools] == [
            ('a', ['1', '3']),
            ('b', ['2']),
        ]

    run(main)


def test_an_executor_is_opened_once_per_run() -> None:
    async def main() -> None:
        opened: list[tuple[str, Any]] = []

        class Sandbox(FunctionExecutor):
            async def open(self, session: str, environment: Any = None) -> None:
                opened.append((session, environment))
                if session == 'broken':
                    raise RuntimeError('no sandbox')

        sandbox = Sandbox('sandbox').register(ECHO_TOOL, lambda value, context: {'type': 'text', 'text': 'ran'})
        script = [
            {'type': 'tool-calls', 'calls': [{'id': '1', 'input': {}}, {'id': '2', 'input': {}}]},
            {'type': 'tool-call', 'id': '3', 'input': {}},
            {'type': 'text', 'text': 'done'},
            {'type': 'tool-call', 'id': '4', 'input': {}},
            {'type': 'text', 'text': 'done'},
        ]
        harness, store, _ = setup(script, executors=[sandbox])
        environment = {'image': 'python:3.13'}
        await harness.run({'session': 's', 'agent': {**AGENT, 'environment': environment}, 'input': 'go'})
        assert opened == [('s', environment)]
        await harness.run({'session': 'broken', 'agent': AGENT, 'input': 'go'})
        [result] = [
            entry for entry in await store.list('broken', types=['message']) if entry['message']['role'] == 'tool'
        ]
        assert result['message']['content'][0]['output'] == {
            'type': 'error',
            'message': 'Executor "sandbox" could not prepare session "broken" for tool "echo": no sandbox',
        }

    run(main)


def test_step_and_budget_limits() -> None:
    async def main() -> None:
        call = {'type': 'tool-call', 'id': 'c1', 'input': {'text': 'x'}}
        harness, store, _ = setup([call, {'type': 'text', 'text': 'never'}])
        result = await harness.run({'session': 's', 'agent': {**AGENT, 'maxSteps': 1}, 'input': 'go'})
        assert result['stopReason'] == 'max_steps'
        # 最后一步的工具照样执行、结果照样记下。
        assert [shape(entry)[1] for entry in await store.list('s', types=['message'])] == ['user', 'assistant', 'tool']
        harness, _, _ = setup([call, {'type': 'text', 'text': 'never'}])
        result = await harness.run({'session': 's', 'agent': {**AGENT, 'budget': {'maxTotalTokens': 1}}, 'input': 'go'})
        assert result['stopReason'] == 'max_budget'
        harness, _, _ = setup([{'type': 'text', 'text': 'cut', 'truncated': True}])
        result = await harness.run({'session': 's', 'agent': AGENT, 'input': 'go'})
        assert result['stopReason'] == 'max_tokens'
        assert result['text'] == 'cut'

    run(main)


SCHEMA = {'type': 'object', 'properties': {'n': {'type': 'integer'}}, 'required': ['n']}


def test_structured_output() -> None:
    async def main() -> None:
        harness, store, _ = setup([{'type': 'text', 'text': '{"n": 3}'}])
        result = await harness.run({'session': 's', 'agent': {**AGENT, 'output': {'schema': SCHEMA}}, 'input': 'go'})
        assert result['stopReason'] == 'end_turn'
        assert result['output'] == {'n': 3}
        answer = (await store.list('s', types=['message']))[-1]
        assert answer['message']['content'] == [{'type': 'text', 'text': '{"n":3}'}]

    run(main)


def test_an_answer_that_breaks_the_schema() -> None:
    async def main() -> None:
        spec = {**AGENT, 'output': {'schema': SCHEMA}}
        # pydantic-ai 不按 JSON Schema 查 `StructuredDict`：最后的回答由适配器查，和参考实现一样是 invalid_output。
        harness, _, _ = setup([{'type': 'text', 'text': '{"n": "three"}'}])
        result = await harness.run({'session': 's', 'agent': spec, 'input': 'go'})
        assert result['error'] == {
            'message': "The final answer does not match AgentSpec.output.schema: /n: 'three' is not of type 'integer'.",
            'type': 'invalid_output',
        }
        # 给了文字：pydantic-ai 让模型改了再答，那段话记成适配器的事件。
        harness, store, _ = setup([{'type': 'text', 'text': '不是 JSON'}, {'type': 'text', 'text': '{"n": 3}'}])
        result = await harness.run({'session': 's', 'agent': {**spec, 'maxSteps': 3}, 'input': 'go'})
        assert result['output'] == {'n': 3}
        log = await store.list('s')
        assert [shape(entry)[1] for entry in log] == [
            'ctx.run.started',
            'user',
            'assistant',
            RETRY_EVENT,
            'assistant',
            'ctx.run.ended',
        ]
        assert log[3]['source'] == 'harness'
        # 步数用完了还没交对：invalid_output，不是 max_steps。
        harness, _, model = setup([{'type': 'text', 'text': '不是 JSON'}, {'type': 'text', 'text': '{"n": 3}'}])
        result = await harness.run({'session': 's', 'agent': {**spec, 'tools': False}, 'input': 'go'})
        assert result['stopReason'] == 'error'
        assert result['error']['type'] == 'invalid_output'
        assert len(model.requests) == 1

    run(main)


def test_nothing_to_answer() -> None:
    async def main() -> None:
        harness, _, model = setup([{'type': 'text', 'text': 'A'}])
        await harness.run({'session': 's', 'agent': AGENT, 'input': 'q'})
        result = await harness.run({'session': 's', 'agent': AGENT})
        assert result['error'] == {
            'message': 'Nothing to answer: give RunRequest.input or prompt.',
            'type': 'invalid_request',
        }
        assert len(model.requests) == 1

    run(main)


def test_tool_output_is_limited() -> None:
    async def main() -> None:
        long = FunctionExecutor('local').register(ECHO_TOOL, lambda value, context: {'type': 'text', 'text': 'x' * 100})
        harness, store, _ = setup(
            [{'type': 'tool-call', 'id': 'c1', 'input': {}}, {'type': 'text', 'text': 'ok'}],
            executors=[long],
            max_tool_output_chars=10,
        )
        await harness.run({'session': 's', 'agent': AGENT, 'input': 'go'})
        [tool] = [entry for entry in await store.list('s', types=['message']) if entry['message']['role'] == 'tool']
        assert tool['message']['content'][0]['output']['text'].startswith(
            'x' * 10 + '\n[… truncated 90 more characters'
        )

    run(main)


# ---- 交给别处执行的工具：requires_action（对照参考实现的 external.test.ts 和 agent-spec.test.ts）----

LOOKUP = {
    'name': 'lookup',
    'description': '查内网的订单',
    'inputSchema': {'type': 'object', 'properties': {'id': {'type': 'string'}}},
    'executor': 'worker',
}
LOOKUP_CALL = {'type': 'tool-call', 'id': 'c1', 'tool': 'lookup', 'input': {'id': '42'}}


def external_setup(
    script: list[dict[str, Any]], *, executors: list[Any] | None = None
) -> tuple[PydanticAIHarness, MemorySessionStore, ScriptedModel]:
    """``lookup`` 绑在执行环境 ``worker`` 上，这个 harness 没有它的实例；``echo`` 在这里执行。"""
    return setup(script, executors=executors, tools=[LOOKUP, {**ECHO_TOOL, 'executor': 'local'}], external=['worker'])


def roles(entries: list[dict[str, Any]]) -> list[str]:
    return [shape(entry)[1] for entry in entries]


def test_an_external_call_waits_for_its_result_in_the_log() -> None:
    async def main() -> None:
        harness, store, model = external_setup([LOOKUP_CALL, {'type': 'text', 'text': '订单 42 已经发货了'}])
        first = await harness.run({'session': 's', 'agent': AGENT, 'input': '订单 42 到哪了？'})
        assert first['stopReason'] == 'requires_action'
        assert first['pending'] == [{'id': 'c1', 'name': 'lookup', 'input': {'id': '42'}}]
        log = await store.list('s')
        assert roles(log) == ['ctx.run.started', 'user', 'assistant', 'ctx.run.ended']
        assert log[-1]['data']['stopReason'] == 'requires_action'
        assert [(item['call']['id'], item['runId'], item['seq']) for item in pending_tool_calls(log)] == [
            ('c1', first['runId'], log[2]['seq'])
        ]
        # 执行方追加结果：两个都执行了也只记一条（幂等键）。
        output = {'type': 'text', 'text': '订单 42 已发货'}
        for _ in range(2):
            await store.append('s', [tool_result_entry(first['pending'][0], output, source='worker')])
        log = await store.list('s')
        assert roles(log)[-1] == 'tool'
        assert roles(log).count('tool') == 1
        assert log[-1]['key'] == 'ctx.tool-result:c1'
        assert pending_tool_calls(log) == []
        # 下一轮不带输入接着跑：模型看到执行方给的结果。
        second = await harness.run({'session': 's', 'agent': AGENT})
        assert second['stopReason'] == 'end_turn'
        assert second['text'] == '订单 42 已经发货了'
        assert '订单 42 已发货' in str(model.requests[1])

    run(main)


def test_the_stream_ends_with_the_pending_calls() -> None:
    async def main() -> None:
        harness, _, _ = external_setup([LOOKUP_CALL])
        events = [event async for event in harness.stream({'session': 's', 'agent': AGENT, 'input': '订单 42？'})]
        assert [event['type'] for event in events if event['type'].startswith('tool.')] == ['tool.called']
        ended = events[-1]
        assert ended['type'] == 'run.ended'
        assert ended['result']['stopReason'] == 'requires_action'
        assert ended['result']['pending'] == [{'id': 'c1', 'name': 'lookup', 'input': {'id': '42'}}]

    run(main)


def test_without_a_result_the_next_run_goes_on() -> None:
    async def main() -> None:
        harness, store, model = external_setup([LOOKUP_CALL, {'type': 'text', 'text': '查不到'}])
        await harness.run({'session': 's', 'agent': AGENT, 'input': '订单 42？'})
        after = await harness.run({'session': 's', 'agent': AGENT, 'input': '算了'})
        assert after['stopReason'] == 'end_turn'
        assert pending_tool_calls(await store.list('s')) == []
        # 投影给缺结果的那次调用补上「没有记录到结果」。
        assert MISSING_RESULT in str(model.requests[1])

    run(main)


def test_a_step_with_a_local_and_an_external_call() -> None:
    async def main() -> None:
        both = {'type': 'tool-calls', 'calls': [LOOKUP_CALL, {'id': 'c2', 'input': {'text': 'hi'}}]}
        harness, store, model = external_setup([both, {'type': 'text', 'text': 'never'}])
        result = await harness.run({'session': 's', 'agent': AGENT, 'input': 'go'})
        assert result['stopReason'] == 'requires_action'
        assert [call['id'] for call in result['pending']] == ['c1']
        log = await store.list('s')
        assert [shape(entry) for entry in log] == [
            ('event', 'ctx.run.started', 'harness'),
            ('message', 'user', None),
            ('message', 'assistant', 'model'),
            ('message', 'tool', 'local'),
            ('event', 'ctx.run.ended', 'harness'),
        ]
        # 在这里执行的照常记下结果；交给别处的不补「结果未知」。
        assert [part['id'] for part in log[3]['message']['content']] == ['c2']
        assert [item['call']['id'] for item in pending_tool_calls(log)] == ['c1']
        assert len(model.requests) == 1

    run(main)


def test_ask_stops_until_the_app_confirms() -> None:
    async def main() -> None:
        calls: list[Any] = []
        executor = FunctionExecutor('local').register(
            ECHO_TOOL, lambda value, context: calls.append(value) or {'type': 'json', 'value': value}
        )
        harness, store, _ = setup(
            [{'type': 'tool-call', 'id': 'c1', 'input': {'text': 'hi'}}, {'type': 'text', 'text': '回显好了'}],
            executors=[executor],
        )
        agent = {**AGENT, 'permissions': {'default': 'ask'}}
        first = await harness.run({'session': 's', 'agent': agent, 'input': '回显'})
        assert first['stopReason'] == 'requires_action'
        assert first['pending'] == [{'id': 'c1', 'name': 'echo', 'input': {'text': 'hi'}}]
        assert calls == []
        # 应用确认了：交给执行环境执行，把结果追加进日志，再不带输入跑一轮。
        [call] = first['pending']
        output = await executor.execute(call, {'session': 's', 'runId': first['runId']})
        await store.append('s', [tool_result_entry(call, output, source='local')])
        second = await harness.run({'session': 's', 'agent': agent})
        assert second['stopReason'] == 'end_turn'
        assert second['text'] == '回显好了'
        assert calls == [{'text': 'hi'}]

    run(main)


# ---- 人工确认（对照参考实现的 approval.test.ts）----

ASKING = {**AGENT, 'permissions': {'default': 'ask'}}
RM = [{'type': 'tool-call', 'id': 'c1', 'input': {'text': 'rm'}}, {'type': 'text', 'text': '好了'}]


def counting() -> tuple[FunctionExecutor, list[Any]]:
    calls: list[Any] = []
    executor = FunctionExecutor('local').register(
        ECHO_TOOL, lambda value, context: calls.append(value) or {'type': 'json', 'value': value}
    )
    return executor, calls


def parts_of(entry: Mapping[str, Any]) -> list[str]:
    content = entry['message']['content'] if entry['type'] == 'message' else None
    return [part['type'] for part in content] if isinstance(content, list) else []


def test_ask_writes_the_approval_request_next_to_the_call() -> None:
    async def main() -> None:
        executor, calls = counting()
        harness, store, _ = setup(RM, executors=[executor])
        first = await harness.run({'session': 's', 'agent': ASKING, 'input': '删掉'})
        assert first['stopReason'] == 'requires_action'
        assert first['pending'] == [{'id': 'c1', 'name': 'echo', 'input': {'text': 'rm'}}]
        [approval] = first['approvals']
        assert approval['callId'] == 'c1'
        assert calls == []
        log = await store.list('s')
        assert roles(log) == ['ctx.run.started', 'user', 'assistant', 'ctx.run.ended']
        assert parts_of(log[2]) == ['tool-call', 'tool-approval-request']
        [pending] = pending_tool_calls(log)
        assert pending['approval'] == {'approvalId': approval['approvalId']}
        assert approval['approvalId'] in repr(first['messages'])

    run(main)


def test_an_approved_call_runs_first_in_the_next_round() -> None:
    async def main() -> None:
        executor, calls = counting()
        harness, store, model = setup(RM, executors=[executor])
        first = await harness.run({'session': 's', 'agent': ASKING, 'input': '删掉'})
        await store.append('s', [tool_approval_entry(first['approvals'][0]['approvalId'], {'approved': True})])
        events: list[dict[str, Any]] = []
        async for event in harness.stream({'session': 's', 'agent': ASKING}):
            events.append(event)
        second = events[-1]['result']
        assert second['stopReason'] == 'end_turn'
        assert second['text'] == '好了'
        assert calls == [{'text': 'rm'}]
        assert [event['type'] for event in events[:3]] == ['run.started', 'tool.returned', 'model.started']
        log = await store.list('s')
        assert roles(log)[-4:] == ['ctx.run.started', 'tool', 'assistant', 'ctx.run.ended']
        assert log[-3]['key'] == f'{TOOL_RESULT_KEY_PREFIX}c1'
        assert "'text': 'rm'" in repr(model.requests[1])
        assert pending_tool_calls(log) == []

    run(main)


def test_a_denied_call_is_not_run_and_the_model_sees_why() -> None:
    async def main() -> None:
        executor, calls = counting()
        harness, store, model = setup(RM, executors=[executor])
        first = await harness.run({'session': 's', 'agent': ASKING, 'input': '删掉'})
        approval = first['approvals'][0]['approvalId']
        await store.append('s', [tool_approval_entry(approval, {'approved': False, 'reason': '不行'})])
        second = await harness.run({'session': 's', 'agent': ASKING})
        assert second['stopReason'] == 'end_turn'
        assert calls == []
        assert 'was not approved: 不行' in repr(model.requests[1])

    run(main)


def test_decisions_land_before_the_new_input_and_late_ones_do_not_count() -> None:
    async def main() -> None:
        executor, calls = counting()
        harness, store, model = setup(
            [*RM, {'type': 'tool-call', 'id': 'c2', 'input': {'text': 'mv'}}, {'type': 'text', 'text': '不动了'}],
            executors=[executor],
        )
        first = await harness.run({'session': 's', 'agent': ASKING, 'input': '删掉'})
        await store.append('s', [tool_approval_entry(first['approvals'][0]['approvalId'], {'approved': True})])
        second = await harness.run({'session': 's', 'agent': ASKING, 'input': '删完了吗'})
        assert roles(second['recorded']) == ['ctx.run.started', 'tool', 'user', 'assistant', 'ctx.run.ended']
        # 没决定就带着新输入跑：不执行，模型看到缺结果，这一轮结束以后它不再等待，迟到的确认不算数。
        third = await harness.run({'session': 's', 'agent': ASKING, 'input': '再挪一下'})
        assert third['stopReason'] == 'requires_action'
        fourth = await harness.run({'session': 's', 'agent': ASKING, 'input': '算了'})
        assert fourth['text'] == '不动了'
        assert MISSING_RESULT in repr(model.requests[3])
        await store.append('s', [tool_approval_entry(third['approvals'][0]['approvalId'], {'approved': True})])
        assert pending_tool_calls(await store.list('s')) == []
        assert calls == [{'text': 'rm'}]

    run(main)


def test_deny_still_wins_over_an_approval() -> None:
    async def main() -> None:
        executor, calls = counting()
        harness, store, model = setup(RM, executors=[executor])
        first = await harness.run({'session': 's', 'agent': ASKING, 'input': '删掉'})
        await store.append('s', [tool_approval_entry(first['approvals'][0]['approvalId'], {'approved': True})])
        denied = {**AGENT, 'permissions': {'default': 'deny'}}
        await harness.run({'session': 's', 'agent': denied})
        assert calls == []
        assert "denied by the agent\\'s permissions" in repr(model.requests[1])

    run(main)


def test_an_approved_external_call_is_left_to_its_executor() -> None:
    async def main() -> None:
        harness, store, _ = external_setup([LOOKUP_CALL, {'type': 'text', 'text': '发货了'}])
        first = await harness.run({'session': 's', 'agent': ASKING, 'input': '订单 42？'})
        assert first['approvals'][0]['callId'] == 'c1'
        await store.append('s', [tool_approval_entry(first['approvals'][0]['approvalId'], {'approved': True})])
        [waiting] = pending_tool_calls(await store.list('s'))
        assert waiting['approval']['decision'] == {'approved': True}
        await store.append(
            's', [tool_result_entry(waiting['call'], {'type': 'text', 'text': '已发货'}, source='worker')]
        )
        second = await harness.run({'session': 's', 'agent': ASKING})
        assert second['text'] == '发货了'
        assert roles(second['recorded']) == ['ctx.run.started', 'assistant', 'ctx.run.ended']

    run(main)


def test_deny_comes_first_and_deferred_input_is_left_to_the_executor() -> None:
    async def main() -> None:
        harness, store, _ = external_setup([LOOKUP_CALL, {'type': 'text', 'text': '被拒了'}])
        denied = {**AGENT, 'permissions': {'tools': {'lookup': 'deny'}}}
        result = await harness.run({'session': 'a', 'agent': denied, 'input': '订单 42？'})
        assert result['stopReason'] == 'end_turn'
        assert 'pending' not in result
        [refused] = [entry for entry in await store.list('a', types=['message']) if entry['message']['role'] == 'tool']
        assert refused['message']['content'][0]['output'] == {
            'type': 'error',
            'message': 'Tool call "lookup" was denied by the agent\'s permissions.',
        }
        # 同参考实现：交给别处执行的不在这里按 `inputSchema` 查，由执行方处理。
        harness, _, _ = external_setup([{**LOOKUP_CALL, 'input': {'id': 42}}])
        waiting = await harness.run({'session': 'b', 'agent': AGENT, 'input': '订单 42？'})
        assert waiting['pending'] == [{'id': 'c1', 'name': 'lookup', 'input': {'id': 42}}]

    run(main)


def test_a_structured_answer_next_to_an_external_call_waits_too() -> None:
    async def main() -> None:
        # 同一个回答里先交结构化输出、再调外部的工具（pydantic-ai 两种顺序都照样处理那次调用）。
        async def stream(messages: list[Any], info: AgentInfo) -> AsyncIterator[Any]:
            yield {
                0: DeltaToolCall(name=info.output_tools[0].name, json_args='{"n": 1}', tool_call_id='out'),
                1: DeltaToolCall(name='lookup', json_args='{"id": "42"}', tool_call_id='c1'),
            }

        store = MemorySessionStore()
        model = FunctionModel(stream_function=stream)
        harness = PydanticAIHarness(store=store, tools=[LOOKUP], external=['worker'], models={'scripted': model})
        result = await harness.run({'session': 's', 'agent': {**AGENT, 'output': {'schema': SCHEMA}}, 'input': 'go'})
        # 同参考实现：有等着的调用就是 requires_action，只在 end_turn 时解析回答。
        assert result['stopReason'] == 'requires_action'
        assert 'output' not in result
        assert [call['id'] for call in result['pending']] == ['c1']

    run(main)


def test_abort_in_a_step_with_an_external_call() -> None:
    async def main() -> None:
        entered = asyncio.Event()

        async def hang(value: Any, context: Mapping[str, Any]) -> dict[str, Any]:
            entered.set()
            await asyncio.Event().wait()
            return {'type': 'text', 'text': 'never'}

        both = {'type': 'tool-calls', 'calls': [LOOKUP_CALL, {'id': 'c2', 'input': {'text': 'hi'}}]}
        harness, store, _ = external_setup([both], executors=[FunctionExecutor('local').register(ECHO_TOOL, hang)])
        signal = AbortSignal()
        task = asyncio.ensure_future(harness.run({'session': 's', 'agent': AGENT, 'input': 'go'}, signal=signal))
        await asyncio.wait_for(entered.wait(), 5)
        signal.abort()
        result = await asyncio.wait_for(task, 5)
        # 这一步没走完：两个调用都补「结果未知」，没有等着的。
        assert result['stopReason'] == 'aborted'
        assert 'pending' not in result
        log = await store.list('s')
        [filler] = [entry for entry in log if entry['type'] == 'message' and entry['message']['role'] == 'tool']
        assert [(part['id'], part['output']['message']) for part in filler['message']['content']] == [
            ('c1', INTERRUPTED),
            ('c2', INTERRUPTED),
        ]
        assert pending_tool_calls(log) == []

    run(main)


# ---- 窗口和上下文：AgentSpec.window、AgentSpec.context ----


def dialogue(store: MemorySessionStore, session: str, turns: int, text: str = '一段不短的话' * 10) -> Any:
    return store.append(
        session,
        [
            {'type': 'message', 'message': {'role': role, 'content': f'{role} {turn}：{text}'}}
            for turn in range(turns)
            for role in ('user', 'assistant')
        ],
    )


def test_the_window_limits_the_history() -> None:
    async def main() -> None:
        harness, store, model = setup([{'type': 'text', 'text': '好'}] * 3)
        await dialogue(store, 'a', 10)
        await harness.run({'session': 'a', 'agent': {**AGENT, 'window': {'maxMessages': 3}}, 'input': '接着说'})
        # 最后三条，这一轮的输入是最后一条。
        assert [text.split('：')[0] for text in texts(model.requests[0])] == [
            'user:user 9',
            'model:assistant 9',
            'user:接着说',
        ]
        await harness.run({'session': 'a', 'agent': {**AGENT, 'window': {'maxTokens': 200}}, 'input': '再说'})
        assert 1 < len(texts(model.requests[1])) < 10
        await harness.run({'session': 'a', 'agent': {**AGENT, 'window': {}}, 'input': '全部'})
        # 空窗口不裁：原来的二十条、前两轮各两条、这一轮的输入。
        assert len(texts(model.requests[2])) == 10 * 2 + 2 * 2 + 1

    run(main)


def test_the_window_budget_leaves_room_for_instructions_and_tools() -> None:
    async def main() -> None:
        window = {'maxTokens': 600}
        harness, store, model = setup([{'type': 'text', 'text': '好'}] * 2)
        await dialogue(store, 'plain', 10)
        await dialogue(store, 'long', 10)
        await harness.run({'session': 'plain', 'agent': {**AGENT, 'window': window, 'tools': False}, 'input': '在吗'})
        long = {**AGENT, 'window': window, 'instructions': '要求' * 200}
        await harness.run({'session': 'long', 'agent': long, 'input': '在吗'})
        # 指令和工具定义先占掉一部分，剩给历史的少了。
        assert len(texts(model.requests[1])) < len(texts(model.requests[0]))

    run(main)


def test_overflow_trims_or_refuses() -> None:
    async def main() -> None:
        harness, store, model = setup([{'type': 'text', 'text': '好'}] * 3)
        strict = {**AGENT, 'context': {'overflow': {'maxTokens': 1, 'strategy': 'error'}}}
        refused = await harness.run({'session': 'e', 'agent': strict, 'input': '在吗'})
        assert refused['stopReason'] == 'error'
        assert refused['error']['type'] == 'context_overflow'
        assert refused['error']['retryable'] is False
        assert refused['error']['message'].endswith('over the limit of 1.')
        assert roles(await store.list('e'))[-2:] == ['ctx.error', 'ctx.run.ended']
        assert model.requests == []
        # trim：裁到放得下再调模型，不写摘要。
        await dialogue(store, 'long', 40)
        overflow = {'maxTokens': 1_500, 'strategy': 'trim'}
        result = await harness.run(
            {'session': 'long', 'agent': {**AGENT, 'context': {'overflow': overflow}}, 'input': '接着说'}
        )
        assert result['stopReason'] == 'end_turn', result.get('error')
        assert await store.list('long', types=['summary']) == []
        assert len(texts(model.requests[-1])) < 40
        [answer] = await store.list('long', types=['message'], last=1)
        assert answer['meta']['step']['estimatedInputTokens'] <= 1_500
        # 指令本身就放不下：裁到底还超，不调模型。
        huge = {
            **AGENT,
            'instructions': '要求' * 2_000,
            'context': {'overflow': {'maxTokens': 100, 'strategy': 'trim'}},
        }
        over = await harness.run({'session': 'huge', 'agent': huge, 'input': '在吗'})
        assert over['error']['type'] == 'context_overflow'
        assert over['error']['message'].endswith('even after compaction and trimming.')
        assert len(model.requests) == 1

    run(main)


def test_overflow_compacts_first() -> None:
    async def main() -> None:
        harness, store, model = setup([{'type': 'text', 'text': '早先聊了四十轮'}, {'type': 'text', 'text': '好'}])
        await dialogue(store, 'long', 40)
        agent = {**AGENT, 'context': {'overflow': {'maxTokens': 1_500}}}
        result = await harness.run({'session': 'long', 'agent': agent, 'input': '接着说'})
        assert result['stopReason'] == 'end_turn', result.get('error')
        [summary] = await store.list('long', types=['summary'])
        assert (summary['text'], summary['source']) == ('早先聊了四十轮', 'model')
        [event] = await store.list('long', kinds=['ctx.compacted'])
        assert event['source'] == 'context'
        assert event['data'] == {'covers': summary['covers'], 'summaryId': summary['id']}
        # 第一次调模型是写摘要：缺省的指令，记录从最早的一条开始；最近 12 条留着，这一轮的输入不在里面。
        [request] = model.requests[0]
        assert request.instructions == DEFAULT_SUMMARY_INSTRUCTIONS
        transcript = request.parts[0].content
        assert transcript.startswith('user: user 0：') and '接着说' not in transcript
        # 这一轮的模型看到的历史从摘要开始，没再裁剪。
        history = texts(model.requests[1])
        assert history[0] == f'user:{SUMMARY_PREFIX}早先聊了四十轮'
        assert len(history) == 1 + 12 and history[-1] == 'user:接着说'
        # 摘要和 `ctx.compacted` 是压缩写的，不算这一轮写的（同参考实现）。
        assert {entry['type'] for entry in result['recorded']} == {'event', 'message'}
        [answer] = await store.list('long', types=['message'], last=1)
        assert answer['meta']['step']['estimatedInputTokens'] <= 1_500
        # 下一轮从摘要接着：不超就不再压。
        await harness.run({'session': 'long', 'agent': agent, 'input': '还有呢'})
        assert len(model.requests) == 3
        assert len(await store.list('long', types=['summary'])) == 1

    run(main)


def test_compaction_options_and_the_summary_model() -> None:
    async def main() -> None:
        store = MemorySessionStore()
        model = ScriptedModel([{'type': 'text', 'text': '好'}])
        summarizer = ScriptedModel([{'type': 'text', 'text': '四十轮的摘要'}], model_name='summarizer')
        harness = PydanticAIHarness(
            store=store,
            executors=[echo_executor()],
            models={'scripted': model, 'cheap': summarizer},
            summary_model='cheap',
        )
        await dialogue(store, 'long', 40)
        compact = {'keep': 0, 'minimum': 1, 'instructions': '压成一句话'}
        agent = {**AGENT, 'context': {'overflow': {'maxTokens': 1_500, 'compact': compact}}}
        result = await harness.run({'session': 'long', 'agent': agent, 'input': '接着说'})
        assert result['stopReason'] == 'end_turn', result.get('error')
        [[request]] = summarizer.requests
        assert request.instructions == '压成一句话'
        # `keep` 至少是 1：这一轮刚记下的输入不进摘要，模型原样看到它。
        assert '接着说' not in request.parts[0].content
        assert texts(model.requests[0]) == [f'user:{SUMMARY_PREFIX}四十轮的摘要', 'user:接着说']

    run(main)


def test_without_a_summary_compaction_falls_back_to_trimming(caplog: pytest.LogCaptureFixture) -> None:
    async def main() -> None:
        script = [
            {'type': 'error', 'message': 'socket hang up'},
            {'type': 'text', 'text': '好'},
            {'type': 'text', 'text': '写了一半', 'truncated': True},
            {'type': 'text', 'text': '好'},
        ]
        harness, store, model = setup(script)
        agent = {**AGENT, 'context': {'overflow': {'maxTokens': 1_500}}}
        # 摘要模型出错、摘要被截断：都不写摘要，裁到放得下再调模型。
        for session in ('failed', 'truncated'):
            await dialogue(store, session, 40)
            result = await harness.run({'session': session, 'agent': agent, 'input': '接着说'})
            assert result['stopReason'] == 'end_turn', result.get('error')
            assert await store.list(session, types=['summary']) == []
            assert len(texts(model.requests[-1])) < 40
        assert 'compaction failed while the context is over its limit; trimming instead: socket hang up' in caplog.text
        assert 'summary hit maxOutputTokens' in caplog.text
        assert len(model.requests) == 4

    with caplog.at_level(logging.WARNING, logger='ctx_pydantic_ai'):
        run(main)


def test_a_run_that_is_not_recorded_does_not_compact() -> None:
    async def main() -> None:
        harness, store, model = setup([{'type': 'text', 'text': '好'}])
        await dialogue(store, 'long', 40)
        agent = {**AGENT, 'context': {'overflow': {'maxTokens': 1_500}}}
        result = await harness.run({'session': 'long', 'record': False, 'agent': agent, 'input': '接着说'})
        assert result['stopReason'] == 'end_turn', result.get('error')
        # 只调了这一轮的模型，没有写摘要：裁剪。
        [request] = model.requests
        assert len(texts(request)) < 40
        assert await store.list('long', types=['summary']) == []
        assert len(await store.list('long')) == 80

    run(main)


def test_abort_while_compacting() -> None:
    async def main() -> None:
        started = asyncio.Event()

        async def slow(messages: list[Any], info: AgentInfo) -> ModelResponse:
            started.set()
            await asyncio.sleep(30)
            return ModelResponse(parts=[TextPart('摘要')])

        store = MemorySessionStore()
        model = ScriptedModel([{'type': 'text', 'text': '好'}])
        harness = PydanticAIHarness(
            store=store, executors=[echo_executor()], models={'scripted': model}, summary_model=FunctionModel(slow)
        )
        await dialogue(store, 'long', 40)
        signal = AbortSignal()
        agent = {**AGENT, 'context': {'overflow': {'maxTokens': 1_500}}}
        task = asyncio.ensure_future(harness.run({'session': 'long', 'agent': agent, 'input': '接着说'}, signal=signal))
        await asyncio.wait_for(started.wait(), 10)
        signal.abort()
        result = await asyncio.wait_for(task, 10)
        assert result['stopReason'] == 'aborted'
        assert model.requests == []
        assert await store.list('long', types=['summary']) == []
        assert roles(await store.list('long'))[-1] == 'ctx.run.ended'

    run(main)


def test_the_parent_session_comes_first() -> None:
    async def main() -> None:
        harness, store, model = setup([{'type': 'text', 'text': '好'}] * 2)
        await store.append(
            'p',
            [
                {'type': 'message', 'message': {'role': 'user', 'content': '父会话的问题'}},
                {'type': 'message', 'message': {'role': 'assistant', 'content': '父会话的回答'}},
                {'type': 'message', 'message': {'role': 'user', 'content': '派出子任务之后的话'}},
            ],
        )
        agent = {**AGENT, 'context': {'inherit': {'session': 'p', 'upTo': 2}}}
        await harness.run({'session': 'p/task/1', 'agent': agent, 'input': '子任务'})
        assert texts(model.requests[0]) == ['user:父会话的问题', 'model:父会话的回答', 'user:子任务']
        # 子会话自己的日志里没有父会话的条目。
        assert [entry['message']['content'] for entry in await store.list('p/task/1', types=['message'])][:1] == [
            '子任务'
        ]
        await harness.run(
            {'session': 'p/task/2', 'agent': {**AGENT, 'context': {'inherit': {'session': 'p'}}}, 'input': '再来'}
        )
        assert len(texts(model.requests[1])) == 4

    run(main)


def test_the_first_step_records_its_estimate_and_the_next_run_calibrates() -> None:
    async def main() -> None:
        harness, store, _ = setup([{'type': 'text', 'text': '好'}] * 2)
        await harness.run({'session': 's', 'agent': AGENT, 'input': '在吗'})
        [answer] = await store.list('s', types=['message'], last=1)
        assert answer['meta']['step']['estimatedInputTokens'] > 0
        assert 'calibration' not in answer['meta']['step']
        # 上一轮实际用的输入是估算的两倍：这一轮的估算和窗口都按两倍收紧。
        sample = {'runId': 'r0', 'step': 0, 'estimatedInputTokens': 100, 'usage': {'inputTokens': 200}}
        await store.append(
            'c', [{'type': 'message', 'message': {'role': 'assistant', 'content': '旧'}, 'meta': {'step': sample}}]
        )
        await harness.run({'session': 'c', 'agent': {**AGENT, 'window': {'maxTokens': 10_000}}, 'input': '在吗'})
        [answer] = await store.list('c', types=['message'], last=1)
        assert answer['meta']['step']['calibration'] == 2
        assert answer['meta']['step']['estimatedInputTokens'] % 2 == 0

    run(main)
