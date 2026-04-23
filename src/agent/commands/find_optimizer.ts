/**
 * FindOptimizer — intercepts `find /vfs/... [-name PATTERN] [-type f|d]`
 * and resolves against PathTree (in-memory) instead of recursing via FUSE.
 *
 * Supported forms:
 *   find /vfs/docs
 *   find /vfs/docs -name "*.md"
 *   find /vfs/docs -type f
 *   find /vfs/docs -name "*.md" -type f
 *   (flags in any order)
 *
 * Unsupported (falls through to FUSE):
 *   -exec, -mtime, -size, -maxdepth, -regex, -print0, etc.
 */

import type { CommandOptimizer, CommandResult } from "./types.js";
import type { VectorStore } from "../../types.js";
import {
  basename,
  globMatch,
  isDirectoryInTree,
  iterateSlugsUnder,
  slugUnderPrefix,
  vfsPathToPrefix,
} from "./helpers.js";

interface ParsedFind {
  vfsPath: string;
  namePattern?: string;
  type?: "f" | "d";
}

function parseFindCommand(cmd: string): ParsedFind | null {
  // Split tokens respecting simple quotes
  const tokens = tokenize(cmd);
  if (tokens[0] !== "find") return null;
  if (!tokens[1]?.startsWith("/vfs")) return null;

  const out: ParsedFind = { vfsPath: tokens[1] };
  for (let i = 2; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === "-name" && i + 1 < tokens.length) {
      out.namePattern = tokens[++i];
      continue;
    }
    if (t === "-type" && i + 1 < tokens.length) {
      const v = tokens[++i];
      if (v !== "f" && v !== "d") return null;
      out.type = v;
      continue;
    }
    // Any other flag -> unsupported
    return null;
  }
  return out;
}

function tokenize(cmd: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cmd)) !== null) {
    out.push(m[1] ?? m[2] ?? m[3]);
  }
  return out;
}

export class FindOptimizer implements CommandOptimizer {
  readonly name = "find-optimizer";
  // No required capabilities — PathTree is always present.

  match(command: string): boolean {
    if (!command.startsWith("find ")) return false;
    if (!command.includes("/vfs")) return false;
    return parseFindCommand(command) !== null;
  }

  async execute(command: string, store: VectorStore): Promise<CommandResult> {
    const parsed = parseFindCommand(command);
    if (!parsed) {
      return { stdout: "", stderr: "find: failed to parse command\n", exitCode: 1 };
    }

    const tree = await store.getPathTree();
    const prefix = vfsPathToPrefix(parsed.vfsPath);

    const out: string[] = [];
    // Include the prefix itself if it's a valid directory (emulates GNU find)
    const prefixIsDir = prefix === "" || isDirectoryInTree(prefix, tree);
    if (prefixIsDir && (!parsed.type || parsed.type === "d")) {
      if (!parsed.namePattern || globMatch(basename(prefix) || "/", parsed.namePattern)) {
        out.push(`/vfs${prefix ? "/" + prefix : ""}`);
      }
    }

    for (const slug of iterateSlugsUnder(tree, prefix, { includeDirs: true })) {
      if (slug === prefix) continue;
      if (!slugUnderPrefix(slug, prefix)) continue;

      const isDir = isDirectoryInTree(slug, tree);
      if (parsed.type === "f" && isDir) continue;
      if (parsed.type === "d" && !isDir) continue;
      if (parsed.namePattern && !globMatch(basename(slug), parsed.namePattern)) continue;

      out.push(`/vfs/${slug}`);
    }

    out.sort();
    return {
      stdout: out.length ? out.join("\n") + "\n" : "",
      stderr: "",
      exitCode: 0,
    };
  }
}
