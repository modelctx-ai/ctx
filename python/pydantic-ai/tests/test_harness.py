"""进程内的 harness：内存存储、按剧本回答的模型。契约测试（``test_conformance.py``）之外的语义在这里查。"""

from __future__ import annotations

import asyncio
import contextlib
from collections.abc import AsyncIterator, Callable, Coroutine, Mapping
from typing import Any

import pydantic_ai
import pytest
from pydantic_ai.messages import ModelRequest, ModelResponse, TextPart, UserPromptPart
from pydantic_ai.models.function import AgentInfo, FunctionModel

from ctx_pydantic_ai import (
    HARNESS_NAME,
    INTERRUPTED,
    RETRY_EVENT,
    AbortSignal,
    FunctionExecutor,
    MemorySessionStore,
    PydanticAIHarness,
)
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
    ({'window': {'maxMessages': 10}}, 'AgentSpec.window and AgentSpec.context are not supported'),
    ({'context': {'facts': {}}}, 'AgentSpec.window and AgentSpec.context are not supported'),
    ({'settings': {'providerOptions': {'openai': {}}}}, 'AgentSpec.settings.providerOptions not supported'),
    ({'settings': {'timeoutMs': 0}}, 'AgentSpec.settings.timeoutMs must be a positive number.'),
    ({'permissions': {'default': 'ask'}}, 'AgentSpec.permissions "ask" is not supported'),
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
