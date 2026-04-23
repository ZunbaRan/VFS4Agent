"""
Integration test for all four Agent-framework adapters.

For each framework, we:
  1. Start the mock vfs server (binds /v1/bash to examples/sample-docs).
  2. Import the adapter's tool definition from its example file.
  3. Invoke the tool directly (bypass the LLM) with a canned command.
  4. Verify the returned text contains expected docs content.

This proves the "adapter ↔ vfs4Agent HTTP bridge" glue works for each
framework. Running the full LLM loop requires API keys and is a separate
manual check (see each demo's README).
"""

from __future__ import annotations

import os
import subprocess
import sys
import time
from pathlib import Path

import requests

REPO_ROOT = Path(__file__).resolve().parents[2]
SAMPLE_DOCS = REPO_ROOT / "examples" / "sample-docs"
MOCK_SERVER = REPO_ROOT / "examples" / "_mock" / "mock_vfs_server.py"
PORT = 7811  # avoid clashing with a dev server on 7801

os.environ["VFS_SERVER_URL"] = f"http://127.0.0.1:{PORT}"
os.environ.pop("VFS_SESSION_TOKEN", None)

# Make the shared _mock.vfs_client importable.
sys.path.insert(0, str(REPO_ROOT / "examples"))
sys.path.insert(0, str(REPO_ROOT / "examples" / "langchain-demo"))
sys.path.insert(0, str(REPO_ROOT / "examples" / "langgraph-demo"))
sys.path.insert(0, str(REPO_ROOT / "examples" / "crewai-qwen-demo"))


def start_mock() -> subprocess.Popen:
    proc = subprocess.Popen(
        [sys.executable, str(MOCK_SERVER), "--port", str(PORT),
         "--root", str(SAMPLE_DOCS)],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    # Wait for /v1/health
    deadline = time.time() + 5.0
    while time.time() < deadline:
        try:
            r = requests.get(f"http://127.0.0.1:{PORT}/v1/health", timeout=0.3)
            if r.ok:
                return proc
        except requests.RequestException:
            pass
        time.sleep(0.1)
    proc.terminate()
    raise RuntimeError("mock server failed to start")


def check(name: str, text: str, *needles: str) -> None:
    missing = [n for n in needles if n.lower() not in text.lower()]
    if missing:
        print(f"  ✗ {name}: missing {missing}")
        print(f"    got: {text[:200]!r}")
        raise SystemExit(1)
    print(f"  ✓ {name}: {text[:80].strip()}...")


def test_raw_client() -> None:
    print("[1/5] raw HTTP client (_mock.vfs_client)")
    from _mock.vfs_client import vfs_bash as raw_bash
    r = raw_bash("ls /vfs")
    check("ls /vfs", r.stdout, "auth", "guides")
    r2 = raw_bash("grep -rni oauth /vfs")
    check("grep oauth", r2.stdout, "oauth.md")


def test_langchain() -> None:
    print("[2/5] langchain @tool adapter")
    # Import only the tool definition; skip building the LLM agent.
    import importlib.util
    spec = importlib.util.spec_from_file_location(
        "lc_agent", REPO_ROOT / "examples" / "langchain-demo" / "agent.py"
    )
    mod = importlib.util.module_from_spec(spec)  # type: ignore[arg-type]
    # Lazy-load only the tool — build_agent() would error without API keys,
    # but simply importing the module only runs top-level @tool registration.
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    out = mod.vfs_bash.invoke({"command": "ls /vfs"})
    check("langchain tool", out, "auth", "guides")


def test_langgraph() -> None:
    print("[3/5] langgraph @tool adapter")
    import importlib.util
    spec = importlib.util.spec_from_file_location(
        "lg_agent", REPO_ROOT / "examples" / "langgraph-demo" / "agent.py"
    )
    mod = importlib.util.module_from_spec(spec)  # type: ignore[arg-type]
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    out = mod.vfs_bash.invoke({"command": "cat /vfs/auth/oauth.md"})
    check("langgraph tool", out, "oauth")


def test_crewai() -> None:
    print("[4/5] crewai BaseTool adapter")
    # Provide a dummy DashScope key so the top-level env lookup doesn't KeyError.
    os.environ.setdefault("DASHSCOPE_API_KEY", "test-placeholder")
    import importlib.util
    spec = importlib.util.spec_from_file_location(
        "crew_agent", REPO_ROOT / "examples" / "crewai-qwen-demo" / "agent.py"
    )
    mod = importlib.util.module_from_spec(spec)  # type: ignore[arg-type]
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    tool = mod.VfsBashTool()
    out = tool._run("find /vfs -name '*.md' | head -3")
    check("crewai tool", out, ".md")


def test_claude_sdk() -> None:
    print("[5/5] claude-agent-sdk TS demo — HTTP contract")
    # We don't run TS from Python; instead verify the HTTP contract the TS
    # client relies on (same as every other adapter).
    r = requests.post(
        f"http://127.0.0.1:{PORT}/v1/bash",
        json={"command": "wc -l /vfs/auth/oauth.md"},
        timeout=5,
    )
    r.raise_for_status()
    data = r.json()
    assert "stdout" in data and "exitCode" in data, f"bad payload: {data}"
    check("claude http", data["stdout"], "oauth.md")


def main() -> None:
    if not SAMPLE_DOCS.is_dir():
        sys.exit(f"sample-docs not found at {SAMPLE_DOCS}")
    mock = start_mock()
    print(f"[runner] mock vfs server on :{PORT}")
    try:
        test_raw_client()
        test_langchain()
        test_langgraph()
        test_crewai()
        test_claude_sdk()
    finally:
        mock.terminate()
        try:
            mock.wait(timeout=3)
        except subprocess.TimeoutExpired:
            mock.kill()
    print("\nALL 5 CHECKS PASSED ✓")


if __name__ == "__main__":
    main()
