#!/usr/bin/env tsx
/**
 * Interactive-ish shell + self-test harness for the VFS.
 *
 * Modes:
 *   --self-test     run a canned sequence of commands (used in CI)
 *   --exec "cmd"    run a single command and print stdout
 *   (default)       REPL
 */

import * as readline from "node:readline/promises";
import { SqliteVectorStore } from "../backend/sqlite.js";
import { createShell } from "../shell.js";

function parseArgs(argv: string[]) {
  const out: Record<string, string | true> = {};
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === "--self-test") {
      out["self-test"] = true;
      i++;
    } else if (a === "--exec") {
      out["exec"] = argv[i + 1] ?? "";
      i += 2;
    } else if (a === "--db") {
      out["db"] = argv[i + 1] ?? "";
      i += 2;
    } else if (a === "--mount") {
      out["mount"] = argv[i + 1] ?? "";
      i += 2;
    } else {
      i++;
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dbPath = (args["db"] as string) || "./data/vfs.db";
  const mount = (args["mount"] as string) || "/docs";

  const store = new SqliteVectorStore({ path: dbPath });
  const { bash, close } = createShell({ store, mountPoint: mount });

  const run = async (cmd: string) => {
    try {
      const r = await bash.exec(cmd);
      process.stdout.write(r.stdout);
      if (r.stderr) process.stderr.write(r.stderr);
      return r;
    } catch (e) {
      const err = e as Error & { code?: string };
      process.stderr.write(`bash: ${err.code ?? "ERROR"}: ${err.message}\n`);
      return { stdout: "", stderr: err.message, exitCode: 1 };
    }
  };

  try {
    if (args["self-test"]) {
      const cases = [
        "ls /",
        `ls ${mount}`,
        `find ${mount} -name '*.md' | head -20`,
        `find ${mount} -name '*.md' | wc -l`,
        `cat ${mount}/$(find ${mount} -name '*.md' | head -1 | xargs basename) 2>/dev/null | head -5 || true`,
        `grep -ril "introduction" ${mount}`,
        `grep -rni "the" ${mount} | head -5`,
        `echo "writable" > /tmp/x.txt && cat /tmp/x.txt`,
        `echo "should fail" > ${mount}/readonly.txt 2>&1 || echo "EROFS ok"`,
        `tree ${mount} | head -30`,
      ];
      for (const c of cases) {
        console.log(`\n$ ${c}`);
        await run(c);
      }
      return;
    }

    if (args["exec"]) {
      const cmd = args["exec"] as string;
      const r = await run(cmd);
      process.exit(r.exitCode);
    }

    // REPL
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    console.log(`vfs4Agent shell (mount=${mount}, db=${dbPath}) — type 'exit' to quit`);
    while (true) {
      const line = await rl.question("$ ");
      if (!line.trim()) continue;
      if (line === "exit" || line === "quit") break;
      await run(line);
    }
    rl.close();
  } finally {
    close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
