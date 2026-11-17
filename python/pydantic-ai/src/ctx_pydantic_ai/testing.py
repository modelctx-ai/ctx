"""测试和一致性模式用的东西：按剧本回答的 pydantic-ai 模型、回显工具。

剧本的一步和协议包的 ``ModelScriptStep`` 一样：``{ type: 'text', text, truncated? }`` 是一段回答（``truncated`` 时
``finish_reason`` 是 ``length``），``{ type: 'tool-call', id, input }`` 调回显工具，``{ type: 'error', message }`` 是模型调用失败。
另有两样：``tool-call`` 可以带 ``tool`` 换一个工具，``{ type: 'tool-calls', calls: [{ id, input, tool? }] }`` 一次并行调几个。
第 n 次调用模型回第 n 步。要了结构化输出时，能解析成 JSON 对象的 ``text`` 交给输出工具。
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator, Mapping, Sequence
from contextlib import asynccontextmanager
from typing import Any

from pydantic_ai.exceptions import ModelAPIError
from pydantic_ai.messages import ModelMessage, ModelResponse, TextPart, ToolCallPart
from pydantic_ai.models import ModelRequestParameters, StreamedResponse
from pydantic_ai.models.function import AgentInfo, DeltaToolCall, FunctionModel
from pydantic_ai.settings import ModelSettings

from .executors import FunctionExecutor

#: 回显工具：``inputSchema`` 要求 ``text`` 是字符串，结果原样带着输入（契约用 ``{ text: 42 }`` 查输入校验）。
ECHO_TOOL = {
    'name': 'echo',
    'description': '原样返回输入',
    'inputSchema': {'type': 'object', 'properties': {'text': {'type': 'string'}}},
}


def echo_executor(name: str = 'local') -> FunctionExecutor:
    """带回显工具的函数执行环境。"""
    return FunctionExecutor(name).register(ECHO_TOOL, lambda value, context: {'type': 'json', 'value': value})


def _parsed_object(text: str) -> dict[str, Any] | None:
    try:
        value = json.loads(text)
    except ValueError:
        return None
    return value if isinstance(value, dict) else None


class ScriptedModel(FunctionModel):
    """按剧本回答的模型。``delay_ms`` 是每一步先等多久（可以被取消）。"""

    def __init__(
        self,
        script: Sequence[Mapping[str, Any]],
        *,
        tool: str = 'echo',
        delay_ms: float = 0,
        model_name: str = 'scripted',
    ) -> None:
        self._script = list(script)
        self._tool = tool
        self._delay = delay_ms / 1000
        self._next = 0
        #: 每次调用模型时它收到的消息（给测试看）。
        self.requests: list[list[ModelMessage]] = []
        super().__init__(self._respond, stream_function=self._stream, model_name=model_name)

    def _take(self, messages: list[ModelMessage]) -> Mapping[str, Any]:
        self.requests.append(list(messages))
        index = self._next
        self._next += 1
        if index >= len(self._script):
            return {'type': 'error', 'message': 'The scripted model has no more steps.'}
        return self._script[index]

    def _peek(self) -> Mapping[str, Any] | None:
        return self._script[self._next] if self._next < len(self._script) else None

    def _tool_name(self, info: AgentInfo, wanted: Any = None) -> str:
        tool = str(wanted or self._tool)
        names = [definition.name for definition in info.function_tools]
        return next((name for name in names if name == tool or name.endswith(f'__{tool}')), tool)

    def _calls(self, step: Mapping[str, Any]) -> list[Mapping[str, Any]]:
        return list(step.get('calls') or []) if step.get('type') == 'tool-calls' else [step]

    def _structured(self, info: AgentInfo, text: str) -> tuple[str, dict[str, Any]] | None:
        if not info.output_tools:
            return None
        value = _parsed_object(text)
        return (info.output_tools[0].name, value) if value is not None else None

    async def _respond(self, messages: list[ModelMessage], info: AgentInfo) -> ModelResponse:
        if self._delay:
            await asyncio.sleep(self._delay)
        step = self._take(messages)
        kind = step.get('type')
        if kind == 'error':
            raise ModelAPIError(self.model_name, str(step.get('message', 'scripted error')))
        if kind in ('tool-call', 'tool-calls'):
            return ModelResponse(
                parts=[
                    ToolCallPart(
                        tool_name=self._tool_name(info, call.get('tool')),
                        args=dict(call.get('input') or {}),
                        tool_call_id=str(call.get('id')),
                    )
                    for call in self._calls(step)
                ]
            )
        text = str(step.get('text', ''))
        structured = self._structured(info, text)
        if structured is not None:
            return ModelResponse(
                parts=[ToolCallPart(tool_name=structured[0], args=structured[1], tool_call_id='out-1')]
            )
        return ModelResponse(
            parts=[TextPart(content=text)], finish_reason='length' if step.get('truncated') else 'stop'
        )

    async def _stream(self, messages: list[ModelMessage], info: AgentInfo) -> AsyncIterator[Any]:
        if self._delay:
            await asyncio.sleep(self._delay)
        step = self._take(messages)
        kind = step.get('type')
        if kind == 'error':
            raise ModelAPIError(self.model_name, str(step.get('message', 'scripted error')))
        if kind in ('tool-call', 'tool-calls'):
            yield {
                index: DeltaToolCall(
                    name=self._tool_name(info, call.get('tool')),
                    json_args=json.dumps(call.get('input') or {}, ensure_ascii=False),
                    tool_call_id=str(call.get('id')),
                )
                for index, call in enumerate(self._calls(step))
            }
            return
        text = str(step.get('text', ''))
        structured = self._structured(info, text)
        if structured is not None:
            yield {0: DeltaToolCall(name=structured[0], json_args=json.dumps(structured[1]), tool_call_id='out-1')}
            return
        # 一个字一个字地给：流式的一方看得到增量。
        for char in text:
            yield char

    @asynccontextmanager
    async def request_stream(
        self,
        messages: list[ModelMessage],
        model_settings: ModelSettings | None,
        model_request_parameters: ModelRequestParameters,
        run_context: Any = None,
    ) -> AsyncIterator[StreamedResponse]:
        upcoming = self._peek()
        async with super().request_stream(messages, model_settings, model_request_parameters, run_context) as response:
            # 流式的函数模型不给 `finish_reason`：被截断的那一步在这里补上。
            if upcoming is not None and upcoming.get('type') == 'text' and upcoming.get('truncated'):
                response.finish_reason = 'length'
            yield response
