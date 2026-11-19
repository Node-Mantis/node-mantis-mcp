"""Run this source checkout using the installed Node Mantis client."""
import argparse
import asyncio
import os
import sys

from nodemantis import NodeMantis, _client_events
from nodemantis.config import resolve_config
from nodemantis.installation import cli_version, detect_install

from ._mcp_client import McpClient
from ._mcp_server import (
    DEFAULT_MAX_TASKS,
    DEFAULT_WAIT_SECONDS,
    MCP_DESCRIPTION,
    MCP_EPILOG,
    serve,
    validate_mcp_flags,
)


def report_missing_api_key() -> None:
    _client_events.report_failure(
        {"code": "API_KEY_MISSING", "message": "No API key configured."},
        phase="cli", command="run", stage="auth",
    )


def main() -> int:
    parser = argparse.ArgumentParser(
        description=MCP_DESCRIPTION,
        epilog=MCP_EPILOG,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--wait-seconds", type=float, default=None,
                        help=f"seconds to wait before returning a task id (default {DEFAULT_WAIT_SECONDS})")
    parser.add_argument("--max-tasks", type=int, default=None,
                        help=f"maximum concurrent tasks (default {DEFAULT_MAX_TASKS})")
    parser.add_argument("-H", "--headed", action="store_true", help="show the browser window by default")
    args = parser.parse_args()
    problem = validate_mcp_flags(args.wait_seconds, args.max_tasks)
    if problem:
        parser.error(problem)
    try:
        method = detect_install().method
    except Exception:
        method = "unknown"
    _client_events.configure(surface="sdk", install_method=f"mcp-{method}")
    client = McpClient(
        start_session=NodeMantis.start,
        resolve_api_key=lambda env: resolve_config(env=env).api_key,
        report_missing_api_key=report_missing_api_key,
        version=cli_version,
    )

    async def run() -> int:
        closed = await serve(client=client, wait_seconds=args.wait_seconds,
                             max_tasks=args.max_tasks, headed=args.headed)
        _client_events.flush()
        if not closed:
            try:
                sys.stderr.flush()
            except Exception:
                pass
            os._exit(0)
        return 0

    return asyncio.run(run())


if __name__ == "__main__":
    raise SystemExit(main())
