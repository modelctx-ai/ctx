"""压缩（``compact.py``）对同一组输入和参考实现 builder 的 ``compactDetailed`` 比：切点、每次交给摘要模型的指令和记录、
写下的 ``summary`` 和 ``ctx.compacted``、``CompactResult``、中途抛的错。摘要模型两边按同一个剧本回答（``ctx_ts.mjs`` 的
``summarizer``）；常量从 TypeScript 源码里读出来比。"""

from __future__ import annotations

import asyncio
import re
from typing import Any

import pytest

from conftest import REPO, ts_compact
from ctx_pydantic_ai import CtxError, MemorySessionStore
from ctx_pydantic_ai import compact as compaction
from ctx_pydantic_ai.compact import compact_session
from ctx_pydantic_ai.context import estimate_text_tokens

#: 和 `ctx_ts.mjs` 里的 `TOO_LONG` 一样：摘要模型说输入太长。
TOO_LONG = "This model's maximum context length is 2048 tokens. However, your messages resulted in 9000 tokens."
NOW = 1_000


def _ts_source_constant(name: str) -> str:
    """builder.ts 里的常量的字面写法；字符串可以是几段 `'…' +` 拼起来的。"""
    source = (REPO / 'packages/core/src/builder.ts').read_text(encoding='utf-8')
    match = re.search(rf'(?:export )?const {name} =\s*(.+?);\n', source, re.DOTALL)
    assert match is not None, f'{name} not found in builder.ts'
    return match[1]


def test_constants_match_the_reference_builder() -> None:
    instructions = _ts_source_constant('DEFAULT_SUMMARY_INSTRUCTIONS')
    assert ''.join(re.findall(r"'([^']*)'", instructions)) == compaction.DEFAULT_SUMMARY_INSTRUCTIONS
    for name in ('DEFAULT_COMPACT_INPUT_TOKENS', 'COMPACT_TOOL_TOKENS', 'MIN_CHUNK_TOKENS'):
        assert int(_ts_source_constant(name).replace('_', '')) == getattr(compaction, name), name
    source = (REPO / 'packages/core/src/builder.ts').read_text(encoding='utf-8')
    assert 'compactOptions.keep ?? 12' in source and compaction.DEFAULT_KEEP == 12
    assert 'compactOptions.minimum ?? 8' in source and compaction.DEFAULT_MINIMUM == 8
    assert 'compactOptions.maxOutputTokens ?? 1024' in source and compaction.DEFAULT_MAX_OUTPUT_TOKENS == 1024


# ---- 条目 ----


def message(role: str, content: Any, **extra: Any) -> dict[str, Any]:
    return {'type': 'message', 'message': {'role': role, 'content': content}, **extra}


def chat(count: int, chars: int = 20) -> list[dict[str, Any]]:
    """一问一答交替的 ``count`` 条消息，每条正文 ``chars`` 个字符左右。"""
    filler = ('lorem ipsum dolor sit amet ' * (chars // 27 + 1))[:chars]
    return [
        message('user', f'问 {index}：{filler}') if index % 2 == 0 else message('assistant', f'答 {index}：{filler}')
        for index in range(count)
    ]


def call(call_id: str, name: str, value: Any, text: str = '') -> dict[str, Any]:
    parts: list[dict[str, Any]] = [{'type': 'text', 'text': text}] if text else []
    return message('assistant', [*parts, {'type': 'tool-call', 'id': call_id, 'name': name, 'input': value}])


def result(call_id: str, name: str, output: dict[str, Any]) -> dict[str, Any]:
    return message('tool', [{'type': 'tool-result', 'id': call_id, 'name': name, 'output': output}])


def tool_rounds(count: int, filler: str = '') -> list[dict[str, Any]]:
    entries: list[dict[str, Any]] = []
    for index in range(count):
        entries += [
            message('user', f'问 {index} {filler}'),
            call(f'call-{index}', 'lookup', {'q': filler or str(index)}),
            result(f'call-{index}', 'lookup', {'type': 'text', 'text': filler or f'结果 {index}'}),
            message('assistant', f'答 {index}'),
        ]
    return entries


def mixed() -> list[dict[str, Any]]:
    """各种部分：长的工具输入和输出、json、错误、带文件的内容、附件、推理。"""
    long_output = f'HEAD {"工具输出" * 3_000} TAIL'
    return [
        message(
            'user',
            [
                {'type': 'text', 'text': '看看这两个'},
                {'type': 'file', 'mediaType': 'image/png', 'data': {'type': 'data', 'data': 'iVBORw0KGgo='}},
                {
                    'type': 'file',
                    'mediaType': 'application/pdf',
                    'data': {'type': 'url', 'url': 'https://x.test/a.pdf'},
                },
            ],
        ),
        message(
            'assistant',
            [
                {'type': 'reasoning', 'text': '先查一下'},
                {'type': 'text', 'text': '我查一下。'},
                {'type': 'tool-call', 'id': 'c1', 'name': 'search', 'input': {'q': 'x' * 6_000, 'n': 1.0}},
                {'type': 'tool-call', 'id': 'c2', 'name': 'stats', 'input': {}},
            ],
        ),
        message(
            'tool',
            [
                {'type': 'tool-result', 'id': 'c1', 'name': 'search', 'output': {'type': 'text', 'text': long_output}},
                {
                    'type': 'tool-result',
                    'id': 'c2',
                    'name': 'stats',
                    'output': {'type': 'json', 'value': {'rows': 3, 'mean': 2.5, '名字': ['甲', None]}},
                },
            ],
        ),
        call('c3', 'open', {'path': '/a'}),
        result('c3', 'open', {'type': 'error', 'message': '文件不存在：/a'}),
        call('c4', 'render', {}),
        result(
            'c4',
            'render',
            {
                'type': 'content',
                'parts': [
                    {'type': 'text', 'text': '画好了'},
                    {'type': 'file', 'mediaType': 'image/jpeg', 'data': {'type': 'data', 'data': '/9j/4AAQ'}},
                    {'type': 'file', 'mediaType': '', 'data': {'type': 'url', 'url': 'https://x.test/b'}},
                ],
            },
        ),
        message('assistant', '都看完了'),
        message('user', '最后一句'),
    ]


def windows(count: int) -> list[dict[str, Any]]:
    """``at`` 乱序的日志：补写的旧记录 ``seq`` 在后、``at`` 在前。"""
    entries = chat(count, 400)
    for index, entry in enumerate(entries):
        entry['at'] = NOW - 10_000 + index * 10
    entries.insert(count // 2, message('user', '补写的旧记录：上个月说过的话', at=NOW - 20_000))
    entries.append(message('user', '再补一条更早的', at=NOW - 30_000))
    entries += chat(6, 50)
    return entries


CASES: dict[str, dict[str, Any]] = {
    'too_short': {'entries': chat(15)},
    'basic': {'entries': chat(20)},
    'keep_and_minimum': {'entries': chat(10), 'options': {'keep': 3, 'minimum': 2}},
    'minimum_not_reached': {'entries': chat(10), 'options': {'keep': 3, 'minimum': 8}},
    'keep_fraction': {'entries': chat(14), 'options': {'keep': 2.7, 'minimum': 1}},
    'keep_zero': {'entries': chat(10), 'options': {'keep': 0, 'minimum': 1}},
    'keep_negative': {'entries': chat(10), 'options': {'keep': -3, 'minimum': 1}},
    'tool_boundary': {'entries': tool_rounds(3), 'options': {'keep': 6, 'minimum': 1}},
    'tool_rounds_chunked': {
        'entries': tool_rounds(12, 'x' * 2_000),
        'options': {'keep': 2, 'maxInputTokens': 1_400},
    },
    'mixed_parts': {'entries': mixed(), 'options': {'keep': 1, 'minimum': 1}},
    'mixed_parts_small_budget': {'entries': mixed(), 'options': {'keep': 1, 'minimum': 1, 'maxInputTokens': 900}},
    'oversized_message': {
        'entries': [
            message('user', f'开头 {"很长的一段话" * 3_000} 结尾'),
            message('assistant', '收到'),
            message('user', '最后一句'),
        ],
        'options': {'keep': 1, 'minimum': 1, 'maxInputTokens': 4_000},
    },
    'chunked': {'entries': chat(60, 400), 'options': {'keep': 4, 'maxInputTokens': 2_000}},
    'carry': {
        'entries': [{'type': 'summary', 'text': '早先：主人对花生过敏。', 'covers': 0}, *chat(20)],
    },
    'carry_covers_some': {
        'entries': [*chat(10), {'type': 'summary', 'text': '前十条的摘要', 'covers': 10}, *chat(24, 60)],
        'options': {'keep': 4, 'maxInputTokens': 600},
    },
    'custom_instructions': {
        'entries': chat(12),
        'options': {'keep': 2, 'minimum': 1, 'instructions': '把对话压成一段话，用中文。', 'maxOutputTokens': 300},
    },
    'empty_instructions': {'entries': chat(12), 'options': {'keep': 2, 'minimum': 1, 'instructions': ''}},
    'empty_messages': {
        'entries': [message('user', []), message('assistant', []), *chat(2), message('user', [])] * 2,
        'options': {'keep': 1, 'minimum': 1},
    },
    'only_empty_messages': {
        'entries': [message('assistant', []) for _ in range(6)] + chat(2),
        'options': {'keep': 2, 'minimum': 1},
    },
    'truncated': {'entries': chat(20), 'script': [{'type': 'text', 'text': '截断了', 'truncated': True}]},
    'truncated_later': {
        'entries': chat(60, 400),
        'options': {'keep': 4, 'maxInputTokens': 2_000},
        'script': [
            {'type': 'text', 'text': '第一段'},
            {'type': 'text', 'text': '第二段'},
            {'type': 'text', 'text': '第三段', 'truncated': True},
        ],
    },
    'empty_answer': {'entries': chat(20), 'script': [{'type': 'text', 'text': '  \n '}]},
    'answer_trimmed': {'entries': chat(20), 'script': [{'type': 'text', 'text': '\n  摘要，两头有空白  \n'}]},
    'input_too_long': {
        'entries': [{'type': 'summary', 'text': '很长的旧摘要 ' * 2_000, 'covers': 0}, *chat(20)],
        'options': {'keep': 4, 'maxInputTokens': 1_000},
    },
    'budget_below_one': {'entries': chat(20), 'options': {'maxInputTokens': 0.4}},
    'halving': {'entries': chat(40, 400), 'options': {'keep': 4, 'maxInputTokens': 8_000}, 'window': 1_500},
    'never_fits': {'entries': chat(40, 400), 'options': {'keep': 4, 'maxInputTokens': 8_000}, 'window': 0},
    'error_midway': {
        'entries': chat(60, 400),
        'options': {'keep': 4, 'maxInputTokens': 2_000},
        'script': [
            {'type': 'text', 'text': '摘要 1'},
            {'type': 'text', 'text': '摘要 2'},
            {'type': 'error', 'message': 'socket hang up'},
        ],
    },
    'timeout': {
        'entries': chat(60, 400),
        'options': {'keep': 4, 'maxInputTokens': 2_000, 'timeoutMs': 100},
        'tick': 40,
    },
    'future_entries': {
        'entries': [
            *chat(8),
            message('user', '提醒：明天交报告', at=NOW + 86_400_000),
            *chat(12),
            message('user', '提醒：下周体检', at=NOW + 7 * 86_400_000),
        ],
        'options': {'keep': 4},
    },
    'backfilled': {'entries': windows(24), 'options': {'keep': 3, 'maxInputTokens': 1_200}},
    'backfilled_keep_zero': {'entries': windows(10), 'options': {'keep': 0, 'minimum': 1}},
}


def scripted(case: dict[str, Any], clock: list[float], seen: list[dict[str, str]]) -> compaction.Summarize:
    """和 ``ctx_ts.mjs`` 的 ``summarizer`` 一样回答。"""
    script = case.get('script') or []
    window = case.get('window')
    tick = case.get('tick', 0)

    async def summarize(
        instructions: str, prompt: str, max_output_tokens: int, timeout_ms: float | None
    ) -> tuple[str, str | None]:
        index = len(seen)
        seen.append({'system': instructions, 'prompt': prompt})
        clock[0] += tick
        tokens = estimate_text_tokens(instructions) + estimate_text_tokens(prompt)
        over = window is not None and tokens > window
        step = {'type': 'too-long'} if over else (script[index] if index < len(script) else None)
        if step is None:
            step = {'type': 'text', 'text': f'摘要 {index + 1}'}
        if step['type'] == 'too-long':
            raise CtxError('context_overflow', TOO_LONG)
        if step['type'] == 'error':
            raise RuntimeError(step['message'])
        return step['text'], 'length' if step.get('truncated') else 'stop'

    return summarize


async def python_side(case: dict[str, Any]) -> dict[str, Any]:
    clock = [float(case.get('now', NOW))]

    def now() -> float:
        return clock[0]

    store = MemorySessionStore(now=now)
    await store.append('s', case['entries'])
    seen: list[dict[str, str]] = []
    out: dict[str, Any] = {}
    try:
        out['result'] = await compact_session(store, 's', scripted(case, clock, seen), case.get('options'), now=now)
    except Exception as error:  # noqa: BLE001 - 和 TypeScript 那边抛的比
        out['thrown'] = {
            key: value
            for key, value in (('message', str(error)), ('type', getattr(error, 'type', None)))
            if value is not None
        }
    out['log'] = await store.list('s')
    out['seen'] = seen
    return out


def normalized(output: dict[str, Any]) -> dict[str, Any]:
    """去掉随机的 ``id``：摘要按写下的顺序编号，``ctx.compacted`` 的 ``summaryId`` 换成那个编号。钟两边一样，``at`` 照比。"""
    names: dict[str, str] = {}
    for entry in output['log']:
        if entry['type'] == 'summary':
            names[entry['id']] = f'summary {len(names) + 1}'

    def clean(entry: dict[str, Any]) -> dict[str, Any]:
        out = {key: value for key, value in entry.items() if key != 'id'}
        if entry['type'] == 'summary':
            out['id'] = names.get(entry['id'])
        if entry.get('kind') == compaction.COMPACTED:
            out['data'] = {**entry['data'], 'summaryId': names.get(entry['data']['summaryId'])}
        return out

    result = output.get('result')
    if result is not None and 'summary' in result:
        result = {**result, 'summary': clean(result['summary'])}
    return {
        'result': result,
        'thrown': output.get('thrown'),
        'log': [clean(entry) for entry in output['log']],
        'seen': output['seen'],
    }


@pytest.fixture(scope='module')
def reference(node: str) -> dict[str, dict[str, Any]]:
    """每一组在 TypeScript 那边压一次的结果（一个 node 进程跑完）。"""
    names = list(CASES)
    payload = [{'now': NOW, **CASES[name]} for name in names]
    return dict(zip(names, ts_compact(node, payload), strict=True))


@pytest.mark.parametrize('name', list(CASES))
def test_compaction_matches_the_reference_builder(name: str, reference: dict[str, dict[str, Any]]) -> None:
    mine = normalized(asyncio.run(python_side(CASES[name])))
    theirs = normalized(reference[name])
    assert mine['thrown'] == theirs['thrown']
    assert mine['seen'] == theirs['seen']
    assert mine['result'] == theirs['result']
    assert mine['log'] == theirs['log']


def test_the_cases_cover_every_way_compaction_ends(reference: dict[str, dict[str, Any]]) -> None:
    """这组输入走到了每一种收场，分段时落了多个检查点，也截短过：比的不只是最简单的路径。"""
    statuses = {output['result']['status'] for output in reference.values() if output.get('result')}
    assert statuses == {'compacted', 'not_needed', 'truncated', 'empty', 'input_too_long'}
    assert {output['thrown'].get('type') for output in reference.values() if output.get('thrown')} == {None, 'timeout'}
    assert reference['chunked']['result']['calls'] > 3

    def summaries(name: str) -> int:
        return sum(entry['type'] == 'summary' for entry in reference[name]['log'])

    assert summaries('chunked') > 3
    assert summaries('error_midway') == 2
    # 补写的旧记录让有的段落不了检查点：摘要带在内存里进下一段。
    assert reference['backfilled']['result']['calls'] > summaries('backfilled') > 0
    assert reference['mixed_parts']['result']['shortened'] >= 2
    assert reference['oversized_message']['result']['shortened'] == 1
    halving = reference['halving']['seen']
    assert (
        sum(estimate_text_tokens(one['system']) + estimate_text_tokens(one['prompt']) > 1_500 for one in halving) >= 2
    )
    assert reference['carry']['seen'][0]['prompt'].startswith('user: Summary of the earlier conversation:\n早先')
