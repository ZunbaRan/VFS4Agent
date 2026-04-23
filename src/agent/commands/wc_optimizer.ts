/**
 * WcOptimizer — intercepts `wc -l|-c|-lc /vfs/file.md [/vfs/more.md ...]`
 * and answers from PathTreeEntry.lines / .size metadata (zero DB reads).
 *
 * Supported:  wc -l, wc -c, wc -lc, wc -l /path, wc -c /a /b
 * Unsupported (falls through to FUSE): -w (word count), -m (char count),
 *                                       wc without flags, glob patterns.
 */

import type { CommandOptimizer, CommandResult } from "./types.js";
import type { VectorStore } from "../../types.js";
import { isDirectoryInTree, vfsPathToPrefix } from "./helpers.js";

interface ParsedWc {
  flags: string; // e.g. "l", "c", "lc"
  paths: string[]; // absolute /vfs/... paths
}

function parseWcCommand(cmd: string): ParsedWc | null {
  const tokens = cmd.split(/\s+/).filter(Boolean);
  if (tokens[0] !== "wc") return null;

  let flags = "";
  const paths: string[] = [];
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.startsWith("-") && !t.startsWith("--")) {
      const ff = t.slice(1);
      if (!/^[lc]+$/.test(ff)) return null;
      flags += ff;
    } else if (t.startsWith("/vfs/")) {
      paths.push(t);
    } else {
      return null; // unknown token
    }
  }
  if (!flags) return null;
  if (paths.length === 0) return null;
  return { flags, paths };
}

function pad(n: number): string {
  return String(n).padStart(7);
}

export class WcOptimizer implements CommandOptimizer {
  readonly name = "wc-optimizer";
  readonly requiredCapabilities = ["hasLineCounts", "hasByteSizes"];

  match(command: string): boolean {
    if (!command.startsWith("wc ")) return false;
    if (!command.includes("/vfs/")) return false;
    return parseWcCommand(command) !== null;
  }

  async execute(command: string, store: VectorStore): Promise<CommandResult> {
    const parsed = parseWcCommand(command);
    if (!parsed) {
      return { stdout: "", stderr: "wc: failed to parse command\n", exitCode: 1 };
    }

    const tree = await store.getPathTree();
    const showLines = parsed.flags.includes("l");
    const showBytes = parsed.flags.includes("c");

    const rows: Array<{ lines: number; bytes: number; path: string }> = [];
    const errors: string[] = [];
    let totalLines = 0;
    let totalBytes = 0;

    for (const vfsPath of parsed.paths) {
      const slug = vfsPathToPrefix(vfsPath);
      const entry = tree[slug];
      if (!entry || isDirectoryInTree(slug, tree)) {
        errors.push(`wc: ${vfsPath}: No such file or directory`);
        continue;
      }
      const lines = entry.lines ?? 0;
      const bytes = entry.size ?? 0;
      totalLines += lines;
      totalBytes += bytes;
      rows.push({ lines, bytes, path: vfsPath });
    }

    if (rows.length === 0) {
      return {
        stdout: "",
        stderr: errors.join("\n") + (errors.length ? "\n" : ""),
        exitCode: 1,
      };
    }

    const fmtRow = (lines: number, bytes: number, path: string): string => {
      const parts: string[] = [];
      if (showLines) parts.push(pad(lines));
      if (showBytes) parts.push(pad(bytes));
      if (path) parts.push(path);
      return parts.join(" ");
    };

    const lines = rows.map((r) => fmtRow(r.lines, r.bytes, r.path));
    if (rows.length > 1) {
      lines.push(fmtRow(totalLines, totalBytes, "total"));
    }

    return {
      stdout: lines.join("\n") + "\n",
      stderr: errors.join("\n") + (errors.length ? "\n" : ""),
      exitCode: errors.length ? 1 : 0,
    };
  }
}
