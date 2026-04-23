"""
LangGraph + OpenAI demo against vfs4Agent.

Binding pattern: LangGraph reuses LangChain's @tool; `ToolNode` is a
pre-built graph node that executes tool_calls and appends ToolMessages
back into the state. The model decides whether to continue or finish.
"""

from __future__ import annotations

import os
import sys
from typing import Literal

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from dotenv import load_dotenv
from langchain_core.messages import HumanMessage, SystemMessage
from langchain_core.tools import tool
from langchain_openai import ChatOpenAI
from langgraph.graph import END, StateGraph, MessagesState
from langgraph.prebuilt import ToolNode

from _mock.vfs_client import SYSTEM_PROMPT, vfs_bash as _vfs_bash

load_dotenv()


@tool
def vfs_bash(command: str) -> str:
    """Run a bash command in the /vfs documentation sandbox.

    Args:
        command: bash command (e.g. "cat /vfs/auth/oauth.md").
    """
    return _vfs_bash(command).to_llm_string()


TOOLS = [vfs_bash]


def build_graph():
    llm = ChatOpenAI(
        model=os.environ.get("OPENAI_MODEL", "gpt-4o-mini"),
        api_key=os.environ.get("OPENAI_API_KEY")
            or os.environ.get("DASHSCOPE_API_KEY"),
        base_url=os.environ.get("OPENAI_BASE_URL")
            or os.environ.get("DASHSCOPE_BASE_URL"),
        temperature=0,
    ).bind_tools(TOOLS)

    def call_model(state: MessagesState) -> dict:
        response = llm.invoke(state["messages"])
        return {"messages": [response]}

    def should_continue(state: MessagesState) -> Literal["tools", END]:
        last = state["messages"][-1]
        if getattr(last, "tool_calls", None):
            return "tools"
        return END

    builder = StateGraph(MessagesState)
    builder.add_node("agent", call_model)
    builder.add_node("tools", ToolNode(TOOLS))
    builder.set_entry_point("agent")
    builder.add_conditional_edges("agent", should_continue)
    builder.add_edge("tools", "agent")
    return builder.compile()


def main() -> None:
    question = " ".join(sys.argv[1:]).strip() \
        or "How do I authenticate with OAuth and what is the refresh flow?"
    graph = build_graph()

    initial = {
        "messages": [
            SystemMessage(content=SYSTEM_PROMPT),
            HumanMessage(content=question),
        ]
    }
    final = graph.invoke(initial, {"recursion_limit": 20})

    print("\n" + "=" * 60)
    print("FINAL ANSWER")
    print("=" * 60)
    print(final["messages"][-1].content)


if __name__ == "__main__":
    main()
