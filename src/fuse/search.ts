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
 * State is process-global (single-tenant Agent sandbox).
 */

import type { VectorStore } from "../types.js";
import { assembleChunks, utf8ByteLength } from "./helpers.js";

export interface SearchResult {
  slug: string;
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

/** Header lines shown when reading /search/last_query (always at least one byte). */
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

/** Listing for /search/results. */
export function listResultFilenames(): string[] {
  return state.results.map((r) => r.filename);
}

/** True iff this path looks like /search/results/<filename>. */
export function isResultPath(path: string): boolean {
  return path.startsWith("/search/results/");
}

export function getResultByPath(path: string): SearchResult | undefined {
  const filename = path.slice("/search/results/".length);
  if (!filename) return undefined;
  return state.results.find((r) => r.filename === filename);
}

/**
 * Trigger a new search. Replaces previous results.
 * Uses store.searchText() (M3 keyword scope; M4 will swap to embeddings).
 */
export async function runSearch(query: string, store: VectorStore, limit = 10): Promise<void> {
  const trimmed = query.trim();
  state.query = trimmed;
  state.mtime = new Date();
  state.results = [];

  if (!trimmed) return;

  let slugs: string[] = [];
  try {
    slugs = await store.searchText({ pattern: trimmed, limit });
  } catch (e) {
    // Surface the error inside a fake result file so the agent can see it.
    state.results = [
      {
        slug: "__error__",
        filename: "000_search_error.txt",
        content: `Search failed for ${JSON.stringify(trimmed)}:\n${(e as Error).message}\n`,
      },
    ];
    return;
  }

  let idx = 1;
  for (const slug of slugs) {
    const chunks = await store.getChunksByPage(slug);
    const content = assembleChunks(chunks);
    const safeSlug = slug.replace(/[\\/]/g, "_");
    const filename = `${String(idx).padStart(3, "0")}_${safeSlug}`;
    state.results.push({ slug, filename, content });
    idx++;
  }
}
