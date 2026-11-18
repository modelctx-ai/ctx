"""ctx 的消息（``docs/protocol.md`` 的 ``Message``）和 pydantic-ai 的 ``ModelMessage`` 之间的转换。从日志投影出历史在
``context``。
"""

from __future__ import annotations

import base64
import json
from collections.abc import Mapping, Sequence
from typing import Any

from pydantic_ai.messages import (
    AudioUrl,
    BinaryContent,
    DocumentUrl,
    ImageUrl,
    ModelMessage,
    ModelRequest,
    ModelRequestPart,
    ModelResponse,
    ModelResponsePart,
    RetryFeedbackPart,
    RetryPromptPart,
    SystemPromptPart,
    TextPart,
    ThinkingPart,
    ToolCallPart,
    ToolReturnPart,
    UserContent,
    UserPromptPart,
    VideoUrl,
)

from .protocol import Json

#: ``providerOptions`` 里放 pydantic-ai 自己的字段（推理的签名）用的键。
PROVIDER_KEY = 'pydantic-ai'


# ---- ctx → pydantic-ai ----


def _file_content(part: Mapping[str, Any]) -> UserContent:
    media = str(part.get('mediaType') or 'application/octet-stream')
    data = part.get('data') or {}
    kind = data.get('type')
    if kind == 'data':
        return BinaryContent(data=base64.b64decode(str(data.get('data', ''))), media_type=media)
    if kind == 'url':
        url = str(data.get('url', ''))
        if media.startswith('image/'):
            return ImageUrl(url=url)
        if media.startswith('audio/'):
            return AudioUrl(url=url)
        if media.startswith('video/'):
            return VideoUrl(url=url)
        return DocumentUrl(url=url)
    if kind == 'text':
        return str(data.get('text', ''))
    return f'[{part.get("filename") or media}: a provider file reference this model cannot read]'


def user_content(content: Json) -> str | list[UserContent]:
    """``MessageContent``（字符串或文字、文件的列表）→ pydantic-ai 的用户内容。"""
    if isinstance(content, str):
        return content
    out: list[UserContent] = []
    for part in content or []:
        if part.get('type') == 'text':
            out.append(str(part.get('text', '')))
        elif part.get('type') == 'file':
            out.append(_file_content(part))
    return out


def tool_return_content(output: Mapping[str, Any]) -> Any:
    """``ToolOutput`` → 交给模型的工具结果。"""
    kind = output.get('type')
    if kind == 'text':
        return str(output.get('text', ''))
    if kind == 'json':
        return output.get('value')
    if kind == 'error':
        return str(output.get('message', ''))
    parts: list[Any] = []
    for part in output.get('parts') or []:
        parts.append(str(part.get('text', '')) if part.get('type') == 'text' else _file_content(part))
    if all(isinstance(part, str) for part in parts):
        return '\n'.join(parts)
    return parts


def _response_parts(content: Json) -> list[ModelResponsePart]:
    if isinstance(content, str):
        return [TextPart(content=content)] if content else []
    parts: list[ModelResponsePart] = []
    for part in content or []:
        kind = part.get('type')
        if kind == 'text' and part.get('text'):
            parts.append(TextPart(content=str(part['text'])))
        elif kind == 'reasoning':
            own = (part.get('providerOptions') or {}).get(PROVIDER_KEY) or {}
            parts.append(
                ThinkingPart(
                    content=str(part.get('text', '')),
                    signature=own.get('signature'),
                    id=own.get('id'),
                    provider_name=own.get('providerName'),
                )
            )
        elif kind == 'tool-call':
            value = part.get('input')
            parts.append(
                ToolCallPart(
                    tool_name=str(part.get('name', '')),
                    args=value if isinstance(value, dict) else json.dumps(value),
                    tool_call_id=str(part.get('id', '')),
                )
            )
    return parts


def to_model_messages(messages: Sequence[Mapping[str, Any]]) -> list[ModelMessage]:
    """ctx 消息 → pydantic-ai 的 ``message_history``：相邻的用户、工具消息并进一个 ``ModelRequest``。"""
    out: list[ModelMessage] = []
    pending: list[ModelRequestPart] = []
    for message in messages:
        role = message.get('role')
        content = message.get('content')
        if role == 'assistant':
            if pending:
                out.append(ModelRequest(parts=pending))
                pending = []
            parts = _response_parts(content)
            if parts:
                out.append(ModelResponse(parts=parts))
        elif role == 'user':
            pending.append(UserPromptPart(content=user_content(content)))
        elif role == 'system':
            pending.append(SystemPromptPart(content=str(content)))
        elif role == 'tool':
            for part in content or []:
                if part.get('type') != 'tool-result':
                    continue
                output = part.get('output') or {}
                pending.append(
                    ToolReturnPart(
                        tool_name=str(part.get('name', '')),
                        content=tool_return_content(output),
                        tool_call_id=str(part.get('id', '')),
                        outcome='failed' if output.get('type') == 'error' else 'success',
                    )
                )
    if pending:
        out.append(ModelRequest(parts=pending))
    return out


# ---- pydantic-ai → ctx ----

_FINISH_REASONS = {
    'stop': 'stop',
    'length': 'length',
    'content_filter': 'content-filter',
    'tool_call': 'tool-calls',
    'error': 'error',
}


def finish_reason_of(response: ModelResponse) -> str:
    """``StepMeta.finishReason``（AI SDK 的写法）。服务商没给时按有没有工具调用推。"""
    if response.finish_reason is not None:
        return _FINISH_REASONS.get(response.finish_reason, str(response.finish_reason))
    return 'tool-calls' if any(isinstance(part, ToolCallPart) for part in response.parts) else 'stop'


def assistant_message(response: ModelResponse, function_tools: set[str], output_tool: str | None) -> dict[str, Any]:
    """一步的模型回答 → ctx 的助手消息。结构化输出的工具（``output_tool``）的调用记成它交的 JSON 文字。"""
    parts: list[dict[str, Any]] = []
    for part in response.parts:
        if isinstance(part, TextPart):
            if part.content:
                parts.append({'type': 'text', 'text': part.content})
        elif isinstance(part, ThinkingPart):
            own = {
                key: value
                for key, value in (
                    ('signature', part.signature),
                    ('id', part.id),
                    ('providerName', part.provider_name),
                )
                if value is not None
            }
            reasoning: dict[str, Any] = {'type': 'reasoning', 'text': part.content}
            if own:
                reasoning['providerOptions'] = {PROVIDER_KEY: own}
            parts.append(reasoning)
        elif isinstance(part, ToolCallPart):
            if output_tool is not None and part.tool_name == output_tool and part.tool_name not in function_tools:
                parts.append({'type': 'text', 'text': part.args_as_json_str()})
                continue
            try:
                value: Json = part.args_as_dict()
            except Exception:  # noqa: BLE001 - 模型给的参数不是 JSON：原样记下
                value = part.args
            parts.append({'type': 'tool-call', 'id': part.tool_call_id, 'name': part.tool_name, 'input': value})
        else:
            parts.append({'type': 'custom', 'kind': f'pydantic-ai.{getattr(part, "part_kind", "part")}'})
    return {'role': 'assistant', 'content': parts}


def text_of(message: Mapping[str, Any]) -> str:
    content = message.get('content')
    if isinstance(content, str):
        return content
    return ''.join(str(part.get('text', '')) for part in content or [] if part.get('type') == 'text')


def retry_text(part: RetryFeedbackPart | RetryPromptPart | ToolReturnPart) -> str:
    """pydantic-ai 让模型改了再来的那段话（模型看到的样子）。"""
    if isinstance(part, ToolReturnPart):
        return part.model_response_str()
    return part.model_response()


def usage_of(usage: Any) -> dict[str, int]:
    """pydantic-ai 的 ``RequestUsage`` / ``RunUsage`` → ctx 的 ``Usage``：缓存和推理是 0 时不写。"""
    inputs = int(getattr(usage, 'input_tokens', 0) or 0)
    outputs = int(getattr(usage, 'output_tokens', 0) or 0)
    out = {'inputTokens': inputs, 'outputTokens': outputs, 'totalTokens': inputs + outputs}
    for key, name in (
        ('cacheReadTokens', 'cache_read_tokens'),
        ('cacheWriteTokens', 'cache_write_tokens'),
        ('reasoningTokens', 'output_reasoning_tokens'),
    ):
        value = int(getattr(usage, name, 0) or 0)
        if value > 0:
            out[key] = value
    return out


def add_usage(total: dict[str, int] | None, step: Mapping[str, int]) -> dict[str, int]:
    out = dict(total or {})
    for key, value in step.items():
        out[key] = out.get(key, 0) + value
    return out
