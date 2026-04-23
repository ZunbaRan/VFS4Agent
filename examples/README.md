# External Agent integration examples

Four demos showing how to bind an LLM agent to vfs4Agent's `/v1/bash` HTTP
endpoint. Each framework exposes tool-calling with a slightly different
primitive; the `bash` tool body is **identical** — a single POST to
`http://<vfs-server>/v1/bash`.

| framework                     | language | binding primitive                    | file                            |
|-------------------------------|----------|--------------------------------------|---------------------------------|
| LangChain 1.x                 | Python   | `@tool` + `create_agent`             | [langchain-demo/](./langchain-demo/) |
| LangGraph                     | Python   | `@tool` + `StateGraph` + `ToolNode`  | [langgraph-demo/](./langgraph-demo/) |
| CrewAI                        | Python   | `BaseTool` subclass + `args_schema`  | [crewai-qwen-demo/](./crewai-qwen-demo/) |
| Claude Agent SDK (Anthropic)  | TS       | `Anthropic.Messages.Tool` + manual loop | [claude-agent-sdk-demo/](./claude-agent-sdk-demo/) |

Shared HTTP client: [`_mock/vfs_client.py`](./_mock/vfs_client.py) —
every Python example imports `vfs_bash()` + `SYSTEM_PROMPT` from here so the
wire format stays consistent.

## Run the server

```bash
# Production (Linux + FUSE, via docker-compose):
pnpm ingest ./examples/sample-docs
pnpm server                          # → http://localhost:7801

# macOS dev (no FUSE, no Docker): mock server executes bash in a real tmpdir,
# path-rewriting /vfs → fixture root.
python3 examples/_mock/mock_vfs_server.py --root examples/sample-docs
```

Both expose the same contract:

```
POST /v1/bash    { command }                    → { stdout, stderr, exitCode }
POST /v1/fs/cat  { path }                       → { content }
POST /v1/fs/ls   { path }                       → { entries[] }
GET  /v1/health                                 → { status, backend, mount }
```

Optional auth: set `VFS_SESSION_TOKEN` on the server and pass
`x-vfs-session: <token>` on every request.

## Test

Integration test (no LLM key needed — invokes each tool directly against the
mock server):

```bash
python3.12 -m venv .venv-test
.venv-test/bin/pip install requests python-dotenv \
    langchain langchain-openai langgraph crewai
.venv-test/bin/python examples/_mock/test_adapters.py
```

Expected output:

```
[runner] mock vfs server on :7811
[1/5] raw HTTP client (_mock.vfs_client)
  ✓ ls /vfs: ...
  ✓ grep oauth: ...
[2/5] langchain @tool adapter
  ✓ langchain tool: ...
[3/5] langgraph @tool adapter
  ✓ langgraph tool: ...
[4/5] crewai BaseTool adapter
  ✓ crewai tool: ...
[5/5] claude-agent-sdk TS demo — HTTP contract
  ✓ claude http: ...

ALL 5 CHECKS PASSED ✓
```
