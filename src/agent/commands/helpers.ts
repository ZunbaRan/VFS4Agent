/**
 * Shared helpers for Command Optimizers.
 */

import type { PathTree, PathTreeEntry } from "../../types.js";
import { isDirectoryInTree } from "../../fuse/helpers.js";

export { isDirectoryInTree };

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/**
 * Strip the /vfs/ prefix and trailing slashes. Returns "" for /vfs or /vfs/.
 */
export function vfsPathToPrefix(p: string): string {
  let s = p;
  if (s.startsWith("/vfs")) s = s.slice(4);
  if (s.startsWith("/")) s = s.slice(1);
  return s.replace(/\/+$/, "");
}

/**
 * True iff slug is under prefix (inclusive).
 *   slugUnderPrefix("docs/auth/oauth.md", "docs")     -> true
 *   slugUnderPrefix("docs/auth/oauth.md", "docs/auth")-> true
 *   slugUnderPrefix("docs/auth/oauth.md", "")         -> true (root)
 *   slugUnderPrefix("docs/auth", "docs/auth")         -> true
 *   slugUnderPrefix("docs/authors", "docs/auth")      -> false
 */
export function slugUnderPrefix(slug: string, prefix: string): boolean {
  if (!prefix) return true;
  if (slug === prefix) return true;
  return slug.startsWith(prefix + "/");
}

// ---------------------------------------------------------------------------
// Glob matching (shell-style, not full POSIX)
// ---------------------------------------------------------------------------

/**
 * Minimal glob matcher supporting *, ?, [abc], [a-z].
 * Used by find -name patterns (which match basenames only, no `/`).
 */
export function globMatch(name: string, pattern: string): boolean {
  const re = globToRegExp(pattern);
  return re.test(name);
}

function globToRegExp(pattern: string): RegExp {
  let re = "^";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") re += ".*";
    else if (c === "?") re += ".";
    else if (c === "[") {
      const end = pattern.indexOf("]", i + 1);
      if (end < 0) {
        re += "\\[";
      } else {
        re += "[" + pattern.slice(i + 1, end).replace(/\\/g, "\\\\") + "]";
        i = end;
      }
    } else if (".\\+^$(){}|".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  re += "$";
  return new RegExp(re);
}

// ---------------------------------------------------------------------------
// Human size
// ---------------------------------------------------------------------------

/**
 * Format bytes as human-readable (BSD du -h style: integer + suffix).
 */
export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  const units = ["K", "M", "G", "T"];
  let size = bytes / 1024;
  let u = 0;
  while (size >= 1024 && u < units.length - 1) {
    size /= 1024;
    u++;
  }
  if (size >= 10) return `${Math.round(size)}${units[u]}`;
  return `${size.toFixed(1)}${units[u]}`;
}

// ---------------------------------------------------------------------------
// Tree building / formatting
// ---------------------------------------------------------------------------

export interface TreeNode {
  name: string;
  slug: string;
  isDir: boolean;
  children: TreeNode[];
}

/**
 * Build a nested tree rooted at `prefix` from a flat PathTree.
 * Depth is counted from the prefix (0 = prefix itself).
 */
export function buildTreeStructure(tree: PathTree, prefix: string, maxDepth: number): TreeNode {
  const root: TreeNode = {
    name: prefix || "/",
    slug: prefix,
    isDir: true,
    children: [],
  };
  // Map slug -> node for O(1) inserts
  const index = new Map<string, TreeNode>();
  index.set(prefix, root);

  // Collect all descendant slugs under prefix (including intermediate dirs)
  const candidates = new Set<string>();
  for (const slug of Object.keys(tree)) {
    if (!slugUnderPrefix(slug, prefix)) continue;
    candidates.add(slug);
    // Walk parent chain up to prefix so intermediate dirs are included
    let cursor = slug;
    while (cursor && cursor !== prefix) {
      const idx = cursor.lastIndexOf("/");
      if (idx < 0) break;
      cursor = cursor.slice(0, idx);
      if (!cursor || cursor === prefix) break;
      candidates.add(cursor);
    }
  }

  // Sort by depth so parents exist before children
  const sorted = [...candidates].sort((a, b) => {
    const da = a.split("/").length;
    const db = b.split("/").length;
    return da - db || a.localeCompare(b);
  });

  for (const slug of sorted) {
    const parentIdx = slug.lastIndexOf("/");
    const parentSlug = parentIdx < 0 ? "" : slug.slice(0, parentIdx);
    const parent = index.get(parentSlug) ?? root;

    // Enforce max depth
    const depthFromRoot = depthBetween(prefix, slug);
    if (depthFromRoot > maxDepth) continue;

    const isDir = isDirectoryInTree(slug, tree);
    const node: TreeNode = {
      name: slug.slice(parentSlug ? parentSlug.length + 1 : 0),
      slug,
      isDir,
      children: [],
    };
    parent.children.push(node);
    index.set(slug, node);
  }

  // Sort children alphabetically
  const sortChildren = (n: TreeNode): void => {
    n.children.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const c of n.children) sortChildren(c);
  };
  sortChildren(root);

  return root;
}

function depthBetween(prefix: string, slug: string): number {
  if (!prefix) return slug.split("/").length;
  if (slug === prefix) return 0;
  const rest = slug.slice(prefix.length + 1); // skip trailing "/"
  return rest.split("/").length;
}

/**
 * Render a tree node as ASCII (mimics GNU `tree` output).
 */
export function formatTree(root: TreeNode): string {
  const lines: string[] = [`/vfs/${root.slug}`.replace(/\/$/, "") || "/vfs"];
  walk(root, "", lines);
  return lines.join("\n");
}

function walk(node: TreeNode, prefix: string, out: string[]): void {
  const n = node.children.length;
  for (let i = 0; i < n; i++) {
    const child = node.children[i];
    const last = i === n - 1;
    const connector = last ? "└── " : "├── ";
    out.push(prefix + connector + child.name);
    if (child.isDir && child.children.length > 0) {
      walk(child, prefix + (last ? "    " : "│   "), out);
    }
  }
}

/**
 * Count dirs/files in a tree (root itself is counted as a directory).
 */
export function countEntries(root: TreeNode): { directories: number; files: number } {
  let directories = 0;
  let files = 0;
  const visit = (n: TreeNode, isRoot: boolean): void => {
    if (n.isDir) {
      if (!isRoot) directories += 1;
    } else {
      files += 1;
    }
    for (const c of n.children) visit(c, false);
  };
  visit(root, true);
  return { directories, files };
}

// ---------------------------------------------------------------------------
// Flat iteration helpers (used by find / wc / du / ls -R)
// ---------------------------------------------------------------------------

/**
 * All slugs under prefix (inclusive). Ordered alphabetically.
 * Optionally includes intermediate directory slugs (even if not in PathTree).
 */
export function iterateSlugsUnder(
  tree: PathTree,
  prefix: string,
  opts: { includeDirs?: boolean } = {},
): string[] {
  const out = new Set<string>();
  for (const slug of Object.keys(tree)) {
    if (!slugUnderPrefix(slug, prefix)) continue;
    out.add(slug);
    if (opts.includeDirs) {
      let cursor = slug;
      while (cursor && cursor !== prefix) {
        const idx = cursor.lastIndexOf("/");
        if (idx < 0) break;
        cursor = cursor.slice(0, idx);
        if (!cursor || cursor === prefix) break;
        out.add(cursor);
      }
      if (prefix) out.add(prefix);
    }
  }
  return [...out].sort();
}

/**
 * Basename of a slug.
 */
export function basename(slug: string): string {
  const i = slug.lastIndexOf("/");
  return i < 0 ? slug : slug.slice(i + 1);
}

export type { PathTreeEntry };
