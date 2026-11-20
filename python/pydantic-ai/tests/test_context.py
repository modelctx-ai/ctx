"""上下文：事实来源、事件规则和按名字选的投影。

harness 交给模型的调用（指令、历史和最后的提示、第一步记下的估算和校准）对同一组日志、同样配置的来源和投影，和参考实现
builder 的 ``build`` 比（``ctx_ts.mjs build``）；收集事实的细节（并行、超时、告警）和 harness 的接法在这里另查。
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncIterator, Mapping
from typing import Any

import pytest
from pydantic_ai.messages import ModelMessage, ModelResponse, TextPart
from pydantic_ai.models.function import AgentInfo, FunctionModel

from conftest import projection_of, sources_of, ts_build
from ctx_pydantic_ai import (
    AbortSignal,
    ContextSource,
    EventRule,
    MemorySessionStore,
    ProjectionOptions,
    PydanticAIHarness,
)
from ctx_pydantic_ai.compact import DEFAULT_SUMMARY_INSTRUCTIONS
from ctx_pydantic_ai.context import DEFAULT_SOURCE_TIMEOUT_MS, collect_facts, render_facts
from ctx_pydantic_ai.messages import text_of, to_model_messages
from ctx_pydantic_ai.testing import ECHO_TOOL, ScriptedModel, echo_executor

#: harness 交给模型的工具定义：回显工具，绑在 `local` 上。
TOOLS = [{**ECHO_TOOL, 'executor': 'local'}]


class Capture(FunctionModel):
    """记下每次调用收到的消息和 ``AgentInfo``，回一句 ``好``。"""

    def __init__(self) -> None:
        self.calls: list[tuple[list[ModelMessage], AgentInfo]] = []
        super().__init__(self._respond, stream_function=self._stream, model_name='capture')

    async def _respond(self, messages: list[ModelMessage], info: AgentInfo) -> ModelResponse:
        self.calls.append((list(messages), info))
        return ModelResponse(parts=[TextPart('好')])

    async def _stream(self, messages: list[ModelMessage], info: AgentInfo) -> AsyncIterator[str]:
        self.calls.append((list(messages), info))
        yield '好'


def parts(messages: list[ModelMessage]) -> list[tuple[Any, ...]]:
    """消息里的各部分，按顺序摊平：pydantic-ai 合并相邻请求的方式不影响比较。"""
    out: list[tuple[Any, ...]] = []
    for message in messages:
        for part in message.parts:
            kind = type(part).__name__
            if kind == 'UserPromptPart':
                out.append(('user', part.content))
            elif kind == 'TextPart':
                out.append(('text', part.content))
            elif kind == 'ToolCallPart':
                out.append(('call', part.tool_call_id, part.tool_name, part.args_as_dict()))
            elif kind == 'ToolReturnPart':
                out.append(('return', part.tool_call_id, part.tool_name, part.content))
            else:
                out.append((kind,))
    return out


def chat(count: int, text: str = '一段话') -> list[dict[str, Any]]:
    return [
        {
            'type': 'message',
            'message': {'role': 'user' if index % 2 == 0 else 'assistant', 'content': f'{index}：{text}'},
        }
        for index in range(count)
    ]


def event(kind: str, data: Any = None) -> dict[str, Any]:
    return {'type': 'event', 'kind': kind, **({} if data is None else {'data': data})}


def step_meta(estimated: int, actual: int) -> dict[str, Any]:
    meta = {'runId': 'r0', 'step': 0, 'estimatedInputTokens': estimated, 'usage': {'inputTokens': actual}}
    return {'type': 'message', 'message': {'role': 'assistant', 'content': '上一轮的回答'}, 'meta': {'step': meta}}


SOURCES = [
    {'name': 'clock', 'text': '  下午三点 '},
    {'name': 'weather', 'text': '晴'},
    {'name': 'blank', 'text': '   '},
    {'name': 'nothing'},
]
TICKS = {'events': {'tick': {'fold': True, 'render': 'user'}, 'note': {'render': 'system'}}}
TICKING = [
    *chat(2),
    event('tick', {'n': 1}),
    event('tick', {'n': 2}),
    event('note', {'text': '带伞'}),
    *chat(3, '又一段'),
    event('tick', {'n': 3}),
]

CASES: dict[str, dict[str, Any]] = {
    'facts in the instructions': {
        'entries': chat(2),
        'sources': SOURCES,
        'agent': {'instructions': '简短回答', 'context': {'facts': {'heading': '现在：'}}},
    },
    'facts in the prompt': {
        'entries': chat(2),
        'sources': SOURCES,
        'factsPlacement': 'prompt',
        'agent': {'instructions': '简短回答'},
        'prompt': '（临时）',
    },
    'facts as the whole prompt': {'entries': chat(2), 'sources': SOURCES, 'factsPlacement': 'prompt'},
    'facts before a list prompt': {
        'entries': chat(2),
        'sources': SOURCES,
        'agent': {'context': {'facts': {'placement': 'prompt'}}},
        'prompt': [{'type': 'text', 'text': '看这个'}],
    },
    'chosen sources': {
        'entries': chat(2),
        'sources': SOURCES,
        'agent': {'context': {'facts': {'sources': ['weather', 'missing'], 'heading': ''}}},
    },
    'no facts': {'entries': chat(2), 'sources': SOURCES, 'agent': {'context': {'facts': False}}},
    'a failing and a slow source': {
        'entries': chat(2),
        'sources': [
            {'name': 'broken', 'error': 'boom'},
            {'name': 'slow', 'text': '太晚了', 'delayMs': 400},
            {'name': 'clock', 'text': '下午三点'},
        ],
        'sourceTimeoutMs': 50,
    },
    'events into the history and the instructions': {
        'entries': TICKING,
        'projection': TICKS,
        'agent': {'instructions': '简短回答'},
    },
    'a named projection': {
        'entries': TICKING,
        'projections': {'brief': {'events': {'tick': {'render': 'pair'}}, 'window': {'maxMessages': 4}}},
        'agent': {'context': {'projection': 'brief'}},
    },
    'the default projection has its own window': {
        'entries': chat(10),
        'projection': {'window': {'maxMessages': 3}},
    },
    'AgentSpec.window replaces it': {
        'entries': chat(10),
        'projection': {'window': {'maxMessages': 3}},
        'agent': {'window': {'maxMessages': 6}},
    },
    'an empty AgentSpec.window means no window': {
        'entries': chat(10),
        'projection': {'window': {'maxMessages': 3}},
        'agent': {'window': {}},
    },
    'facts take their share of the budget': {
        'entries': chat(12, '一段不短的话' * 6),
        'sources': [{'name': 'notes', 'text': '记事：' + '很长的一段背景' * 40}],
        'agent': {'instructions': '简短回答', 'window': {'maxTokens': 700}},
    },
    'calibrated': {
        'entries': [*chat(12, '一段不短的话' * 6), step_meta(400, 800), *chat(1)],
        'sources': SOURCES,
        'agent': {'window': {'maxTokens': 900}},
    },
    'an own estimate is not calibrated': {
        'entries': [*chat(12, '一段不短的话' * 6), step_meta(400, 800), *chat(1)],
        'projection': {'estimate': 'double'},
        'agent': {'window': {'maxTokens': 900}},
        'prompt': '（临时）',
    },
    'a rendered summary goes to the instructions': {
        'entries': [*chat(4), {'type': 'summary', 'text': '前面聊了天气', 'covers': 3}, *chat(2)],
        'sources': SOURCES,
        'projection': {'summary': 'system'},
        'agent': {'instructions': '简短回答'},
    },
    'redacted messages': {
        'entries': [*chat(2), {'type': 'message', 'message': {'role': 'user', 'content': 'secret 是 42'}}, *chat(1)],
        'projection': {'message': 'redact'},
    },
    'the parent session with the same rules': {
        'entries': chat(3, '子任务'),
        'parent': TICKING,
        'projection': {**TICKS, 'window': {'maxTokens': 160}},
        'agent': {'context': {'inherit': {'session': 'p'}}},
    },
    'trimmed with truncate': {
        'entries': [*chat(2), {'type': 'message', 'message': {'role': 'user', 'content': '很长' * 600}}],
        'sources': SOURCES,
        'projection': {**TICKS, 'estimate': 'double'},
        'agent': {'window': {'maxTokens': 300, 'truncate': True}},
    },
}


def strip(entry: Mapping[str, Any]) -> dict[str, Any]:
    """读出来的条目 → 追加用的形状：``seq``、``id`` 由存储重新给，``at`` 照留。"""
    return {key: value for key, value in entry.items() if key not in ('id', 'seq', 'session', 'v')}


async def python_side(case: dict[str, Any]) -> dict[str, Any]:
    store = MemorySessionStore()
    await store.append('s', case['entries'])
    if case.get('parent'):
        await store.append('p', case['parent'])
    model = Capture()
    harness = PydanticAIHarness(
        store=store,
        executors=[echo_executor()],
        models={'capture': model},
        projection=projection_of(case.get('projection')),
        projections={name: projection_of(recipe) for name, recipe in (case.get('projections') or {}).items()},
        sources=sources_of(case.get('sources')),
        source_timeout_ms=case.get('sourceTimeoutMs', DEFAULT_SOURCE_TIMEOUT_MS),
        facts_placement=case.get('factsPlacement', 'instructions'),
    )
    request: dict[str, Any] = {'session': 's', 'agent': {'model': 'capture', **case.get('agent', {})}, 'input': '在吗'}
    if 'prompt' in case:
        request['prompt'] = case['prompt']
    result = await harness.run(request)
    assert result['stopReason'] == 'end_turn', result
    log = await store.list('s')
    started = max(index for index, entry in enumerate(log) if entry.get('kind') == 'ctx.run.started')
    [(messages, info)] = model.calls
    meta = next(entry for entry in log if entry['seq'] > log[started]['seq'] and 'meta' in entry)['meta']['step']
    return {
        # 组装那一刻的日志：这一轮的 `ctx.run.started` 和输入为止。
        'prepared': [strip(entry) for entry in log[: started + 2]],
        'parent': [strip(entry) for entry in await store.list('p')],
        'instructions': info.instructions,
        'parts': parts(messages),
        'tokens': meta['estimatedInputTokens'],
        'calibration': meta.get('calibration'),
    }


def build_request(case: dict[str, Any]) -> dict[str, Any]:
    """harness 交给 builder 的 ``BuildRequest``，同参考实现的 harness：输入已经在日志里。"""
    agent = case.get('agent', {})
    context = agent.get('context') or {}
    request: dict[str, Any] = {'tools': TOOLS}
    for key, value in (
        ('instructions', agent.get('instructions')),
        ('prompt', case.get('prompt')),
        ('window', agent.get('window')),
        ('facts', context.get('facts')),
        ('projection', context.get('projection')),
        ('inherit', context.get('inherit')),
    ):
        if value is not None:
            request[key] = value
    return request


@pytest.fixture(scope='module')
def compared(node: str) -> dict[str, tuple[dict[str, Any], dict[str, Any]]]:
    """每一组：harness 这边的结果，和同一份日志在 TypeScript 的 builder 里 ``build`` 一次的结果（一个 node 进程跑完）。"""
    names = list(CASES)
    mine = {name: asyncio.run(python_side(CASES[name])) for name in names}
    payload = [
        {
            'entries': mine[name]['prepared'],
            'parent': mine[name]['parent'],
            'request': build_request(CASES[name]),
            **{
                key: CASES[name][key]
                for key in ('sources', 'projection', 'projections', 'factsPlacement', 'sourceTimeoutMs')
                if key in CASES[name]
            },
        }
        for name in names
    ]
    theirs = ts_build(node, payload)
    return {name: (mine[name], one) for name, one in zip(names, theirs, strict=True)}


@pytest.mark.parametrize('name', list(CASES))
def test_the_call_matches_the_reference_builder(
    name: str, compared: dict[str, tuple[dict[str, Any], dict[str, Any]]]
) -> None:
    mine, theirs = compared[name]
    assert 'thrown' not in theirs, theirs
    call = theirs['call']
    assert mine['instructions'] == call['instructions']
    assert mine['parts'] == parts(to_model_messages(call['messages']))
    assert mine['tokens'] == call['tokens']
    assert mine['calibration'] == call['calibration']


def test_the_cases_exercise_what_they_name(compared: dict[str, tuple[dict[str, Any], dict[str, Any]]]) -> None:
    """比的不只是没有事实、没有规则的路径。"""

    def call(name: str) -> dict[str, Any]:
        return compared[name][1]['call']

    assert call('facts in the instructions')['instructions'] == '简短回答\n\n现在：\n下午三点\n晴'
    assert call('facts in the prompt')['messages'][-1] == {'role': 'user', 'content': '下午三点\n晴\n\n（临时）'}
    assert call('facts as the whole prompt')['messages'][-1] == {'role': 'user', 'content': '下午三点\n晴'}
    assert call('chosen sources')['facts'] == [{'source': 'weather', 'text': '晴'}]
    assert call('no facts')['facts'] == []
    assert call('a failing and a slow source')['facts'] == [{'source': 'clock', 'text': '下午三点'}]
    assert call('events into the history and the instructions')['instructions'] == '简短回答\n\nnote {"text":"带伞"}'
    assert {'role': 'assistant', 'content': 'noted'} in call('a named projection')['messages']
    assert len(call('the default projection has its own window')['messages']) < len(
        call('AgentSpec.window replaces it')['messages']
    )
    assert len(call('an empty AgentSpec.window means no window')['messages']) == 11
    assert call('calibrated')['calibration'] == 2
    assert call('an own estimate is not calibrated')['calibration'] is None
    assert call('a rendered summary goes to the instructions')['instructions'].endswith('Earlier: 前面聊了天气')
    assert all('secret' not in str(message) for message in call('redacted messages')['messages'])
    inherited = call('the parent session with the same rules')['messages']
    assert {'role': 'user', 'content': 'tick {"n":1}\ntick {"n":2}'} in inherited
    assert 'characters omitted' in str(call('trimmed with truncate')['messages'])


# ---- 收集事实 ----


def run(coroutine: Any) -> Any:
    return asyncio.run(coroutine)


def test_facts_are_collected_in_parallel_and_kept_in_order(caplog: pytest.LogCaptureFixture) -> None:
    seen: list[Mapping[str, Any]] = []

    async def slow(context: Mapping[str, Any]) -> str:
        seen.append(context)
        await asyncio.sleep(0.05)
        return '慢的'

    def sync(context: Mapping[str, Any]) -> str:
        return '  同步的\n'

    async def main() -> None:
        signal = AbortSignal()
        sources = [
            ContextSource('slow', slow),
            ContextSource('sync', sync),
            ContextSource('number', lambda context: 42),  # type: ignore[arg-type,return-value]
        ]
        loop = asyncio.get_running_loop()
        started = loop.time()
        facts = await collect_facts([*sources, ContextSource('slow2', slow)], session='s', signal=signal)
        assert loop.time() - started < 0.09
        assert facts == [
            {'source': 'slow', 'text': '慢的'},
            {'source': 'sync', 'text': '同步的'},
            {'source': 'slow2', 'text': '慢的'},
        ]
        assert seen[0] == {'session': 's', 'signal': signal}
        assert await collect_facts(sources, session='s', only=['sync', 'nope', 'sync']) == [
            {'source': 'sync', 'text': '同步的'}
        ]

    with caplog.at_level(logging.WARNING, logger='ctx_pydantic_ai.context'):
        run(main())
    assert [record.getMessage() for record in caplog.records] == ['context source "nope" is not registered']


def test_a_failing_or_slow_source_only_loses_itself(caplog: pytest.LogCaptureFixture) -> None:
    cancelled: list[bool] = []

    async def hangs(context: Mapping[str, Any]) -> str:
        try:
            await asyncio.sleep(10)
        except asyncio.CancelledError:
            cancelled.append(True)
            raise
        return 'never'

    def broken(context: Mapping[str, Any]) -> str:
        raise RuntimeError('boom')

    async def main() -> None:
        sources = [ContextSource('hangs', hangs), ContextSource('broken', broken), ContextSource('ok', lambda c: '好')]
        assert await collect_facts(sources, session='s', timeout_ms=20) == [{'source': 'ok', 'text': '好'}]
        await asyncio.sleep(0)
        assert cancelled == [True]

    with caplog.at_level(logging.WARNING, logger='ctx_pydantic_ai.context'):
        run(main())
    assert [record.getMessage() for record in caplog.records] == [
        'context source "broken" failed: boom',
        'context source "hangs" failed: context source "hangs" timed out after 20ms',
    ]


def test_cancelling_the_collection_cancels_the_sources() -> None:
    cancelled: list[bool] = []

    async def hangs(context: Mapping[str, Any]) -> str:
        try:
            await asyncio.sleep(10)
        except asyncio.CancelledError:
            cancelled.append(True)
            raise
        return 'never'

    async def main() -> None:
        task = asyncio.ensure_future(collect_facts([ContextSource('hangs', hangs)], session='s'))
        await asyncio.sleep(0.01)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        await asyncio.sleep(0)
        assert cancelled == [True]

    run(main())


def test_render_facts() -> None:
    facts = [{'source': 'a', 'text': '一'}, {'source': 'b', 'text': '二'}]
    assert render_facts(facts) == '一\n二'
    assert render_facts(facts, '标题') == '标题\n一\n二'
    assert render_facts([], '标题') == '标题'


# ---- harness 的接法 ----


def harness_with(**options: Any) -> tuple[PydanticAIHarness, MemorySessionStore, Capture]:
    store = MemorySessionStore()
    model = Capture()
    harness = PydanticAIHarness(store=store, executors=[echo_executor()], models={'capture': model}, **options)
    return harness, store, model


def test_an_unknown_projection_lists_the_registered_names() -> None:
    async def main() -> None:
        calls: list[str] = []
        harness, _, model = harness_with(
            projections={'brief': ProjectionOptions()},
            sources=[ContextSource('clock', lambda context: calls.append('clock') or '三点')],
        )
        agent = {'model': 'capture', 'context': {'projection': 'nope'}}
        result = await harness.run({'session': 's', 'agent': agent, 'input': '在吗'})
        assert result['error'] == {
            'message': 'Unknown projection "nope". Registered: default, brief.',
            'type': 'not_found',
        }
        # 名字不对就不收事实、不调模型。
        assert calls == [] and model.calls == []
        brief = await harness.run(
            {'session': 't', 'agent': {**agent, 'context': {'projection': 'brief'}}, 'input': '在吗'}
        )
        assert brief['stopReason'] == 'end_turn'
        assert calls == ['clock']

    run(main())


@pytest.mark.parametrize(
    ('facts', 'message'),
    [
        ({'sources': 'clock'}, 'AgentSpec.context.facts.sources must be a list of strings.'),
        ({'sources': ['clock', 1]}, 'AgentSpec.context.facts.sources must be a list of strings.'),
        ({'placement': 'system'}, 'AgentSpec.context.facts.placement must be "instructions" or "prompt".'),
        ({'heading': 3}, 'AgentSpec.context.facts.heading must be a string.'),
    ],
)
def test_a_bad_facts_spec_is_invalid_request(facts: Any, message: str) -> None:
    async def main() -> None:
        harness, _, model = harness_with()
        agent = {'model': 'capture', 'context': {'facts': facts}}
        result = await harness.run({'session': 's', 'agent': agent, 'input': '在吗'})
        assert result['error'] == {'message': message, 'type': 'invalid_request'}
        assert model.calls == []

    run(main())


def test_facts_placement_is_checked() -> None:
    with pytest.raises(ValueError, match='facts_placement'):
        PydanticAIHarness(store=MemorySessionStore(), facts_placement='system')  # type: ignore[arg-type]


def test_facts_are_collected_once_per_run_and_never_logged() -> None:
    async def main() -> None:
        calls: list[Mapping[str, Any]] = []

        def clock(context: Mapping[str, Any]) -> str:
            calls.append(context)
            return '现在是下午三点'

        harness, store, model = harness_with(sources=[ContextSource('clock', clock)])
        await store.append('s', chat(30, '一段不短的话' * 6))
        # 超窗时只裁剪：重新组装沿用这一轮收到的事实，不再收一遍。
        agent = {'model': 'capture', 'context': {'overflow': {'maxTokens': 600, 'strategy': 'trim'}}}
        result = await harness.run({'session': 's', 'agent': agent, 'input': '在吗'})
        assert result['stopReason'] == 'end_turn'
        assert len(calls) == 1 and calls[0]['session'] == 's'
        [(_, info)] = model.calls
        assert info.instructions == '现在是下午三点'
        assert '下午三点' not in str(await store.list('s'))

    run(main())


def test_compaction_follows_the_default_projection() -> None:
    """超窗压缩按缺省投影的规则写记录，这一轮选的是别的投影也一样（同参考实现：压缩用 ``default``）。"""

    async def main() -> None:
        store = MemorySessionStore()
        model = ScriptedModel([{'type': 'text', 'text': '摘要'}, {'type': 'text', 'text': '好'}])
        noted = EventRule(render=lambda events: {'role': 'user', 'content': f'事件 {len(events)} 条'}, fold=True)
        harness = PydanticAIHarness(
            store=store,
            executors=[echo_executor()],
            models={'scripted': model},
            projection=ProjectionOptions(events={'tick': noted}),
            projections={'plain': ProjectionOptions()},
        )
        await store.append('s', [*chat(4), event('tick'), event('tick'), *chat(30, '一段不短的话' * 6)])
        agent = {
            'model': 'scripted',
            'context': {'projection': 'plain', 'overflow': {'maxTokens': 900, 'compact': {'keep': 4}}},
        }
        result = await harness.run({'session': 's', 'agent': agent, 'input': '在吗'})
        assert result['stopReason'] == 'end_turn'
        transcript = model.requests[0]
        assert DEFAULT_SUMMARY_INSTRUCTIONS in str(transcript)
        assert 'user: 事件 2 条' in str(transcript)
        # 这一轮的历史按 `plain`：事件不可见。
        assert '事件' not in str(model.requests[1])

    run(main())


def test_input_that_is_only_whitespace_is_not_recorded() -> None:
    """同参考实现的 ``isEmptyContent``：只有空白的输入不记，也不算进提示。"""

    async def main() -> None:
        harness, store, model = harness_with()
        await store.append('s', chat(1))
        result = await harness.run({'session': 's', 'agent': {'model': 'capture'}, 'input': '  \n'})
        assert result['stopReason'] == 'end_turn'
        assert [text_of(entry['message']) for entry in await store.list('s', types=['message'])] == ['0：一段话', '好']
        [(messages, _)] = model.calls
        assert parts(messages) == [('user', '0：一段话')]

    run(main())
