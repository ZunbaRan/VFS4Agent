/**
 * Virtual /search directory.
 *
 *   /search/
 *     last_query        ← write a query string here to trigger a search
 *     results/          ← virtual files containing matching documents
 *       001_<slug>.md
 *       002_<slug>.md
 *       ...
 *
 * Routes through `MountRouter.search()` + `MountRouter.read()` so it sees the
 * union of all mounted providers.
 * State is process-global (single-tenant Agent sandbox).
 */

import { utf8ByteLength } from "./helpers.js";
import type { MountRouter } from "../provider/router.js";
import type { VfsContext } from "../provider/types.js";
import { isVfsError } from "../provider/types.js";

export interface SearchResult {
  slug: string; // absolute VFS path, minus leading slash
  filename: string;
  content: string;
}

interface SearchState {
  query: string;
  mtime: Date;
  results: SearchResult[];
}

const state: SearchState = {
  query: "",
  mtime: new Date(0),
  results: [],
};

function lastQueryContent(): string {
  return state.query ? state.query + "\n" : "";
}

export function getLastQueryContent(): string {
  return lastQueryContent();
}

export function getLastQuerySize(): number {
  return utf8ByteLength(lastQueryContent());
}

export function getLastQueryMtime(): Date {
  return state.mtime;
}

export function listResultFilenames(): string[] {
  return state.results.map((r) => r.filename);
}

export function isResultPath(path: string): boolean {
  return path.startsWith("/search/results/");
}

export function getResultByPath(path: string): SearchResult | undefined {
  const filename = path.slice("/search/results/".length);
  if (!filename) return undefined;
  return state.results.find((r) => r.filename === filename);
}

/**
 * Trigger a new search via the router. Replaces previous results.
 */
export async function runSearch(
  query: string,
  router: MountRouter,
  ctx: VfsContext,
  limit = 10,
): Promise<void> {
  const trimmed = query.trim();
  state.query = trimmed;
  state.mtime = new Date();
  state.results = [];

  if (!trimmed) return;

  let hits;
  try {
    hits = await router.search({ query: trimmed, subpath: "/", maxHits: limit }, ctx);
  } catch (e) {
    state.results = [
      {
        slug: "__error__",
        filename: "000_search_error.txt",
        content: `Search failed for ${JSON.stringify(trimmed)}:\n${(e as Error).message}\n`,
      },
    ];
    return;
  }

  if (!hits || hits.length === 0) return;

  // De-duplicate by path (fan-out search may yield repeats across mounts).
  const seen = new Set<string>();
  let idx = 1;
  for (const hit of hits) {
    if (seen.has(hit.path)) continue;
    seen.add(hit.path);
    if (idx > limit) break;

    let content = "";
    try {
      const r = await router.read(hit.path, ctx);
      content = r.content;
    } catch (e) {
      if (isVfsError(e)) {
        content = `(cannot read ${hit.path}: ${e.code} ${e.message})\n`;
      } else {
        content = `(error reading ${hit.path}: ${(e as Error).message})\n`;
      }
    }

    const slug = hit.path.startsWith("/") ? hit.path.slice(1) : hit.path;
    const safeSlug = slug.replace(/[\\/]/g, "_");
    const filename = `${String(idx).padStart(3, "0")}_${safeSlug}`;
    state.results.push({ slug, filename, content });
    idx++;
  }
}
