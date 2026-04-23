/**
 * SQLite-backed VectorStore implementation.
 * - PathTree stored as one JSON blob in a meta table (analogous to Chroma's __path_tree__).
 * - Chunks stored as rows; FTS5 virtual table for fast $contains-style queries.
 * - REGEXP SQL function registered for Chroma-style $regex coarse filtering.
 */

import Database from "better-sqlite3";
import type {
  Chunk,
  GrepOptions,
  PathTree,
  VectorStore,
} from "../types.js";

const PATH_TREE_KEY = "__path_tree__";

export interface SqliteVectorStoreOptions {
  path: string; // file path (":memory:" for in-memory)
}

export class SqliteVectorStore implements VectorStore {
  private db: Database.Database;

  constructor(opts: SqliteVectorStoreOptions) {
    this.db = new Database(opts.path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");

    // Register REGEXP so we can do ERE-style matching in SQL (like Chroma $regex).
    this.db.function("REGEXP", { deterministic: true }, (pattern, value) => {
      if (value == null) return 0;
      try {
        return new RegExp(String(pattern)).test(String(value)) ? 1 : 0;
      } catch {
        return 0;
      }
    });

    this.migrate();
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS chunks (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        page        TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        line_start  INTEGER NOT NULL DEFAULT 1,
        content     TEXT NOT NULL,
        UNIQUE(page, chunk_index)
      );

      CREATE INDEX IF NOT EXISTS idx_chunks_page ON chunks(page);

      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
        content,
        content='chunks',
        content_rowid='id',
        tokenize='porter unicode61'
      );

      CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
        INSERT INTO chunks_fts(rowid, content) VALUES (new.id, new.content);
      END;
      CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
        INSERT INTO chunks_fts(chunks_fts, rowid, content) VALUES('delete', old.id, old.content);
      END;
      CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
        INSERT INTO chunks_fts(chunks_fts, rowid, content) VALUES('delete', old.id, old.content);
        INSERT INTO chunks_fts(rowid, content) VALUES (new.id, new.content);
      END;
    `);
  }

  async getPathTree(): Promise<PathTree> {
    const row = this.db
      .prepare("SELECT value FROM meta WHERE key = ?")
      .get(PATH_TREE_KEY) as { value: string } | undefined;
    if (!row) return {};
    return JSON.parse(row.value) as PathTree;
  }

  async upsertPathTree(tree: PathTree): Promise<void> {
    this.db
      .prepare(
        "INSERT INTO meta(key, value) VALUES(?, ?) " +
          "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(PATH_TREE_KEY, JSON.stringify(tree));
  }

  async getChunksByPage(slug: string): Promise<Chunk[]> {
    const rows = this.db
      .prepare(
        "SELECT page, chunk_index, line_start, content FROM chunks " +
          "WHERE page = ? ORDER BY chunk_index ASC",
      )
      .all(slug) as Chunk[];
    return rows;
  }

  async bulkGetChunksByPages(slugs: string[]): Promise<Map<string, Chunk[]>> {
    const out = new Map<string, Chunk[]>();
    if (slugs.length === 0) return out;
    // sqlite parameter limit guard; batch by 500
    const BATCH = 500;
    for (let i = 0; i < slugs.length; i += BATCH) {
      const batch = slugs.slice(i, i + BATCH);
      const placeholders = batch.map(() => "?").join(",");
      const rows = this.db
        .prepare(
          `SELECT page, chunk_index, line_start, content FROM chunks
             WHERE page IN (${placeholders})
             ORDER BY page ASC, chunk_index ASC`,
        )
        .all(...batch) as Chunk[];
      for (const r of rows) {
        const arr = out.get(r.page) ?? [];
        arr.push(r);
        out.set(r.page, arr);
      }
    }
    return out;
  }

  async upsertChunks(chunks: Chunk[]): Promise<void> {
    const insert = this.db.prepare(
      "INSERT INTO chunks(page, chunk_index, line_start, content) VALUES(?,?,?,?) " +
        "ON CONFLICT(page, chunk_index) DO UPDATE SET " +
        "  line_start = excluded.line_start, content = excluded.content",
    );
    const tx = this.db.transaction((items: Chunk[]) => {
      for (const c of items) {
        insert.run(c.page, c.chunk_index, c.line_start, c.content);
      }
    });
    tx(chunks);
  }

  async deleteChunksByPage(slug: string): Promise<void> {
    this.db.prepare("DELETE FROM chunks WHERE page = ?").run(slug);
  }

  async searchText(opts: GrepOptions): Promise<string[]> {
    const { pattern, regex = false, ignoreCase = false, pathPrefix, limit = 1000 } = opts;

    // Fixed-string: push into FTS5 when the pattern contains a tokenisable
    // term (alphanumeric). FTS5 is token-based and case-insensitive by default
    // (the porter tokenizer lowercases), so it naturally handles `ignoreCase`.
    // We still need LIKE as a fallback for patterns FTS5 can't represent
    // (pure punctuation, short fragments under the token length, etc.), and
    // we always re-run the exact filter downstream in the two-stage grep, so
    // over-matching here is fine.
    const ftsTerm = !regex ? ftsQueryForSubstring(pattern) : null;
    const params: unknown[] = [];
    let sql: string;

    if (ftsTerm) {
      sql =
        `SELECT DISTINCT c.page FROM chunks c
           JOIN chunks_fts f ON f.rowid = c.id
           WHERE f.content MATCH ?`;
      params.push(ftsTerm);
      if (pathPrefix) {
        sql += " AND (c.page = ? OR c.page LIKE ?)";
        params.push(pathPrefix, `${pathPrefix}/%`);
      }
    } else if (regex) {
      const effectivePattern = ignoreCase ? caseInsensitiveRegex(pattern) : pattern;
      sql = "SELECT DISTINCT page FROM chunks WHERE content REGEXP ?";
      params.push(effectivePattern);
      if (pathPrefix) {
        sql += " AND (page = ? OR page LIKE ?)";
        params.push(pathPrefix, `${pathPrefix}/%`);
      }
    } else {
      // Fallback for fixed strings FTS5 can't tokenize (e.g. pure punctuation).
      if (ignoreCase) {
        sql = "SELECT DISTINCT page FROM chunks WHERE LOWER(content) LIKE ?";
        params.push(`%${pattern.toLowerCase()}%`);
      } else {
        sql = "SELECT DISTINCT page FROM chunks WHERE content LIKE ?";
        params.push(`%${pattern}%`);
      }
      if (pathPrefix) {
        sql += " AND (page = ? OR page LIKE ?)";
        params.push(pathPrefix, `${pathPrefix}/%`);
      }
    }

    sql += ` LIMIT ${Number(limit) | 0}`;
    const rows = this.db.prepare(sql).all(...params) as { page: string }[];
    let slugs = rows.map((r) => r.page);

    if (opts.allowedSlugs) {
      slugs = slugs.filter((s) => opts.allowedSlugs!.has(s));
    }
    return slugs;
  }

  close(): void {
    this.db.close();
  }
}

function caseInsensitiveRegex(pattern: string): string {
  // Expand every ASCII letter to [aA] so the resulting JS RegExp
  // (built without /i flag) matches both cases. This is a conservative
  // coarse filter — the caller performs exact regex fine-filtering later,
  // so a slight over-match here is acceptable.
  return pattern.replace(/[a-zA-Z]/g, (c) => `[${c.toLowerCase()}${c.toUpperCase()}]`);
}

/**
 * Build an FTS5 MATCH query from a substring pattern, or return null when
 * FTS5 can't usefully match it (empty / no alphanumeric tokens).
 *
 * FTS5 is token-based: single-token alphanumeric patterns map to a prefix
 * query (`foo*`), multi-token ones to a conjunction (`"a b"` as phrase).
 * Non-alphanumeric patterns return null so the caller falls back to LIKE.
 */
function ftsQueryForSubstring(pattern: string): string | null {
  const trimmed = pattern.trim();
  if (!trimmed) return null;
  const tokens = trimmed.match(/[A-Za-z0-9_]+/g);
  if (!tokens || tokens.length === 0) return null;
  if (tokens.length === 1) return `${tokens[0]}*`;
  // Phrase search preserves ordering; good enough for the coarse filter.
  return `"${tokens.join(" ")}"`;
}
