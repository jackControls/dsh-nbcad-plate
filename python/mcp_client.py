"""Minimal MCP stdio client for the headless noBS CAD server (nbcad-mcp)."""

from __future__ import annotations

import json
import queue
import subprocess
import threading
import time


class McpError(RuntimeError):
    pass


class McpClient:
    def __init__(self, server_path: str, args=(), log_path: str | None = None, init_timeout: float = 180.0):
        self.log = open(log_path, "a") if log_path else subprocess.DEVNULL
        self.proc = subprocess.Popen(
            [server_path, *args],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=self.log,
            text=True,
            bufsize=1,
        )
        self.replies: queue.Queue = queue.Queue()
        self.next_id = 1
        self.calls = 0
        threading.Thread(target=self._reader, daemon=True).start()
        self.initialization = self.rpc(
            "initialize",
            {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "vlm-harness", "version": "1"}},
            timeout=init_timeout,
        )
        self._notify("notifications/initialized")

    def _reader(self) -> None:
        for line in self.proc.stdout:
            line = line.strip()
            if not line:
                continue
            try:
                message = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(message, dict) and "id" in message:
                self.replies.put(message)

    def _send(self, payload: dict) -> None:
        self.proc.stdin.write(json.dumps(payload) + "\n")
        self.proc.stdin.flush()

    def _notify(self, method: str, params: dict | None = None) -> None:
        payload = {"jsonrpc": "2.0", "method": method}
        if params is not None:
            payload["params"] = params
        self._send(payload)

    def rpc(self, method: str, params: dict, timeout: float = 900.0) -> dict:
        request_id = self.next_id
        self.next_id += 1
        self._send({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params})
        deadline = time.time() + timeout
        while True:
            remaining = deadline - time.time()
            if remaining <= 0:
                raise McpError(f"{method}: no reply within {timeout} s")
            try:
                reply = self.replies.get(timeout=min(remaining, 1.0))
            except queue.Empty:
                if self.proc.poll() is not None:
                    raise McpError(f"{method}: server exited with {self.proc.returncode}")
                continue
            if reply.get("id") != request_id:
                continue
            if "error" in reply:
                raise McpError(f"{method}: {json.dumps(reply['error'])}")
            return reply.get("result", {})

    def list_tools(self) -> list:
        return self.rpc("tools/list", {}).get("tools", [])

    def call(self, name: str, arguments: dict | None = None, timeout: float = 900.0):
        """tools/call decoded the way the Rust replay client decodes it."""
        self.calls += 1
        result = self.rpc("tools/call", {"name": name, "arguments": arguments or {}}, timeout=timeout)
        content = result.get("content") or []
        text = next((item.get("text") for item in content if item.get("type") == "text"), None)
        if result.get("isError"):
            raise McpError(text or json.dumps(content))
        if text is None:
            raise McpError(f"{name}: response has no text content")
        try:
            decoded = json.loads(text)
        except json.JSONDecodeError:
            return text
        if isinstance(decoded, dict) and decoded.get("status") == "failed":
            raise McpError(json.dumps(decoded))
        return decoded

    def interface(self, action: str, **arguments):
        return self.call("cad_interface", {"action": action, **arguments})

    def close(self, timeout: float = 15.0) -> None:
        try:
            self.proc.stdin.close()
        except Exception:
            pass
        deadline = time.time() + timeout
        while self.proc.poll() is None and time.time() < deadline:
            time.sleep(0.05)
        if self.proc.poll() is None:
            self.proc.kill()
            self.proc.wait()
        if self.log is not subprocess.DEVNULL:
            self.log.close()
