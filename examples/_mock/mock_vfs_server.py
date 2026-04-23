"""
Mock vfs4Agent HTTP server for local adapter testing.

Why this exists:
  fuse-native is Linux-only, so on macOS dev machines you can't run the real
  `pnpm server` (which mounts FUSE). This mock server speaks the exact same
  HTTP contract (/v1/bash, /v1/health) but runs bash commands in a real
  temp directory populated with the sample docs. That's good enough to
  verify the adapter layer (LangChain / LangGraph / CrewAI / Claude SDK)
  correctly sends tool calls and consumes tool results.

Usage:
  python examples/_mock/mock_vfs_server.py --port 7801 --root examples/sample-docs
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

STARTED_AT = time.time()


class Handler(BaseHTTPRequestHandler):
    # Injected by factory
    root: str = ""
    token: str | None = None

    def _write_json(self, code: int, obj: dict) -> None:
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _auth_ok(self) -> bool:
        if not self.token:
            return True
        return self.headers.get("x-vfs-session") == self.token

    def log_message(self, fmt: str, *args) -> None:  # quiet
        sys.stderr.write(f"[mock] {fmt % args}\n")

    def do_GET(self) -> None:
        if not self._auth_ok():
            return self._write_json(401, {"error": "unauthorized"})
        if self.path == "/v1/health":
            return self._write_json(
                200,
                {
                    "status": "ok",
                    "backend": "mock",
                    "mount": self.root,
                    "optimizers": [],
                    "uptime": int(time.time() - STARTED_AT),
                },
            )
        self._write_json(404, {"error": "not found"})

    def do_POST(self) -> None:
        if not self._auth_ok():
            return self._write_json(401, {"error": "unauthorized"})
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length)
        try:
            body = json.loads(raw or b"{}")
        except json.JSONDecodeError:
            return self._write_json(400, {"error": "invalid json"})

        if self.path == "/v1/bash":
            command = body.get("command")
            if not isinstance(command, str) or not command.strip():
                return self._write_json(400, {"error": "missing command"})
            # Rewrite /vfs → actual root so bash commands transparently hit the fixture tree.
            rewritten = command.replace("/vfs", self.root)
            try:
                proc = subprocess.run(
                    ["/bin/bash", "-c", rewritten],
                    capture_output=True,
                    text=True,
                    timeout=15,
                    cwd=self.root,
                )
                stdout = proc.stdout[: 64 * 1024]
                stderr = proc.stderr[: 64 * 1024]
                return self._write_json(
                    200, {"stdout": stdout, "stderr": stderr, "exitCode": proc.returncode}
                )
            except subprocess.TimeoutExpired:
                return self._write_json(
                    200, {"stdout": "", "stderr": "timeout", "exitCode": 124}
                )

        if self.path == "/v1/fs/cat":
            p = body.get("path", "")
            abs_p = os.path.join(self.root, p.lstrip("/"))
            if not abs_p.startswith(self.root):
                return self._write_json(400, {"error": "path traversal"})
            try:
                with open(abs_p, "r", encoding="utf-8") as f:
                    return self._write_json(200, {"content": f.read()})
            except FileNotFoundError:
                return self._write_json(404, {"error": "not found"})

        if self.path == "/v1/fs/ls":
            p = body.get("path", "")
            abs_p = os.path.join(self.root, p.lstrip("/"))
            if not abs_p.startswith(self.root):
                return self._write_json(400, {"error": "path traversal"})
            try:
                return self._write_json(200, {"entries": sorted(os.listdir(abs_p))})
            except FileNotFoundError:
                return self._write_json(404, {"error": "not found"})

        self._write_json(404, {"error": "not found"})


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=7801)
    ap.add_argument("--root", default="examples/sample-docs",
                    help="Directory serving as the /vfs root")
    ap.add_argument("--token", default=os.environ.get("VFS_SESSION_TOKEN"))
    args = ap.parse_args()

    root_abs = os.path.abspath(args.root)
    if not os.path.isdir(root_abs):
        print(f"[mock] root directory not found: {root_abs}", file=sys.stderr)
        sys.exit(2)

    Handler.root = root_abs
    Handler.token = args.token
    srv = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"[mock] serving {root_abs} as /vfs on http://127.0.0.1:{args.port}")
    print(f"[mock] endpoints: POST /v1/bash, POST /v1/fs/cat, POST /v1/fs/ls, GET /v1/health")
    if args.token:
        print(f"[mock] auth enabled (x-vfs-session required)")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        srv.server_close()


if __name__ == "__main__":
    main()
