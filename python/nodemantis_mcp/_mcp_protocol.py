"""Minimal Model Context Protocol server over a newline-delimited JSON-RPC
stream (the stdio transport). This module exposes tools and uses only
standard library modules.

It serves both protocol eras on one stream:
 - legacy clients open with an ``initialize`` handshake (revisions up to
   2025-11-25);
 - clients using revision 2026-07-28 send no handshake and declare the
   protocol version in every request's ``_meta``; they may probe with
   ``server/discover`` first.
A request that carries the modern version key is served under modern rules,
anything else under legacy rules.

All methods run on the event loop thread.
"""

from __future__ import annotations

import asyncio
import json
import math
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Dict, List, Optional, Set, Union

MODERN_PROTOCOL_VERSIONS = ("2026-07-28",)
LEGACY_PROTOCOL_VERSIONS = ("2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05")

META_PROTOCOL_VERSION = "io.modelcontextprotocol/protocolVersion"
META_CLIENT_CAPABILITIES = "io.modelcontextprotocol/clientCapabilities"
META_SERVER_INFO = "io.modelcontextprotocol/serverInfo"

PARSE_ERROR = -32700
INVALID_REQUEST = -32600
METHOD_NOT_FOUND = -32601
INVALID_PARAMS = -32602
INTERNAL_ERROR = -32603
UNSUPPORTED_PROTOCOL_VERSION = -32022

# Modern revisions require caching hints on discovery and list results. The
# tool list is fixed for the life of the process and the same for everyone.
CACHE_HINTS = {"ttlMs": 5 * 60_000, "cacheScope": "public"}

# Longest accepted input line; a client never needs more for a tool call.
MAX_LINE_BYTES = 8 * 1024 * 1024

JsonRpcId = Union[str, int, float]


@dataclass
class McpToolResult:
    # Model-readable text.
    text: str
    # The same result as JSON, for clients that read structured output.
    structured_content: Any = None
    # True for a tool execution error the model can react to.
    is_error: bool = False


@dataclass
class McpToolCallContext:
    # Set when the client cancels this request.
    cancelled: asyncio.Event
    # Sends a progress note for this request, if the client asked for them.
    progress: Callable[[str], None]


ToolHandler = Callable[[str, Dict[str, Any], McpToolCallContext], Awaitable[McpToolResult]]


class ProtocolError(Exception):
    """A protocol-level failure answered as a JSON-RPC error."""

    def __init__(self, code: int, message: str, data: Any = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.data = data


def _is_request_id(value: Any) -> bool:
    if isinstance(value, bool):
        return False
    if isinstance(value, str):
        return True
    return isinstance(value, (int, float)) and math.isfinite(value)


class McpServer:
    def __init__(
        self,
        *,
        name: str,
        title: str,
        version: str,
        instructions: str,
        tools: List[Dict[str, Any]],
        call_tool: ToolHandler,
        write: Callable[[str], None],
        log: Optional[Callable[[str], None]] = None,
    ) -> None:
        self._name = name
        self._title = title
        self._version = version
        self._instructions = instructions
        self._tools = tools
        self._call_tool = call_tool
        self._write = write
        self._log = log
        self._in_flight: Dict[JsonRpcId, asyncio.Event] = {}
        self._pending: Set["asyncio.Task[None]"] = set()
        self._buffered = bytearray()
        self._overflow = False

    def push(self, chunk: Union[bytes, str]) -> None:
        """Feed raw bytes from the client."""
        self._buffered += chunk.encode("utf-8") if isinstance(chunk, str) else chunk
        while True:
            newline = self._buffered.find(b"\n")
            if newline == -1:
                break
            line = bytes(self._buffered[:newline])
            del self._buffered[: newline + 1]
            if self._overflow:
                # The tail of an oversized line: already answered, drop it.
                self._overflow = False
                continue
            self._handle_line(line)
        if not self._overflow and len(self._buffered) > MAX_LINE_BYTES:
            self._buffered.clear()
            self._overflow = True
            self._send_error(None, INVALID_REQUEST, "Message too large")

    def abort_all(self) -> None:
        """Abort every in-flight request (the client went away)."""
        for cancelled in list(self._in_flight.values()):
            cancelled.set()
        self._in_flight.clear()

    async def idle(self) -> None:
        """Returns once every request that already started has been answered."""
        while self._pending:
            await asyncio.gather(*list(self._pending), return_exceptions=True)

    def _handle_line(self, raw_line: bytes) -> None:
        line = raw_line[:-1] if raw_line.endswith(b"\r") else raw_line
        if not line.strip():
            return
        try:
            message = json.loads(line.decode("utf-8"))
        except (ValueError, RecursionError):
            self._send_error(None, PARSE_ERROR, "Parse error")
            return
        if not isinstance(message, dict):
            # JSON-RPC batches were removed from the protocol; nothing else is valid here.
            self._send_error(None, INVALID_REQUEST, "Expected one JSON-RPC message object per line")
            return
        method = message.get("method")
        request_id = message.get("id")
        if not isinstance(method, str):
            # A response (we never send requests) or garbage. Only garbage with an id gets an answer.
            if _is_request_id(request_id) and "result" not in message and "error" not in message:
                self._send_error(request_id, INVALID_REQUEST, "Missing method")
            return
        if request_id is None:
            self._handle_notification(method, message.get("params"))
            return
        if not _is_request_id(request_id):
            self._send_error(None, INVALID_REQUEST, "Request id must be a string or number")
            return
        task = asyncio.ensure_future(self._handle_request(request_id, method, message.get("params")))
        self._pending.add(task)
        task.add_done_callback(self._request_done)

    def _request_done(self, task: "asyncio.Task[None]") -> None:
        self._pending.discard(task)
        if not task.cancelled() and task.exception() is not None and self._log:
            self._log(f"mcp: unexpected failure answering a request: {task.exception()}")

    def _handle_notification(self, method: str, params: Any) -> None:
        if method == "notifications/cancelled" and isinstance(params, dict) and _is_request_id(params.get("requestId")):
            cancelled = self._in_flight.pop(params["requestId"], None)
            if cancelled is not None:
                cancelled.set()
        # notifications/initialized and anything unknown: nothing to do.

    async def _handle_request(self, request_id: JsonRpcId, method: str, params: Any) -> None:
        cancelled = asyncio.Event()
        self._in_flight[request_id] = cancelled
        try:
            meta = params.get("_meta") if isinstance(params, dict) and isinstance(params.get("_meta"), dict) else None
            modern = meta is not None and META_PROTOCOL_VERSION in meta
            if modern:
                self._assert_modern_meta(meta)
            result = await self._dispatch(method, params if isinstance(params, dict) else {}, meta, modern, cancelled)
            # A cancelled request gets no response.
            if cancelled.is_set():
                return
            if modern:
                result = {"resultType": "complete", **result, "_meta": {META_SERVER_INFO: self._server_info()}}
            self._send({"jsonrpc": "2.0", "id": request_id, "result": result})
        except ProtocolError as error:
            if not cancelled.is_set():
                self._send_error(request_id, error.code, error.message, error.data)
        except Exception as error:  # noqa: BLE001 - protocol boundary
            if not cancelled.is_set():
                if self._log:
                    self._log(f"mcp: {method} failed: {error}")
                self._send_error(request_id, INTERNAL_ERROR, "Internal error")
        finally:
            if self._in_flight.get(request_id) is cancelled:
                del self._in_flight[request_id]

    def _assert_modern_meta(self, meta: Dict[str, Any]) -> None:
        requested = meta.get(META_PROTOCOL_VERSION)
        if not isinstance(requested, str) or requested not in MODERN_PROTOCOL_VERSIONS:
            raise ProtocolError(UNSUPPORTED_PROTOCOL_VERSION, "Unsupported protocol version", {
                "supported": list(MODERN_PROTOCOL_VERSIONS),
                "requested": requested,
            })
        if not isinstance(meta.get(META_CLIENT_CAPABILITIES), dict):
            raise ProtocolError(INVALID_PARAMS, f"Missing required _meta field {META_CLIENT_CAPABILITIES}")

    def _server_info(self) -> Dict[str, str]:
        return {"name": self._name, "title": self._title, "version": self._version}

    async def _dispatch(
        self,
        method: str,
        params: Dict[str, Any],
        meta: Optional[Dict[str, Any]],
        modern: bool,
        cancelled: asyncio.Event,
    ) -> Dict[str, Any]:
        if method == "initialize":
            if modern:
                raise ProtocolError(METHOD_NOT_FOUND, "initialize is not part of this protocol version")
            requested = params.get("protocolVersion")
            protocol_version = (
                requested
                if isinstance(requested, str) and requested in LEGACY_PROTOCOL_VERSIONS
                else LEGACY_PROTOCOL_VERSIONS[0]
            )
            return {
                "protocolVersion": protocol_version,
                "capabilities": {"tools": {}},
                "serverInfo": self._server_info(),
                "instructions": self._instructions,
            }
        if method == "server/discover":
            if not modern:
                raise ProtocolError(INVALID_PARAMS, f"Missing required _meta field {META_PROTOCOL_VERSION}")
            return {
                "supportedVersions": list(MODERN_PROTOCOL_VERSIONS),
                "capabilities": {"tools": {}},
                "instructions": self._instructions,
                **CACHE_HINTS,
            }
        if method == "ping":
            return {}
        if method == "tools/list":
            return {"tools": self._tools, **CACHE_HINTS} if modern else {"tools": self._tools}
        if method == "tools/call":
            return await self._call(params, meta, cancelled)
        raise ProtocolError(METHOD_NOT_FOUND, f"Method not found: {method}")

    async def _call(
        self,
        params: Dict[str, Any],
        meta: Optional[Dict[str, Any]],
        cancelled: asyncio.Event,
    ) -> Dict[str, Any]:
        name = params.get("name")
        if not isinstance(name, str) or not any(tool["name"] == name for tool in self._tools):
            raise ProtocolError(INVALID_PARAMS, f"Unknown tool: {name}")
        arguments = params.get("arguments")
        if arguments is None:
            arguments = {}
        if not isinstance(arguments, dict):
            raise ProtocolError(INVALID_PARAMS, "Tool arguments must be an object")

        token = (meta or {}).get("progressToken")
        progress_token = token if _is_request_id(token) else None
        sent = 0

        def progress(message: str) -> None:
            nonlocal sent
            if progress_token is None or cancelled.is_set():
                return
            sent += 1
            self._send({
                "jsonrpc": "2.0",
                "method": "notifications/progress",
                "params": {"progressToken": progress_token, "progress": sent, "message": message},
            })

        try:
            result = await self._call_tool(name, arguments, McpToolCallContext(cancelled=cancelled, progress=progress))
        except Exception as error:  # noqa: BLE001
            # Anything a tool raises is feedback for the model, not a protocol fault.
            result = McpToolResult(text=str(error), is_error=True)
        reply: Dict[str, Any] = {"content": [{"type": "text", "text": result.text}]}
        if result.structured_content is not None:
            reply["structuredContent"] = result.structured_content
        reply["isError"] = result.is_error is True
        return reply

    def _send_error(self, request_id: Optional[JsonRpcId], code: int, message: str, data: Any = None) -> None:
        error: Dict[str, Any] = {"code": code, "message": message}
        if data is not None:
            error["data"] = data
        self._send({"jsonrpc": "2.0", "id": request_id, "error": error})

    def _send(self, message: Any) -> None:
        # ASCII-only output never contains a raw newline, so one message is one line.
        self._write(json.dumps(message, separators=(",", ":"), default=str))
