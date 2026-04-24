/**
 * MountRouter — dispatches VfsProvider calls based on path prefix.
 *
 * The router itself implements `VfsProvider` so the FUSE layer can depend on a
 * single object regardless of how many backends are mounted.
 *
 * Root behavior (path === "/"):
 *   - readdir(): returns one directory entry per mounted provider
 *   - read():    ENOENT (root is a directory)
 *   - stat():    fixed dir stat
 *   - search():  fan out to every provider, concatenate hits
 *
 * Dispatch for anything deeper: find the longest matching `mountPrefix`, strip
 * it, and forward the remaining subpath to that provider.
 *
 * Error translation:
 *   - `VfsError` rethrows unchanged
 *   - anything else becomes `VfsError("EIO", provider.name + ": " + msg)`
 */

import {
  type DirEntry,
  type FileStat,
  type ReadResult,
  type SearchHit,
  type SearchRequest,
  type VfsContext,
  type VfsProvider,
  VfsError,
  isVfsError,
} from "./types.js";
import { joinMount, matchMount, normalizeAbsPath, normalizeMountPrefix, topSegment } from "./paths.js";

const ROOT_MTIME = Date.now();

export class MountRouter implements VfsProvider {
  readonly name = "mount-router";
  readonly mountPrefix = "";

  private readonly providers = new Map<string, VfsProvider>(); // key = normalized mountPrefix

  /** Register a provider. Throws if its mountPrefix is already taken. */
  mount(provider: VfsProvider): void {
    const mp = normalizeMountPrefix(provider.mountPrefix);
    if (mp === "") {
      // Single-root mount — only allowed when the router is empty.
      if (this.providers.size > 0) {
        throw new Error(
          `cannot mount ${provider.name} at "/" while other providers are mounted`,
        );
      }
      this.providers.set("", provider);
      return;
    }
    if (this.providers.has(mp)) {
      throw new Error(`mount prefix ${mp} already occupied by ${this.providers.get(mp)!.name}`);
    }
    if (this.providers.has("")) {
      throw new Error(`cannot mount ${provider.name} at ${mp} while a root provider is mounted`);
    }
    this.providers.set(mp, provider);
  }

  unmount(name: string): void {
    for (const [mp, p] of this.providers) {
      if (p.name === name) {
        this.providers.delete(mp);
        return;
      }
    }
  }

  list(): { name: string; mountPrefix: string }[] {
    return Array.from(this.providers.values()).map((p) => ({
      name: p.name,
      mountPrefix: p.mountPrefix,
    }));
  }

  async close(): Promise<void> {
    await Promise.allSettled(
      Array.from(this.providers.values()).map((p) => p.close?.()),
    );
  }

  // ── VfsProvider implementation ────────────────────────────────────────────

  async readdir(absPath: string, ctx: VfsContext): Promise<DirEntry[]> {
    const abs = normalizeAbsPath(absPath);

    // Root mount (single provider at "/") — transparent passthrough.
    const root = this.providers.get("");
    if (root) return this.dispatch(root, "readdir", abs, ctx);

    if (abs === "/") {
      return Array.from(this.providers.values()).map((p) => ({
        name: topSegment(p.mountPrefix),
        type: "dir",
      }));
    }

    const m = matchMount(abs, this.providers.keys());
    if (!m) throw new VfsError("ENOENT", `no mount for ${abs}`);
    return this.dispatch(this.providers.get(m.mountPrefix)!, "readdir", m.subpath, ctx);
  }

  async read(absPath: string, ctx: VfsContext): Promise<ReadResult> {
    const abs = normalizeAbsPath(absPath);
    const root = this.providers.get("");
    if (root) return this.dispatch(root, "read", abs, ctx);

    if (abs === "/") throw new VfsError("EISDIR");
    const m = matchMount(abs, this.providers.keys());
    if (!m) throw new VfsError("ENOENT", `no mount for ${abs}`);
    return this.dispatch(this.providers.get(m.mountPrefix)!, "read", m.subpath, ctx);
  }

  async stat(absPath: string, ctx: VfsContext): Promise<FileStat> {
    const abs = normalizeAbsPath(absPath);
    const root = this.providers.get("");
    if (root) return this.dispatch(root, "stat", abs, ctx);

    if (abs === "/") {
      return { type: "dir", size: 0, mtime: ROOT_MTIME };
    }
    // A bare mount root (e.g. "/docs") is always a directory, even if the
    // provider doesn't expose a stat for its own root.
    for (const mp of this.providers.keys()) {
      if (abs === mp) return { type: "dir", size: 0, mtime: ROOT_MTIME };
    }
    const m = matchMount(abs, this.providers.keys());
    if (!m) throw new VfsError("ENOENT", `no mount for ${abs}`);
    return this.dispatch(this.providers.get(m.mountPrefix)!, "stat", m.subpath, ctx);
  }

  async search(req: SearchRequest, ctx: VfsContext): Promise<SearchHit[] | null> {
    const abs = normalizeAbsPath(req.subpath);
    const root = this.providers.get("");
    if (root) {
      return root.search
        ? this.dispatchSearch(root, { ...req, subpath: abs }, ctx)
        : null;
    }

    // Scoped search under one mount
    if (abs !== "/") {
      const m = matchMount(abs, this.providers.keys());
      if (!m) return [];
      const p = this.providers.get(m.mountPrefix)!;
      const inner = await this.dispatchSearch(p, { ...req, subpath: m.subpath }, ctx);
      return inner; // already absolute paths from provider's perspective — rewrite below
        // note: dispatchSearch already rewrites
    }

    // Global search — fan out to all mounted providers in parallel
    const all = Array.from(this.providers.values());
    const results = await Promise.all(
      all.map((p) => this.dispatchSearch(p, { ...req, subpath: "/" }, ctx)),
    );
    return results.flatMap((r) => r ?? []);
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private async dispatch<M extends "readdir" | "read" | "stat">(
    provider: VfsProvider,
    method: M,
    subpath: string,
    ctx: VfsContext,
  ): Promise<Awaited<ReturnType<VfsProvider[M]>>> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return await (provider[method] as any).call(provider, subpath, ctx);
    } catch (e) {
      if (isVfsError(e)) throw e;
      throw new VfsError("EIO", `${provider.name}.${method}(${subpath}): ${(e as Error).message}`);
    }
  }

  private async dispatchSearch(
    provider: VfsProvider,
    req: SearchRequest,
    ctx: VfsContext,
  ): Promise<SearchHit[] | null> {
    if (!provider.search) return null;
    try {
      const hits = await provider.search(req, ctx);
      if (!hits) return null;
      // Provider returns paths relative to its own tree; rewrite to absolute.
      return hits.map((h) => ({ ...h, path: joinMount(provider.mountPrefix, h.path) }));
    } catch (e) {
      if (isVfsError(e)) throw e;
      throw new VfsError("EIO", `${provider.name}.search: ${(e as Error).message}`);
    }
  }
}
