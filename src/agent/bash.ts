/**
 * Bash adapter — runs commands in a real /bin/bash subprocess rooted at the
 * mount point. Used by the OpenAI function-calling REPL.
 *
 * If a CommandOptimizer matches the command (and required backend capabilities
 * are satisfied), the optimizer executes directly against the VectorStore and
 * no subprocess is spawned. Otherwise the command falls through to real bash +
 * FUSE which is always correct.
 */

import { spawn } from "node:child_process";
import type { VectorStore } from "../types.js";
import type { OptimizerRegistry } from "./commands/types.js";

export interface BashResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface BashOptions {
  cwd: string;
  timeoutMs?: number;
  /** Truncate stdout/stderr to this many bytes per stream. */
  maxBytes?: number;
  env?: NodeJS.ProcessEnv;
  /** Optional Command Optimizer registry. If null, always fall through to bash. */
  registry?: OptimizerRegistry;
  /** VectorStore instance the optimizers run against. Required if `registry` is set. */
  store?: VectorStore;
  /** Custom logger; defaults to console.log. */
  logger?: (msg: string) => void;
}

export function createBashRunner(opts: BashOptions) {
  const cwd = opts.cwd;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const maxBytes = opts.maxBytes ?? 64 * 1024;
  const env = opts.env ?? process.env;
  const registry = opts.registry;
  const store = opts.store;
  const log = opts.logger ?? ((m: string) => console.log(m));

  return async function exec(command: string): Promise<BashResult> {
    // --- Optimizer fast path ---
    if (registry && store) {
      const opt = registry.find(command, store);
      if (opt) {
        const t0 = Date.now();
        try {
          const r = await opt.execute(command, store);
          const elapsed = Date.now() - t0;
          log(
            `[optimizer] ${opt.name} handled ${JSON.stringify(
              command.slice(0, 80),
            )} in ${elapsed}ms (exit=${r.exitCode})`,
          );
          return {
            stdout: r.stdout.slice(0, maxBytes),
            stderr: r.stderr.slice(0, maxBytes),
            exitCode: r.exitCode,
          };
        } catch (e) {
          log(`[optimizer] ${opt.name} failed, falling through to bash: ${(e as Error).message}`);
          // fall through to bash
        }
      }
    }

    // --- Real bash + FUSE ---
    return spawnBash(command, { cwd, env, timeoutMs, maxBytes });
  };
}

interface SpawnOpts {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxBytes: number;
}

function spawnBash(command: string, opts: SpawnOpts): Promise<BashResult> {
  const { cwd, env, timeoutMs, maxBytes } = opts;
  return new Promise<BashResult>((resolve) => {
    const child = spawn("/bin/bash", ["-lc", command], { cwd, env });

    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.on("data", (d: Buffer) => {
      if (outBytes < maxBytes) {
        out.push(d);
        outBytes += d.length;
      }
    });
    child.stderr.on("data", (d: Buffer) => {
      if (errBytes < maxBytes) {
        err.push(d);
        errBytes += d.length;
      }
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(out).toString("utf8").slice(0, maxBytes);
      const stderr = Buffer.concat(err).toString("utf8").slice(0, maxBytes);
      const tail = killed ? `\n[killed: timeout ${timeoutMs}ms]` : "";
      resolve({
        stdout,
        stderr: stderr + tail,
        exitCode: killed ? 124 : code ?? 0,
      });
    });

    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ stdout: "", stderr: `spawn error: ${e.message}`, exitCode: 127 });
    });
  });
}
