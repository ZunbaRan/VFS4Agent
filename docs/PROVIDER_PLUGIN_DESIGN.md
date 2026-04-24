# Provider Plugin System — Design

> Status: **design, not yet implemented**
> Branch: `feat/provider-plugin-system`
> Author: 2026-04-24

---

## 1. Motivation

Today vfs4Agent is hardwired to one concept: a **vector store of document chunks**.
The `VectorStore` interface (`src/types.ts`) is the single extension point, and the
FUSE layer (`src/fuse/`) calls it directly.

This is fine for docs, but the same `bash over a virtual tree` abstraction can
power far more:

- Business systems via REST API (CRM, ticketing, ERP, ...)
- SQL databases exposed as `/tables/<tbl>/<rowid>`
- Kubernetes `kubectl`-style resources as paths
- Log aggregators (`/logs/<service>/<date>.log`)
- Multiple sources **mounted side-by-side**:
  `/docs/*` from Chroma, `/crm/*` from an API, `/tickets/*` from Jira.

So the goal is: **turn vfs4Agent from "a VFS over a vector store" into
"a VFS over any queryable system", with a plugin interface any team can implement
in ~50 lines of TypeScript**.

---

## 2. Target architecture

```
┌──────────────────────────────────────────────────────┐
│  Agent (LangChain / Claude SDK / CrewAI ...)         │
└──────────────────────────────────────────────────────┘
                      │ bash
                      ▼
┌──────────────────────────────────────────────────────┐
│  FUSE layer  /  HTTP /v1/bash bridge  (unchanged)    │
└──────────────────────────────────────────────────────┘
                      │ readdir / read / search / stat
                      ▼
┌──────────────────────────────────────────────────────┐
│  MountRouter                                          │
│    /docs/*     → VectorStoreProvider (Chroma)        │
│    /crm/*      → business-owned CrmApiProvider        │
│    /tickets/*  → community JiraProvider               │
└──────────────────────────────────────────────────────┘
                      │
         ┌────────────┴────────────┐
         ▼                         ▼
   VfsProvider (interface, 5 methods)
```

The FUSE layer and HTTP-bash bridge **do not change**. Only the data-source
adapter layer is replaced: `VectorStore` is no longer called directly; the
router dispatches to the right `VfsProvider` based on path prefix.

---

## 3. VfsProvider interface (authoritative)

```ts
interface VfsProvider {
  readonly name: string;         // "docs"  "crm"  "jira"
  readonly mountPrefix: string;  // "/docs" "/crm" "/tickets"  (always starts with "/")

  /** Enumerate one level of the tree under `subpath`.
   *  subpath is always relative to mountPrefix and starts with "/". */
  readdir(subpath: string, ctx: VfsContext): Promise<DirEntry[]>;

  /** Return the file content shown to the LLM (Markdown strongly recommended). */
  read(subpath: string, ctx: VfsContext): Promise<ReadResult>;

  /** Metadata for getattr(). size/mtime may be approximate. */
  stat(subpath: string, ctx: VfsContext): Promise<FileStat>;

  /** OPTIONAL. Intercept grep and friends. Return null to fall back to the
   *  generic "readdir+read+scan" implementation. */
  search?(req: SearchRequest, ctx: VfsContext): Promise<SearchHit[] | null>;

  /** OPTIONAL. Called once during graceful shutdown. */
  close?(): Promise<void>;
}

interface DirEntry { name: string; type: "file" | "dir"; size?: number; mtime?: number }
interface ReadResult { content: string; mime?: string; size?: number; mtime?: number }
interface FileStat { type: "file" | "dir"; size: number; mtime: number }

interface SearchRequest {
  query: string;
  subpath: string;        // relative to mountPrefix
  regex?: boolean;
  caseInsensitive?: boolean;
  maxHits?: number;
}

interface SearchHit { path: string; line?: number; snippet: string }

/** Per-invocation context, threaded from the FUSE/HTTP entry point. */
interface VfsContext {
  sessionId: string;
  userId?: string;
  groups?: string[];
  /** Free-form — providers can stash their own per-session cache here. */
  locals?: Record<string, unknown>;
}

/** Canonical error. Providers throw these; MountRouter translates to FUSE errno. */
class VfsError extends Error {
  constructor(public code: "ENOENT" | "EACCES" | "EIO" | "ENOTDIR" | "EISDIR" | "ENOSYS",
              message?: string) { super(message ?? code); }
}
```

### Design notes

- **`mountPrefix`** is always absolute (`"/docs"`, not `"docs"`). Router
  normalizes both sides.
- **`subpath`** is always relative to mount prefix, starts with `/`, and uses
  forward slashes. `/` means "the mount root".
- **`read` returns text**, not bytes. Binary support is deferred; if a Provider
  has binary data it should format a textual rendering (e.g. `image: 1024x768 png`).
- **`search` returning `null`** means "I have no specialized search — please
  scan for me". The router implements generic scan by calling `readdir`+`read`.
  Returning `[]` means "I searched, found nothing".
- **`VfsContext`** is threaded from day one even if we start with a dummy
  session. Retrofitting it later would be painful.
- **Errors** are `VfsError` with POSIX-ish codes. The router maps them to
  `Fuse.ENOENT` etc. `throw new Error("...")` is treated as `EIO`.

---

## 4. MountRouter

```ts
class MountRouter implements VfsProvider {
  mount(provider: VfsProvider): void;
  unmount(name: string): void;

  // Implements the full VfsProvider interface itself, so it's transparent to
  // the FUSE layer. name/mountPrefix are "/" for the router.

  readdir(path: string, ctx): ...
  read(path: string, ctx): ...
  stat(path: string, ctx): ...
  search(req, ctx): ...
}
```

Dispatch rules:

- `readdir("/")` → union of all mount prefixes as directory names
- `readdir("/docs/foo")` → strip prefix `/docs`, delegate to docs provider's
  `readdir("/foo")`
- `readdir("/unknown")` → `ENOENT`
- `search({subpath: "/"})` → fan out to **all** providers in parallel
- `search({subpath: "/docs/..."})` → only the docs provider

Router also owns:

- **A small LRU cache** around `stat`/`readdir` (keyed by path + sessionId,
  TTL ~2s) — without this a single `find` would hammer every provider.
- **Error translation**: `VfsError.code` → FUSE errno
- **Generic scan fallback** when `provider.search` is undefined or returns null

---

## 5. Plugin loading

Config file: `vfs.config.yaml` at repo root (overridable via `VFS_CONFIG`).

```yaml
providers:
  - name: docs
    mount: /docs
    source: builtin:vector-store
    config:
      backend: chroma
      collection: vfs_docs

  - name: crm
    mount: /crm
    source: ./providers/crm-provider.ts     # local file (for in-repo dev)
    config:
      apiBase: https://crm.internal
      token: ${CRM_TOKEN}                   # env-var interpolation

  - name: jira
    mount: /tickets
    source: npm:@mycorp/vfs-jira-provider   # published npm package
    config:
      site: mycorp.atlassian.net
```

Loader contract:

```ts
// The plugin's default export is a factory.
import { defineProvider } from "vfs4agent/plugin";

export default defineProvider({
  name: "crm",
  async readdir(subpath, ctx) { /* ... */ },
  async read(subpath, ctx)    { /* ... */ },
  async stat(subpath, ctx)    { /* ... */ },
});
```

`defineProvider` is a pass-through helper that:

1. Adds type safety
2. Validates the object shape at load time (fail fast with a clear error)
3. Normalizes defaults (e.g. if `stat` is omitted, synthesize one from `readdir`)

Sources:

- `builtin:<name>` — shipped with vfs4Agent (`builtin:vector-store` is the
  first)
- `./path/to/file.ts` — local file, dynamic-imported via tsx/esbuild
- `npm:pkg-name` — `await import(pkg)`, the package's default export must be a
  VfsProvider factory

---

## 6. Implementation roadmap

### Step 1 — foundation (no behavior change, all tests green)

- `src/provider/` new folder:
  - `types.ts` — `VfsProvider`, `DirEntry`, `VfsError`, `VfsContext`
  - `router.ts` — `MountRouter` class
  - `vector-store-provider.ts` — wraps existing `VectorStore` to fulfil `VfsProvider`
- **Do not yet wire into FUSE.** Existing `src/fuse/context.ts` keeps using
  `VectorStore` directly. The new code compiles but is unused.

### Step 2 — flip the FUSE layer to the router

- `src/fuse/context.ts` now holds a `MountRouter` instead of a `VectorStore`.
- `src/fuse/ops/*.ts` call `router.readdir / read / stat / search` instead of
  `getPathTree()` / `getChunksByPage()` / `searchText()`.
- At bootstrap, wrap the backend-selected `VectorStore` in a
  `VectorStoreProvider` with mount `/` (preserves the current layout where
  everything lives at the top level).
- All existing tests still pass.

### Step 3 — config-driven providers + plugin loader

- `vfs.config.yaml` loader (YAML + env interpolation)
- Dynamic import for `./local.ts` and `npm:pkg-name`
- Example config in `examples/` showing two providers mounted side-by-side
- **Breaking change**: default mount becomes `/docs` instead of `/`. Old paths
  keep working via a `legacy: true` flag that remounts to `/`.

### Step 4 — example external Provider

- `examples/providers/jsonplaceholder/` — a provider that proxies
  https://jsonplaceholder.typicode.com as:
  - `/users/<id>.md`
  - `/posts/<id>.md`
  - `/users/<id>/posts/` (nested)
  - Custom `search()` that calls the query API rather than scanning
- Add it to `examples/_mock/test_adapters.py` so CI proves external Providers
  work end-to-end.

---

## 7. Open questions (pre-Step 1)

These were resolved in discussion before this doc was written:

- **Path tree ownership**: each Provider owns its tree; it maps to business
  menu structure however it likes. ✓
- **grep interception**: each Provider decides via `search()`. ✓
- **Plugin extensibility**: yes, via config + dynamic import. ✓
- **Config format**: YAML (primary) because business users will edit it.
  A `vfs.config.ts` form can be added later if we need env-conditional logic.
- **Provider language**: TypeScript only in v1 (same-process `import()`).
  Subprocess / HTTP providers are explicitly out of scope.
- **VfsContext**: yes, added from day one.
- **Old VectorStore interface**: kept only as an internal data-access interface
  for Chroma/SQLite. The public extension surface is `VfsProvider`.

---

## 8. What we are NOT doing

- Writes. (`create`, `write`, `truncate` stay as the FUSE layer's current
  scratch-tmpfs behavior; Providers remain read-only.)
- Binary file contents.
- Subprocess-based or cross-language Providers.
- Authentication protocols — the Provider receives a `VfsContext.userId` and
  is responsible for enforcing RBAC itself.
