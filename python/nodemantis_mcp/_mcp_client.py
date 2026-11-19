"""Client services used by the MCP layer."""
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Mapping, Optional


@dataclass(frozen=True)
class McpClient:
    start_session: Callable[..., Awaitable[Any]]
    resolve_api_key: Callable[[Mapping[str, str]], Optional[str]]
    report_missing_api_key: Callable[[], None]
    version: Callable[[], str]
