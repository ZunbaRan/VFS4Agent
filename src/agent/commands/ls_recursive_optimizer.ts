/**
 * LsRecursiveOptimizer — intercepts `ls -R`, `ls -lR`, `ls -laR` on /vfs.
 * Plain non-recursive `ls /vfs/docs` is already fast via FUSE (single readdir),
 * so we only optimize the recursive variant.
 */

import type { CommandOptimizer, CommandResult } from "./types.js";
import type { VectorStore } from "../../types.js";
import {
  basename,
  isDirectoryInTree,
  slugUnderPrefix,
  vfsPathToPrefix,
} from "./helpers.js";
import type { PathTree, PathTreeEntry } from "../../types.js";

interface ParsedLs {
  flags: string;
  vfsPath: string;
}

function parseLsCommand(cmd: string): ParsedLs | null {
  const tokens = cmd.split(/\s+/).filter(Boolean);
  if (tokens[0] !== "ls") return null;

  let flags = "";
  let vfsPath: string | null = null;
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.startsWith("--")) return null; // long options unsupported
    if (t.startsWith("-")) {
      const ff = t.slice(1);
      if (!/^[laRhH]+$/.test(ff)) return null;
      flags += ff;
      continue;
    }
    if (t.startsWith("/vfs")) {
      if (vfsPath !== null) return null; // multiple paths unsupported
      vfsPath = t;
      continue;
    }
    return null;
  }
  if (!flags.includes("R")) return null; // only optimize recursive form
  if (!vfsPath) return null;
  return { flags, vfsPath };
}

function formatMtime(mtime?: number): string {
  if (!mtime) return "Jan  1  1970";
  const d = new Date(mtime);
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  const mon = months[d.getUTCMonth()];
  const day = String(d.getUTCDate()).padStart(2, " ");
  const year = d.getUTCFullYear();
  return `${mon} ${day}  ${year}`;
}

function groupByDir(
  tree: PathTree,
  prefix: string,
): Map<string, Array<{ name: string; slug: string; entry: PathTreeEntry; isDir: boolean }>> {
  const groups = new Map<
    string,
    Array<{ name: string; slug: string; entry: PathTreeEntry; isDir: boolean }>
  >();

  // Collect all descendant slugs (and their parent dirs) under prefix
  const seen = new Set<string>();
  const queue = new Set<string>([prefix]);
  for (const slug of Object.keys(tree)) {
    if (!slugUnderPrefix(slug, prefix)) continue;
    seen.add(slug);
    // Ensure intermediate dirs are emitted too
    let cursor = slug;
    while (cursor && cursor !== prefix) {
      const i = cursor.lastIndexOf("/");
      if (i < 0) break;
      cursor = cursor.slice(0, i);
      if (!cursor) break;
      queue.add(cursor);
    }
  }

  for (const slug of seen) {
    const i = slug.lastIndexOf("/");
    const parent = i < 0 ? "" : slug.slice(0, i);
    const entry = tree[slug] ?? {};
    const isDir = isDirectoryInTree(slug, tree);
    if (!groups.has(parent)) groups.set(parent, []);
    groups.get(parent)!.push({ name: basename(slug), slug, entry, isDir });
  }

  // Make sure every dir we discovered (even intermediate ones) is keyed
  for (const dirSlug of queue) {
    if (!groups.has(dirSlug)) groups.set(dirSlug, []);
  }

  return groups;
}

export class LsRecursiveOptimizer implements CommandOptimizer {
  readonly name = "ls-recursive-optimizer";

  match(command: string): boolean {
    if (!command.startsWith("ls ")) return false;
    if (!command.includes("/vfs")) return false;
    return parseLsCommand(command) !== null;
  }

  async execute(command: string, store: VectorStore): Promise<CommandResult> {
    const parsed = parseLsCommand(command);
    if (!parsed) {
      return { stdout: "", stderr: "ls: failed to parse command\n", exitCode: 1 };
    }

    const tree = await store.getPathTree();
    const prefix = vfsPathToPrefix(parsed.vfsPath);
    const longFormat = parsed.flags.includes("l");
    const groups = groupByDir(tree, prefix);

    // Order directory listings depth-first, alphabetically
    const orderedDirs = [...groups.keys()].sort((a, b) => {
      const da = a === "" ? 0 : a.split("/").length;
      const db = b === "" ? 0 : b.split("/").length;
      return da - db || a.localeCompare(b);
    });

    const out: string[] = [];
    for (const dir of orderedDirs) {
      const header = `/vfs${dir ? "/" + dir : ""}:`;
      if (out.length > 0) out.push("");
      out.push(header);

      const entries = (groups.get(dir) ?? []).slice().sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

      if (!longFormat) {
        if (entries.length > 0) out.push(entries.map((e) => e.name).join("  "));
        continue;
      }

      for (const e of entries) {
        const perms = e.isDir ? "drwxr-xr-x" : "-rw-r--r--";
        const size = String(e.isDir ? 4096 : e.entry.size ?? 0).padStart(7);
        const mtime = formatMtime(e.entry.mtime);
        out.push(`${perms} 1 root root ${size} ${mtime} ${e.name}`);
      }
    }

    return {
      stdout: out.join("\n") + "\n",
      stderr: "",
      exitCode: 0,
    };
  }
}
