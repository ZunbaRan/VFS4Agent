/**
 * Backend selector. Env vars:
 *   VFS_BACKEND     "chroma" (default) | "sqlite"
 *   CHROMA_URL      http://127.0.0.1:8000
 *   CHROMA_COLLECTION  vfs
 *   VFS_DB_PATH     ./data/vfs.db        (sqlite only)
 */

import path from "node:path";
import type { VectorStore } from "../types.js";
import { ChromaVectorStore } from "./chroma.js";
import { SqliteVectorStore } from "./sqlite.js";

export type BackendKind = "chroma" | "sqlite";

export interface CreateBackendOpts {
  backend?: BackendKind;
  chromaUrl?: string;
  chromaCollection?: string;
  sqlitePath?: string;
}

export function resolveBackend(): BackendKind {
  const raw = (process.env.VFS_BACKEND ?? "chroma").toLowerCase();
  if (raw === "sqlite" || raw === "chroma") return raw;
  throw new Error(`VFS_BACKEND must be "chroma" or "sqlite", got ${raw}`);
}

export function createBackend(opts: CreateBackendOpts = {}): {
  store: VectorStore;
  kind: BackendKind;
  label: string;
} {
  const kind = opts.backend ?? resolveBackend();
  if (kind === "chroma") {
    const url = opts.chromaUrl ?? process.env.CHROMA_URL ?? "http://127.0.0.1:8000";
    const collection =
      opts.chromaCollection ?? process.env.CHROMA_COLLECTION ?? "vfs";
    return {
      store: new ChromaVectorStore({ url, collection }),
      kind,
      label: `chroma(${url} :: ${collection})`,
    };
  }
  const dbPath =
    opts.sqlitePath ?? process.env.VFS_DB_PATH ?? path.resolve("./data/vfs.db");
  return {
    store: new SqliteVectorStore({ path: dbPath }),
    kind,
    label: `sqlite(${dbPath})`,
  };
}
