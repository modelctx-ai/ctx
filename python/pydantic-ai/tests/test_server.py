"""HTTP 这一层：``create_app`` 和一致性模式的入口，进程内经 ASGI 调。线上行为对 TypeScript 客户端的验证在
``test_conformance.py`` 和 ``test_remote.py``。"""

from __future__ import annotations

import asyncio
import json
from collections.abc import Callable, Coroutine
from typing import Any

import httpx2

from ctx_pydantic_ai import (
    CONFORMANCE_PATH,
    PROTOCOL_VERSION,
    MemorySessionStore,
    PydanticAIHarness,
    create_app,
    create_conformance_app,
)
from ctx_pydantic_ai.testing import ScriptedModel, echo_executor

TOKEN = 'secret-token'
AUTH = {'authorization': f'Bearer {TOKEN}'}
AGENT = {'model': 'scripted'}


def run(coroutine: Callable[[], Coroutine[Any, Any, None]]) -> None:
    asyncio.run(coroutine())


def app_of(script: list[dict[str, Any]], *, delay_ms: float = 0, **options: Any) -> tuple[Any, MemorySessionStore]:
    store = MemorySessionStore()
    model = ScriptedModel(script, delay_ms=delay_ms)
    harness = PydanticAIHarness(store=store, executors=[echo_executor()], models={'scripted': model})
    return create_app(harness, access_token=TOKEN, **options), store


def client(app: Any) -> httpx2.AsyncClient:
    return httpx2.AsyncClient(transport=httpx2.ASGITransport(app=app), base_url='http://test', headers=AUTH)


def test_protocol_and_auth() -> None:
    async def main() -> None:
        app, _ = app_of([])
        async with client(app) as http:
            info = (await http.get('/protocol')).json()
            assert info == {
                'protocol': PROTOCOL_VERSION,
                'entryVersion': 1,
                'components': {'harness': {'stream': True}},
            }
            refused = await http.get('/protocol', headers={'authorization': 'Bearer wrong'})
            assert refused.status_code == 401
            assert refused.json()['error']['type'] == 'authentication_error'

    run(main)


def test_a_run_answers_with_its_result() -> None:
    async def main() -> None:
        app, store = app_of([{'type': 'text', 'text': '好'}])
        async with client(app) as http:
            response = await http.post('/runs', json={'session': 's', 'agent': AGENT, 'input': 'hi', 'runId': 'r1'})
            assert response.status_code == 200
            result = response.json()
            assert result['runId'] == 'r1'
            assert result['text'] == '好'
            assert [entry['seq'] for entry in result['recorded']] == [1, 2, 3, 4]
            assert len(await store.list('s')) == 4

    run(main)


def test_a_slow_run_sends_heartbeats_first() -> None:
    async def main() -> None:
        app, _ = app_of([{'type': 'text', 'text': '慢'}], delay_ms=300, heartbeat_seconds=0.05)
        async with client(app) as http:
            response = await http.post('/runs', json={'session': 's', 'agent': AGENT, 'input': 'hi'})
            assert response.status_code == 200
            assert response.text.startswith('\n')
            assert json.loads(response.text)['text'] == '慢'

    run(main)


def test_a_streamed_run_is_ndjson() -> None:
    async def main() -> None:
        app, _ = app_of([{'type': 'tool-call', 'id': 'c1', 'input': {'text': 'x'}}, {'type': 'text', 'text': 'ok'}])
        async with client(app) as http:
            response = await http.post('/runs?stream=1', json={'session': 's', 'agent': AGENT, 'input': 'hi'})
            assert response.headers['content-type'].startswith('application/x-ndjson')
            events = [json.loads(line) for line in response.text.splitlines() if line.strip()]
            assert events[0]['type'] == 'run.started'
            assert events[-1]['type'] == 'run.ended'
            assert events[-1]['result']['text'] == 'ok'
            assert {'tool.called', 'tool.returned'} <= {event['type'] for event in events}

    run(main)


def test_cancel_before_and_during_a_run() -> None:
    async def main() -> None:
        app, _ = app_of([{'type': 'text', 'text': 'late'}], delay_ms=5000)
        async with client(app) as http:
            # 取消先到：记下来，这一轮一到就以已中止开始。
            assert (await http.delete('/runs/early')).json() == {'cancelled': False}
            early = await http.post('/runs', json={'session': 'a', 'agent': AGENT, 'input': 'hi', 'runId': 'early'})
            assert early.json()['stopReason'] == 'aborted'
            running = asyncio.ensure_future(
                http.post('/runs', json={'session': 'b', 'agent': AGENT, 'input': 'hi', 'runId': 'late'})
            )
            await asyncio.sleep(0.2)
            again = await http.post('/runs', json={'session': 'c', 'agent': AGENT, 'input': 'hi', 'runId': 'late'})
            assert again.status_code == 409
            assert (await http.delete('/runs/late')).json() == {'cancelled': True}
            assert (await running).json()['stopReason'] == 'aborted'
            aborted = await http.post('/runs', json={'session': 'd', 'agent': AGENT, 'input': 'hi', 'aborted': True})
            assert aborted.json()['stopReason'] == 'aborted'

    run(main)


def test_requests_the_server_refuses() -> None:
    async def main() -> None:
        app, _ = app_of([], max_runs=1, allowed_models=['scripted'], max_body_bytes=2048, delay_ms=5000)
        async with client(app) as http:

            async def refused(body: Any, status: int) -> dict[str, Any]:
                response = await http.post('/runs', content=body if isinstance(body, bytes) else json.dumps(body))
                assert response.status_code == status, response.text
                return response.json()['error']

            assert (await refused(b'{', 400))['message'].startswith('request body is not JSON')
            assert (await refused({'agent': AGENT}, 400))['message'] == 'RunRequest.session must be a string'
            model = {'session': 's', 'agent': {'model': {'provider': 'x', 'modelId': 'y'}}}
            assert 'model objects cannot cross the boundary' in (await refused(model, 400))['message']
            other = {'session': 's', 'agent': {'model': 'gpt-5'}}
            assert (await refused(other, 400))['message'] == 'model "gpt-5" is not allowed by this server'
            headers = {'session': 's', 'agent': {**AGENT, 'settings': {'headers': {'x': 'y'}}}}
            assert (await refused(headers, 400))['message'].startswith(
                'RunRequest.agent.settings.headers is not accepted'
            )
            parent = {'session': 's', 'agent': AGENT, 'parent': {'session': 'p'}}
            assert (await refused(parent, 400))['message'] == 'RunRequest.parent.runId must be a non-empty string'
            assert (await refused({'session': 's', 'agent': AGENT, 'input': 'x' * 4096}, 413))[
                'type'
            ] == 'request_too_large'
            busy = asyncio.ensure_future(
                http.post('/runs', json={'session': 'a', 'agent': AGENT, 'input': 'hi', 'runId': 'r'})
            )
            await asyncio.sleep(0.2)
            full = await refused({'session': 'b', 'agent': AGENT, 'input': 'hi'}, 429)
            assert full['retryable'] is True
            await http.delete('/runs/r')
            await busy

    run(main)


def test_conformance_instances() -> None:
    async def main() -> None:
        app = create_conformance_app(access_token=TOKEN)
        async with client(app) as http:
            sessions_only = await http.post(CONFORMANCE_PATH, json={'components': ['sessions']})
            assert sessions_only.status_code == 400
            assert 'tests the harness only' in sessions_only.json()['error']['message']
            setup = {'components': ['sessions', 'harness'], 'script': [{'type': 'text', 'text': '好'}]}
            created = (await http.post(CONFORMANCE_PATH, json=setup)).json()
            assert created['agent'] == {'model': 'scripted'}
            assert created['executor'] == {'name': 'local', 'echo': 'echo'}
            base = created['baseUrl']
            result = (
                await http.post(f'{base}/runs', json={'session': 'a/b', 'agent': created['agent'], 'input': 'hi'})
            ).json()
            assert result['text'] == '好'
            listed = (await http.get(f'{base}/sessions/a%2Fb/entries', params={'types': 'event', 'last': '1'})).json()
            assert [entry['kind'] for entry in listed['entries']] == ['ctx.run.ended']
            conflict = await http.post(
                f'{base}/sessions/a%2Fb/entries', json={'entries': [{'type': 'event', 'kind': 'x'}], 'expectSeq': 1}
            )
            assert conflict.status_code == 409
            assert conflict.json()['error']['type'] == 'conflict'
            assert (await http.get(f'{base}/sessions')).json() == {'sessions': ['a/b']}
            assert (await http.get('/protocol')).json()['protocol'] == PROTOCOL_VERSION

    run(main)


def test_browsers_and_foreign_hosts_are_refused() -> None:
    async def main() -> None:
        store = MemorySessionStore()
        harness = PydanticAIHarness(store=store, models={'scripted': ScriptedModel([])})
        app = create_app(harness, allowed_hosts=['127.0.0.1:8090'])
        transport = httpx2.ASGITransport(app=app)
        async with httpx2.AsyncClient(transport=transport, base_url='http://127.0.0.1:8090') as http:
            assert (await http.get('/protocol')).status_code == 200
            web = await http.get('/protocol', headers={'origin': 'https://example.com'})
            assert web.status_code == 403
            assert web.json()['error'] == {'message': 'origin not allowed', 'type': 'permission_error'}
        async with httpx2.AsyncClient(transport=transport, base_url='http://evil.example:8090') as http:
            assert (await http.get('/protocol')).json()['error']['message'] == 'host not allowed'
        try:
            create_app(harness, access_token=' ')
        except ValueError as error:
            assert 'access_token is empty' in str(error)
        else:
            raise AssertionError('an empty token must be refused')

    run(main)
