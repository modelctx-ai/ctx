"""协议函数：常量和 TypeScript 的协议包一致，纯函数对同一组输入给出和它一样的结果。"""

from __future__ import annotations

import re
from typing import Any

import pytest

from conftest import REPO, Evaluate
from ctx_pydantic_ai import harness, messages, protocol
from ctx_pydantic_ai.store import _filter


def _ts_constant(path: str, name: str) -> str:
    source = (REPO / path).read_text(encoding='utf-8')
    match = re.search(rf'(?:export )?const {name}(?:: [^=]+)? = (.+?);\n', source, re.DOTALL)
    assert match is not None, f'{name} not found in {path}'
    return match[1]


def test_constants_match_the_typescript_packages() -> None:
    assert _ts_constant('packages/protocol/src/discovery.ts', 'PROTOCOL_VERSION') == repr(protocol.PROTOCOL_VERSION)
    assert int(_ts_constant('packages/protocol/src/version.ts', 'ENTRY_VERSION')) == protocol.ENTRY_VERSION
    assert (
        int(_ts_constant('packages/protocol/src/tools.ts', 'DEFAULT_MAX_TOOL_OUTPUT_CHARS').replace('_', ''))
        == protocol.DEFAULT_MAX_TOOL_OUTPUT_CHARS
    )
    assert _ts_constant('packages/protocol/src/harness.ts', 'REDACTED_HEADER') == repr(protocol.REDACTED_HEADER)
    assert _ts_constant('packages/protocol/src/harness.ts', 'TOOL_RESULT_KEY_PREFIX') == repr(
        protocol.TOOL_RESULT_KEY_PREFIX
    )
    assert _ts_constant('packages/core/src/harness.ts', 'INTERRUPTED_TOOL_RESULT') == repr(harness.INTERRUPTED)
    assert _ts_constant('packages/protocol/src/context.ts', 'MISSING_RESULT') == repr(messages.MISSING_RESULT)
    allowed = _ts_constant('packages/remote/src/server.ts', 'DEFAULT_ALLOWED_SETTINGS')
    assert re.findall(r"'([^']+)'", allowed) == list(protocol.DEFAULT_ALLOWED_SETTINGS)


OVERFLOW = [
    ("This model's maximum context length is 8192 tokens.", None),
    ('prompt is too long: 250000 tokens > 200000 maximum', 400),
    ('Request Entity Too Large', 413),
    ('Too many tokens per minute, slow down', 429),
    ('{"error":{"code":"context_length_exceeded"}}', None),
    ('Input is too long for requested model.', None),
    ('The input token count (1200000) exceeds the maximum number of tokens allowed (1048576).', 400),
    ('Please reduce the length of the messages or completion.', None),
    ('request_too_large', None),
    ('Your input exceeds the context window of this model', None),
    ('The context window was exceeded', None),
    ('Invalid API key', 401),
    ('prompt is too long', 403),
    ('model not found', 404),
    ('Internal server error', 500),
    ('', None),
]


def test_context_overflow_text_matches_typescript(ts: Evaluate) -> None:
    expected = ts([('isContextOverflowText', [text, status]) for text, status in OVERFLOW])
    assert [protocol.is_context_overflow_text(text, status) for text, status in OVERFLOW] == expected


OUTPUTS = [
    ({'type': 'text', 'text': 'short'}, 10),
    ({'type': 'text', 'text': 'x' * 50}, 10),
    ({'type': 'text', 'text': '😀' * 10}, 5),
    ({'type': 'text', 'text': '中文' * 10}, 7),
    ({'type': 'error', 'message': 'e' * 30, 'retryable': True}, 10),
    ({'type': 'json', 'value': {'a': 'b' * 40}}, 20),
    ({'type': 'json', 'value': {'中': '文', 'n': [1, 2, None, True]}}, 100),
    ({'type': 'json', 'value': None}, 3),
    (
        {
            'type': 'content',
            'parts': [
                {'type': 'text', 'text': 'a' * 8},
                {'type': 'text', 'text': 'b' * 8},
                {'type': 'text', 'text': 'c'},
            ],
        },
        10,
    ),
    (
        {
            'type': 'content',
            'parts': [
                {'type': 'file', 'mediaType': 'image/png', 'data': {'type': 'data', 'data': 'A' * 40}},
                {'type': 'text', 'text': 'hi'},
            ],
        },
        10,
    ),
    (
        {
            'type': 'content',
            'parts': [
                {'type': 'text', 'text': 'hi'},
                {'type': 'file', 'mediaType': 'text/plain', 'data': {'type': 'text', 'text': 't' * 5}},
                {'type': 'file', 'mediaType': 'image/png', 'data': {'type': 'url', 'url': 'https://example.com/a.png'}},
                {'type': 'text', 'text': 'z' * 20},
            ],
        },
        10,
    ),
    ({'type': 'text', 'text': 'x' * 50}, None),
    ({'type': 'text', 'text': 'x' * 50}, 0),
    ({'type': 'text', 'text': 'x' * 50}, 12.7),
]


def test_limit_tool_output_matches_typescript(ts: Evaluate) -> None:
    expected = ts([('limitToolOutput', [output, limit]) for output, limit in OUTPUTS])
    assert [protocol.limit_tool_output(output, limit) for output, limit in OUTPUTS] == expected


def test_limit_tool_output_counts_utf16_units() -> None:
    # 一个 emoji 是两个码元：上限 5 只留得下两个，不把第三个切成半个。
    clipped = protocol.limit_tool_output({'type': 'text', 'text': '😀' * 10}, 5)
    assert clipped['text'].startswith('😀😀\n[… truncated 16 more characters')
    assert protocol.utf16_length('a😀中') == 4


TOOLS = [
    {'name': 'a', 'inputSchema': {}, 'executor': 'x', 'tags': ['read'], 'source': 'local'},
    {'name': 'b', 'inputSchema': {}, 'executor': 'x', 'tags': ['write'], 'source': 'mcp:git'},
    {'name': 'c', 'inputSchema': {}, 'executor': 'y'},
]
SELECTIONS = [
    True,
    False,
    ['c', 'a', 'zzz'],
    {'names': ['a', 'b']},
    {'tags': ['write', 'other']},
    {'sources': ['local']},
    {'names': ['a', 'b'], 'tags': ['read']},
    {},
    None,
]


def test_select_tools_matches_typescript(ts: Evaluate) -> None:
    expected = ts([('selectTools', [TOOLS, selection]) for selection in SELECTIONS])
    actual = [protocol.select_tools(TOOLS, True if selection is None else selection) for selection in SELECTIONS]
    assert actual == expected


PERMISSIONS = [
    (None, 'a'),
    ({}, 'a'),
    ({'default': 'deny'}, 'a'),
    ({'default': 'deny', 'tools': {'a': 'allow'}}, 'a'),
    ({'tools': {'a': 'ask'}}, 'a'),
    ({'tools': {'a': 'ask'}}, 'b'),
]


def test_tool_permission_matches_typescript(ts: Evaluate) -> None:
    expected = ts([('toolPermission', [permissions, tool]) for permissions, tool in PERMISSIONS])
    assert [protocol.tool_permission(permissions, tool) for permissions, tool in PERMISSIONS] == expected


SPECS = [
    {'model': 'openai:gpt-5'},
    {
        'model': 'm',
        'name': 'helper',
        'instructions': '简短回答',
        'tools': ['echo'],
        'maxSteps': 3,
        'output': {'schema': {'type': 'object'}},
        'toolChoice': {'tool': 'echo'},
        'permissions': {'default': 'deny'},
        'budget': {'maxTotalTokens': 100},
        'environment': {'image': 'node'},
        'settings': {'temperature': 0, 'headers': {'authorization': 'Bearer secret', 'x-team': 'a'}},
    },
    {'model': 'm', 'settings': {'seed': 1}},
]


def test_agent_spec_to_json_matches_typescript(ts: Evaluate) -> None:
    expected = ts([('agentSpecToJson', [spec]) for spec in SPECS])
    actual = [protocol.agent_spec_to_json(spec) for spec in SPECS]
    assert actual == expected
    assert actual[1]['settings']['headers'] == {'authorization': '[redacted]', 'x-team': '[redacted]'}


PARENTS = [
    None,
    {'session': 's', 'runId': 'r'},
    {'session': 's', 'runId': 'r', 'toolCallId': 'c'},
    {'session': '', 'runId': 'r'},
    {'session': 's'},
    {'session': 's', 'runId': 'r', 'toolCallId': 3},
    'parent',
    [],
]


def test_run_parent_problem_matches_typescript(ts: Evaluate) -> None:
    expected = ts([('runParentProblem', [parent]) for parent in PARENTS])
    assert [protocol.run_parent_problem(parent) for parent in PARENTS] == expected


def _entry(seq: int, at: int | None = None, **fields: object) -> dict[str, object]:
    return {'id': f'e{seq}', 'session': 's', 'seq': seq, 'at': seq * 10 if at is None else at, 'v': 1, **fields}


def _message(seq: int, role: str, content: object, at: int | None = None) -> dict[str, object]:
    return _entry(seq, at, type='message', message={'role': role, 'content': content})


def _call(call_id: str, **extra: object) -> dict[str, object]:
    return {'type': 'tool-call', 'id': call_id, 'name': 'echo', 'input': {'text': call_id}, **extra}


def _result(call_id: str) -> dict[str, object]:
    return {'type': 'tool-result', 'id': call_id, 'name': 'echo', 'output': {'type': 'text', 'text': call_id}}


LOGS = {
    'plain': [_message(1, 'user', '你好'), _message(2, 'assistant', '你好！')],
    'paired': [
        _message(1, 'user', 'q'),
        _message(2, 'assistant', [{'type': 'text', 'text': 'calling'}, _call('c1'), _call('c2')]),
        _message(3, 'tool', [_result('c2')]),
        _message(4, 'tool', [_result('c1')]),
        _message(5, 'assistant', 'done'),
    ],
    'missing and orphan': [
        _message(1, 'user', 'q'),
        _message(2, 'assistant', [_call('c1'), _call('c2')]),
        _message(3, 'tool', [_result('c1'), _result('zzz')]),
        _message(4, 'tool', [_result('nobody')]),
        _message(5, 'user', 'again'),
    ],
    'result after another message': [
        _message(1, 'assistant', [_call('c1')]),
        _message(2, 'user', 'interrupting'),
        _message(3, 'tool', [_result('c1')]),
    ],
    'provider executed': [
        _message(1, 'user', 'search'),
        _message(
            2, 'assistant', [_call('web', providerExecuted=True), _result('web'), _call('c1', providerExecuted=True)]
        ),
    ],
    'events do not split a step': [
        _message(1, 'assistant', [_call('c1')]),
        _entry(2, type='event', kind='ctx.run.started', data={'runId': 'r'}),
        _message(3, 'tool', [_result('c1')]),
    ],
    'summary': [
        _message(1, 'user', 'old'),
        _message(2, 'assistant', [_call('c1')]),
        _entry(3, type='summary', text='first', covers=1),
        _message(4, 'tool', [_result('c1')]),
        _message(5, 'user', 'new'),
        _entry(6, type='summary', text='second', covers=2),
        _entry(7, type='summary', text='later but smaller', covers=1),
    ],
    'same covers: the later summary wins': [
        _message(1, 'user', 'old'),
        _entry(2, type='summary', text='a', covers=1),
        _entry(3, type='summary', text='b', covers=1),
        _message(4, 'user', 'new'),
    ],
    'ordered by at': [
        _message(1, 'user', 'first'),
        _message(2, 'user', 'third', at=100),
        _message(3, 'user', 'second', at=15),
    ],
}


@pytest.mark.parametrize('name', list(LOGS))
def test_projection_matches_typescript(ts: Evaluate, name: str) -> None:
    [expected] = ts([('project', [LOGS[name]])])
    assert messages.project(LOGS[name]) == expected


FILTERS = [
    {},
    {'after': 2},
    {'last': 2},
    {'last': 0},
    {'limit': 2},
    {'after': 1, 'limit': 1},
    {'last': 3, 'limit': 1},
    {'types': ['event']},
    {'kinds': ['ctx.run.started']},
    {'types': ['message'], 'last': 1},
    {'atAfter': 25},
]


def test_list_filters_match_typescript(ts: Evaluate) -> None:
    log = [
        _message(1, 'user', 'a'),
        _entry(2, type='event', kind='ctx.run.started', data={}),
        _message(3, 'assistant', 'b'),
        _entry(4, type='event', kind='ctx.run.ended', data={}),
        _message(5, 'user', 'c'),
    ]
    expected = ts([('filterEntries', [log, options]) for options in FILTERS])
    actual = [
        _filter(
            log,
            after=options.get('after'),
            last=options.get('last'),
            limit=options.get('limit'),
            types=options.get('types'),
            kinds=options.get('kinds'),
            at_after=options.get('atAfter'),
        )
        for options in FILTERS
    ]
    assert actual == expected


def _started(seq: int, run_id: Any) -> dict[str, Any]:
    return {'seq': seq, 'type': 'event', 'kind': 'ctx.run.started', 'data': {'runId': run_id}}


def _ended(seq: int, run_id: str, stop: str) -> dict[str, Any]:
    return {'seq': seq, 'type': 'event', 'kind': 'ctx.run.ended', 'data': {'runId': run_id, 'stopReason': stop}}


def _calls(seq: int, *ids: str, executed: bool = False) -> dict[str, Any]:
    parts = [{'type': 'tool-call', 'id': call, 'name': 'lookup', 'input': {'id': call}} for call in ids]
    if executed:
        parts = [{**part, 'providerExecuted': True} for part in parts]
    return {'seq': seq, 'type': 'message', 'message': {'role': 'assistant', 'content': parts}}


def _result(seq: int, call: str) -> dict[str, Any]:
    output = {'type': 'text', 'text': 'ok'}
    part = {'type': 'tool-result', 'id': call, 'name': 'lookup', 'output': output}
    return {'seq': seq, 'type': 'message', 'message': {'role': 'tool', 'content': [part]}}


PENDING = {
    '停下来等结果': [_started(1, 'r1'), _calls(2, 'c1', 'c2'), _ended(3, 'r1', 'requires_action')],
    '结果追加了一个': [_started(1, 'r1'), _calls(2, 'c1', 'c2'), _ended(3, 'r1', 'requires_action'), _result(4, 'c2')],
    '同一步里执行了的不算': [
        _started(1, 'r1'),
        _calls(2, 'c1', 'c2'),
        _result(3, 'c1'),
        _ended(4, 'r1', 'requires_action'),
    ],
    '服务商执行的不算': [_started(1, 'r1'), _calls(2, 'c1', executed=True), _ended(3, 'r1', 'requires_action')],
    '别的结束方式作废': [
        _started(1, 'r1'),
        _calls(2, 'c1'),
        _ended(3, 'r1', 'requires_action'),
        _started(4, 'r2'),
        _ended(5, 'r2', 'end_turn'),
    ],
    '下一轮还没结束': [_started(1, 'r1'), _calls(2, 'c1'), _ended(3, 'r1', 'requires_action'), _started(4, 'r2')],
    'runId 对不上': [_started(1, 'r1'), _calls(2, 'c1'), _ended(3, 'r2', 'requires_action')],
    '没有 runId 的事件和文字消息': [
        _started(1, 'r1'),
        _started(2, None),
        {'seq': 3, 'type': 'message', 'message': {'role': 'user', 'content': 'hi'}},
        {'seq': 4, 'type': 'event', 'kind': 'ctx.run.ended', 'data': 'r1'},
        _calls(5, 'c1'),
        _ended(6, 'r1', 'requires_action'),
    ],
    '轮外的调用不算': [_calls(1, 'c0'), _started(2, 'r1'), _ended(3, 'r1', 'requires_action')],
}


@pytest.mark.parametrize('name', list(PENDING))
def test_pending_tool_calls_match_typescript(ts: Evaluate, name: str) -> None:
    [expected] = ts([('pendingToolCalls', [PENDING[name]])])
    assert protocol.pending_tool_calls(PENDING[name]) == expected


def test_tool_result_entry_matches_typescript(ts: Evaluate) -> None:
    call = {'id': 'c1', 'name': 'lookup', 'input': {'id': '42'}}
    output = {'type': 'text', 'text': '订单 42 已发货'}
    plain, sourced = ts(
        [('toolResultEntry', [call, output]), ('toolResultEntry', [call, output, {'source': 'worker'}])]
    )
    assert protocol.tool_result_entry(call, output) == plain
    assert protocol.tool_result_entry(call, output, source='worker') == sourced
