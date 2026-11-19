"""Node Mantis MCP tools, input validation, and stdio server lifecycle.

Tasks continue in the background when a tool call reaches its wait limit.
"""

from __future__ import annotations

import asyncio
import json
import math
import os
import re
import signal
import sys
import threading
from typing import Any, Callable, Dict, List, Mapping, Optional
from urllib.parse import urlsplit

from ._mcp_client import McpClient
from ._mcp_protocol import McpServer, McpToolCallContext, McpToolResult
from ._mcp_tasks import SessionFactory, TaskLimitError, TaskManager, TaskSpec

DEFAULT_WAIT_SECONDS = 45
MAX_WAIT_SECONDS = 600
DEFAULT_MAX_TASKS = 4
MAX_TASKS_LIMIT = 32
# Maximum wait for sessions to close before ending the MCP process.
SHUTDOWN_WAIT_SECONDS = 3.0

EFFORT_LEVELS = ("low", "medium", "high", "xhigh")
SERVICE_TIERS = ("flex", "standard")

MCP_DESCRIPTION = """\
Run a Model Context Protocol server on stdin/stdout so an assistant can
give NodeMantis website tasks. Assistants start this command themselves;
add it to their MCP settings as:

  command: uvx
  args:    node-mantis mcp
  env:     NODEMANTIS_API_KEY=sk_live_...   (not needed after nodemantis configure)

Tools: run_task, retrieve_data, get_task, cancel_task
"""

MCP_EPILOG = """\
Environment: NODEMANTIS_API_KEY, NODEMANTIS_SECRET_<NAME> (values for the secrets
a task may type), NODEMANTIS_PROXY / NODEMANTIS_PROXY_LIST / NODEMANTIS_PROXY_FILE
(used when a task sets use_proxy), NODEMANTIS_TIER, CHROME_PATH
"""

SERVER_INSTRUCTIONS = " ".join([
    "Node Mantis carries out tasks on websites in a real browser and returns the result as structured data.",
    "Use run_task for anything that needs clicking, typing or moving between pages, and retrieve_data to read data from one page.",
    "Both answer directly when the work finishes quickly. Otherwise they return status \"running\" with a task_id:",
    "call get_task with that id until the status is succeeded, failed or cancelled.",
    "Pass result_schema (a JSON Schema) to get the data in a fixed shape.",
    "Never put a password or other private value in a goal. Ask the user to set NODEMANTIS_SECRET_<NAME> in this server's",
    "environment, pass the name in secrets, and refer to it in the goal as <secret:NAME>.",
])

_RESULT_SCHEMA_PROPERTY = {
    "type": "object",
    "description": "JSON Schema describing the shape of the data to return, for example "
    "{\"type\":\"object\",\"properties\":{\"price\":{\"type\":\"number\"}},\"required\":[\"price\"]}. "
    "Omit it for a free-form answer.",
}
_EFFORT_PROPERTY = {
    "type": "string",
    "enum": list(EFFORT_LEVELS),
    "description": "How much capability to spend. Default medium; raise it for hard pages, lower it for simple ones.",
}
_USE_PROXY_PROPERTY = {
    "type": "boolean",
    "description": "Route the browser through the proxy configured in this server's environment. Default false.",
}
_SHOW_BROWSER_PROPERTY = {
    "type": "boolean",
    "description": "Show the browser window while the task runs. Default false unless the server was started with --headed.",
}

# Kept identical to MCP_TOOLS in the TypeScript client (a test compares them).
MCP_TOOLS: List[Dict[str, Any]] = [
    {
        "name": "run_task",
        "title": "Run a website task",
        "description":
            "Carry out a task on a website from a plain-English goal: navigate, click, type, fill in forms and read the outcome, "
            "in a real browser. Returns the outcome and, when result_schema is given, the data in that shape. "
            "If the task is still going when the call returns, the reply has status \"running\" and a task_id: "
            "call get_task with it. Each call starts a fresh browser session with no saved logins.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "goal": {
                    "type": "string",
                    "description": "What to accomplish, with every detail needed to finish it, e.g. \"Find the cheapest direct flight "
                    "from Boston to Denver on March 3 and return the airline, times and price\".",
                },
                "start_url": {"type": "string", "description": "Page to open first (http or https). Omit to let the task find its own way."},
                "result_schema": _RESULT_SCHEMA_PROPERTY,
                "effort": _EFFORT_PROPERTY,
                "max_cost_usd": {"type": "number", "exclusiveMinimum": 0, "description": "Stop once the task has spent this many US dollars."},
                "max_steps": {"type": "integer", "minimum": 1, "maximum": 200, "description": "Stop after this many steps. Default 30."},
                "timeout_seconds": {"type": "integer", "minimum": 10, "maximum": 3600, "description": "Stop after this long. Default 300."},
                "secrets": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Names of private values the task may type (passwords, one-time codes). Each value is read from "
                    "NODEMANTIS_SECRET_<NAME> in this server's environment; refer to one in the goal as <secret:NAME>.",
                },
                "use_proxy": _USE_PROXY_PROPERTY,
                "show_browser": _SHOW_BROWSER_PROPERTY,
            },
            "required": ["goal"],
            "additionalProperties": False,
        },
        "annotations": {
            "title": "Run a website task",
            "readOnlyHint": False,
            "destructiveHint": True,
            "idempotentHint": False,
            "openWorldHint": True,
        },
    },
    {
        "name": "retrieve_data",
        "title": "Read data from a page",
        "description":
            "Open one page and read data from it without changing anything on it. Returns the data, shaped by result_schema "
            "when given. Use run_task instead when getting to the data takes clicking, typing or several pages. "
            "If reading is still going when the call returns, the reply has status \"running\" and a task_id: call get_task with it.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "url": {"type": "string", "description": "The page to read (http or https)."},
                "prompt": {"type": "string", "description": "What to read from the page, e.g. \"every listing with its title, price and link\"."},
                "result_schema": _RESULT_SCHEMA_PROPERTY,
                "effort": _EFFORT_PROPERTY,
                "use_proxy": _USE_PROXY_PROPERTY,
                "show_browser": _SHOW_BROWSER_PROPERTY,
            },
            "required": ["url", "prompt"],
            "additionalProperties": False,
        },
        "annotations": {
            "title": "Read data from a page",
            "readOnlyHint": True,
            "idempotentHint": True,
            "openWorldHint": True,
        },
    },
    {
        "name": "get_task",
        "title": "Check a task",
        "description":
            "Wait for a task started by run_task or retrieve_data and return its status, latest progress and, once finished, "
            "its result. Returns as soon as the task finishes, or after wait_seconds with status \"running\" (call again). "
            "Tasks are kept for an hour after they finish and are lost when this server restarts.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "task_id": {"type": "string", "description": "The task_id returned by run_task or retrieve_data."},
                "wait_seconds": {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": MAX_WAIT_SECONDS,
                    "description": "How long to wait for the task to finish before answering. 0 answers immediately.",
                },
            },
            "required": ["task_id"],
            "additionalProperties": False,
        },
        "annotations": {
            "title": "Check a task",
            "readOnlyHint": True,
            "idempotentHint": True,
            "openWorldHint": False,
        },
    },
    {
        "name": "cancel_task",
        "title": "Cancel a task",
        "description": "Stop a running task and close its browser. A task that already finished is left unchanged.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "task_id": {"type": "string", "description": "The task_id returned by run_task or retrieve_data."},
            },
            "required": ["task_id"],
            "additionalProperties": False,
        },
        "annotations": {
            "title": "Cancel a task",
            "readOnlyHint": False,
            "destructiveHint": False,
            "idempotentHint": True,
            "openWorldHint": False,
        },
    },
]


# ── argument validation ──────────────────────────────────────────────────────


class ToolInputError(Exception):
    """A problem with what the model passed; returned as a tool error it can fix."""


def _is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _assert_known_arguments(tool: Dict[str, Any], args: Dict[str, Any]) -> None:
    allowed = list(tool["inputSchema"]["properties"])
    unknown = [name for name in args if name not in allowed]
    if unknown:
        names = ", ".join(f'"{name}"' for name in unknown)
        raise ToolInputError(f"Unknown parameter {names} for {tool['name']}. Allowed: {', '.join(allowed)}.")


def _required_text(args: Dict[str, Any], name: str) -> str:
    value = args.get(name)
    if not isinstance(value, str) or not value.strip():
        raise ToolInputError(f'"{name}" is required and must be a non-empty string.')
    return value


def _optional_boolean(args: Dict[str, Any], name: str) -> Optional[bool]:
    value = args.get(name)
    if value is None:
        return None
    if not isinstance(value, bool):
        raise ToolInputError(f'"{name}" must be true or false.')
    return value


def _optional_number(
    args: Dict[str, Any],
    name: str,
    *,
    integer: bool = False,
    minimum: Optional[float] = None,
    maximum: Optional[float] = None,
    exclusive_minimum: Optional[float] = None,
) -> Optional[float]:
    value = args.get(name)
    if value is None:
        return None
    valid = (
        _is_number(value)
        and (not integer or float(value).is_integer())
        and (minimum is None or value >= minimum)
        and (maximum is None or value <= maximum)
        and (exclusive_minimum is None or value > exclusive_minimum)
    )
    if not valid:
        bounds = " and ".join(part for part in (
            f"greater than {exclusive_minimum}" if exclusive_minimum is not None else None,
            f"at least {minimum}" if minimum is not None else None,
            f"at most {maximum}" if maximum is not None else None,
        ) if part)
        kind = "a whole number" if integer else "a number"
        raise ToolInputError(f'"{name}" must be {kind}{" " + bounds if bounds else ""}.')
    return int(value) if integer else value


def _optional_effort(args: Dict[str, Any]) -> Optional[str]:
    value = args.get("effort")
    if value is None:
        return None
    if not isinstance(value, str) or value not in EFFORT_LEVELS:
        raise ToolInputError(f'"effort" must be one of {", ".join(EFFORT_LEVELS)}.')
    return value


def _optional_schema(args: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    value = args.get("result_schema")
    if value is None:
        return None
    if not isinstance(value, dict):
        raise ToolInputError('"result_schema" must be a JSON Schema object.')
    return value


def _page_url(args: Dict[str, Any], name: str, required: bool) -> Optional[str]:
    """Pages are opened by address only: web pages, plus inline data: documents."""
    value = args.get(name)
    if value is None:
        if required:
            raise ToolInputError(f'"{name}" is required.')
        return None
    valid = False
    if isinstance(value, str):
        try:
            parts = urlsplit(value.strip())
            valid = (parts.scheme in ("http", "https") and bool(parts.hostname)) or parts.scheme == "data"
        except ValueError:
            valid = False
    if not valid:
        raise ToolInputError(f'"{name}" must be a full http or https address, e.g. https://example.com/page.')
    return value


def secret_env_name(name: str) -> str:
    return f"NODEMANTIS_SECRET_{name.upper()}"


def _secrets_from_names(args: Dict[str, Any], env: Mapping[str, str]) -> Optional[Dict[str, str]]:
    value = args.get("secrets")
    if value is None:
        return None
    if not isinstance(value, list) or any(not isinstance(name, str) for name in value):
        raise ToolInputError('"secrets" must be a list of secret names.')
    hint = " The user sets it in this MCP server's environment; values are never passed in a tool call."
    secrets: Dict[str, str] = {}
    for name in (part.strip() for part in value):
        if not name:
            continue
        if not re.fullmatch(r"[A-Za-z0-9_]{1,64}", name):
            raise ToolInputError(f'secret name "{name}" is invalid: use letters, digits and underscores.')
        secret = env.get(secret_env_name(name), "")
        if not secret:
            raise ToolInputError(
                f'secret "{name}" has no value: set the {secret_env_name(name)} environment variable.{hint}'
            )
        secrets[name] = secret
    return secrets or None


# ── the server ───────────────────────────────────────────────────────────────


def _render_snapshot(snapshot: Dict[str, Any]) -> McpToolResult:
    payload = snapshot
    if snapshot["status"] == "running":
        payload = {
            **snapshot,
            "next_step": f'Still running. Call get_task with task_id "{snapshot["task_id"]}" to wait for the result, '
            "or cancel_task to stop it.",
        }
    return McpToolResult(
        text=json.dumps(payload, indent=2, default=str),
        structured_content=payload,
        is_error=snapshot["status"] == "failed",
    )


def _unknown_task(task_id: str) -> McpToolResult:
    return McpToolResult(
        text=f'No task with id "{task_id}". Tasks are kept for an hour after they finish and are lost when this '
        "server restarts; start a new one.",
        is_error=True,
    )


class NodeMantisMcp:
    """The protocol server plus the tasks it started."""

    def __init__(
        self,
        *,
        write: Callable[[str], None],
        client: McpClient,
        log: Optional[Callable[[str], None]] = None,
        wait_seconds: Optional[float] = None,
        max_tasks: Optional[int] = None,
        headed: bool = False,
        env: Optional[Mapping[str, str]] = None,
        start_session: Optional[SessionFactory] = None,
        version: Optional[str] = None,
    ) -> None:
        self._env = os.environ if env is None else env
        self._wait_seconds = DEFAULT_WAIT_SECONDS if wait_seconds is None else wait_seconds
        self._headed = headed
        self._client = client
        self.tasks = TaskManager(
            start_session=start_session or client.start_session,
            max_running=DEFAULT_MAX_TASKS if max_tasks is None else max_tasks,
        )
        self.server = McpServer(
            name="node-mantis",
            title="Node Mantis",
            version=version or client.version(),
            instructions=SERVER_INSTRUCTIONS,
            tools=MCP_TOOLS,
            call_tool=self._call_tool,
            write=write,
            log=log,
        )

    def _session_settings(self, args: Dict[str, Any]) -> Dict[str, Any]:
        # Resolved per call, so a key added with `nodemantis configure` works without a restart.
        api_key = self._client.resolve_api_key(self._env)
        if not api_key:
            self._client.report_missing_api_key()
            raise ToolInputError(
                "No Node Mantis API key is configured, so the task was not started. Ask the user to add NODEMANTIS_API_KEY "
                "to this MCP server's environment settings, or to run: nodemantis configure --api-key \"sk_live_...\". "
                "Keys are created in the Node Mantis dashboard at https://nodemantis.com."
            )
        tier = self._env.get("NODEMANTIS_TIER") or "flex"
        if tier not in SERVICE_TIERS:
            raise ToolInputError(f'NODEMANTIS_TIER expects flex or standard, got "{tier}".')
        show_browser = _optional_boolean(args, "show_browser")
        return {
            "api_key": api_key,
            "service_tier": tier,
            "effort": _optional_effort(args),
            "use_proxy": _optional_boolean(args, "use_proxy") is True,
            "headless": not (self._headed if show_browser is None else show_browser),
        }

    async def _start_and_wait(self, spec: TaskSpec, context: McpToolCallContext) -> McpToolResult:
        """Start the task, then wait on it like get_task would."""
        started = self.tasks.start(spec)
        task_id = started["task_id"]
        snapshot = await self.tasks.wait(task_id, self._wait_seconds, context.cancelled, context.progress)
        # The client gave up on the call that started the task and never saw its
        # id, so nothing could collect the result: stop the task too.
        if context.cancelled.is_set():
            self.tasks.cancel(task_id)
            return _render_snapshot(self.tasks.snapshot(task_id) or started)
        return _render_snapshot(snapshot or started)

    async def _call_tool(self, name: str, args: Dict[str, Any], context: McpToolCallContext) -> McpToolResult:
        try:
            tool = next(candidate for candidate in MCP_TOOLS if candidate["name"] == name)
            _assert_known_arguments(tool, args)
            if name == "run_task":
                goal = _required_text(args, "goal")
                start_url = _page_url(args, "start_url", False)
                result_schema = _optional_schema(args)
                max_cost_usd = _optional_number(args, "max_cost_usd", exclusive_minimum=0)
                max_steps = _optional_number(args, "max_steps", integer=True, minimum=1, maximum=200)
                timeout_seconds = _optional_number(args, "timeout_seconds", integer=True, minimum=10, maximum=3600)
                secrets = _secrets_from_names(args, self._env)
                settings = self._session_settings(args)
                return await self._start_and_wait(TaskSpec(
                    kind="run_task",
                    goal=goal,
                    start_url=start_url,
                    result_schema=result_schema,
                    max_cost_usd=max_cost_usd,
                    max_steps=None if max_steps is None else int(max_steps),
                    timeout_ms=None if timeout_seconds is None else int(timeout_seconds) * 1000,
                    secrets=secrets,
                    **settings,
                ), context)
            if name == "retrieve_data":
                url = _page_url(args, "url", True)
                prompt = _required_text(args, "prompt")
                schema = _optional_schema(args)
                settings = self._session_settings(args)
                return await self._start_and_wait(TaskSpec(
                    kind="retrieve_data", url=url, prompt=prompt, result_schema=schema, **settings,
                ), context)
            if name == "get_task":
                task_id = _required_text(args, "task_id")
                wait_seconds = _optional_number(args, "wait_seconds", integer=True, minimum=0, maximum=MAX_WAIT_SECONDS)
                snapshot = await self.tasks.wait(
                    task_id,
                    self._wait_seconds if wait_seconds is None else wait_seconds,
                    context.cancelled,
                    context.progress,
                )
                return _render_snapshot(snapshot) if snapshot else _unknown_task(task_id)
            if name == "cancel_task":
                task_id = _required_text(args, "task_id")
                snapshot = self.tasks.cancel(task_id)
                return _render_snapshot(snapshot) if snapshot else _unknown_task(task_id)
            raise ToolInputError(f"Unknown tool: {name}")
        except (ToolInputError, TaskLimitError) as error:
            return McpToolResult(text=str(error), is_error=True)


# ── the command ──────────────────────────────────────────────────────────────


def _stderr_line(line: str) -> None:
    try:
        print(line, file=sys.stderr, flush=True)
    except Exception:  # noqa: BLE001 - diagnostics never stop the server
        pass


def _claim_stdout() -> int:
    """stdout carries protocol messages only. The original stream is kept on a
    private descriptor and descriptor 1 is pointed at stderr, so a stray print
    here or in a child process can never corrupt the protocol stream. Returns
    the descriptor for protocol lines."""
    try:
        sys.stdout.flush()
    except Exception:  # noqa: BLE001
        pass
    protocol_fd = os.dup(1)
    try:
        os.dup2(2, 1)
    except OSError:
        pass
    sys.stdout = sys.stderr
    return protocol_fd


def validate_mcp_flags(wait_seconds: Optional[float], max_tasks: Optional[int]) -> Optional[str]:
    if wait_seconds is not None and not (0 <= wait_seconds <= MAX_WAIT_SECONDS):
        return f"--wait-seconds expects 0 to {MAX_WAIT_SECONDS}, got {wait_seconds:g}"
    if max_tasks is not None and not (1 <= max_tasks <= MAX_TASKS_LIMIT):
        return f"--max-tasks expects a whole number from 1 to {MAX_TASKS_LIMIT}, got {max_tasks}"
    return None


async def serve(
    *,
    client: McpClient,
    wait_seconds: Optional[float] = None,
    max_tasks: Optional[int] = None,
    headed: bool = False,
) -> bool:
    """Serve one client on this process's stdin/stdout until it disconnects.

    Returns whether every browser session closed before the shutdown wait ran out.
    """
    if sys.stdin is not None and sys.stdin.isatty():
        _stderr_line(
            "NodeMantis MCP server: waiting for an MCP client on stdin. Assistants start this command themselves; "
            "see nodemantis mcp --help. Press Ctrl+C to stop."
        )

    loop = asyncio.get_running_loop()
    stop = asyncio.Event()
    protocol_fd = _claim_stdout()

    def write(line: str) -> None:
        data = line.encode("ascii", "backslashreplace") + b"\n"
        try:
            while data:
                data = data[os.write(protocol_fd, data):]
        except OSError:
            # The client is gone: stop like a closed stdin.
            stop.set()

    mcp = NodeMantisMcp(
        write=write, log=_stderr_line, wait_seconds=wait_seconds, max_tasks=max_tasks,
        headed=headed, client=client,
    )

    def read_stdin() -> None:
        try:
            while True:
                chunk = os.read(0, 65536)
                if not chunk:
                    break
                loop.call_soon_threadsafe(mcp.server.push, chunk)
        except Exception:  # noqa: BLE001 - a broken stdin ends the server like a closed one
            pass
        try:
            loop.call_soon_threadsafe(stop.set)
        except RuntimeError:
            pass  # the loop already closed

    # The client closing stdin is the normal way to stop; signals end it the same way.
    for name in ("SIGINT", "SIGTERM", "SIGHUP"):
        number = getattr(signal, name, None)
        if number is None:
            continue
        try:
            loop.add_signal_handler(number, stop.set)
        except (NotImplementedError, RuntimeError, ValueError):
            try:
                signal.signal(number, lambda *_args: loop.call_soon_threadsafe(stop.set))
            except (OSError, ValueError):
                pass

    threading.Thread(target=read_stdin, name="nodemantis-mcp-stdin", daemon=True).start()
    await stop.wait()

    mcp.server.abort_all()
    try:
        await asyncio.wait_for(asyncio.shield(mcp.tasks.close_all()), SHUTDOWN_WAIT_SECONDS)
        return True
    except asyncio.TimeoutError:
        return False
