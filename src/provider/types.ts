/**
 * Public Provider-plugin API.
 *
 * A Provider is any class/object implementing `VfsProvider`. It exposes a tree
 * of "files" (text blobs) and optionally a specialized `search()` — anything
 * beyond that is the router's job.
 *
 * See docs/PROVIDER_PLUGIN_DESIGN.md for the authoritative design.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Context
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Per-invocation context threaded from the FUSE/HTTP entry point.
 * Providers may use `locals` to cache their own per-session state.
 */
export interface VfsContext {
  sessionId: string;
  userId?: string;
  groups?: string[];
  locals?: Record<string, unknown>;
}

/** A default, anonymous context — acceptable during Step 1/2 when we have no real sessions. */
export function anonymousContext(sessionId = "anon"): VfsContext {
  return { sessionId };
}

// ─────────────────────────────────────────────────────────────────────────────
// Data shapes
// ─────────────────────────────────────────────────────────────────────────────

export interface DirEntry {
  name: string;
  type: "file" | "dir";
  size?: number;
  mtime?: number;
}

export interface ReadResult {
  content: string;
  mime?: string;
  size?: number;
  mtime?: number;
}

export interface FileStat {
  type: "file" | "dir";
  size: number;
  mtime: number;
}

export interface SearchRequest {
  /** Pattern as given by the user — treat as literal unless `regex: true`. */
  query: string;
  /** Provider-relative path (starts with "/"). "/" means whole mount. */
  subpath: string;
  regex?: boolean;
  caseInsensitive?: boolean;
  /** Defensive cap for the router-fallback scanner. Providers may ignore. */
  maxHits?: number;
}

export interface SearchHit {
  /** Absolute VFS path (already prefixed with the provider's mount). */
  path: string;
  line?: number;
  snippet: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Provider contract
// ─────────────────────────────────────────────────────────────────────────────

export interface VfsProvider {
  /** Stable identifier, used in logs and for error messages. */
  readonly name: string;
  /** Absolute mount prefix, e.g. "/docs". Must start with "/". */
  readonly mountPrefix: string;

  readdir(subpath: string, ctx: VfsContext): Promise<DirEntry[]>;
  read(subpath: string, ctx: VfsContext): Promise<ReadResult>;
  stat(subpath: string, ctx: VfsContext): Promise<FileStat>;

  /** Optional. Return `null` to let the router fall back to readdir+read scanning. */
  search?(req: SearchRequest, ctx: VfsContext): Promise<SearchHit[] | null>;

  /** Optional. Called once during graceful shutdown. */
  close?(): Promise<void>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────────────────────────

/** POSIX-ish error codes that map cleanly to FUSE errnos. */
export type VfsErrorCode =
  | "ENOENT"
  | "EACCES"
  | "EIO"
  | "ENOTDIR"
  | "EISDIR"
  | "ENOSYS"
  | "ENAMETOOLONG"
  | "EINVAL";

export class VfsError extends Error {
  constructor(public readonly code: VfsErrorCode, message?: string) {
    super(message ?? code);
    this.name = "VfsError";
  }
}

export function isVfsError(e: unknown): e is VfsError {
  return typeof e === "object" && e !== null && (e as { name?: string }).name === "VfsError";
}

// ─────────────────────────────────────────────────────────────────────────────
// Plugin factory helper
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Author ergonomics helper. A plugin file's default export is either:
 *   (1) a ready-made VfsProvider, or
 *   (2) a factory `(config) => VfsProvider | Promise<VfsProvider>`.
 *
 * `defineProvider` is intentionally a pass-through: its only job is to
 * pin types and centralize validation (Step 3 work — currently it just
 * checks the required fields).
 */
export function defineProvider<T extends VfsProvider>(provider: T): T {
  if (!provider || typeof provider !== "object") {
    throw new Error("defineProvider: argument must be an object");
  }
  if (!provider.name) throw new Error("defineProvider: `name` is required");
  if (!provider.mountPrefix || !provider.mountPrefix.startsWith("/")) {
    throw new Error(`defineProvider(${provider.name}): mountPrefix must start with "/"`);
  }
  for (const method of ["readdir", "read", "stat"] as const) {
    if (typeof provider[method] !== "function") {
      throw new Error(`defineProvider(${provider.name}): ${method} is required`);
    }
  }
  return provider;
}
