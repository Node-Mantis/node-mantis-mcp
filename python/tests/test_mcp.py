from __future__ import annotations

import asyncio
import json
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from nodemantis_mcp._mcp_client import McpClient
from nodemantis_mcp._mcp_server import MCP_TOOLS, NodeMantisMcp, validate_mcp_flags
from nodemantis.types import parse_operation_result, parse_retrieve_result

# Tests disable optional diagnostic reporting.
os.environ.setdefault("NODEMANTIS_TELEMETRY", "0")

MODERN_META = {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    "io.modelcontextprotocol/clientCapabilities": {},
}


class FakeSession:
    """Stands in for a NodeMantis session; `gate` holds run/retrieve open."""

    def __init__(self, owner: "Harness") -> None:
        self.owner = owner
        self.closed = asyncio.Event()
        self.close_calls = 0

    async def _hold(self) -> None:
        if self.owner.gate is None:
            return
        gate = asyncio.ensure_future(self.owner.gate.wait())
        closed = asyncio.ensure_future(self.closed.wait())
        try:
            await asyncio.wait([gate, closed], return_when=asyncio.FIRST_COMPLETED)
        finally:
            gate.cancel()
            closed.cancel()
        if self.closed.is_set():
            raise RuntimeError("session closed")

    async def run(self, goal, **options):
        self.owner.run_calls.append((goal, options))
        on_progress = options.get("on_progress")
        if on_progress:
            on_progress(SimpleNamespace(iteration=1, max_iterations=30, message="Looking at the page", action="click"))
        await self._hold()
        if self.owner.run_error is not None:
            raise self.owner.run_error
        return parse_operation_result(self.owner.run_result)

    async def retrieve(self, prompt, **options):
        self.owner.retrieve_calls.append((prompt, options))
        await self._hold()
        return parse_retrieve_result(self.owner.retrieve_result)

    async def close(self):
        self.close_calls += 1
        self.closed.set()


class Harness:
    def __init__(self, **options) -> None:
        self.lines: "list[dict]" = []
        self.gate: "asyncio.Event | None" = None
        self.start_calls: "list[dict]" = []
        self.sessions: "list[FakeSession]" = []
        self.run_calls: list = []
        self.retrieve_calls: list = []
        self.run_error: "Exception | None" = None
        self.run_result = {"ok": True, "reason": "Found it", "iterations": 2, "costUsd": 0.01,
                           "traceId": "op_1_abcdef01", "value": {"price": 12.5}}
        self.retrieve_result = {"status": "success", "data": [{"title": "Emma"}], "message": "Read 1 item",
                                "costUsd": 0.002, "finalUrl": "https://example.com/books"}
        env = options.pop("env", {"NODEMANTIS_API_KEY": "ak_test_mcp", "NODEMANTIS_CONFIG_FILE": self._missing_config()})
        self.mcp = NodeMantisMcp(
            client=McpClient(
                start_session=self._start_session,
                resolve_api_key=lambda env: env.get("NODEMANTIS_API_KEY"),
                report_missing_api_key=lambda: None,
                version=lambda: "9.9.9",
            ),
            write=lambda line: self.lines.append(json.loads(line)),
            start_session=self._start_session, env=env, version="9.9.9", **options,
        )

    @staticmethod
    def _missing_config() -> str:
        return str(Path(tempfile.gettempdir()) / "nodemantis-mcp-test-missing-config.json")

    async def _start_session(self, **options):
        self.start_calls.append(options)
        session = FakeSession(self)
        self.sessions.append(session)
        return session

    def send(self, message: dict) -> None:
        self.mcp.server.push(json.dumps(message) + "\n")

    async def request(self, request_id, method, params=None):
        message = {"jsonrpc": "2.0", "id": request_id, "method": method}
        if params is not None:
            message["params"] = params
        self.send(message)
        return await self.reply(request_id)

    async def reply(self, request_id, timeout: float = 5.0):
        async def find():
            while True:
                for line in self.lines:
                    if line.get("id") == request_id and ("result" in line or "error" in line):
                        return line
                await asyncio.sleep(0.005)
        return await asyncio.wait_for(find(), timeout)

    async def call(self, request_id, name, arguments, meta=None):
        params = {"name": name, "arguments": arguments}
        if meta is not None:
            params["_meta"] = meta
        reply = await self.request(request_id, "tools/call", params)
        return reply["result"]


class ProtocolTests(unittest.IsolatedAsyncioTestCase):
    async def test_legacy_handshake_lists_the_four_tools(self) -> None:
        harness = Harness()
        hello = await harness.request(1, "initialize", {"protocolVersion": "2025-06-18", "capabilities": {}})
        self.assertEqual(hello["result"]["protocolVersion"], "2025-06-18")
        self.assertEqual(hello["result"]["serverInfo"], {"name": "node-mantis", "title": "Node Mantis", "version": "9.9.9"})
        self.assertEqual(hello["result"]["capabilities"], {"tools": {}})
        self.assertIn("run_task", hello["result"]["instructions"])
        harness.send({"jsonrpc": "2.0", "method": "notifications/initialized"})
        listed = await harness.request(2, "tools/list")
        self.assertEqual(
            [tool["name"] for tool in listed["result"]["tools"]],
            ["run_task", "retrieve_data", "get_task", "cancel_task"],
        )
        self.assertNotIn("ttlMs", listed["result"])
        self.assertEqual((await harness.request(3, "ping"))["result"], {})

    async def test_unknown_legacy_version_falls_back_to_the_newest(self) -> None:
        harness = Harness()
        hello = await harness.request(1, "initialize", {"protocolVersion": "1999-01-01"})
        self.assertEqual(hello["result"]["protocolVersion"], "2025-11-25")

    async def test_modern_requests_need_no_handshake(self) -> None:
        harness = Harness()
        discovered = await harness.request(1, "server/discover", {"_meta": MODERN_META})
        self.assertEqual(discovered["result"]["supportedVersions"], ["2026-07-28"])
        self.assertEqual(discovered["result"]["resultType"], "complete")
        self.assertEqual(discovered["result"]["ttlMs"], 300000)
        self.assertEqual(discovered["result"]["cacheScope"], "public")
        self.assertEqual(
            discovered["result"]["_meta"]["io.modelcontextprotocol/serverInfo"]["version"], "9.9.9",
        )
        listed = await harness.request(2, "tools/list", {"_meta": MODERN_META})
        self.assertEqual(len(listed["result"]["tools"]), 4)
        self.assertEqual(listed["result"]["ttlMs"], 300000)
        refused = await harness.request(3, "initialize", {"_meta": MODERN_META})
        self.assertEqual(refused["error"]["code"], -32601)

    async def test_modern_version_and_capabilities_are_checked(self) -> None:
        harness = Harness()
        wrong = await harness.request(1, "tools/list", {"_meta": {**MODERN_META, "io.modelcontextprotocol/protocolVersion": "2030-01-01"}})
        self.assertEqual(wrong["error"]["code"], -32022)
        self.assertEqual(wrong["error"]["data"], {"supported": ["2026-07-28"], "requested": "2030-01-01"})
        missing = await harness.request(2, "tools/list", {"_meta": {"io.modelcontextprotocol/protocolVersion": "2026-07-28"}})
        self.assertEqual(missing["error"]["code"], -32602)
        legacy_discover = await harness.request(3, "server/discover")
        self.assertEqual(legacy_discover["error"]["code"], -32602)

    async def test_malformed_input_gets_json_rpc_errors(self) -> None:
        harness = Harness()
        harness.mcp.server.push(b"not json\n")
        harness.mcp.server.push(b"[1,2]\n")
        harness.mcp.server.push(b'{"jsonrpc":"2.0","id":7}\n')
        harness.mcp.server.push(b'{"jsonrpc":"2.0","id":true,"method":"ping"}\n')
        harness.mcp.server.push(b"\r\n")
        self.assertEqual([line["error"]["code"] for line in harness.lines], [-32700, -32600, -32600, -32600])
        self.assertEqual([line["id"] for line in harness.lines], [None, None, 7, None])
        unknown = await harness.request(8, "resources/list")
        self.assertEqual(unknown["error"]["code"], -32601)
        bad_tool = await harness.request(9, "tools/call", {"name": "nope"})
        self.assertEqual(bad_tool["error"]["code"], -32602)

    async def test_a_message_split_across_chunks_is_reassembled(self) -> None:
        harness = Harness()
        raw = (json.dumps({"jsonrpc": "2.0", "id": 1, "method": "ping", "params": {"note": "é"}}) + "\n").encode("utf-8")
        for index in range(len(raw)):
            harness.mcp.server.push(raw[index:index + 1])
        self.assertEqual((await harness.reply(1))["result"], {})


class ToolTests(unittest.IsolatedAsyncioTestCase):
    async def test_run_task_answers_directly_when_it_finishes_in_time(self) -> None:
        harness = Harness()
        schema = {"type": "object", "properties": {"price": {"type": "number"}}}
        result = await harness.call(1, "run_task", {
            "goal": "Find the price", "start_url": "https://example.com", "result_schema": schema,
            "effort": "high", "max_cost_usd": 0.5, "max_steps": 12, "timeout_seconds": 90, "use_proxy": True,
        })
        self.assertFalse(result["isError"])
        payload = result["structuredContent"]
        self.assertEqual(json.loads(result["content"][0]["text"]), payload)
        self.assertEqual(payload["status"], "succeeded")
        self.assertEqual(payload["tool"], "run_task")
        self.assertEqual(payload["result"], {
            "ok": True, "reason": "Found it", "value": {"price": 12.5},
            "steps": 2, "cost_usd": 0.01, "trace_id": "op_1_abcdef01",
        })
        self.assertNotIn("progress", payload)
        self.assertEqual(harness.start_calls, [{
            "api_key": "ak_test_mcp", "start_url": "https://example.com", "headless": True, "use_proxy": True,
        }])
        goal, options = harness.run_calls[0]
        self.assertEqual(goal, "Find the price")
        self.assertEqual(options["result_schema"], schema)
        self.assertEqual(options["effort"], "high")
        self.assertEqual(options["service_tier"], "flex")
        self.assertEqual(options["max_iterations"], 12)
        self.assertEqual(options["timeout"], 90_000)
        self.assertEqual(options["max_cost"], 0.5)
        self.assertEqual(harness.sessions[0].close_calls, 1)

    async def test_a_failed_outcome_is_a_tool_error(self) -> None:
        harness = Harness()
        harness.run_result = {"ok": False, "reason": "Could not find it", "iterations": 30}
        result = await harness.call(1, "run_task", {"goal": "Find it"})
        self.assertTrue(result["isError"])
        self.assertEqual(result["structuredContent"]["status"], "failed")
        self.assertEqual(result["structuredContent"]["result"]["reason"], "Could not find it")

    async def test_a_raised_error_reports_its_message_and_code(self) -> None:
        harness = Harness()
        error = RuntimeError("Budget exceeded")
        error.code = "BUDGET_EXCEEDED"  # type: ignore[attr-defined]
        harness.run_error = error
        result = await harness.call(1, "run_task", {"goal": "Find it"})
        self.assertTrue(result["isError"])
        self.assertEqual(result["structuredContent"]["error"], {"message": "Budget exceeded", "code": "BUDGET_EXCEEDED"})
        self.assertEqual(harness.sessions[0].close_calls, 1)

    async def test_retrieve_data_maps_the_result(self) -> None:
        harness = Harness(headed=True)
        result = await harness.call(1, "retrieve_data", {"url": "https://example.com/books", "prompt": "Every book title"})
        self.assertFalse(result["isError"])
        self.assertEqual(result["structuredContent"]["result"], {
            "status": "success", "message": "Read 1 item", "data": [{"title": "Emma"}],
            "final_url": "https://example.com/books", "cost_usd": 0.002,
        })
        self.assertEqual(harness.start_calls[0]["start_url"], "https://example.com/books")
        self.assertFalse(harness.start_calls[0]["headless"])
        self.assertIsNone(harness.start_calls[0]["use_proxy"])
        self.assertEqual(harness.retrieve_calls[0][0], "Every book title")

    async def test_a_long_task_returns_an_id_and_is_collected_with_get_task(self) -> None:
        harness = Harness(wait_seconds=0.05)
        harness.gate = asyncio.Event()
        started = await harness.call(1, "run_task", {"goal": "Slow one"}, meta={"progressToken": "p1"})
        self.assertFalse(started["isError"])
        running = started["structuredContent"]
        self.assertEqual(running["status"], "running")
        self.assertIn(running["task_id"], running["next_step"])
        self.assertEqual(running["progress"], {"step": 1, "max_steps": 30, "message": "Step 1/30: Looking at the page — click"})
        progress = [line["params"] for line in harness.lines if line.get("method") == "notifications/progress"]
        self.assertTrue(progress)
        self.assertTrue(all(note["progressToken"] == "p1" for note in progress))
        self.assertEqual([note["progress"] for note in progress], list(range(1, len(progress) + 1)))

        still = await harness.call(2, "get_task", {"task_id": running["task_id"], "wait_seconds": 0})
        self.assertEqual(still["structuredContent"]["status"], "running")

        harness.send({"jsonrpc": "2.0", "id": 3, "method": "tools/call",
                      "params": {"name": "get_task", "arguments": {"task_id": running["task_id"], "wait_seconds": 30}}})
        await asyncio.sleep(0.02)
        harness.gate.set()
        finished = (await harness.reply(3))["result"]
        self.assertEqual(finished["structuredContent"]["status"], "succeeded")
        self.assertEqual(finished["structuredContent"]["result"]["value"], {"price": 12.5})

    async def test_cancel_task_closes_the_browser_and_is_final(self) -> None:
        harness = Harness(wait_seconds=0.05)
        harness.gate = asyncio.Event()
        running = (await harness.call(1, "run_task", {"goal": "Slow one"}))["structuredContent"]
        cancelled = await harness.call(2, "cancel_task", {"task_id": running["task_id"]})
        self.assertFalse(cancelled["isError"])
        self.assertEqual(cancelled["structuredContent"]["status"], "cancelled")
        await harness.mcp.tasks.close_all()
        self.assertGreaterEqual(harness.sessions[0].close_calls, 1)
        again = await harness.call(3, "get_task", {"task_id": running["task_id"]})
        self.assertEqual(again["structuredContent"]["status"], "cancelled")
        self.assertNotIn("result", again["structuredContent"])

    async def test_a_cancelled_first_call_stops_its_task_and_gets_no_reply(self) -> None:
        harness = Harness(wait_seconds=30)
        harness.gate = asyncio.Event()
        harness.send({"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                      "params": {"name": "run_task", "arguments": {"goal": "Slow one"}}})
        await asyncio.sleep(0.02)
        harness.send({"jsonrpc": "2.0", "method": "notifications/cancelled", "params": {"requestId": 1}})
        await harness.mcp.server.idle()
        await harness.mcp.tasks.close_all()
        self.assertEqual([line for line in harness.lines if line.get("id") == 1], [])
        # Closed by the cancel and again when the task unwinds; close is idempotent.
        self.assertGreaterEqual(harness.sessions[0].close_calls, 1)
        self.assertTrue(harness.sessions[0].closed.is_set())

    async def test_too_many_running_tasks_is_a_tool_error(self) -> None:
        harness = Harness(wait_seconds=0.01, max_tasks=1)
        harness.gate = asyncio.Event()
        first = (await harness.call(1, "run_task", {"goal": "Slow one"}))["structuredContent"]
        second = await harness.call(2, "run_task", {"goal": "Another"})
        self.assertTrue(second["isError"])
        self.assertIn(first["task_id"], second["content"][0]["text"])
        self.assertEqual(len(harness.start_calls), 1)
        await harness.mcp.tasks.close_all()

    async def test_bad_arguments_are_tool_errors_and_start_nothing(self) -> None:
        harness = Harness()
        cases = [
            ("run_task", {}, '"goal" is required'),
            ("run_task", {"goal": "x", "bogus": 1}, 'Unknown parameter "bogus"'),
            ("run_task", {"goal": "x", "start_url": "ftp://example.com"}, "full http or https address"),
            ("run_task", {"goal": "x", "start_url": "example.com"}, "full http or https address"),
            ("run_task", {"goal": "x", "max_steps": 0}, '"max_steps" must be a whole number'),
            ("run_task", {"goal": "x", "max_steps": 2.5}, '"max_steps" must be a whole number'),
            ("run_task", {"goal": "x", "max_cost_usd": 0}, "greater than 0"),
            ("run_task", {"goal": "x", "effort": "extreme"}, '"effort" must be one of'),
            ("run_task", {"goal": "x", "result_schema": []}, "JSON Schema object"),
            ("run_task", {"goal": "x", "show_browser": "yes"}, "must be true or false"),
            ("run_task", {"goal": "x", "secrets": ["LOGIN"]}, "NODEMANTIS_SECRET_LOGIN"),
            ("run_task", {"goal": "x", "secrets": ["bad name"]}, "is invalid"),
            ("retrieve_data", {"prompt": "x"}, '"url" is required'),
            ("get_task", {"task_id": "task_missing"}, "No task with id"),
            ("cancel_task", {"task_id": "task_missing"}, "No task with id"),
        ]
        for index, (name, arguments, expected) in enumerate(cases):
            with self.subTest(name=name, arguments=arguments):
                result = await harness.call(index + 1, name, arguments)
                self.assertTrue(result["isError"])
                self.assertIn(expected, result["content"][0]["text"])
        self.assertEqual(harness.start_calls, [])

    async def test_secret_values_come_from_the_environment(self) -> None:
        harness = Harness(env={
            "NODEMANTIS_API_KEY": "ak_test_mcp", "NODEMANTIS_SECRET_LOGIN": "hunter2",
            "NODEMANTIS_TIER": "standard", "NODEMANTIS_CONFIG_FILE": Harness._missing_config(),
        })
        result = await harness.call(1, "run_task", {"goal": "Sign in with <secret:login>", "secrets": ["login"]})
        self.assertFalse(result["isError"])
        self.assertEqual(harness.run_calls[0][1]["secrets"], {"login": "hunter2"})
        self.assertEqual(harness.run_calls[0][1]["service_tier"], "standard")
        self.assertNotIn("hunter2", json.dumps(harness.lines))

    async def test_a_missing_api_key_explains_how_to_add_one(self) -> None:
        with tempfile.TemporaryDirectory() as home:
            harness = Harness(env={"NODEMANTIS_CONFIG_FILE": str(Path(home) / "config.json"), "HOME": home})
            result = await harness.call(1, "run_task", {"goal": "x"})
        self.assertTrue(result["isError"])
        self.assertIn("NODEMANTIS_API_KEY", result["content"][0]["text"])
        self.assertEqual(harness.start_calls, [])


class CommandTests(unittest.TestCase):
    def test_tool_definitions_match_the_shared_fixture(self) -> None:
        # The TypeScript client checks its own definitions against the same file.
        fixture = json.loads((Path(__file__).parents[2] / "fixtures" / "mcp-tools.json").read_text(encoding="utf-8"))
        self.assertEqual(MCP_TOOLS, fixture["tools"])

    def test_flag_limits(self) -> None:
        self.assertIsNone(validate_mcp_flags(None, None))
        self.assertIsNone(validate_mcp_flags(0, 32))
        self.assertIn("--wait-seconds", validate_mcp_flags(601, None) or "")
        self.assertIn("--max-tasks", validate_mcp_flags(None, 0) or "")



if __name__ == "__main__":
    unittest.main()
