/**
 * Bash adapter — runs commands in a real /bin/bash subprocess rooted at the
 * mount point. Used by the OpenAI function-calling REPL.
 */

import { spawn } from "node:child_process";

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
}

export function createBashRunner(opts: BashOptions) {
  const cwd = opts.cwd;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const maxBytes = opts.maxBytes ?? 64 * 1024;
  const env = opts.env ?? process.env;

  return async function exec(command: string): Promise<BashResult> {
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
  };
}
