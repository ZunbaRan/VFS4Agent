/**
 * Core types for vfs4Agent.
 * VectorStore is the single source of truth (PathTree + chunks).
 */

export interface PathTreeEntry {
  /** Optional per-file RBAC (M3+). Default public. */
  isPublic?: boolean;
  groups?: string[];
  /** Optional lazy pointer (M4+). */
  lazy?: { kind: "s3" | "http"; url: string };
  /** Total line count (populated at ingest for cheap wc -l). */
  lines?: number;
  /** mtime in ms epoch. */
  mtime?: number;
  /** Size in bytes (raw UTF-8). */
  size?: number;
}

/** Map of slug (absolute path without leading slash) -> entry. */
export type PathTree = Record<string, PathTreeEntry>;

export interface Chunk {
  page: string; // slug
  chunk_index: number;
  /** Line number (1-based) of the first line of this chunk within the page. */
  line_start: number;
  content: string;
}

export interface Session {
  userId?: string;
  groups: string[];
}

export interface GrepOptions {
  pattern: string;
  /** Treat pattern as a regex (ERE). Default: fixed string. */
  regex?: boolean;
  ignoreCase?: boolean;
  /** Path filter: scope to pages under this slug prefix (e.g. "docs/auth"). */
  pathPrefix?: string;
  /** Slug allow-list (RBAC). */
  allowedSlugs?: Set<string>;
  /** Max hits for coarse filter. */
  limit?: number;
}

export interface VectorStoreCapabilities {
  /** Supports searchText() for coarse text filtering. */
  supportsTextSearch?: boolean;
  /** Supports native regex in searchText (e.g. Chroma $regex). */
  supportsRegex?: boolean;
  /** Supports bulkGetChunksByPages() for batch prefetch. */
  supportsBulkPrefetch?: boolean;
  /** PathTree entries have accurate line counts (for wc -l optimization). */
  hasLineCounts?: boolean;
  /** PathTree entries have accurate byte sizes (for wc -c / du optimization). */
  hasByteSizes?: boolean;
}

export interface VectorStore {
  /** Runtime capability introspection. Optimizers check this before executing. */
  readonly capabilities?: VectorStoreCapabilities;

  getPathTree(): Promise<PathTree>;
  upsertPathTree(tree: PathTree): Promise<void>;

  getChunksByPage(slug: string): Promise<Chunk[]>;
  bulkGetChunksByPages(slugs: string[]): Promise<Map<string, Chunk[]>>;
  upsertChunks(chunks: Chunk[]): Promise<void>;
  deleteChunksByPage(slug: string): Promise<void>;

  /**
   * Coarse text filter. Returns distinct page slugs that contain at least one
   * chunk matching the pattern. Two strategies:
   * - regex=false: substring match via LIKE / FTS
   * - regex=true:  RE2-style regex match (implementation may downgrade unsupported
   *   features to substring and let caller fine-filter)
   */
  searchText(opts: GrepOptions): Promise<string[]>;

  close(): void;
}

/** Optional — M4. */
export interface Embedder {
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
  dimension(): number;
}
