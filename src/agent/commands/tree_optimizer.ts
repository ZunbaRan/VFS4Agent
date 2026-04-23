/**
 * TreeOptimizer — intercepts `tree [-L N] [/vfs/path]` and renders from
 * PathTree. Uses no database calls (PathTree is already cached by the store).
 */

import type { CommandOptimizer, CommandResult } from "./types.js";
import type { VectorStore } from "../../types.js";
import {
  buildTreeStructure,
  countEntries,
  formatTree,
  vfsPathToPrefix,
} from "./helpers.js";

interface ParsedTree {
  vfsPath: string;
  maxDepth: number;
}

function parseTreeCommand(cmd: string): ParsedTree | null {
  // Forms: tree | tree /vfs/x | tree -L 2 /vfs/x | tree /vfs/x -L 2
  const tokens = cmd.split(/\s+/).filter(Boolean);
  if (tokens[0] !== "tree") return null;

  let vfsPath = "/vfs";
  let maxDepth = Infinity;

  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === "-L" && i + 1 < tokens.length) {
      const v = Number(tokens[++i]);
      if (!Number.isFinite(v) || v < 1) return null;
      maxDepth = Math.floor(v);
      continue;
    }
    if (t.startsWith("/vfs")) {
      vfsPath = t;
      continue;
    }
    // Unsupported flag (e.g. -a, -p, -s, -i, --json)
    if (t.startsWith("-")) return null;
  }

  return { vfsPath, maxDepth };
}

export class TreeOptimizer implements CommandOptimizer {
  readonly name = "tree-optimizer";

  match(command: string): boolean {
    if (!command.startsWith("tree")) return false;
    if (command !== "tree" && !command.startsWith("tree ")) return false;
    return parseTreeCommand(command) !== null;
  }

  async execute(command: string, store: VectorStore): Promise<CommandResult> {
    const parsed = parseTreeCommand(command);
    if (!parsed) {
      return { stdout: "", stderr: "tree: failed to parse command\n", exitCode: 1 };
    }

    const tree = await store.getPathTree();
    const prefix = vfsPathToPrefix(parsed.vfsPath);
    const root = buildTreeStructure(tree, prefix, parsed.maxDepth);
    const body = formatTree(root);
    const stats = countEntries(root);

    return {
      stdout: `${body}\n\n${stats.directories} directories, ${stats.files} files\n`,
      stderr: "",
      exitCode: 0,
    };
  }
}
