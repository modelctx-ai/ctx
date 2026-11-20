"""把 pydantic-ai 的 ``Agent`` 接成 ctx 的 harness：轨迹实时写进 ctx 的会话日志，工具调用交给 ctx 的执行环境，经 ctx 的线上协议对外。"""

from .context import ContextSource, EventRule, ProjectionOptions
from .executors import Executor, FunctionExecutor, RemoteExecutor
from .harness import (
    HARNESS_NAME,
    INTERRUPTED,
    OUTPUT_TOOL,
    RETRY_EVENT,
    AbortSignal,
    PydanticAIHarness,
    spec_problem,
)
from .protocol import (
    DEFAULT_MAX_TOOL_OUTPUT_CHARS,
    ENTRY_VERSION,
    PROTOCOL_VERSION,
    TOOL_APPROVAL_KEY_PREFIX,
    TOOL_RESULT_KEY_PREFIX,
    CtxError,
    approval_denied_output,
    pending_tool_calls,
    tool_approval_entry,
    tool_result_entry,
)
from .server import CONFORMANCE_PATH, create_app, create_conformance_app
from .store import MemorySessionStore, RemoteSessionStore, SessionStore

__all__ = [
    'CONFORMANCE_PATH',
    'DEFAULT_MAX_TOOL_OUTPUT_CHARS',
    'ENTRY_VERSION',
    'HARNESS_NAME',
    'INTERRUPTED',
    'OUTPUT_TOOL',
    'PROTOCOL_VERSION',
    'RETRY_EVENT',
    'TOOL_APPROVAL_KEY_PREFIX',
    'TOOL_RESULT_KEY_PREFIX',
    'AbortSignal',
    'ContextSource',
    'CtxError',
    'EventRule',
    'Executor',
    'FunctionExecutor',
    'MemorySessionStore',
    'ProjectionOptions',
    'PydanticAIHarness',
    'RemoteExecutor',
    'RemoteSessionStore',
    'SessionStore',
    'approval_denied_output',
    'create_app',
    'create_conformance_app',
    'pending_tool_calls',
    'spec_problem',
    'tool_approval_entry',
    'tool_result_entry',
]
