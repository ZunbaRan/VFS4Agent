"""
Thin HTTP client for vfs4Agent's /v1/bash endpoint.
Used by every framework adapter (LangChain / LangGraph / CrewAI / Claude SDK)
so that the "connect to vfs" bit is identical; only the "bind as tool" bit
differs per framework.
"""

from __future__ import annotations

import os
from dataclasses import dataclass

import requests


DEFAULT_URL = os.environ.get("VFS_SERVER_URL", "http://localhost:7801")
DEFAULT_TOKEN = os.environ.get("VFS_SESSION_TOKEN")


@dataclass
class BashResult:
    stdout: str
    stderr: str
    exitCode: int

    def to_llm_string(self, max_bytes: int = 6000) -> str:
        """Format for tool_result content — what the LLM actually reads."""
        parts: list[str] = []
        if self.stdout:
            parts.append(self.stdout.rstrip())
        if self.stderr:
            parts.append(f"[stderr]\n{self.stderr.rstrip()}")
        if self.exitCode and not parts:
            parts.append(f"[exit {self.exitCode}]")
        out = "\n".join(parts) if parts else "(no output)"
        if len(out) > max_bytes:
            out = out[:max_bytes] + "\n...[truncated]"
        return out


def vfs_bash(command: str, *, url: str = DEFAULT_URL, token: str | None = DEFAULT_TOKEN,
             timeout: float = 20.0) -> BashResult:
    headers = {"Content-Type": "application/json"}
    if token:
        headers["x-vfs-session"] = token
    resp = requests.post(f"{url}/v1/bash", json={"command": command},
                         headers=headers, timeout=timeout)
    resp.raise_for_status()
    data = resp.json()
    return BashResult(
        stdout=data.get("stdout", ""),
        stderr=data.get("stderr", ""),
        exitCode=int(data.get("exitCode", 0)),
    )


# Shared system prompt that teaches the LLM how to use /vfs
SYSTEM_PROMPT = """You are a documentation assistant with bash access to a \
read-only documentation tree mounted at /vfs.

Workflow:
  1. Explore with `ls /vfs` or `tree /vfs` to see layout.
  2. Locate relevant files with `grep -rni <keyword> /vfs` or `find /vfs -name '*.md'`.
  3. Read with `cat /vfs/path/to/file.md`.
  4. Answer the user in their language and cite file paths inline.

Rules:
  - Quote paths that may contain spaces.
  - The filesystem is read-only. Do not attempt writes.
  - Prefer specific tools over broad `grep -r /vfs` when possible.
"""
