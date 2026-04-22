"""
CrewAI + Qwen (DashScope) demo against vfs4Agent.

Prereq:
  1. In terminal A:   pnpm ingest ./examples/sample-docs && pnpm server
  2. In this folder:  python3.12 -m venv .venv && source .venv/bin/activate
                      pip install -r requirements.txt
                      cp .env.example .env  (edit if needed)
                      python agent.py "how do I authenticate with OAuth?"
"""

from __future__ import annotations

import os
import sys
import json
import requests
from typing import Type

from dotenv import load_dotenv
from pydantic import BaseModel, Field
from crewai import Agent, Task, Crew, LLM
from crewai.tools import BaseTool


load_dotenv()

VFS_URL = os.environ.get("VFS_SERVER_URL", "http://localhost:7801")
VFS_SESSION = os.environ.get("VFS_SESSION", "demo-session")
DASHSCOPE_KEY = os.environ["DASHSCOPE_API_KEY"]
DASHSCOPE_BASE = os.environ.get(
    "DASHSCOPE_BASE_URL", "https://dashscope.aliyuncs.com/compatible-mode/v1"
)
QWEN_MODEL = os.environ.get("QWEN_MODEL", "qwen-plus")


# ----------------------------------------------------------------------------
# VFS bridge tool
# ----------------------------------------------------------------------------


def _vfs_post(path: str, body: dict) -> dict:
    r = requests.post(
        f"{VFS_URL}{path}",
        json=body,
        headers={"X-VFS-Session": VFS_SESSION, "Content-Type": "application/json"},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


class VfsBashInput(BaseModel):
    command: str = Field(
        ...,
        description=(
            "A bash-like command to execute inside the documentation sandbox. "
            "Supports: ls, cat, head, tail, wc, find, tree, grep (-r/-i/-n/-l), "
            "awk, sed, sort, uniq. The docs are read-only under /docs."
        ),
    )


class VfsBashTool(BaseTool):
    name: str = "vfs_bash"
    description: str = (
        "Execute bash commands against a virtual filesystem of documentation. "
        "Example: `grep -rni 'oauth' /docs`, `cat /docs/auth/oauth.md`, "
        "`find /docs -name '*.md'`, `tree /docs`."
    )
    args_schema: Type[BaseModel] = VfsBashInput

    def _run(self, command: str) -> str:
        data = _vfs_post("/v1/bash", {"command": command})
        stdout = (data.get("stdout") or "").rstrip()
        stderr = (data.get("stderr") or "").rstrip()
        exit_code = data.get("exitCode", 0)
        parts: list[str] = []
        if stdout:
            parts.append(stdout)
        if stderr:
            parts.append(f"[stderr]\n{stderr}")
        if exit_code and not parts:
            parts.append(f"[exit {exit_code}]")
        out = "\n".join(parts) if parts else "(no output)"
        # Truncate to keep context manageable
        if len(out) > 6000:
            out = out[:6000] + "\n...[truncated]"
        return out


# ----------------------------------------------------------------------------
# Crew
# ----------------------------------------------------------------------------


def build_crew(question: str) -> Crew:
    llm = LLM(
        model=f"dashscope/{QWEN_MODEL}",
        base_url=DASHSCOPE_BASE,
        api_key=DASHSCOPE_KEY,
    )

    researcher = Agent(
        role="Docs Researcher",
        goal=(
            "Answer questions accurately by reading the project documentation "
            "exposed under /docs using bash commands."
        ),
        backstory=(
            "You are a careful technical writer. You never fabricate details. "
            "When a question comes in you first explore the docs layout with "
            "`tree /docs` or `find /docs -name '*.md'`, then grep for keywords, "
            "and finally `cat` the most relevant files to extract the answer."
        ),
        tools=[VfsBashTool()],
        llm=llm,
        allow_delegation=False,
        verbose=True,
        max_iter=8,
    )

    task = Task(
        description=(
            f"User question: {question}\n\n"
            "Answer using only evidence found in /docs. Cite file paths you read.\n"
            "Workflow hint:\n"
            "  1. `tree /docs` to see layout.\n"
            "  2. `grep -rni <keyword> /docs` to locate relevant files.\n"
            "  3. `cat <path>` to read the full doc.\n"
            "  4. Synthesize a concise answer with inline file citations."
        ),
        expected_output=(
            "A concise answer that directly addresses the question, followed by "
            "a `Sources:` list of file paths."
        ),
        agent=researcher,
    )

    return Crew(agents=[researcher], tasks=[task], verbose=True)


def main() -> None:
    question = (
        " ".join(sys.argv[1:]).strip()
        or "How do I authenticate with OAuth, and what is the refresh flow?"
    )
    print(f"[demo] question: {question}")
    print(f"[demo] vfs:      {VFS_URL}")
    print(f"[demo] model:    {QWEN_MODEL}")

    # Sanity ping
    try:
        ping = _vfs_post("/v1/bash", {"command": "ls /docs"})
        print(f"[demo] vfs ping: {json.dumps(ping)[:200]}")
    except Exception as e:
        print(f"[demo] ERROR: cannot reach vfs-server at {VFS_URL}: {e}")
        sys.exit(2)

    crew = build_crew(question)
    result = crew.kickoff()
    print("\n" + "=" * 60)
    print("FINAL ANSWER")
    print("=" * 60)
    print(result)


if __name__ == "__main__":
    main()
