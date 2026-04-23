/**
 * Interactive REPL backed by an OpenAI-compatible chat model.
 * Each user line spawns a fresh agent turn (no cross-turn history beyond the
 * filesystem itself — the FS is the memory).
 */

import * as readline from "node:readline";
import OpenAI from "openai";
import { runAgentTurn, type AgentStep } from "./adapters/openai.js";
import { createBashRunner } from "./bash.js";

export interface ReplOptions {
  cwd: string;
  model: string;
  baseURL?: string;
  apiKey: string;
}

function printStep(step: AgentStep): void {
  if (step.type === "tool_call") {
    process.stdout.write(`\n$ ${step.command}\n`);
  } else if (step.type === "tool_result") {
    const { stdout, stderr, exitCode } = step.result;
    if (stdout) process.stdout.write(stdout.endsWith("\n") ? stdout : stdout + "\n");
    if (stderr) process.stderr.write(stderr.endsWith("\n") ? stderr : stderr + "\n");
    if (exitCode !== 0) process.stdout.write(`[exit ${exitCode}]\n`);
  } else if (step.type === "assistant") {
    process.stdout.write(`\n${step.text}\n`);
  }
}

export async function startRepl(opts: ReplOptions): Promise<void> {
  const client = new OpenAI({ apiKey: opts.apiKey, baseURL: opts.baseURL });
  const exec = createBashRunner({ cwd: opts.cwd });

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.on("close", () => {
    console.log("\nbye");
    process.exit(0);
  });

  console.log(`vfs4agent REPL — model=${opts.model} cwd=${opts.cwd}`);
  console.log(`Type a question, or 'exit' to quit.\n`);

  const ask = (q: string): Promise<string> => new Promise((r) => rl.question(q, r));

  while (true) {
    let line: string;
    try {
      line = await ask("> ");
    } catch {
      break;
    }
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed === "exit" || trimmed === "quit") break;

    try {
      await runAgentTurn({
        client,
        model: opts.model,
        question: trimmed,
        exec,
        onStep: printStep,
      });
    } catch (e) {
      console.error("agent error:", (e as Error).message);
    }
  }

  rl.close();
}
