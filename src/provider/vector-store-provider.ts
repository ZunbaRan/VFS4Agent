/**
 * VectorStoreProvider — adapts the legacy `VectorStore` interface to the new
 * `VfsProvider` contract, so the existing Chroma / SQLite backends continue
 * to work unchanged.
 *
 * Mount prefix is configurable. During Step 2 rollout we mount this at "/" so
 * `/docs/auth/oauth.md` etc. keep their current absolute paths. Later it can
 * be remounted under e.g. "/docs" and side-by-side with other providers.
 */

import type { Chunk, PathTree, VectorStore } from "../types.js";
import {
  type DirEntry,
  type FileStat,
  type ReadResult,
  type SearchHit,
  type SearchRequest,
  type VfsContext,
  type VfsProvider,
  VfsError,
} from "./types.js";
import { normalizeAbsPath, normalizeMountPrefix } from "./paths.js";

const DEFAULT_PATH_TREE_TTL_MS = 2_000;

export interface VectorStoreProviderOpts {
  name?: string;
  mountPrefix?: string;
  pathTreeTtlMs?: number;
}

export class VectorStoreProvider implements VfsProvider {
  readonly name: string;
  readonly mountPrefix: string;

  private readonly ttl: number;
  private cache: { tree: PathTree; expires: number } | null = null;

  constructor(private readonly store: VectorStore, opts: VectorStoreProviderOpts = {}) {
    this.name = opts.name ?? "vector-store";
    this.mountPrefix = normalizeMountPrefix(opts.mountPrefix ?? "/");
    this.ttl = opts.pathTreeTtlMs ?? DEFAULT_PATH_TREE_TTL_MS;
  }

  invalidate(): void {
    this.cache = null;
  }

  async close(): Promise<void> {
    this.store.close();
  }

  // ── VfsProvider ───────────────────────────────────────────────────────────

  async readdir(subpath: string, _ctx: VfsContext): Promise<DirEntry[]> {
    const slug = this.subpathToSlug(subpath);
    const tree = await this.getTree();

    const prefix = slug === "" ? "" : slug + "/";
    const direct = new Map<string, { isDir: boolean; size?: number; mtime?: number }>();

    for (const [key, entry] of Object.entries(tree)) {
      if (!key.startsWith(prefix) && key !== slug) continue;
      if (key === slug) continue;
      const rest = key.slice(prefix.length);
      if (!rest) continue;
      const parts = rest.split("/");
      const head = parts[0];
      const isDir = parts.length > 1;
      if (!head) continue;

      if (!direct.has(head)) {
        direct.set(head, {
          isDir,
          size: isDir ? undefined : entry.size,
          mtime: entry.mtime,
        });
      } else if (!isDir && !direct.get(head)!.isDir) {
        // dedup — keep the entry with size info
        direct.set(head, { isDir: false, size: entry.size, mtime: entry.mtime });
      }
    }

    if (direct.size === 0 && slug !== "" && tree[slug] === undefined && !this.hasAnyChild(slug, tree)) {
      throw new VfsError("ENOENT", subpath);
    }

    const entries: DirEntry[] = [];
    for (const [name, meta] of direct) {
      entries.push({
        name,
        type: meta.isDir ? "dir" : "file",
        size: meta.size,
        mtime: meta.mtime,
      });
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    return entries;
  }

  async read(subpath: string, _ctx: VfsContext): Promise<ReadResult> {
    const slug = this.subpathToSlug(subpath);
    if (slug === "") throw new VfsError("EISDIR");
    const tree = await this.getTree();
    if (tree[slug] === undefined) {
      if (this.hasAnyChild(slug, tree)) throw new VfsError("EISDIR");
      throw new VfsError("ENOENT", subpath);
    }
    const chunks = await this.store.getChunksByPage(slug);
    const content = assembleChunks(chunks);
    const entry = tree[slug];
    return {
      content,
      mime: "text/markdown",
      size: entry.size ?? Buffer.byteLength(content, "utf8"),
      mtime: entry.mtime,
    };
  }

  async stat(subpath: string, _ctx: VfsContext): Promise<FileStat> {
    const slug = this.subpathToSlug(subpath);
    const tree = await this.getTree();
    if (slug === "") return { type: "dir", size: 0, mtime: Date.now() };
    if (tree[slug] !== undefined) {
      const entry = tree[slug];
      return {
        type: "file",
        size: entry.size ?? 0,
        mtime: entry.mtime ?? Date.now(),
      };
    }
    if (this.hasAnyChild(slug, tree)) {
      return { type: "dir", size: 0, mtime: Date.now() };
    }
    throw new VfsError("ENOENT", subpath);
  }

  async search(req: SearchRequest, _ctx: VfsContext): Promise<SearchHit[] | null> {
    if (!this.store.capabilities?.supportsTextSearch) return null;

    const pathPrefix = this.subpathToSlug(req.subpath);
    const slugs = await this.store.searchText({
      pattern: req.query,
      regex: req.regex ?? false,
      ignoreCase: req.caseInsensitive ?? false,
      pathPrefix: pathPrefix || undefined,
      limit: req.maxHits ?? 500,
    });
    // searchText is a coarse filter — we return one synthetic hit per page so
    // the router can report the file, and the fuse `read` pass (or the caller's
    // own grep) will produce the real line numbers.
    return slugs.map((slug) => ({
      path: "/" + slug,
      snippet: "(matched page — open with `cat` for lines)",
    }));
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private subpathToSlug(subpath: string): string {
    const abs = normalizeAbsPath(subpath);
    return abs === "/" ? "" : abs.slice(1);
  }

  private async getTree(): Promise<PathTree> {
    const now = Date.now();
    if (this.cache && this.cache.expires > now) return this.cache.tree;
    const tree = await this.store.getPathTree();
    this.cache = { tree, expires: now + this.ttl };
    return tree;
  }

  private hasAnyChild(slug: string, tree: PathTree): boolean {
    if (slug === "") return Object.keys(tree).length > 0;
    const prefix = slug + "/";
    for (const key of Object.keys(tree)) {
      if (key.startsWith(prefix)) return true;
    }
    return false;
  }
}

function assembleChunks(chunks: Chunk[]): string {
  if (chunks.length === 0) return "";
  return [...chunks]
    .sort((a, b) => a.chunk_index - b.chunk_index)
    .map((c) => c.content)
    .join("");
}
