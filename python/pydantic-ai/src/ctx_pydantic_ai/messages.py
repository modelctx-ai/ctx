"""ctx 的消息（``docs/protocol.md`` 的 ``Message``）和 pydantic-ai 的 ``ModelMessage`` 之间的转换，加上从日志投影出历史。

投影照协议包 ``project`` 的缺省规则：按 ``(at, seq)`` 排，``covers`` 最大的摘要代替它盖住的条目、渲染成一条用户消息排在最前，
事件不进上下文，助手消息和紧跟的工具结果是一组，组里的调用和结果按 ``id`` 配对（没有调用的结果去掉，没有结果的调用补一条
错误结果）。不裁窗口。
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

from .protocol import Json, error_output

#: ``providerOptions`` 里放 pydantic-ai 自己的字段（推理的签名）用的键。
PROVIDER_KEY = 'pydantic-ai'
#: 日志里有调用、没有结果（协议包投影的 ``MISSING_RESULT``）。
MISSING_RESULT = 'No result was recorded for this tool call.'


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


def project(entries: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
    """日志 → 上下文里的 ctx 消息（协议包 ``project`` 的缺省规则，不裁窗口）。"""
    ordered = sorted(entries, key=lambda entry: (entry.get('at', 0), entry.get('seq', 0)))
    summary: Mapping[str, Any] | None = None
    for entry in ordered:
        if entry.get('type') != 'summary':
            continue
        if (
            summary is None
            or entry['covers'] > summary['covers']
            or (entry['covers'] == summary['covers'] and entry['seq'] > summary['seq'])
        ):
            summary = entry
    out: list[dict[str, Any]] = []
    if summary is not None:
        out.append({'role': 'user', 'content': f'Summary of the earlier conversation:\n{summary.get("text", "")}'})
    rest = [
        dict(entry['message'])
        for entry in ordered
        if entry.get('type') == 'message' and (summary is None or entry['seq'] > summary['covers'])
    ]
    for group in _blocks(rest):
        # 开头是工具结果的组：它的调用不在视图里（被摘要盖住了），整组不要。
        if group[0].get('role') != 'tool':
            out.extend(_paired(group))
    return out


def _blocks(messages: list[dict[str, Any]]) -> list[list[dict[str, Any]]]:
    """带工具调用的助手消息和紧跟的工具结果是一组。"""
    out: list[list[dict[str, Any]]] = []
    for message in messages:
        if message.get('role') == 'tool' and out:
            out[-1].append(message)
        else:
            out.append([message])
    return out


def _paired(group: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """一组里的工具调用和结果按 ``id`` 配对：结果找不到同组的调用就去掉，调用找不到结果就补一条错误结果。
    服务商自己执行的调用（``providerExecuted``）不补。"""
    first, *results = group
    calls: dict[str, Any] = {}
    answered: set[str] = set()
    content = first.get('content')
    if first.get('role') == 'assistant' and isinstance(content, list):
        for part in content:
            if part.get('type') == 'tool-call' and part.get('providerExecuted') is not True:
                calls[str(part.get('id'))] = part.get('name')
            if part.get('type') == 'tool-result':
                answered.add(str(part.get('id')))
    out = [first]
    for message in results:
        parts = message.get('content')
        if message.get('role') != 'tool' or isinstance(parts, str):
            out.append(message)
            continue
        kept = [part for part in parts or [] if part.get('type') != 'tool-result' or str(part.get('id')) in calls]
        answered.update(str(part.get('id')) for part in kept if part.get('type') == 'tool-result')
        if len(kept) == len(parts or []):
            out.append(message)
        elif kept:
            out.append({**message, 'content': kept})
    missing = [(call_id, name) for call_id, name in calls.items() if call_id not in answered]
    if missing:
        out.append(
            {
                'role': 'tool',
                'content': [
                    {'type': 'tool-result', 'id': call_id, 'name': name, 'output': error_output(MISSING_RESULT)}
                    for call_id, name in missing
                ],
            }
        )
    return out


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
