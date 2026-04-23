/**
 * Chroma-backed VectorStore — the reference backend, matching the original
 * Mintlify ChromaFs design.
 *
 * Design decisions (mirrors the blog post):
 *   - One Chroma collection per VFS mount. Default name: "vfs".
 *   - PathTree stored as a single metadata-only document with a sentinel ID.
 *   - Each chunk = one Chroma record. ID = `${slug}::${chunk_index}`.
 *   - searchText pushes the pattern down to Chroma's native `$regex` /
 *     `$contains` operator on whereDocument. No client-side FTS. This is the
 *     "aha!" moment from the article: grep becomes a Chroma metadata query.
 *   - Embeddings are optional in M2 (text-only). We register a zero-vector
 *     embedding function so upsert works without spinning up a model.
 *     When M4 adds semantic search, swap this for a real embedder.
 */

import {
  ChromaClient,
  type Collection,
  type EmbeddingFunction,
} from "chromadb";
import type {
  Chunk,
  GrepOptions,
  PathTree,
  VectorStore,
  VectorStoreCapabilities,
} from "../types.js";

const PATH_TREE_ID = "__path_tree__";
const DEFAULT_EMBED_DIM = 8;

export interface ChromaVectorStoreOptions {
  /** Chroma server URL. Default env CHROMA_URL or http://127.0.0.1:8000 */
  url?: string;
  /** Collection name. Default: "vfs". */
  collection?: string;
  /** Optional real embedder (M4). Defaults to a zero-vector placeholder. */
  embeddingFunction?: EmbeddingFunction;
  /** Vector dimension for the zero-embedder. Default 8. */
  placeholderDim?: number;
  /** Tenant / database (Chroma multi-tenant). Defaults to library defaults. */
  tenant?: string;
  database?: string;
}

export class ChromaVectorStore implements VectorStore {
  readonly capabilities = {
    supportsTextSearch: true,
    supportsRegex: true, // Chroma supports $regex on whereDocument
    supportsBulkPrefetch: true,
    hasLineCounts: true,
    hasByteSizes: true,
  } satisfies VectorStoreCapabilities;

  private client: ChromaClient;
  private collectionName: string;
  private embedder: EmbeddingFunction;
  private _collection: Collection | null = null;

  constructor(opts: ChromaVectorStoreOptions = {}) {
    const url = new URL(
      opts.url ?? process.env.CHROMA_URL ?? "http://127.0.0.1:8000",
    );
    this.client = new ChromaClient({
      host: url.hostname,
      port: url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80,
      ssl: url.protocol === "https:",
      tenant: opts.tenant,
      database: opts.database,
    });
    this.collectionName = opts.collection ?? process.env.CHROMA_COLLECTION ?? "vfs";
    this.embedder =
      opts.embeddingFunction ??
      makeZeroEmbedder(opts.placeholderDim ?? DEFAULT_EMBED_DIM);
  }

  private async collection(): Promise<Collection> {
    if (this._collection) return this._collection;
    this._collection = await this.client.getOrCreateCollection({
      name: this.collectionName,
      embeddingFunction: this.embedder,
    });
    return this._collection;
  }

  // ------------------------------------------------------------
  // PathTree
  // ------------------------------------------------------------

  async getPathTree(): Promise<PathTree> {
    const col = await this.collection();
    try {
      const r = await col.get({ ids: [PATH_TREE_ID], include: ["metadatas"] });
      const meta = r.metadatas?.[0];
      if (meta && typeof meta.tree === "string") {
        return JSON.parse(meta.tree) as PathTree;
      }
    } catch {
      // fall through to empty tree
    }
    return {};
  }

  async upsertPathTree(tree: PathTree): Promise<void> {
    const col = await this.collection();
    await col.upsert({
      ids: [PATH_TREE_ID],
      documents: ["__path_tree__"],
      metadatas: [{ tree: JSON.stringify(tree), __meta: "path_tree" }],
    });
  }

  // ------------------------------------------------------------
  // Chunks
  // ------------------------------------------------------------

  async getChunksByPage(slug: string): Promise<Chunk[]> {
    const col = await this.collection();
    const r = await col.get({
      where: { page: slug },
      include: ["documents", "metadatas"],
    });
    return assembleChunks(r.ids, r.documents, r.metadatas);
  }

  async bulkGetChunksByPages(slugs: string[]): Promise<Map<string, Chunk[]>> {
    const col = await this.collection();
    const out = new Map<string, Chunk[]>();
    if (slugs.length === 0) return out;
    const r = await col.get({
      where: slugs.length === 1
        ? { page: slugs[0] }
        : { page: { $in: slugs } },
      include: ["documents", "metadatas"],
    });
    const chunks = assembleChunks(r.ids, r.documents, r.metadatas);
    for (const c of chunks) {
      const arr = out.get(c.page);
      if (arr) arr.push(c);
      else out.set(c.page, [c]);
    }
    for (const [, arr] of out) arr.sort((a, b) => a.chunk_index - b.chunk_index);
    return out;
  }

  async upsertChunks(chunks: Chunk[]): Promise<void> {
    if (chunks.length === 0) return;
    const col = await this.collection();
    const ids = chunks.map((c) => `${c.page}::${c.chunk_index}`);
    const documents = chunks.map((c) => c.content);
    const metadatas = chunks.map((c) => ({
      page: c.page,
      chunk_index: c.chunk_index,
      line_start: c.line_start,
    }));
    // Batch to respect Chroma's max batch size.
    const max = await this.client.getMaxBatchSize();
    for (let i = 0; i < ids.length; i += max) {
      await col.upsert({
        ids: ids.slice(i, i + max),
        documents: documents.slice(i, i + max),
        metadatas: metadatas.slice(i, i + max),
      });
    }
  }

  async deleteChunksByPage(slug: string): Promise<void> {
    const col = await this.collection();
    await col.delete({ where: { page: slug } });
  }

  // ------------------------------------------------------------
  // searchText — the ChromaFs trick: $regex / $contains pushdown
  // ------------------------------------------------------------

  async searchText(opts: GrepOptions): Promise<string[]> {
    const col = await this.collection();
    let pattern = opts.pattern;
    // Chroma's $regex does not take flags. Emulate case-insensitive by
    // wrapping in (?i) which Python's `re` engine (Chroma's backend) respects.
    if (opts.regex && opts.ignoreCase) pattern = `(?i)${pattern}`;

    const whereDocument = opts.regex
      ? { $regex: pattern }
      : opts.ignoreCase
        ? { $regex: `(?i)${escapeRegex(pattern)}` }
        : { $contains: pattern };

    // Chroma metadata filters only allow $eq/$ne/$in/$nin/$gt/$gte/$lt/$lte/
    // $contains/$not_contains — not $regex. So we resolve the pathPrefix into
    // an explicit slug allow-list using the in-memory PathTree. This matches
    // the ChromaFs blog post's "PathTree is the single source of truth for
    // structural queries" principle.
    const where = await this.buildMetaWhere(opts);

    const r = await col.get({
      where: where as never,
      whereDocument: whereDocument as never,
      include: ["metadatas"],
      limit: opts.limit,
    });

    const slugs = new Set<string>();
    for (const m of r.metadatas ?? []) {
      const p = (m as { page?: string } | null)?.page;
      if (typeof p === "string") slugs.add(p);
    }
    return Array.from(slugs);
  }

  /**
   * Resolve a coarse GrepOptions filter into a Chroma `where` clause that only
   * uses supported operators. Path scoping is turned into an $in list by
   * walking the in-memory PathTree; RBAC intersects the same list.
   */
  private async buildMetaWhere(
    opts: GrepOptions,
  ): Promise<Record<string, unknown> | undefined> {
    let slugSet: Set<string> | undefined;
    if (opts.pathPrefix) {
      const tree = await this.getPathTree();
      const prefix = opts.pathPrefix.replace(/\/+$/, "");
      slugSet = new Set<string>();
      for (const slug of Object.keys(tree)) {
        if (slug === prefix || slug.startsWith(prefix + "/")) slugSet.add(slug);
      }
    }
    if (opts.allowedSlugs && opts.allowedSlugs.size > 0) {
      slugSet = slugSet
        ? new Set(Array.from(slugSet).filter((s) => opts.allowedSlugs!.has(s)))
        : new Set(opts.allowedSlugs);
    }
    if (slugSet) {
      if (slugSet.size === 0) return { page: { $eq: "__nomatch__" } };
      return { page: { $in: Array.from(slugSet) } };
    }
    // No scoping — just exclude the PathTree sentinel doc.
    return { page: { $ne: PATH_TREE_ID } };
  }

  close(): void {
    // ChromaClient is stateless HTTP; nothing to close.
  }
}

// ----------------------------------------------------------------------------
// helpers
// ----------------------------------------------------------------------------

function assembleChunks(
  ids: string[],
  docs: (string | null)[] | undefined,
  metas: (Record<string, unknown> | null)[] | undefined,
): Chunk[] {
  const out: Chunk[] = [];
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    if (id === PATH_TREE_ID) continue;
    const meta = metas?.[i] as
      | { page?: string; chunk_index?: number; line_start?: number }
      | null;
    const content = docs?.[i] ?? "";
    if (!meta || typeof meta.page !== "string") continue;
    out.push({
      page: meta.page,
      chunk_index: Number(meta.chunk_index ?? 0),
      line_start: Number(meta.line_start ?? 1),
      content,
    });
  }
  out.sort(
    (a, b) =>
      a.page.localeCompare(b.page) || a.chunk_index - b.chunk_index,
  );
  return out;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function makeZeroEmbedder(dim: number): EmbeddingFunction {
  const vec = new Array<number>(dim).fill(0);
  return {
    generate: async (texts: string[]) => texts.map(() => [...vec]),
  } as unknown as EmbeddingFunction;
}
