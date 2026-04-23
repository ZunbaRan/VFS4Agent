/**
 * FUSE-layer helpers: path translation, PathTree directory probing, chunk
 * assembly. These are pure helpers — they don't open any FUSE handles.
 */

import type { Chunk, PathTree } from "../types.js";

/**
 * Convert a FUSE absolute path (e.g. "/docs/auth/oauth.md") to a VectorStore
 * slug (e.g. "docs/auth/oauth.md"). The slug never has a leading slash.
 */
export function fusePathToSlug(path: string): string {
  if (!path || path === "/") return "";
  return path.startsWith("/") ? path.slice(1) : path;
}

/**
 * True iff the given slug refers to a directory (i.e. some PathTree entry
 * key is strictly nested under it). Empty slug ("/") is always a directory.
 */
export function isDirectoryInTree(slug: string, tree: PathTree): boolean {
  if (slug === "") return true;
  const prefix = slug + "/";
  for (const key of Object.keys(tree)) {
    if (key === slug) continue;
    if (key.startsWith(prefix)) return true;
  }
  return false;
}

/**
 * Direct children (one level deep) of `slug` in the PathTree.
 * Returns deduplicated names (without parent prefix).
 */
export function getDirectoryEntries(slug: string, tree: PathTree): string[] {
  const prefix = slug === "" ? "" : slug + "/";
  const out = new Set<string>();
  for (const key of Object.keys(tree)) {
    if (!key.startsWith(prefix)) continue;
    const rest = key.slice(prefix.length);
    if (!rest) continue;
    const head = rest.split("/")[0];
    if (head) out.add(head);
  }
  return Array.from(out);
}

/**
 * Assemble a list of chunks (already ordered by chunk_index) into a single
 * UTF-8 string representing the page contents.
 */
export function assembleChunks(chunks: Chunk[]): string {
  if (chunks.length === 0) return "";
  const sorted = [...chunks].sort((a, b) => a.chunk_index - b.chunk_index);
  return sorted.map((c) => c.content).join("");
}

/**
 * Compute size in bytes of a UTF-8 string.
 */
export function utf8ByteLength(s: string): number {
  return Buffer.byteLength(s, "utf8");
}
