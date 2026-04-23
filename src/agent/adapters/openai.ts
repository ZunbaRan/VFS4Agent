/**
 * OpenAI-compatible function-calling REPL for any provider that speaks the
 * OpenAI Chat Completions API (OpenAI, DashScope/Qwen, etc.).
 *
 * The agent has exactly one tool: `bash`, which runs in a real subprocess
 * rooted at the FUSE mount point.
 */

import OpenAI from "openai";
import type { BashResult } from "../bash.js";

export const SYSTEM_PROMPT = `You are a documentation assistant operating inside a Linux sandbox.

You have shell access to a documentation tree mounted under your current working directory.
- Use \`ls\`, \`cat\`, \`grep\`, \`find\`, \`head\`, \`tail\`, etc. to explore the tree.
- Semantic search: write a query into \`search/last_query\`, then read \`search/results/\`.
  Example:
    echo "OAuth refresh token" > search/last_query
    ls search/results/
    cat search/results/001_*.md
- Always quote paths that may contain spaces.
- The filesystem is read-only except for \`search/last_query\`.

When you have enough information, give the user a concise answer in their language.`;

const TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "bash",
      description:
        "Run a bash command in the documentation sandbox. Returns stdout, stderr, exitCode.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Bash command to execute" },
        },
        required: ["command"],
      },
    },
  },
];

export interface RunAgentOpts {
  client: OpenAI;
  model: string;
  question: string;
  exec: (cmd: string) => Promise<BashResult>;
  systemPrompt?: string;
  maxTurns?: number;
  onStep?: (step: AgentStep) => void;
}

export type AgentStep =
  | { type: "tool_call"; command: string }
  | { type: "tool_result"; result: BashResult }
  | { type: "assistant"; text: string };

export async function runAgentTurn(opts: RunAgentOpts): Promise<string> {
  const { client, model, question, exec, onStep } = opts;
  const maxTurns = opts.maxTurns ?? 12;

  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: "system", content: opts.systemPrompt ?? SYSTEM_PROMPT },
    { role: "user", content: question },
  ];

  for (let turn = 0; turn < maxTurns; turn++) {
    const response = await client.chat.completions.create({
      model,
      messages,
      tools: TOOLS,
      tool_choice: "auto",
    });

    const choice = response.choices[0];
    const msg = choice.message;

    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      const text = msg.content ?? "";
      if (text) onStep?.({ type: "assistant", text });
      return text;
    }

    messages.push(msg);

    for (const call of msg.tool_calls) {
      if (call.type !== "function" || call.function.name !== "bash") {
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: `unsupported tool: ${(call as any).function?.name ?? call.type}`,
        });
        continue;
      }
      let parsed: { command?: string };
      try {
        parsed = JSON.parse(call.function.arguments || "{}");
      } catch {
        parsed = {};
      }
      const command = (parsed.command ?? "").toString();
      onStep?.({ type: "tool_call", command });
      const result = command ? await exec(command) : { stdout: "", stderr: "missing command", exitCode: 1 };
      onStep?.({ type: "tool_result", result });
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify({
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
        }),
      });
    }
  }

  return "[agent] max turns reached without final answer";
}
