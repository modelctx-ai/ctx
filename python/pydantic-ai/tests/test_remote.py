"""对着真的 ``ctx-remote``（TypeScript，``ctx_ts.mjs remote``）：Python 的客户端，和整条部署链路
（TypeScript 的 ``createRemoteHarness`` → ``ctx-pydantic-ai serve`` → ``ctx-remote`` 的会话和执行环境）。"""

from __future__ import annotations

import asyncio
from collections.abc import Callable, Coroutine
from typing import Any

import pytest

from conftest import serve, ts_pending, ts_run
from ctx_pydantic_ai import CtxError, PydanticAIHarness, RemoteExecutor, RemoteSessionStore, tool_approval_entry
from ctx_pydantic_ai.testing import ScriptedModel


def run(coroutine: Callable[[], Coroutine[Any, Any, None]]) -> None:
    asyncio.run(coroutine())


async def _append(remote: dict[str, Any], session: str, entry: dict[str, Any]) -> None:
    store = RemoteSessionStore(remote['baseUrl'], access_token=remote['token'])
    try:
        await store.append(session, [entry])
    finally:
        await store.aclose()


def test_session_store_against_ctx_remote(ctx_remote: dict[str, Any]) -> None:
    async def main() -> None:
        store = RemoteSessionStore(ctx_remote['baseUrl'], access_token=ctx_remote['token'])
        try:
            session = 'py/store 一'
            written = await store.append(
                session,
                [
                    {'type': 'message', 'message': {'role': 'user', 'content': 'hi'}, 'key': 'k1'},
                    {'type': 'event', 'kind': 'ctx.run.started', 'data': {'runId': 'r'}},
                ],
            )
            assert [entry['seq'] for entry in written] == [1, 2]
            assert all(entry['v'] == 1 and entry['session'] == session for entry in written)
            # 同一个 key 跳过；expectSeq 对不上整批不写。
            assert (
                await store.append(
                    session, [{'type': 'message', 'message': {'role': 'user', 'content': 'x'}, 'key': 'k1'}]
                )
                == []
            )
            with pytest.raises(CtxError) as caught:
                await store.append(session, [{'type': 'event', 'kind': 'x'}], expect_seq=1)
            assert caught.value.type == 'conflict'
            await store.append(session, [{'type': 'event', 'kind': f'n{i}'} for i in range(10)], expect_seq=2)
            # 服务端一页 5 条：客户端接着读，结果和一次读完一样。
            everything = await store.list(session)
            assert [entry['seq'] for entry in everything] == list(range(1, 13))
            assert [entry['seq'] for entry in await store.list(session, after=3, limit=7)] == list(range(4, 11))
            assert [entry['seq'] for entry in await store.list(session, last=3)] == [10, 11, 12]
            assert [entry['kind'] for entry in await store.list(session, kinds=['ctx.run.started'])] == [
                'ctx.run.started'
            ]
            assert [entry['type'] for entry in await store.list(session, types=['message'])] == ['message']
        finally:
            await store.aclose()

    run(main)


def test_executor_against_ctx_remote(ctx_remote: dict[str, Any]) -> None:
    async def main() -> None:
        local = RemoteExecutor(ctx_remote['baseUrl'], 'local', access_token=ctx_remote['token'])
        missing = RemoteExecutor(ctx_remote['baseUrl'], 'nobody', access_token=ctx_remote['token'])
        try:
            [echo] = await local.tools()
            assert echo['name'] == 'echo'
            assert echo['executor'] == 'local'
            await local.open('py/exec', {'image': 'x'})
            output = await local.execute({'id': 'c1', 'name': 'echo', 'input': {'text': 'hi'}}, {'session': 'py/exec'})
            assert output == {'type': 'json', 'value': {'text': 'hi'}}
            refused = await missing.execute({'id': 'c2', 'name': 'echo', 'input': {}}, {'session': 'py/exec'})
            assert refused['type'] == 'error'
            assert refused['message'].startswith('Remote executor "nobody" at ')
            assert '(HTTP 404)' in refused['message']
        finally:
            await local.aclose()
            await missing.aclose()

    run(main)


def test_a_run_writes_through_ctx_remote(ctx_remote: dict[str, Any]) -> None:
    async def main() -> None:
        base, token = ctx_remote['baseUrl'], ctx_remote['token']
        store = RemoteSessionStore(base, access_token=token)
        executors = [RemoteExecutor(base, name, access_token=token) for name in ('local', 'broken')]
        model = ScriptedModel(
            [
                {
                    'type': 'tool-calls',
                    'calls': [{'id': 'c1', 'input': {'text': 'hi'}}, {'id': 'c2', 'tool': 'probe', 'input': {}}],
                },
                {'type': 'text', 'text': '好了'},
            ]
        )
        harness = PydanticAIHarness(store=store, executors=executors, models={'scripted': model})
        try:
            result = await harness.run({'session': 'py/run', 'agent': {'model': 'scripted'}, 'input': 'go'})
            assert result['stopReason'] == 'end_turn'
            tools = [
                entry for entry in await store.list('py/run', types=['message']) if entry['message']['role'] == 'tool'
            ]
            outputs = {entry['source']: entry['message']['content'][0]['output'] for entry in tools}
            assert outputs['local'] == {'type': 'json', 'value': {'text': 'hi'}}
            # `broken` 打不开会话：它的调用回错误，别的照常。
            assert outputs['broken']['type'] == 'error'
            # ctx-remote 不把执行环境内部的异常原文传出去，只给一个引用号。
            assert outputs['broken']['message'].startswith(
                'Executor "broken" could not prepare session "py/run" for tool "probe": '
            )
        finally:
            await store.aclose()
            for executor in executors:
                await executor.aclose()

    run(main)


def test_the_typescript_client_drives_serve(node: str, ctx_remote: dict[str, Any]) -> None:
    # pydantic-ai 自带的 `test` 模型：把给它的工具各调一次，再用文字报结果。
    server = serve(
        'serve',
        '--remote',
        ctx_remote['baseUrl'],
        '--remote-token',
        ctx_remote['token'],
        '--executor',
        'local',
        '--model',
        'test',
        '--token',
        'serve-token',
    )
    try:
        request = {'session': 'py/serve', 'agent': {'model': 'test'}, 'input': '用一下工具'}
        done = ts_run(node, {'baseUrl': server.url, 'token': 'serve-token', 'request': request})
        result = done['result']
        assert result['stopReason'] == 'end_turn', result
        recorded = result['recorded']
        assert recorded[0]['data']['harness']['name'] == 'pydantic-ai'
        roles = [entry['message']['role'] for entry in recorded if entry['type'] == 'message']
        assert roles == ['user', 'assistant', 'tool', 'assistant']
        tool = next(entry for entry in recorded if entry['type'] == 'message' and entry['message']['role'] == 'tool')
        assert tool['source'] == 'local'
        assert tool['message']['content'][0]['output']['type'] == 'json'
        streamed = ts_run(
            node,
            {'baseUrl': server.url, 'token': 'serve-token', 'request': {**request, 'input': '再来'}, 'stream': True},
        )
        kinds = [event['type'] for event in streamed['events']]
        assert kinds[0] == 'run.started'
        assert kinds[-1] == 'run.ended'
        assert streamed['result']['stopReason'] == 'end_turn'
        # `ask`：停下来等应用确认。没确认时 `runPendingTools` 不碰它；应用追加确认以后，它交给 ctx-remote 上的执行环境、
        # 把结果追加进会话，再不带输入跑一轮。
        asked = {'session': 'py/serve-ask', 'agent': {'model': 'test', 'permissions': {'default': 'ask'}}}
        waiting = ts_run(node, {'baseUrl': server.url, 'token': 'serve-token', 'request': {**asked, 'input': '用一下'}})
        assert waiting['result']['stopReason'] == 'requires_action', waiting
        pending = waiting['result']['pending']
        assert [call['name'] for call in pending] == ['echo']
        [approval] = waiting['result']['approvals']
        assert approval['callId'] == pending[0]['id']
        remote = {'baseUrl': ctx_remote['baseUrl'], 'token': ctx_remote['token']}
        early = ts_pending(node, {**remote, 'session': 'py/serve-ask', 'executor': 'local'})
        assert early['executed'] == []
        assert early['remaining'][0]['approval'] == {'approvalId': approval['approvalId']}
        asyncio.run(
            _append(ctx_remote, 'py/serve-ask', tool_approval_entry(approval['approvalId'], {'approved': True}))
        )
        done = ts_pending(node, {**remote, 'session': 'py/serve-ask', 'executor': 'local'})
        assert [item['call'] for item in done['executed']] == pending
        assert done['remaining'] == []
        resumed = ts_run(node, {'baseUrl': server.url, 'token': 'serve-token', 'request': asked})['result']
        assert resumed['stopReason'] == 'end_turn', resumed
        roles = [entry['message']['role'] for entry in resumed['recorded'] if entry['type'] == 'message']
        assert roles == ['assistant']
        # `--model test`：别的模型名在服务端就被拒绝（400），TypeScript 的客户端抛 `RemoteError`。
        refused = ts_run(
            node,
            {'baseUrl': server.url, 'token': 'serve-token', 'request': {**request, 'agent': {'model': 'openai:gpt-5'}}},
        )
        assert refused['thrown'] == {
            'name': 'RemoteError',
            'message': 'model "openai:gpt-5" is not allowed by this server',
            'status': 400,
            'type': 'invalid_request_error',
        }
    except BaseException:
        print(server.stderr())
        raise
    finally:
        server.stop()
