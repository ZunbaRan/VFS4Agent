"""
LangChain 1.x demo against vfs4Agent.

Binding pattern: @tool decorator auto-builds the JSON schema from the
Python signature + docstring; `create_agent(model, tools, system_prompt)`
returns a compiled LangGraph that loops LLM ↔ tool calls until done.
(The old `AgentExecutor` / `create_tool_calling_agent` were removed in v1.)
"""

from __future__ import annotations

import os
import sys

# Allow `from _mock.vfs_client import ...` when run from repo root.
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from dotenv import load_dotenv
from langchain.agents import create_agent
from langchain_core.messages import HumanMessage
from langchain_core.tools import tool
from langchain_openai import ChatOpenAI

from _mock.vfs_client import SYSTEM_PROMPT, vfs_bash as _vfs_bash

load_dotenv()


# --- Tool definition ------------------------------------------------------
# LangChain reads the signature + docstring to auto-build the tool schema.
@tool
def vfs_bash(command: str) -> str:
    """Execute a bash command in the /vfs documentation sandbox.

    Use this to run ls, cat, grep, find, tree, head, tail, wc, etc.
    against the read-only documentation tree mounted at /vfs.

    Args:
        command: The full bash command to execute (e.g. "grep -rni oauth /vfs").

    Returns:
        Combined stdout/stderr, truncated to 6KB.
    """
    return _vfs_bash(command).to_llm_string()


# --- Agent wiring ---------------------------------------------------------
def build_agent():
    # Works with OpenAI, DashScope (OpenAI-compat), Azure, etc.
    llm = ChatOpenAI(
        model=os.environ.get("OPENAI_MODEL", "gpt-4o-mini"),
        api_key=os.environ.get("OPENAI_API_KEY")
            or os.environ.get("DASHSCOPE_API_KEY"),
        base_url=os.environ.get("OPENAI_BASE_URL")
            or os.environ.get("DASHSCOPE_BASE_URL"),
        temperature=0,
    )
    return create_agent(llm, tools=[vfs_bash], system_prompt=SYSTEM_PROMPT)


def main() -> None:
    question = " ".join(sys.argv[1:]).strip() \
        or "How do I authenticate with OAuth and what is the refresh flow?"
    agent = build_agent()
    result = agent.invoke({"messages": [HumanMessage(content=question)]})
    print("\n" + "=" * 60)
    print("FINAL ANSWER")
    print("=" * 60)
    print(result["messages"][-1].content)


if __name__ == "__main__":
    main()
