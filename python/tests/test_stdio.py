"""Exercise source startup and shutdown over a real stdio subprocess."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


class StdioTests(unittest.TestCase):
    def test_source_discovery_and_missing_key(self):
        with tempfile.TemporaryDirectory() as directory:
            env = {**os.environ, "NODEMANTIS_TELEMETRY": "0",
                   "NODEMANTIS_CONFIG_FILE": str(Path(directory) / "config.json")}
            for name in ["NODEMANTIS_API_KEY", "NODEMANTIS_AUTH_TOKEN", "AGENT_API_KEY"]:
                env.pop(name, None)
            process = subprocess.Popen(
                [sys.executable, "-m", "nodemantis_mcp"], env=env,
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                text=True,
            )
            try:
                assert process.stdin is not None and process.stdout is not None
                for request_id, method, params in [
                    (1, "initialize", {"protocolVersion": "2025-11-25", "capabilities": {}}),
                    (2, "tools/list", {}),
                    (3, "tools/call", {"name": "run_task", "arguments": {"goal": "Example"}}),
                ]:
                    process.stdin.write(json.dumps({"jsonrpc": "2.0", "id": request_id,
                                                    "method": method, "params": params}) + "\n")
                process.stdin.flush()
                # communicate supplies the deadline for the complete exchange.
                stdout, stderr = process.communicate(timeout=15)
                replies = [json.loads(line) for line in stdout.splitlines()]
                self.assertEqual(process.returncode, 0, stderr)
                by_id = {reply["id"]: reply for reply in replies}
                self.assertEqual(len(by_id[2]["result"]["tools"]), 4)
                self.assertTrue(by_id[3]["result"]["isError"])
                self.assertIn("NODEMANTIS_API_KEY", by_id[3]["result"]["content"][0]["text"])
            finally:
                if process.poll() is None:
                    process.kill()
                    process.communicate()

    def test_hidden_mock_flag_is_rejected(self):
        process = subprocess.run(
            [sys.executable, "-m", "nodemantis_mcp", "--mock-llm", "{}"],
            capture_output=True, text=True, timeout=15,
            env={**os.environ, "NODEMANTIS_TELEMETRY": "0"},
        )
        self.assertEqual(process.returncode, 2)
        self.assertIn("unrecognized arguments", process.stderr)


if __name__ == "__main__":
    unittest.main()
