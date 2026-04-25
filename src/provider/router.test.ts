/**
 * Smoke test for the Provider plugin system. Runs under Node's built-in test runner.
 *   node --test --experimental-strip-types src/provider/router.test.ts
 *   (or via tsx: `tsx --test src/provider/router.test.ts`)
 *
 * Exercises:
 *   - MountRouter dispatch (root, single mount, multi mount)
 *   - Error translation (unknown paths → ENOENT)
 *   - VectorStoreProvider against an in-memory VectorStore stub
 *   - search() fan-out and path rewriting
 */

import test from "node:test";
import assert from "node:assert/strict";

import { MountRouter } from "./router.js";
import { VectorStoreProvider } from "./vector-store-provider.js";
import { VfsError, defineProvider, anonymousContext, type VfsProvider } from "./types.js";
import type { PathTree, VectorStore, Chunk, GrepOptions } from "../types.js";

// ── Stub VectorStore with a tiny docs tree ─────────────────────────────────
function makeStubStore(): VectorStore {
  const tree: PathTree = {
    "auth/oauth.md": { size: 120, mtime: 1 },
    "auth/token-refresh.md": { size: 80, mtime: 2 },
    "guides/quickstart.md": { size: 40, mtime: 3 },
  };
  const chunks: Record<string, Chunk[]> = {
    "auth/oauth.md": [{ page: "auth/oauth.md", chunk_index: 0, line_start: 1, content: "# OAuth\nflow\n" }],
    "auth/token-refresh.md": [{ page: "auth/token-refresh.md", chunk_index: 0, line_start: 1, content: "refresh\n" }],
    "guides/quickstart.md": [{ page: "guides/quickstart.md", chunk_index: 0, line_start: 1, content: "quickstart\n" }],
  };
  return {
    capabilities: { supportsTextSearch: true },
    async getPathTree() { return tree; },
    async upsertPathTree() { },
    async getChunksByPage(slug: string) { return chunks[slug] ?? []; },
    async bulkGetChunksByPages(slugs: string[]) { return new Map(slugs.map(s => [s, chunks[s] ?? []])); },
    async upsertChunks() { },
    async deleteChunksByPage() { },
    async searchText(opts: GrepOptions) {
      const hits: string[] = [];
      for (const [slug, cs] of Object.entries(chunks)) {
        if (opts.pathPrefix && !slug.startsWith(opts.pathPrefix)) continue;
        const body = cs.map(c => c.content).join("");
        const needle = opts.ignoreCase ? body.toLowerCase() : body;
        const pat = opts.ignoreCase ? opts.pattern.toLowerCase() : opts.pattern;
        if (needle.includes(pat)) hits.push(slug);
      }
      return hits;
    },
    close() { },
  };
}

const ctx = anonymousContext();

// ── Tests ──────────────────────────────────────────────────────────────────

test("VectorStoreProvider readdir/read/stat at root mount", async () => {
  const p = new VectorStoreProvider(makeStubStore(), { mountPrefix: "/" });

  const top = await p.readdir("/", ctx);
  assert.deepEqual(top.map(e => e.name).sort(), ["auth", "guides"]);
  assert.equal(top.find(e => e.name === "auth")!.type, "dir");

  const auth = await p.readdir("/auth", ctx);
  assert.deepEqual(auth.map(e => e.name).sort(), ["oauth.md", "token-refresh.md"]);
  assert.equal(auth[0].type, "file");

  const r = await p.read("/auth/oauth.md", ctx);
  assert.match(r.content, /OAuth/);

  const s = await p.stat("/guides", ctx);
  assert.equal(s.type, "dir");

  const sf = await p.stat("/auth/oauth.md", ctx);
  assert.equal(sf.type, "file");
  assert.equal(sf.size, 120);
});

test("VectorStoreProvider ENOENT and EISDIR", async () => {
  const p = new VectorStoreProvider(makeStubStore(), { mountPrefix: "/" });
  await assert.rejects(p.read("/nope", ctx), (e: any) => e instanceof VfsError && e.code === "ENOENT");
  await assert.rejects(p.read("/auth", ctx), (e: any) => e instanceof VfsError && e.code === "EISDIR");
});

test("MountRouter root listing across multiple mounts", async () => {
  const router = new MountRouter();
  const docs = new VectorStoreProvider(makeStubStore(), { name: "docs", mountPrefix: "/docs" });
  const other = new VectorStoreProvider(makeStubStore(), { name: "other", mountPrefix: "/other" });
  router.mount(docs);
  router.mount(other);

  const top = await router.readdir("/", ctx);
  assert.deepEqual(top.map(e => e.name).sort(), ["docs", "other"]);

  const auth = await router.readdir("/docs/auth", ctx);
  assert.deepEqual(auth.map(e => e.name).sort(), ["oauth.md", "token-refresh.md"]);

  const rootStat = await router.stat("/", ctx);
  assert.equal(rootStat.type, "dir");

  const docsStat = await router.stat("/docs", ctx);
  assert.equal(docsStat.type, "dir");
});

test("MountRouter unknown path → ENOENT", async () => {
  const router = new MountRouter();
  router.mount(new VectorStoreProvider(makeStubStore(), { name: "docs", mountPrefix: "/docs" }));
  await assert.rejects(router.readdir("/nowhere", ctx), (e: any) => e.code === "ENOENT");
  await assert.rejects(router.read("/nowhere/file", ctx), (e: any) => e.code === "ENOENT");
});

test("MountRouter search fan-out and path rewriting", async () => {
  const router = new MountRouter();
  router.mount(new VectorStoreProvider(makeStubStore(), { name: "a", mountPrefix: "/a" }));
  router.mount(new VectorStoreProvider(makeStubStore(), { name: "b", mountPrefix: "/b" }));

  const hits = await router.search({ query: "oauth", subpath: "/", caseInsensitive: true }, ctx);
  assert.ok(hits);
  // 1 match per mount (auth/oauth.md), rewritten to absolute paths
  const paths = hits!.map(h => h.path).sort();
  assert.deepEqual(paths, ["/a/auth/oauth.md", "/b/auth/oauth.md"]);
});

test("MountRouter scoped search only hits the matching mount", async () => {
  const router = new MountRouter();
  router.mount(new VectorStoreProvider(makeStubStore(), { name: "a", mountPrefix: "/a" }));
  router.mount(new VectorStoreProvider(makeStubStore(), { name: "b", mountPrefix: "/b" }));

  const hits = await router.search({ query: "oauth", subpath: "/a/auth", caseInsensitive: true }, ctx);
  assert.ok(hits);
  assert.equal(hits!.length, 1);
  assert.equal(hits![0].path, "/a/auth/oauth.md");
});

test("MountRouter refuses to mix root + prefixed providers", () => {
  const router = new MountRouter();
  router.mount(new VectorStoreProvider(makeStubStore(), { name: "root", mountPrefix: "/" }));
  assert.throws(() =>
    router.mount(new VectorStoreProvider(makeStubStore(), { name: "x", mountPrefix: "/x" })),
  );
});

test("MountRouter root-mounted provider is passthrough", async () => {
  const router = new MountRouter();
  router.mount(new VectorStoreProvider(makeStubStore(), { name: "root", mountPrefix: "/" }));

  const top = await router.readdir("/", ctx);
  assert.deepEqual(top.map(e => e.name).sort(), ["auth", "guides"]);

  const auth = await router.readdir("/auth", ctx);
  assert.deepEqual(auth.map(e => e.name).sort(), ["oauth.md", "token-refresh.md"]);
});

test("defineProvider validates required fields", () => {
  assert.throws(() => defineProvider({} as unknown as VfsProvider));
  assert.throws(() =>
    defineProvider({
      name: "x",
      mountPrefix: "bad",
      readdir: async () => [],
      read: async () => ({ content: "" }),
      stat: async () => ({ type: "file", size: 0, mtime: 0 }),
    } as VfsProvider),
  );
  const ok = defineProvider({
    name: "ok",
    mountPrefix: "/ok",
    readdir: async () => [],
    read: async () => ({ content: "" }),
    stat: async () => ({ type: "file", size: 0, mtime: 0 }),
  });
  assert.equal(ok.name, "ok");
});
