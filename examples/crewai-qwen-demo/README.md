# CrewAI + Qwen(DashScope) demo — vfs4Agent

CrewAI agent uses `qwen-plus` via DashScope's OpenAI-compatible endpoint,
and talks to the vfs-server HTTP bridge to run `ls / cat / grep / tree / find`
against the virtual filesystem.

## 1. Start the VFS server

From the repo root:

```bash
pnpm ingest ./examples/sample-docs      # one-time: build ./data/vfs.db
pnpm server                              # listens on http://localhost:7801
```

## 2. Install CrewAI (Python 3.12 recommended)

CrewAI does not yet support Python 3.14. Use 3.12:

```bash
cd examples/crewai-qwen-demo
python3.12 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env            # DashScope key is pre-filled
```

## 3. Ask a question

```bash
python agent.py "how do I authenticate with OAuth, and what is the refresh flow?"
```

The agent will `tree /docs`, `grep` for keywords, `cat` the matching files,
then produce an answer with citations to file paths under `/docs`.

## Configuration

All via `.env`:

| var                  | default                                                        |
|----------------------|----------------------------------------------------------------|
| `DASHSCOPE_API_KEY`  | (pre-filled in .env.example)                                   |
| `DASHSCOPE_BASE_URL` | `https://dashscope.aliyuncs.com/compatible-mode/v1`            |
| `QWEN_MODEL`         | `qwen-plus`  (try `qwen-max`, `qwen-turbo`, `qwen3-*` as well) |
| `VFS_SERVER_URL`     | `http://localhost:7801`                                        |
| `VFS_SESSION`        | `demo-session`                                                 |

## Ports / tools available to the agent

The `vfs_bash` tool POSTs to `/v1/bash` on the VFS server. The sandbox
provides the full just-bash built-in command set on top of the SQLite-backed
VirtualFs mounted at `/docs` (read-only) plus `/tmp`, `/home/user` as in-memory
scratch. Writes to `/docs` return `EROFS`.
