#!/usr/bin/env tsx
/**
 * ask — single-shot question answering against the FUSE-mounted docs.
 *
 * Mounts the FUSE filesystem at a temp path (or VFS_MOUNT), runs one agent
 * turn, prints the answer, then unmounts.
 *
 * Usage:
 *   pnpm ask "how do I authenticate with OAuth?"
 *   pnpm ask --model qwen-plus --max-turns 15 "..."
 *
 * Env (any one of the following pairs):
 *   OPENAI_API_KEY   [+ OPENAI_BASE_URL] [+ OPENAI_MODEL]
 *   DASHSCOPE_API_KEY [+ DASHSCOPE_BASE_URL] [+ QWEN_MODEL]
 */

import "dotenv/config";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import OpenAI from "openai";

import { createBackend } from "../backend/factory.js";
import { mount } from "../fuse/index.js";
import { runAgentTurn } from "../agent/adapters/openai.js";
import { createBashRunner } from "../agent/bash.js";
import { buildRegistryFromEnv } from "../agent/commands/index.js";

interface Args {
  question?: string;
  mount?: string;
  model?: string;
  baseURL?: string;
  maxTurns?: number;
  quiet?: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {};
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--mount") out.mount = argv[++i];
    else if (a === "--model") out.model = argv[++i];
    else if (a === "--base-url") out.baseURL = argv[++i];
    else if (a === "--max-turns") out.maxTurns = Number(argv[++i]);
    else if (a === "--quiet" || a === "-q") out.quiet = true;
    else rest.push(a);
  }
  out.question = rest.join(" ").trim();
  return out;
}

function pickEnv(...names: string[]): string | undefined {
  for (const n of names) {
    const v = process.env[n];
    if (v && v.trim()) return v.trim();
  }
  return undefined;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.question) {
    console.error('usage: pnpm ask "<your question>"');
    process.exit(2);
  }

  const apiKey = pickEnv("OPENAI_API_KEY", "DASHSCOPE_API_KEY");
  if (!apiKey) {
    console.error("error: OPENAI_API_KEY (or DASHSCOPE_API_KEY) not set");
    process.exit(1);
  }
  const model = args.model ?? pickEnv("OPENAI_MODEL", "QWEN_MODEL") ?? "gpt-4o-mini";
  const baseURL = args.baseURL ?? pickEnv("OPENAI_BASE_URL", "DASHSCOPE_BASE_URL");

  const mountPoint =
    args.mount ?? process.env.VFS_MOUNT ?? fs.mkdtempSync(path.join(os.tmpdir(), "vfs4agent-"));

  const { store, label } = createBackend();
  if (!args.quiet) console.error(`[ask] backend=${label}, mount=${mountPoint}`);

  const m = await mount({ store, mountPoint });
  const registry = buildRegistryFromEnv(process.env.VFS_OPTIMIZERS);
  const exec = createBashRunner({ cwd: mountPoint, registry, store });
  const client = new OpenAI({ apiKey, baseURL });

  let exitCode = 0;
  try {
    const answer = await runAgentTurn({
      client,
      model,
      question: args.question,
      exec,
      maxTurns: args.maxTurns ?? 12,
      onStep: args.quiet
        ? undefined
        : (step) => {
            if (step.type === "tool_call") process.stderr.write(`\n$ ${step.command}\n`);
            else if (step.type === "tool_result") {
              if (step.result.exitCode !== 0) {
                process.stderr.write(`[exit ${step.result.exitCode}]\n`);
              }
            }
          },
    });
    process.stdout.write(answer.endsWith("\n") ? answer : answer + "\n");
  } catch (e) {
    console.error("ask failed:", (e as Error).message);
    exitCode = 1;
  } finally {
    await m.unmount();
    store.close();
  }
  process.exit(exitCode);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
