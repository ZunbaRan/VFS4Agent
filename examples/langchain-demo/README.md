# LangChain demo — vfs4Agent

LangChain 1.x `@tool` + `create_agent` binding a single `vfs_bash` tool that
POSTs to vfs4Agent's `/v1/bash` HTTP endpoint.

## Run

```bash
# 1. Start vfs server (pick one):
#    — real:  pnpm server          (inside docker-compose, Linux + FUSE)
#    — mock:  python3 examples/_mock/mock_vfs_server.py --root examples/sample-docs

# 2. Install (Python 3.12 recommended):
python3.12 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

# 3. Ask:
export OPENAI_API_KEY=sk-...
python agent.py "OAuth refresh flow 是怎么实现的？"
```

## Bind mechanism

```python
from langchain_core.tools import tool
from langchain.agents import create_agent

@tool
def vfs_bash(command: str) -> str:
    """Run a bash command in the /vfs documentation sandbox."""
    return vfs_client.vfs_bash(command).to_llm_string()

agent = create_agent(llm, tools=[vfs_bash], system_prompt=SYSTEM_PROMPT)
result = agent.invoke({"messages": [HumanMessage(content=question)]})
```

LangChain auto-generates the JSON schema from the function signature and
docstring — no manual wiring. `create_agent` returns a compiled LangGraph
that loops model ↔ tools until the model emits a final message.

> Note: v1.x removed the old `AgentExecutor` / `create_tool_calling_agent`.
> For the old 0.3.x API, downgrade with `pip install 'langchain<1.0'`.
