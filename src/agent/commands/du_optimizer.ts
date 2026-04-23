/**
 * DuOptimizer — intercepts `du [-s] [-h] /vfs/...` and sums PathTreeEntry.size.
 *
 * Supported:
 *   du /vfs/docs           (per-directory totals, 1K blocks)
 *   du -s /vfs/docs        (summary only)
 *   du -sh /vfs/docs       (summary, human-readable)
 *   du -h /vfs/docs        (per-directory, human)
 *
 * Unsupported (fall through to FUSE): -a, -c, -d, --max-depth, etc.
 */

import type { CommandOptimizer, CommandResult } from "./types.js";
import type { VectorStore } from "../../types.js";
import {
  humanSize,
  isDirectoryInTree,
  slugUnderPrefix,
  vfsPathToPrefix,
} from "./helpers.js";

interface ParsedDu {
  flags: string;
  vfsPath: string;
}

function parseDuCommand(cmd: string): ParsedDu | null {
  const tokens = cmd.split(/\s+/).filter(Boolean);
  if (tokens[0] !== "du") return null;
  let flags = "";
  let vfsPath: string | null = null;
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.startsWith("--")) return null;
    if (t.startsWith("-")) {
      const ff = t.slice(1);
      if (!/^[sh]+$/.test(ff)) return null;
      flags += ff;
      continue;
    }
    if (t.startsWith("/vfs")) {
      if (vfsPath !== null) return null;
      vfsPath = t;
      continue;
    }
    return null;
  }
  if (!vfsPath) return null;
  return { flags, vfsPath };
}

function formatSize(bytes: number, human: boolean): string {
  if (human) return humanSize(bytes);
  return String(Math.max(1, Math.ceil(bytes / 1024)));
}

export class DuOptimizer implements CommandOptimizer {
  readonly name = "du-optimizer";
  readonly requiredCapabilities = ["hasByteSizes"];

  match(command: string): boolean {
    if (!command.startsWith("du ")) return false;
    if (!command.includes("/vfs")) return false;
    return parseDuCommand(command) !== null;
  }

  async execute(command: string, store: VectorStore): Promise<CommandResult> {
    const parsed = parseDuCommand(command);
    if (!parsed) {
      return { stdout: "", stderr: "du: failed to parse command\n", exitCode: 1 };
    }

    const tree = await store.getPathTree();
    const prefix = vfsPathToPrefix(parsed.vfsPath);
    const human = parsed.flags.includes("h");
    const summaryOnly = parsed.flags.includes("s");

    // Accumulate per-directory sizes (sum of descendants)
    const dirTotals = new Map<string, number>();
    let grandTotal = 0;

    for (const slug of Object.keys(tree)) {
      if (!slugUnderPrefix(slug, prefix)) continue;
      if (isDirectoryInTree(slug, tree)) continue; // only files count
      const size = tree[slug].size ?? 0;
      grandTotal += size;

      // Walk ancestors up to prefix
      let cursor = slug;
      while (true) {
        const i = cursor.lastIndexOf("/");
        const parent = i < 0 ? "" : cursor.slice(0, i);
        dirTotals.set(parent, (dirTotals.get(parent) ?? 0) + size);
        if (parent === prefix || parent === "") break;
        cursor = parent;
      }
    }

    const out: string[] = [];
    if (summaryOnly) {
      out.push(`${formatSize(grandTotal, human)}\t/vfs${prefix ? "/" + prefix : ""}`);
    } else {
      const dirs = [...dirTotals.keys()].sort();
      for (const d of dirs) {
        if (!slugUnderPrefix(d, prefix)) continue;
        out.push(`${formatSize(dirTotals.get(d) ?? 0, human)}\t/vfs${d ? "/" + d : ""}`);
      }
      if (out.length === 0) {
        out.push(`${formatSize(0, human)}\t/vfs${prefix ? "/" + prefix : ""}`);
      }
    }

    return {
      stdout: out.join("\n") + "\n",
      stderr: "",
      exitCode: 0,
    };
  }
}
