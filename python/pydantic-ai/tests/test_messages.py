"""ctx 的消息和 pydantic-ai 的 ``ModelMessage`` 之间的转换。"""

from __future__ import annotations

import base64

from pydantic_ai.messages import (
    BinaryContent,
    ImageUrl,
    ModelRequest,
    ModelResponse,
    SystemPromptPart,
    TextPart,
    ThinkingPart,
    ToolCallPart,
    ToolReturnPart,
    UserPromptPart,
)
from pydantic_ai.usage import RequestUsage

from ctx_pydantic_ai.messages import (
    PROVIDER_KEY,
    assistant_message,
    finish_reason_of,
    to_model_messages,
    tool_return_content,
    usage_of,
)


def test_user_and_tool_messages_merge_into_one_request() -> None:
    png = base64.b64encode(b'\x89PNG').decode()
    history = to_model_messages(
        [
            {'role': 'system', 'content': '规则'},
            {
                'role': 'user',
                'content': [
                    {'type': 'text', 'text': '看图'},
                    {'type': 'file', 'mediaType': 'image/png', 'data': {'type': 'data', 'data': png}},
                    {
                        'type': 'file',
                        'mediaType': 'image/jpeg',
                        'data': {'type': 'url', 'url': 'https://example.com/a.jpg'},
                    },
                ],
            },
            {
                'role': 'assistant',
                'content': [
                    {'type': 'text', 'text': '查一下'},
                    {'type': 'tool-call', 'id': 'c1', 'name': 'echo', 'input': {}},
                ],
            },
            {
                'role': 'tool',
                'content': [
                    {'type': 'tool-result', 'id': 'c1', 'name': 'echo', 'output': {'type': 'error', 'message': 'no'}}
                ],
            },
            {'role': 'user', 'content': '继续'},
        ]
    )
    assert [type(message) for message in history] == [ModelRequest, ModelResponse, ModelRequest]
    system, user = history[0].parts
    assert isinstance(system, SystemPromptPart) and system.content == '规则'
    assert isinstance(user, UserPromptPart)
    text, image, url = user.content
    assert text == '看图'
    assert isinstance(image, BinaryContent) and image.data == b'\x89PNG' and image.media_type == 'image/png'
    assert isinstance(url, ImageUrl) and url.url == 'https://example.com/a.jpg'
    assert [type(part) for part in history[1].parts] == [TextPart, ToolCallPart]
    result, follow = history[2].parts
    assert isinstance(result, ToolReturnPart)
    assert (result.tool_call_id, result.content, result.outcome) == ('c1', 'no', 'failed')
    assert isinstance(follow, UserPromptPart) and follow.content == '继续'


def test_reasoning_keeps_its_signature_across_runs() -> None:
    response = ModelResponse(
        parts=[ThinkingPart(content='想一想', signature='sig', provider_name='anthropic'), TextPart(content='答案')]
    )
    message = assistant_message(response, set(), None)
    assert message == {
        'role': 'assistant',
        'content': [
            {
                'type': 'reasoning',
                'text': '想一想',
                'providerOptions': {PROVIDER_KEY: {'signature': 'sig', 'providerName': 'anthropic'}},
            },
            {'type': 'text', 'text': '答案'},
        ],
    }
    [back] = to_model_messages([message])
    thinking, text = back.parts
    assert isinstance(thinking, ThinkingPart)
    assert (thinking.content, thinking.signature, thinking.provider_name) == ('想一想', 'sig', 'anthropic')
    assert isinstance(text, TextPart) and text.content == '答案'


def test_the_output_tool_is_logged_as_text() -> None:
    response = ModelResponse(
        parts=[
            ToolCallPart(tool_name='echo', args={'text': 'x'}, tool_call_id='c1'),
            ToolCallPart(tool_name='final_result', args={'n': 1}, tool_call_id='out'),
        ]
    )
    assert assistant_message(response, {'echo'}, 'final_result')['content'] == [
        {'type': 'tool-call', 'id': 'c1', 'name': 'echo', 'input': {'text': 'x'}},
        {'type': 'text', 'text': '{"n":1}'},
    ]
    # 没要结构化输出时，同名的就是普通的工具调用。
    assert assistant_message(response, {'echo', 'final_result'}, None)['content'][1]['type'] == 'tool-call'


def test_tool_results_for_the_model() -> None:
    assert tool_return_content({'type': 'text', 'text': 'a'}) == 'a'
    assert tool_return_content({'type': 'json', 'value': {'a': 1}}) == {'a': 1}
    assert (
        tool_return_content(
            {'type': 'content', 'parts': [{'type': 'text', 'text': 'a'}, {'type': 'text', 'text': 'b'}]}
        )
        == 'a\nb'
    )


def test_usage_and_finish_reason() -> None:
    assert usage_of(RequestUsage(input_tokens=10, output_tokens=5)) == {
        'inputTokens': 10,
        'outputTokens': 5,
        'totalTokens': 15,
    }
    assert usage_of(RequestUsage(input_tokens=10, output_tokens=5, cache_read_tokens=4))['cacheReadTokens'] == 4
    assert finish_reason_of(ModelResponse(parts=[TextPart('x')], finish_reason='length')) == 'length'
    assert finish_reason_of(ModelResponse(parts=[TextPart('x')], finish_reason='content_filter')) == 'content-filter'
    assert finish_reason_of(ModelResponse(parts=[ToolCallPart(tool_name='a', args={})])) == 'tool-calls'
    assert finish_reason_of(ModelResponse(parts=[TextPart('x')])) == 'stop'
