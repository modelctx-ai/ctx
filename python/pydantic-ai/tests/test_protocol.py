"""协议函数：常量和 TypeScript 的协议包一致，纯函数对同一组输入给出和它一样的结果。"""

from __future__ import annotations

import re
from typing import Any

import pytest

from conftest import REPO, Evaluate
from ctx_pydantic_ai import context, harness, protocol
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
    assert _ts_constant('packages/protocol/src/context.ts', 'MISSING_RESULT') == repr(context.MISSING_RESULT)
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
    assert context.project(LOGS[name]).messages == expected


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


def _erased(seq: int, op: str, **data: Any) -> dict[str, Any]:
    return {'seq': seq, 'type': 'event', 'kind': 'ctx.erased', 'data': {'op': op, **data}}


#: 这一轮的 started 在 seq 5，写了 5、6、7；每一例是这一轮的 started 起的生命周期事件和擦除记录。
FENCES = {
    '没人动': [_started(5, 'r1')],
    '别的运行结束了': [_started(5, 'r1'), _ended(8, 'r0', 'error')],
    '自己被收走了': [_started(5, 'r1'), _ended(8, 'r1', 'error')],
    'started 不在了': [],
    '删的是更早的历史': [_started(5, 'r1'), _erased(8, 'truncate', upTo=4, count=4)],
    '删到了这一轮': [_erased(8, 'truncate', upTo=6, count=6)],
    'remove 了这一轮的一条': [_started(5, 'r1'), _erased(8, 'remove', seqs=[2, 7], count=2)],
    'redact 了这一轮的一条': [_started(5, 'r1'), _erased(8, 'redact', seqs=[6], count=1)],
    'remove 了别处的': [_started(5, 'r1'), _erased(8, 'remove', seqs=[2, 9], count=2)],
    '擦除记录不认识': [_started(5, 'r1'), _erased(8, 'shred', seqs=[6], count=1)],
    '没有 count': [_started(5, 'r1'), _erased(8, 'redact', seqs=[6])],
    'upTo 不是数': [_started(5, 'r1'), _erased(8, 'truncate', upTo='9', count=9)],
    'seqs 里有别的': [_started(5, 'r1'), _erased(8, 'remove', seqs=[6, 'x'], count=2)],
}


@pytest.mark.parametrize('name', list(FENCES))
def test_fencing_matches_typescript(ts: Evaluate, name: str) -> None:
    run = {'runId': 'r1', 'started': 5, 'recorded': [{'seq': 5}, {'seq': 6}, {'seq': 7}]}
    [expected] = ts([('isFenced', [FENCES[name], run])])
    assert protocol.is_fenced(FENCES[name], 'r1', started=5, recorded=run['recorded']) is expected


def test_fencing_without_a_started_seq_only_looks_at_ended_and_erasures() -> None:
    assert protocol.is_fenced([], 'r1', started=None, recorded=[]) is False
    assert protocol.is_fenced([_ended(3, 'r1', 'error')], 'r1', started=None, recorded=[]) is True


def test_tool_result_entry_matches_typescript(ts: Evaluate) -> None:
    call = {'id': 'c1', 'name': 'lookup', 'input': {'id': '42'}}
    output = {'type': 'text', 'text': '订单 42 已发货'}
    plain, sourced = ts(
        [('toolResultEntry', [call, output]), ('toolResultEntry', [call, output, {'source': 'worker'}])]
    )
    assert protocol.tool_result_entry(call, output) == plain
    assert protocol.tool_result_entry(call, output, source='worker') == sourced


TEXTS = [
    '',
    'hello world',
    '你好，世界',
    'Привет, мир',
    '😀 emoji and 𠀀 wide',
    'mixed 中文 and ascii 1234567890',
    'tab\tnewline\n',
    '\ud800 lone surrogate',
]
FILES = [
    ('text/plain', {'type': 'text', 'text': '一段文字'}),
    ('image/png', {'type': 'data', 'data': 'A' * 100}),
    ('image/png', {'type': 'data', 'data': 'A' * 100_000}),
    ('application/json', {'type': 'data', 'data': 'QUJD' * 50 + '=='}),
    ('application/pdf', {'type': 'data', 'data': 'A' * 40_000 + '='}),
    ('image/jpeg', {'type': 'url', 'url': 'https://example.com/a.jpg'}),
    ('application/pdf', {'type': 'reference', 'reference': {'openai': 'file-1'}}),
]
MESSAGES = [
    {'role': 'user', 'content': '你好'},
    {
        'role': 'user',
        'content': [{'type': 'text', 'text': 'look'}, {'type': 'file', 'mediaType': FILES[1][0], 'data': FILES[1][1]}],
    },
    {
        'role': 'assistant',
        'content': [
            {'type': 'reasoning', 'text': 'thinking…'},
            {'type': 'text', 'text': 'calling'},
            {
                'type': 'tool-call',
                'id': 'c1',
                'name': 'echo',
                'input': {'text': 'hi', 'n': 1.0, 'nested': [1, 2.5, None]},
            },
            {'type': 'tool-call', 'id': 'c2', 'name': 'echo', 'input': None},
            {'type': 'custom', 'kind': 'x'},
        ],
    },
    {
        'role': 'tool',
        'content': [
            {'type': 'tool-result', 'id': 'c1', 'name': 'echo', 'output': {'type': 'text', 'text': 'ok'}},
            {'type': 'tool-result', 'id': 'c2', 'name': 'echo', 'output': {'type': 'json', 'value': {'a': [1, 'b']}}},
            {
                'type': 'tool-result',
                'id': 'c3',
                'name': 'echo',
                'output': {'type': 'error', 'message': 'bad', 'data': {'code': 7}},
            },
            {
                'type': 'tool-result',
                'id': 'c4',
                'name': 'echo',
                'output': {
                    'type': 'content',
                    'parts': [
                        {'type': 'text', 'text': 'see'},
                        {'type': 'file', 'mediaType': 'image/png', 'data': {'type': 'data', 'data': 'A' * 200}},
                    ],
                },
            },
        ],
    },
]


def test_token_estimates_match_typescript(ts: Evaluate) -> None:
    calls = [('estimateTextTokens', [text]) for text in TEXTS]
    calls += [('estimateFileTokens', [media, data]) for media, data in FILES]
    calls += [('estimateTokens', [message]) for message in MESSAGES]
    expected = ts(calls)
    actual = [context.estimate_text_tokens(text) for text in TEXTS]
    actual += [context.estimate_file_tokens(media, data) for media, data in FILES]
    actual += [context.estimate_tokens(message) for message in MESSAGES]
    assert actual == expected


LONG = ('前面一段中文，' * 40) + ('then some ascii words ' * 40) + ('😀𠀀' * 30) + '结尾'


def test_truncation_matches_typescript(ts: Evaluate) -> None:
    texts = [(LONG, budget) for budget in (0, 1, 10, 40, 100, 400, 10_000)] + [('😀' * 50, 9), ('a😀' * 40, 13)]
    big = {
        'role': 'user',
        'content': [
            {'type': 'text', 'text': LONG},
            {'type': 'file', 'mediaType': 'image/png', 'data': {'type': 'data', 'data': 'A' * 100_000}},
        ],
    }
    tool = {
        'role': 'tool',
        'content': [
            {'type': 'tool-result', 'id': 'c1', 'name': 'echo', 'output': {'type': 'json', 'value': {'text': LONG}}},
            {
                'type': 'tool-result',
                'id': 'c2',
                'name': 'echo',
                'output': {'type': 'error', 'message': LONG, 'retryable': True, 'data': 1},
            },
            {
                'type': 'tool-result',
                'id': 'c3',
                'name': 'echo',
                'output': {
                    'type': 'content',
                    'parts': [
                        {'type': 'text', 'text': LONG},
                        {'type': 'file', 'mediaType': 'text/plain', 'data': {'type': 'text', 'text': LONG}},
                    ],
                },
            },
        ],
    }
    calls_only = {
        'role': 'assistant',
        'content': [{'type': 'tool-call', 'id': 'c1', 'name': 'echo', 'input': {'text': LONG}}],
    }
    messages = [
        ({'role': 'user', 'content': LONG}, 50),
        (big, 300),
        (big, 3_000),
        (tool, 100),
        (tool, 800),
        (calls_only, 50),
    ]
    expected = ts(
        [('truncateText', [text, budget]) for text, budget in texts]
        + [('truncateMessage', [message, budget]) for message, budget in messages]
    )
    actual = [context.truncate_text(text, budget) for text, budget in texts]
    actual += [context.truncate_message(message, budget) for message, budget in messages]
    assert actual == expected


def _turn(seq: int, text: str) -> list[dict[str, object]]:
    return [_message(seq, 'user', f'问题 {seq}：{text}'), _message(seq + 1, 'assistant', f'回答 {seq}：{text}')]


DIALOGUE = [entry for seq in range(1, 40, 2) for entry in _turn(seq, '一段不短的话' * 8)]
TOOLS = [
    _message(1, 'user', 'q' * 200),
    _message(2, 'assistant', [{'type': 'text', 'text': 'calling'}, _call('c1')]),
    _message(
        3,
        'tool',
        [{'type': 'tool-result', 'id': 'c1', 'name': 'echo', 'output': {'type': 'text', 'text': '结果' * 400}}],
    ),
    _message(4, 'assistant', 'a' * 300),
    _message(5, 'assistant', [_call('c2')]),
    _message(6, 'user', 'next'),
    _message(7, 'assistant', 'done'),
]
SUMMARIZED = [
    _entry(1, type='summary', text='早先聊过的' * 30, covers=10),
    *[entry for entry in DIALOGUE if entry['seq'] > 10],
]
WINDOWS = [
    ('dialogue', DIALOGUE, None),
    ('dialogue', DIALOGUE, {}),
    ('dialogue', DIALOGUE, {'maxMessages': 5}),
    ('dialogue', DIALOGUE, {'maxTokens': 300}),
    ('dialogue', DIALOGUE, {'maxTokens': 300, 'maxMessages': 3}),
    ('dialogue', DIALOGUE, {'maxTokens': 10, 'truncate': True}),
    ('tools', TOOLS, {'maxTokens': 200}),
    ('tools', TOOLS, {'maxTokens': 200, 'truncate': True}),
    ('tools', TOOLS, {'maxTokens': 900, 'truncate': True}),
    ('tools', TOOLS, {'maxMessages': 4}),
    ('summarized', SUMMARIZED, {'maxMessages': 2}),
    ('summarized', SUMMARIZED, {'maxTokens': 150, 'truncate': True}),
    ('summarized', SUMMARIZED, {'maxTokens': 0, 'truncate': True}),
]


@pytest.mark.parametrize(
    ('name', 'entries', 'window'), WINDOWS, ids=[f'{name}-{window}' for name, _, window in WINDOWS]
)
def test_windows_match_typescript(
    ts: Evaluate, name: str, entries: list[dict[str, object]], window: dict[str, object] | None
) -> None:
    [expected] = ts([('projectWindow', [entries, window])])
    projection = context.project(entries, window)
    actual = {
        'messages': projection.messages,
        'tokens': projection.tokens,
        'dropped': projection.dropped,
        'truncated': projection.truncated,
    }
    assert actual == expected
    if window and (window.get('maxMessages') is not None or window.get('maxTokens') is not None):
        assert projection.dropped > 0 or projection.truncated > 0 or name == 'none'


def test_calibration_and_window_budget() -> None:
    def step(seq: int, estimated: object, actual: object, applied: object = None) -> dict[str, object]:
        meta = {'runId': 'r', 'step': 0, 'estimatedInputTokens': estimated, 'usage': {'inputTokens': actual}}
        if applied is not None:
            meta['calibration'] = applied
        return {**_message(seq, 'assistant', 'x'), 'meta': {'step': meta}}

    assert context.calibration_of([]) == 1
    assert context.calibration_of([step(1, 100, 150)]) == 1.5
    # 样本里记着当时乘上的倍数：换算回没校准的估算再比。
    assert context.calibration_of([step(1, 100, 150, applied=1.5)]) == 2.25
    assert context.calibration_of([step(1, 100, 50)]) == 1
    assert context.calibration_of([step(1, 100, 10_000)]) == context.MAX_CALIBRATION
    assert context.calibration_of([step(1, 150, 300), step(2, 0, 10)]) == 1
    assert context.calibration_of([step(1, 300, 1001)]) == 3.337
    assert context.window_of({'maxTokens': 1000, 'maxMessages': 3}, reserve=100, calibration=2) == {
        'maxTokens': 400,
        'maxMessages': 3,
    }
    assert context.window_of({'maxTokens': 50}, reserve=100) == {'maxTokens': 0}
    assert context.window_of(None) == {}
