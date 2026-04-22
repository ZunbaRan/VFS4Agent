/**
 * shellRunner — the "LLM lives inside bash" loop.
 *
 * No tool schema, no function-calling. Each assistant reply is interpreted as
 * a raw shell command, executed, and the stdout+stderr (plus a fresh PS1
 * prompt) is fed back as the next user message. Terminates when the model
 * runs `answer "..."` or when maxTurns is reached.
 */

import type OpenAI from "openai";

import { createShell } from "../shell.js";
import type { VectorStore, Session } from "../types.js";
import { createAnswerSlot, installAnswerCommand } from "./answer.js";
import { renderMotd, renderPrompt, SHELL_SYSTEM_PROMPT } from "./motd.js";

type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

export interface Turn {
  /** 0-based turn index. */
  n: number;
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  /** True if this turn's command ran `answer`. */
  terminated: boolean;
}

export interface ShellRunnerOptions {
  question: string;
  store: VectorStore;
  llm: OpenAI;
  model: string;
  session?: Session;
  maxTurns?: number;
  /** Max bytes of shell output shown back to the model per turn. */
  maxOutputBytes?: number;
  /** Max total bytes of transcript history retained in the LLM context. */
  maxHistoryBytes?: number;
  temperature?: number;
  /** Called after each turn; useful for streaming logs in the CLI. */
  onTurn?: (turn: Turn) => void;
  mountPoint?: string;
}

export interface ShellRunnerResult {
  answer: string | null;
  reason: "answered" | "max_turns" | "empty_reply";
  transcript: Turn[];
}

const DEFAULTS = {
  maxTurns: 20,
  maxOutputBytes: 4096,
  maxHistoryBytes: 64_000,
  temperature: 0.2,
};

export async function runShellAgent(
  opts: ShellRunnerOptions,
): Promise<ShellRunnerResult> {
  const maxTurns = opts.maxTurns ?? DEFAULTS.maxTurns;
  const maxOutputBytes = opts.maxOutputBytes ?? DEFAULTS.maxOutputBytes;
  const maxHistoryBytes = opts.maxHistoryBytes ?? DEFAULTS.maxHistoryBytes;
  const temperature = opts.temperature ?? DEFAULTS.temperature;
  const mountPoint = opts.mountPoint ?? "/docs";

  const { bash, close } = createShell({
    store: opts.store,
    session: opts.session,
    mountPoint,
    cwd: mountPoint,
  });
  const slot = createAnswerSlot();
  installAnswerCommand(bash, slot);

  const messages: ChatMessage[] = [
    { role: "system", content: SHELL_SYSTEM_PROMPT },
    {
      role: "user",
      content:
        renderMotd({ question: opts.question, mount: mountPoint }) +
        renderPrompt(bash.getCwd()),
    },
  ];

  const transcript: Turn[] = [];

  try {
    for (let n = 0; n < maxTurns; n++) {
      const resp = await opts.llm.chat.completions.create({
        model: opts.model,
        messages,
        temperature,
        // Intentionally: no `tools`, no `tool_choice`.
      });

      const raw = resp.choices[0]?.message?.content ?? "";
      const command = extractCommand(raw);
      if (!command) {
        return {
          answer: null,
          reason: "empty_reply",
          transcript,
        };
      }

      messages.push({ role: "assistant", content: command });

      let stdout = "";
      let stderr = "";
      let exitCode = 0;
      try {
        const r = await bash.exec(command);
        stdout = r.stdout ?? "";
        stderr = r.stderr ?? "";
        exitCode = r.exitCode ?? 0;
      } catch (e) {
        const err = e as Error & { code?: string };
        stderr = `bash: ${err.code ?? "ERROR"}: ${err.message}\n`;
        exitCode = 1;
      }

      const terminated = slot.value !== null;
      const combined = joinOutput(stdout, stderr, exitCode);
      const shown = truncate(combined, maxOutputBytes);

      const turn: Turn = { n, command, stdout, stderr, exitCode, terminated };
      transcript.push(turn);
      opts.onTurn?.(turn);

      if (terminated) {
        return {
          answer: slot.value,
          reason: "answered",
          transcript,
        };
      }

      messages.push({
        role: "user",
        content: shown + renderPrompt(bash.getCwd()),
      });

      trimHistory(messages, maxHistoryBytes);
    }

    return { answer: null, reason: "max_turns", transcript };
  } finally {
    close();
  }
}

// ------------------------------------------------------------------
// helpers
// ------------------------------------------------------------------

/**
 * Pull a single shell command out of the model's reply.
 * Tolerates (but does not require) ```bash ... ``` fences.
 */
export function extractCommand(raw: string): string {
  let s = raw.trim();
  const fence = s.match(/```(?:bash|sh)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  // Collapse to the first non-blank, non-comment line — the model should send
  // exactly one command, but if it sends several, we take the first.
  const firstLine = s
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0 && !l.startsWith("#"));
  return firstLine ?? "";
}

function joinOutput(stdout: string, stderr: string, exitCode: number): string {
  let out = stdout;
  if (stderr) {
    if (out && !out.endsWith("\n")) out += "\n";
    out += stderr;
  }
  if (exitCode && exitCode !== 0) {
    if (out && !out.endsWith("\n")) out += "\n";
    out += `[exit ${exitCode}]\n`;
  }
  return out;
}

export function truncate(s: string, maxBytes: number): string {
  const buf = Buffer.from(s, "utf8");
  if (buf.length <= maxBytes) return s;
  const head = buf.subarray(0, maxBytes).toString("utf8");
  const trimmed = head.replace(/[^\n]*$/, "");
  return (
    (trimmed || head) +
    `\n... (truncated ${buf.length - maxBytes} more bytes; use head/tail/grep to narrow)\n`
  );
}

/**
 * Keep the system prompt + MOTD at the front; drop oldest turns from the
 * middle until total size is under the budget. Rough char-based heuristic.
 */
function trimHistory(messages: ChatMessage[], maxBytes: number): void {
  const size = () =>
    messages.reduce((acc, m) => acc + Buffer.byteLength(m.content, "utf8"), 0);
  // Always preserve index 0 (system) and 1 (MOTD).
  while (size() > maxBytes && messages.length > 4) {
    messages.splice(2, 2); // drop one (assistant, user) pair
  }
}
