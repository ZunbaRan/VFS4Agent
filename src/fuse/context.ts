/**
 * Shared mutable state for FUSE operations.
 *
 * Holds:
 *  - VectorStore reference
 *  - PathTree cache (refreshed lazily; readdir/getattr both touch it)
 *  - Open-file table (fd -> buffered content + write flag)
 */

import { LRUCache } from "lru-cache";
import type { PathTree, VectorStore } from "../types.js";

export interface OpenHandle {
  path: string;
  /** Current contents (full file) — used for both read and write paths. */
  content: string;
  /** True when the fd was opened for writing (we may need to commit on release). */
  writable: boolean;
  /** True iff this fd is a /search/last_query write handle. */
  searchQueryWrite: boolean;
}

export interface FuseContext {
  store: VectorStore;
  /** Time-to-live (ms) for the cached PathTree. */
  pathTreeTtlMs: number;
}

const PATH_TREE_TTL_MS = 2_000;

let pathTreeCache: { tree: PathTree; expires: number } | null = null;

let nextFd = 100; // start above stdio
const handles = new Map<number, OpenHandle>();

const contentCache = new LRUCache<string, string>({ max: 256 });

let ctx: FuseContext | null = null;

export function initContext(store: VectorStore): FuseContext {
  ctx = { store, pathTreeTtlMs: PATH_TREE_TTL_MS };
  return ctx;
}

export function getContext(): FuseContext {
  if (!ctx) throw new Error("FUSE context not initialized");
  return ctx;
}

export async function getPathTree(forceRefresh = false): Promise<PathTree> {
  const now = Date.now();
  if (!forceRefresh && pathTreeCache && pathTreeCache.expires > now) {
    return pathTreeCache.tree;
  }
  const tree = await getContext().store.getPathTree();
  pathTreeCache = { tree, expires: now + getContext().pathTreeTtlMs };
  return tree;
}

export function invalidatePathTree(): void {
  pathTreeCache = null;
}

/** Cache assembled file content keyed by slug. */
export function getCachedContent(slug: string): string | undefined {
  return contentCache.get(slug);
}

export function setCachedContent(slug: string, content: string): void {
  contentCache.set(slug, content);
}

export function allocHandle(handle: OpenHandle): number {
  const fd = nextFd++;
  handles.set(fd, handle);
  return fd;
}

export function getHandle(fd: number): OpenHandle | undefined {
  return handles.get(fd);
}

export function freeHandle(fd: number): OpenHandle | undefined {
  const h = handles.get(fd);
  handles.delete(fd);
  return h;
}
