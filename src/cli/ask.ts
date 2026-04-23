#!/usr/bin/env tsx
/**
 * ask — Shell-Native docs question answering.
 *
 * Usage:
 *   pnpm ask "how do I authenticate with OAuth?"
 *   pnpm ask --model qwen-plus --max-turns 15 "..."
 *
 * Reads DashScope credentials from env (see examples/crewai-qwen-demo/.env
 * for an example) or from process env directly:
 *   DASHSCOPE_API_KEY, DASHSCOPE_BASE_URL (optional), QWEN_MODEL (optional)
 */

import "dotenv/config";
import OpenAI from "openai";

import { createBackend } from "../backend/factory.js";
import { runShellAgent } from "../runner/shellRunner.js";

function parseArgs(argv: string[]) {
  const out: {
    question?: string;
    db?: string;
    mount?: string;
    model?: string;
    maxTurns?: number;
    maxOutputBytes?: number;
    quiet?: boolean;
  } = {};
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--db") out.db = argv[++i];
    else if (a === "--mount") out.mount = argv[++i];
    else if (a === "--model") out.model = argv[++i];
    else if (a === "--max-turns") out.maxTurns = Number(argv[++i]);
    else if (a === "--max-output") out.maxOutputBytes = Number(argv[++i]);
    else if (a === "--quiet" || a === "-q") out.quiet = true;
    else rest.push(a);
  }
  out.question = rest.join(" ").trim();
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.question) {
    console.error('usage: pnpm ask "<your question>"');
    process.exit(2);
  }

  const apiKey = process.env.DASHSCOPE_API_KEY;
  if (!apiKey) {
    console.error(
      "error: DASHSCOPE_API_KEY not set. Put it in .env or export it.",
    );
    process.exit(2);
  }

  const llm = new OpenAI({
    apiKey,
    baseURL:
      process.env.DASHSCOPE_BASE_URL ??
      "https://dashscope.aliyuncs.com/compatible-mode/v1",
  });
  const model = args.model ?? process.env.QWEN_MODEL ?? "qwen-plus";

  // --db always implies sqlite. Without --db, honour VFS_BACKEND env (default
  // "chroma"). Avoids the footgun where `--db ./x.db` silently talked to a
  // Chroma server because VFS_BACKEND wasn't flipped.
  const { store, label } = args.db
    ? createBackend({ backend: "sqlite", sqlitePath: args.db })
    : createBackend();

  if (!args.quiet) {
    console.error(`[ask] model=${model}  backend=${label}  mount=${args.mount ?? "/docs"}`);
    console.error(`[ask] question: ${args.question}`);
    console.error("—".repeat(60));
  }

  const result = await runShellAgent({
    question: args.question,
    store,
    llm,
    model,
    mountPoint: args.mount ?? "/docs",
    maxTurns: args.maxTurns ?? 20,
    maxOutputBytes: args.maxOutputBytes ?? 4096,
    onTurn: args.quiet
      ? undefined
      : (t) => {
          process.stderr.write(`\n[turn ${t.n}] $ ${t.command}\n`);
          const preview = truncateForLog(t.stdout + (t.stderr ? `\n${t.stderr}` : ""), 800);
          if (preview) process.stderr.write(preview.replace(/^/gm, "  "));
          if (t.exitCode) process.stderr.write(`  [exit ${t.exitCode}]\n`);
        },
  });

  if (!args.quiet) {
    console.error("\n" + "—".repeat(60));
    console.error(`[ask] turns=${result.transcript.length} reason=${result.reason}`);
  }

  if (result.answer) {
    process.stdout.write(result.answer.replace(/\n?$/, "\n"));
    process.exit(0);
  } else {
    console.error(`[ask] no answer: ${result.reason}`);
    process.exit(1);
  }
}

function truncateForLog(s: string, maxBytes: number): string {
  if (!s) return "";
  const buf = Buffer.from(s, "utf8");
  if (buf.length <= maxBytes) return s.endsWith("\n") ? s : s + "\n";
  return (
    buf.subarray(0, maxBytes).toString("utf8").replace(/[^\n]*$/, "") +
    `  ... [+${buf.length - maxBytes}B]\n`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
