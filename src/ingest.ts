/**
 * Ingest pipeline:
 *   walk a directory -> chunk markdown files -> write chunks + PathTree into
 *   the VectorStore. No embedding required for M1/M2 (text-only search).
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type {
  Chunk,
  PathTree,
  PathTreeEntry,
  VectorStore,
} from "./types.js";

export interface IngestOptions {
  rootDir: string;
  /** Slug prefix inside the VFS, e.g. "docs". */
  slugPrefix?: string;
  /** File extensions to include. */
  extensions?: string[];
  /** Target max bytes per chunk. Chunks are split on paragraph/heading boundaries. */
  maxChunkBytes?: number;
}

const DEFAULT_EXTS = [".md", ".mdx", ".txt", ".rst"];

export async function ingestDirectory(
  store: VectorStore,
  opts: IngestOptions,
): Promise<{ files: number; chunks: number }> {
  const root = path.resolve(opts.rootDir);
  const slugPrefix = (opts.slugPrefix ?? "").replace(/^\/+|\/+$/g, "");
  const exts = opts.extensions ?? DEFAULT_EXTS;
  const maxBytes = opts.maxChunkBytes ?? 4_000;

  const tree: PathTree = await store.getPathTree();
  let totalChunks = 0;
  let totalFiles = 0;

  const allChunks: Chunk[] = [];

  for await (const abs of walk(root, exts)) {
    const rel = path.relative(root, abs).split(path.sep).join("/");
    const slug = slugPrefix ? `${slugPrefix}/${rel}` : rel;
    const content = await fs.readFile(abs, "utf8");
    const stat = await fs.stat(abs);
    const chunks = chunkText(slug, content, maxBytes);

    // Replace existing chunks for idempotency.
    await store.deleteChunksByPage(slug);
    allChunks.push(...chunks);
    totalFiles++;
    totalChunks += chunks.length;

    const entry: PathTreeEntry = {
      isPublic: true,
      groups: [],
      lines: content.split("\n").length,
      size: Buffer.byteLength(content, "utf8"),
      mtime: stat.mtimeMs,
    };
    tree[slug] = entry;
  }

  if (allChunks.length > 0) await store.upsertChunks(allChunks);
  await store.upsertPathTree(tree);

  return { files: totalFiles, chunks: totalChunks };
}

async function* walk(dir: string, exts: string[]): AsyncGenerator<string> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name.startsWith(".") || e.name === "node_modules") continue;
      yield* walk(full, exts);
    } else if (e.isFile()) {
      if (exts.some((x) => e.name.toLowerCase().endsWith(x))) yield full;
    }
  }
}

/** Chunk on paragraph/heading boundaries, respecting size target. */
export function chunkText(
  slug: string,
  content: string,
  maxBytes: number,
): Chunk[] {
  const lines = content.split("\n");
  const chunks: Chunk[] = [];
  let buf: string[] = [];
  let bufStartLine = 1;
  let curLine = 1;
  let chunkIndex = 0;

  const flush = () => {
    if (buf.length === 0) return;
    // Preserve trailing newline semantics: always terminate with \n.
    const text = buf.join("\n") + "\n";
    chunks.push({
      page: slug,
      chunk_index: chunkIndex++,
      line_start: bufStartLine,
      content: text,
    });
    buf = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isHeading = /^#{1,6}\s/.test(line);
    const curBytes = Buffer.byteLength(buf.join("\n"), "utf8");

    if (buf.length > 0 && (isHeading || curBytes >= maxBytes)) {
      flush();
      bufStartLine = curLine;
    }

    if (buf.length === 0) bufStartLine = curLine;
    buf.push(line);
    curLine++;
  }
  flush();
  return chunks;
}
