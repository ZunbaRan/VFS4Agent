#!/usr/bin/env tsx
/**
 * Ingest a local directory of markdown/text into the VFS backend.
 *
 * Usage:
 *   tsx src/cli/ingest.ts <srcDir> [--db ./data/vfs.db] [--prefix docs] [--max-bytes 4000]
 */

import "dotenv/config";
import * as path from "node:path";
import { createBackend } from "../backend/factory.js";
import { ingestDirectory } from "../ingest.js";

function parseArgs(argv: string[]) {
  const out: Record<string, string> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        out[key] = next;
        i++;
      } else {
        out[key] = "true";
      }
    } else {
      positional.push(a);
    }
  }
  return { out, positional };
}

async function main() {
  const { out, positional } = parseArgs(process.argv.slice(2));
  const src = positional[0];
  if (!src) {
    console.error(
      "Usage: tsx src/cli/ingest.ts <srcDir> [--db PATH] [--prefix SLUG] [--max-bytes N]",
    );
    process.exit(1);
  }

  const dbPath = path.resolve(out["db"] ?? "./data/vfs.db");
  const prefix = out["prefix"] ?? "";
  const maxBytes = out["max-bytes"] ? Number(out["max-bytes"]) : undefined;

  await import("node:fs").then((fs) => {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  });

  const backendKind = out["backend"];
  const { store, label } = createBackend({
    backend: backendKind === "sqlite" || backendKind === "chroma"
      ? backendKind
      : undefined,
    sqlitePath: dbPath,
    chromaUrl: out["chroma-url"],
    chromaCollection: out["chroma-collection"],
  });
  console.error(`[ingest] backend=${label}`);
  const t0 = Date.now();
  const res = await ingestDirectory(store, {
    rootDir: src,
    slugPrefix: prefix,
    maxChunkBytes: maxBytes,
  });
  const ms = Date.now() - t0;
  store.close();

  console.log(
    `ingested ${res.files} files -> ${res.chunks} chunks into ${label} (${ms}ms)`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
