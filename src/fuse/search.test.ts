/**
 * Integration-style tests for the FUSE search layer. We don't boot FUSE (it's
 * Linux-only) — instead we build a MountRouter + VectorStoreProvider in-memory
 * and exercise `runSearch` + the result-file helpers directly.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { MountRouter } from "../provider/router.js";
import { VectorStoreProvider } from "../provider/vector-store-provider.js";
import { anonymousContext } from "../provider/types.js";
import {
  getLastQueryContent,
  getResultByPath,
  isResultPath,
  listResultFilenames,
  runSearch,
} from "./search.js";
import type { Chunk, PathTree, VectorStore } from "../types.js";

function stubStore(pages: Record<string, string>): VectorStore {
  const tree: PathTree = {};
  for (const [slug, content] of Object.entries(pages)) {
    tree[slug] = { size: Buffer.byteLength(content, "utf8"), mtime: 1_700_000_000_000 };
  }
  return {
    capabilities: { supportsTextSearch: true },
    async getPathTree() { return tree; },
    async getChunksByPage(slug: string) {
      const content = pages[slug];
      if (content === undefined) return [];
      return [{ id: slug, slug, chunk_index: 0, content } as Chunk];
    },
    async bulkGetChunksByPages(slugs: string[]) {
      const out = new Map<string, Chunk[]>();
      for (const s of slugs) {
        const c = pages[s];
        if (c !== undefined) out.set(s, [{ id: s, slug: s, chunk_index: 0, content: c } as Chunk]);
      }
      return out;
    },
    async searchText({ pattern, limit = 50 }) {
      const re = new RegExp(pattern, "i");
      return Object.keys(pages).filter((slug) => re.test(pages[slug]!)).slice(0, limit);
    },
    close() {},
  } as unknown as VectorStore;
}

describe("fuse/search integration (MountRouter-backed)", () => {
  it("runSearch populates results from a root-mounted provider", async () => {
    const store = stubStore({
      "auth/oauth.md": "# OAuth 2.0\nHow to refresh access tokens.\n",
      "api/users.md": "# Users API\nListUsers GET /users\n",
      "guides/quickstart.md": "# Quickstart\nRun `oauth-example` to test.\n",
    });
    const router = new MountRouter();
    router.mount(new VectorStoreProvider(store, { mountPrefix: "/" }));

    await runSearch("oauth", router, anonymousContext(), 5);

    const names = listResultFilenames();
    assert.ok(names.length >= 1, "expected at least one match");
    // First hit should be a prefixed, sanitized filename
    assert.match(names[0]!, /^001_/, "first result is prefixed 001_");

    const first = getResultByPath("/search/results/" + names[0]);
    assert.ok(first, "getResultByPath resolves known filename");
    assert.match(first!.content, /oauth/i, "content contains the query");

    assert.equal(getLastQueryContent().trim(), "oauth");
    assert.equal(isResultPath("/search/results/" + names[0]), true);
    assert.equal(isResultPath("/search/last_query"), false);
  });

  it("runSearch fans out across multiple mounted providers", async () => {
    const docs = stubStore({ "auth/oauth.md": "oauth refresh" });
    const crm = stubStore({ "accounts/acme.md": "Acme Corp — oauth beta" });

    const router = new MountRouter();
    router.mount(new VectorStoreProvider(docs, { name: "docs", mountPrefix: "/docs" }));
    router.mount(new VectorStoreProvider(crm, { name: "crm", mountPrefix: "/crm" }));

    await runSearch("oauth", router, anonymousContext(), 10);

    const names = listResultFilenames();
    assert.equal(names.length, 2, "expected one hit from each mount");
    // Both mounted paths should appear in slugs (filenames get slashes replaced).
    assert.ok(names.some((n) => n.includes("docs_auth_oauth.md")));
    assert.ok(names.some((n) => n.includes("crm_accounts_acme.md")));
  });

  it("runSearch('') clears previous state", async () => {
    const store = stubStore({ "a.md": "hello" });
    const router = new MountRouter();
    router.mount(new VectorStoreProvider(store, { mountPrefix: "/" }));

    await runSearch("hello", router, anonymousContext());
    assert.ok(listResultFilenames().length > 0);

    await runSearch("", router, anonymousContext());
    assert.equal(listResultFilenames().length, 0);
    assert.equal(getLastQueryContent(), "");
  });
});
