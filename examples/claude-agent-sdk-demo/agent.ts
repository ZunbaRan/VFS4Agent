/**
 * Claude Agent SDK demo — vfs4Agent
 *
 * Uses @anthropic-ai/sdk directly (the raw tool_use API) because the
 * Claude Agent SDK's built-in `Bash` tool runs on the host, not against
 * our /vfs filesystem. We declare a single custom `bash` tool and route
 * every invocation to vfs4Agent's HTTP /v1/bash endpoint.
 *
 * Run:
 *   pnpm server                                 # terminal A (docker on macOS)
 *   # or: python examples/_mock/mock_vfs_server.py
 *   cd examples/claude-agent-sdk-demo
 *   pnpm install
 *   ANTHROPIC_API_KEY=sk-ant-... pnpm start "OAuth refresh flow?"
 */

import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";

const VFS_URL = process.env.VFS_SERVER_URL ?? "http://localhost:7801";
const VFS_TOKEN = process.env.VFS_SESSION_TOKEN;
const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-5";

// ── VFS bridge ──────────────────────────────────────────────────────────
async function vfsBash(command: string): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
}> {
  const res = await fetch(`${VFS_URL}/v1/bash`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(VFS_TOKEN ? { "x-vfs-session": VFS_TOKEN } : {}),
    },
    body: JSON.stringify({ command }),
  });
  if (!res.ok) throw new Error(`vfs /v1/bash failed: ${res.status}`);
  return res.json() as Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

function toolResultString(r: { stdout: string; stderr: string; exitCode: number }): string {
  const parts: string[] = [];
  if (r.stdout.trim()) parts.push(r.stdout.trimEnd());
  if (r.stderr.trim()) parts.push(`[stderr]\n${r.stderr.trimEnd()}`);
  if (r.exitCode && parts.length === 0) parts.push(`[exit ${r.exitCode}]`);
  const out = parts.join("\n") || "(no output)";
  return out.length > 6000 ? `${out.slice(0, 6000)}\n...[truncated]` : out;
}

// ── Tool definition (Anthropic schema) ──────────────────────────────────
const TOOLS: Anthropic.Messages.Tool[] = [
  {
    name: "bash",
    description:
      "Execute a bash command in the /vfs documentation sandbox. " +
      "Use ls, cat, grep, find, tree, head, tail, wc etc. Read-only under /vfs.",
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Bash command to run" },
      },
      required: ["command"],
    },
  },
];

const SYSTEM = `You are a documentation assistant with bash access to a \
read-only documentation tree mounted at /vfs.

Workflow: (1) \`ls /vfs\` or \`tree /vfs\` for layout. \
(2) \`grep -rni <keyword> /vfs\` to locate files. \
(3) \`cat /vfs/path\` to read. (4) Answer concisely and cite file paths.`;

// ── Agent loop ──────────────────────────────────────────────────────────
async function ask(question: string): Promise<string> {
  const client = new Anthropic();
  const messages: Anthropic.Messages.MessageParam[] = [
    { role: "user", content: question },
  ];

  for (let turn = 0; turn < 12; turn++) {
    const resp = await client.messages.create({
      model: MODEL,
      max_tokens: 4096,
      system: SYSTEM,
      tools: TOOLS,
      messages,
    });

    if (resp.stop_reason === "end_turn") {
      const text = resp.content
        .filter((b): b is Anthropic.Messages.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n");
      return text;
    }

    messages.push({ role: "assistant", content: resp.content });

    // Execute every tool_use block, batch results as a single user message.
    const results: Anthropic.Messages.ToolResultBlockParam[] = [];
    for (const block of resp.content) {
      if (block.type !== "tool_use") continue;
      if (block.name !== "bash") {
        results.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: `unsupported tool: ${block.name}`,
          is_error: true,
        });
        continue;
      }
      const { command } = block.input as { command: string };
      console.log(`  ⚙  ${command}`);
      const r = await vfsBash(command);
      console.log(`  →  exit=${r.exitCode}`);
      results.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: toolResultString(r),
        is_error: r.exitCode !== 0,
      });
    }
    messages.push({ role: "user", content: results });
  }

  return "[agent] max turns reached";
}

// ── Entry ───────────────────────────────────────────────────────────────
const question =
  process.argv.slice(2).join(" ").trim() ||
  "How do I authenticate with OAuth and what is the refresh flow?";

ask(question).then((answer) => {
  console.log("\n" + "=".repeat(60));
  console.log("FINAL ANSWER");
  console.log("=".repeat(60));
  console.log(answer);
});
