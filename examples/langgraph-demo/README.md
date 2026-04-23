# LangGraph demo — vfs4Agent

Binds the same `vfs_bash` LangChain tool, but routes it through an explicit
graph: `agent → (tool_calls?) → tools → agent → ... → END`.

## Run

```bash
python examples/_mock/mock_vfs_server.py --root examples/sample-docs &
python3.12 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
export OPENAI_API_KEY=sk-...
python agent.py "OAuth refresh flow?"
```

## Bind mechanism

```python
model_with_tools = llm.bind_tools([vfs_bash])

builder = StateGraph(MessagesState)
builder.add_node("agent", call_model)
builder.add_node("tools", ToolNode([vfs_bash]))   # pre-built node
builder.add_conditional_edges("agent", should_continue)
builder.add_edge("tools", "agent")
```

The `ToolNode` is LangGraph's pre-built executor that consumes the last
message's `tool_calls` and emits `ToolMessage`s.
