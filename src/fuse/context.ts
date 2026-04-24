/**
 * Shared mutable state for FUSE operations.
 *
 * After the Provider-plugin refactor:
 *   - the sole data source is a `MountRouter` (holding one or more providers)
 *   - per-slug content cache + open-file table live here
 *   - there is no longer a FUSE-level PathTree cache; each VectorStoreProvider
 *     owns its own tree cache internally.
 */

import { LRUCache } from "lru-cache";
import type { MountRouter } from "../provider/router.js";
import { anonymousContext, type VfsContext } from "../provider/types.js";

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
  router: MountRouter;
  /** Default VfsContext used when no session info is available. */
  defaultVfsContext: VfsContext;
}

let nextFd = 100; // start above stdio
const handles = new Map<number, OpenHandle>();

const contentCache = new LRUCache<string, string>({ max: 256 });

let ctx: FuseContext | null = null;

export function initContext(router: MountRouter): FuseContext {
  ctx = { router, defaultVfsContext: anonymousContext("fuse") };
  return ctx;
}

export function getContext(): FuseContext {
  if (!ctx) throw new Error("FUSE context not initialized");
  return ctx;
}

export function getRouter(): MountRouter {
  return getContext().router;
}

export function getVfsContext(): VfsContext {
  return getContext().defaultVfsContext;
}

/** Cache assembled file content keyed by absolute VFS path. */
export function getCachedContent(absPath: string): string | undefined {
  return contentCache.get(absPath);
}

export function setCachedContent(absPath: string, content: string): void {
  contentCache.set(absPath, content);
}

export function invalidateContentCache(): void {
  contentCache.clear();
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
