/**
 * VirtualFs — implements just-bash's IFileSystem over a VectorStore.
 * Mounts read-only at e.g. /docs; all writes throw EROFS.
 *
 * Design: since `Bash` uses IFileSystem methods (readFile/readdir/stat) for
 * every built-in command (cat, head, tail, wc, sort, uniq, awk, sed, find...),
 * implementing these three correctly yields the entire bash command surface.
 * Only `grep -r` needs special interception for performance (handled elsewhere).
 */

import { LRUCache } from "lru-cache";
import type {
  DirentEntry,
  FsStat,
  IFileSystem,
  ReadFileOptions,
  BufferEncoding,
} from "just-bash";
import type { PathTree, Session, VectorStore } from "../types.js";

export interface VirtualFsOptions {
  store: VectorStore;
  session?: Session;
  /** Mount point inside the bash env, e.g. "/docs". Defaults to "/". */
  mountPoint?: string;
  /** Max reassembled pages cached in memory. */
  pageCacheMax?: number;
  /** Default mtime when entry has none. */
  defaultMtime?: Date;
}

interface TreeNode {
  children: Map<string, TreeNode>;
  /** If this node is a file, the slug used to fetch chunks. */
  fileSlug?: string;
  mtime?: Date;
  size?: number;
  lines?: number;
}

const EROFS = (path: string) =>
  Object.assign(new Error(`EROFS: read-only file system, at '${path}'`), {
    code: "EROFS",
  });

const ENOENT = (path: string) =>
  Object.assign(new Error(`ENOENT: no such file or directory, at '${path}'`), {
    code: "ENOENT",
  });

const ENOTDIR = (path: string) =>
  Object.assign(new Error(`ENOTDIR: not a directory, at '${path}'`), {
    code: "ENOTDIR",
  });

const EISDIR = (path: string) =>
  Object.assign(new Error(`EISDIR: is a directory, at '${path}'`), {
    code: "EISDIR",
  });

export class VirtualFs implements IFileSystem {
  private readonly store: VectorStore;
  private readonly session?: Session;
  private readonly mountPoint: string;
  private readonly defaultMtime: Date;

  /** Raw PathTree from the store (post-RBAC pruning). */
  private tree: PathTree = {};
  /** Hierarchical index built from tree for fast readdir/stat. */
  private root: TreeNode = { children: new Map() };
  private initialized = false;

  /** Cached reassembled page content (slug -> utf-8 string). */
  private pageCache: LRUCache<string, string>;

  constructor(opts: VirtualFsOptions) {
    this.store = opts.store;
    this.session = opts.session;
    this.mountPoint = normalizeMount(opts.mountPoint ?? "/");
    this.defaultMtime = opts.defaultMtime ?? new Date(0);
    this.pageCache = new LRUCache<string, string>({
      max: opts.pageCacheMax ?? 500,
    });
  }

  /** Fetch PathTree and apply RBAC pruning. Idempotent. */
  async init(): Promise<void> {
    if (this.initialized) return;
    const tree = await this.store.getPathTree();
    this.tree = pruneByRbac(tree, this.session);
    this.root = buildTree(this.tree, this.defaultMtime);
    this.initialized = true;
  }

  /** Set of allowed slugs (after RBAC). Used by grep engine. */
  getAllowedSlugs(): Set<string> {
    return new Set(Object.keys(this.tree));
  }

  /** Resolve an absolute path inside this FS to a slug, or null for directories. */
  pathToSlug(absPath: string): string | null {
    // `absPath` here is a full shell-absolute path like "/docs/auth/oauth.md".
    const rel = stripMount(absPath, this.mountPoint);
    if (rel == null) return null;
    const node = this.findNode(rel);
    if (!node) return null;
    return node.fileSlug ?? null;
  }

  // ============================================================
  // IFileSystem reads
  // ============================================================

  async readFile(
    path: string,
    options?: ReadFileOptions | BufferEncoding,
  ): Promise<string> {
    const buf = await this.readFileBuffer(path);
    const encoding = typeof options === "string" ? options : options?.encoding ?? "utf8";
    if (encoding === "binary") return Buffer.from(buf).toString("binary");
    return Buffer.from(buf).toString("utf8");
  }

  async readFileBuffer(path: string): Promise<Uint8Array> {
    await this.init();
    // MountableFs strips the mount prefix before forwarding, so `path` is
    // already relative to our mount root (e.g. "/auth/oauth.md").
    const rel = normalizePath(path);
    const node = this.findNode(rel);
    if (!node) throw ENOENT(path);
    if (!node.fileSlug) throw EISDIR(path);

    const slug = node.fileSlug;
    let content = this.pageCache.get(slug);
    if (content === undefined) {
      const chunks = await this.store.getChunksByPage(slug);
      if (chunks.length === 0) throw ENOENT(path);
      chunks.sort((a, b) => a.chunk_index - b.chunk_index);
      content = chunks.map((c) => c.content).join("");
      this.pageCache.set(slug, content);
    }
    return new TextEncoder().encode(content);
  }

  async exists(path: string): Promise<boolean> {
    try {
      await this.stat(path);
      return true;
    } catch {
      return false;
    }
  }

  async stat(path: string): Promise<FsStat> {
    await this.init();
    const rel = normalizePath(path);
    const node = this.findNode(rel);
    if (!node) throw ENOENT(path);

    if (node.fileSlug) {
      return {
        isFile: true,
        isDirectory: false,
        isSymbolicLink: false,
        mode: 0o444,
        size: node.size ?? 0,
        mtime: node.mtime ?? this.defaultMtime,
      };
    }
    return {
      isFile: false,
      isDirectory: true,
      isSymbolicLink: false,
      mode: 0o555,
      size: 0,
      mtime: this.defaultMtime,
    };
  }

  async lstat(path: string): Promise<FsStat> {
    return this.stat(path);
  }

  async readdir(path: string): Promise<string[]> {
    await this.init();
    const rel = normalizePath(path);
    const node = this.findNode(rel);
    if (!node) throw ENOENT(path);
    if (node.fileSlug) throw ENOTDIR(path);
    return Array.from(node.children.keys()).sort();
  }

  async readdirWithFileTypes(path: string): Promise<DirentEntry[]> {
    await this.init();
    const rel = normalizePath(path);
    const node = this.findNode(rel);
    if (!node) throw ENOENT(path);
    if (node.fileSlug) throw ENOTDIR(path);
    return Array.from(node.children.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, child]) => ({
        name,
        isFile: !!child.fileSlug,
        isDirectory: !child.fileSlug,
        isSymbolicLink: false,
      }));
  }

  resolvePath(base: string, path: string): string {
    if (path.startsWith("/")) return normalizePath(path);
    const combined = base.endsWith("/") ? base + path : base + "/" + path;
    return normalizePath(combined);
  }

  getAllPaths(): string[] {
    // Return paths relative to our mount root; MountableFs prepends the mount
    // prefix when aggregating.
    const out: string[] = [];
    const walk = (node: TreeNode, prefix: string) => {
      for (const [name, child] of node.children) {
        const p = prefix === "/" ? `/${name}` : `${prefix}/${name}`;
        if (child.fileSlug) {
          out.push(p);
        } else {
          out.push(p + "/");
          walk(child, p);
        }
      }
    };
    walk(this.root, "/");
    return out;
  }

  async realpath(path: string): Promise<string> {
    await this.stat(path);
    return path;
  }

  async readlink(path: string): Promise<string> {
    throw Object.assign(new Error(`EINVAL: not a symlink, at '${path}'`), {
      code: "EINVAL",
    });
  }

  // ============================================================
  // IFileSystem writes — all refused
  // ============================================================

  async writeFile(path: string): Promise<void> {
    throw EROFS(path);
  }
  async appendFile(path: string): Promise<void> {
    throw EROFS(path);
  }
  async mkdir(path: string): Promise<void> {
    throw EROFS(path);
  }
  async rm(path: string): Promise<void> {
    throw EROFS(path);
  }
  async cp(_src: string, dest: string): Promise<void> {
    throw EROFS(dest);
  }
  async mv(_src: string, dest: string): Promise<void> {
    throw EROFS(dest);
  }
  async chmod(path: string): Promise<void> {
    throw EROFS(path);
  }
  async symlink(_target: string, linkPath: string): Promise<void> {
    throw EROFS(linkPath);
  }
  async link(_existing: string, newPath: string): Promise<void> {
    throw EROFS(newPath);
  }
  async utimes(path: string): Promise<void> {
    throw EROFS(path);
  }

  // ============================================================
  // Internals
  // ============================================================

  private findNode(relPath: string): TreeNode | null {
    const parts = relPath.split("/").filter(Boolean);
    let node: TreeNode = this.root;
    for (const p of parts) {
      const next = node.children.get(p);
      if (!next) return null;
      node = next;
    }
    return node;
  }
}

// --- helpers ---

function normalizeMount(mp: string): string {
  if (mp === "" || mp === "/") return "/";
  return mp.startsWith("/") ? (mp.endsWith("/") ? mp.slice(0, -1) : mp) : "/" + mp;
}

function mountPrefix(mp: string): string {
  return mp === "/" ? "" : mp;
}

function stripMount(absPath: string, mp: string): string | null {
  const p = normalizePath(absPath);
  if (mp === "/") return p;
  if (p === mp) return "/";
  if (p.startsWith(mp + "/")) return p.slice(mp.length);
  return null;
}

function normalizePath(p: string): string {
  const parts: string[] = [];
  for (const seg of p.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return "/" + parts.join("/");
}

function pruneByRbac(tree: PathTree, session?: Session): PathTree {
  const groups = new Set(session?.groups ?? []);
  const out: PathTree = {};
  for (const [slug, entry] of Object.entries(tree)) {
    if (entry.isPublic === false) {
      const allowed = entry.groups ?? [];
      if (!allowed.some((g) => groups.has(g))) continue;
    }
    out[slug] = entry;
  }
  return out;
}

function buildTree(tree: PathTree, defaultMtime: Date): TreeNode {
  const root: TreeNode = { children: new Map() };
  for (const [slug, entry] of Object.entries(tree)) {
    const parts = slug.split("/").filter(Boolean);
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      let child = node.children.get(parts[i]);
      if (!child) {
        child = { children: new Map() };
        node.children.set(parts[i], child);
      }
      node = child;
    }
    const leaf: TreeNode = {
      children: new Map(),
      fileSlug: slug,
      mtime: entry.mtime ? new Date(entry.mtime) : defaultMtime,
      size: entry.size,
      lines: entry.lines,
    };
    node.children.set(parts[parts.length - 1], leaf);
  }
  return root;
}
