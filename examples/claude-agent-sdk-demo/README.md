# Claude Agent SDK demo — vfs4Agent

Uses Anthropic's raw `messages.create(tools=[...])` API to bind a single
`bash` tool that routes to vfs4Agent's `/v1/bash` endpoint.

> **Why not the official `Bash` tool?** `@anthropic-ai/claude-agent-sdk`
> ships with a host-side `Bash` tool, but it executes on the agent host —
> not against our /vfs mount. We want every `bash` invocation to hit
> vfs4Agent, so we declare a custom tool with the same name.

## Run

```bash
# 1. Start the vfs server
pnpm server                                           # real, needs Docker
# or:
python ../_mock/mock_vfs_server.py --root ../sample-docs

# 2. Run the demo
pnpm install
ANTHROPIC_API_KEY=sk-ant-... pnpm start "OAuth refresh flow?"
```

## Bind mechanism

```typescript
const TOOLS = [{
  name: "bash",
  description: "...",
  input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
}];

const resp = await client.messages.create({ model, tools: TOOLS, messages, ... });
// Loop: for each tool_use block → call vfsBash() → push tool_result.
```
