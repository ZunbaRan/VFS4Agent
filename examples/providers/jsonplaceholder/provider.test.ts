import { describe, it } from "node:test";
import assert from "node:assert/strict";

import createJsonPlaceholderProvider from "./provider.js";
import { anonymousContext } from "../../../src/provider/types.js";
import { MountRouter } from "../../../src/provider/router.js";

// ── Minimal in-memory fetch stub (no network) ─────────────────────────────
const fixtures: Record<string, unknown> = {
  "/users": [
    { id: 1, name: "Leanne Graham", username: "Bret", email: "l@x.io", phone: "1", website: "a.io", company: { name: "Romaguera" } },
    { id: 2, name: "Ervin Howell", username: "Antonette", email: "e@x.io", phone: "2", website: "b.io" },
  ],
  "/users/1": { id: 1, name: "Leanne Graham", username: "Bret", email: "l@x.io", phone: "1", website: "a.io", company: { name: "Romaguera" } },
  "/users/1/posts": [{ id: 10, userId: 1, title: "hello", body: "world" }],
  "/posts": [
    { id: 10, userId: 1, title: "hello oauth", body: "world" },
    { id: 11, userId: 2, title: "goodbye", body: "night" },
  ],
  "/posts/10": { id: 10, userId: 1, title: "hello oauth", body: "world" },
  "/todos": [{ id: 100, userId: 1, title: "buy milk", completed: false }],
  "/todos/100": { id: 100, userId: 1, title: "buy milk", completed: false },
};

const stubFetch: typeof globalThis.fetch = async (input) => {
  const url = typeof input === "string" ? input : (input as URL).toString();
  const pathname = new URL(url).pathname;
  const body = fixtures[pathname];
  if (body === undefined) {
    return new Response("not found", { status: 404 });
  }
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};

function makeProvider() {
  return createJsonPlaceholderProvider({
    name: "jp",
    mountPrefix: "/api",
    config: { fetch: stubFetch, baseUrl: "https://example.test" },
  });
}

describe("jsonplaceholder provider", () => {
  const ctx = anonymousContext();

  it("readdir '/' lists top-level", async () => {
    const p = makeProvider();
    const entries = await p.readdir("/", ctx);
    const names = entries.map((e) => e.name).sort();
    assert.deepEqual(names, ["posts", "todos", "users", "users.md"]);
  });

  it("read /users.md renders the index", async () => {
    const p = makeProvider();
    const r = await p.read("/users.md", ctx);
    assert.match(r.content, /Leanne Graham/);
    assert.equal(r.mime, "text/markdown");
  });

  it("read /users/1.md renders a single user", async () => {
    const p = makeProvider();
    const r = await p.read("/users/1.md", ctx);
    assert.match(r.content, /@Bret/);
    assert.match(r.content, /company: Romaguera/);
  });

  it("readdir /users/1 returns the nested posts.md", async () => {
    const p = makeProvider();
    const entries = await p.readdir("/users/1", ctx);
    assert.deepEqual(entries, [{ name: "posts.md", type: "file" }]);
  });

  it("read /users/1/posts.md lists user posts", async () => {
    const p = makeProvider();
    const r = await p.read("/users/1/posts.md", ctx);
    assert.match(r.content, /10: hello/);
  });

  it("stat of unknown path throws ENOENT", async () => {
    const p = makeProvider();
    await assert.rejects(
      () => p.stat("/nope.md", ctx),
      (err: unknown) => (err as { code?: string }).code === "ENOENT",
    );
  });

  it("search matches posts by title", async () => {
    const p = makeProvider();
    const hits = await p.search!({ query: "oauth", subpath: "/" }, ctx);
    assert.ok(hits, "search should return hits array");
    assert.equal(hits!.length, 1);
    assert.equal(hits![0]!.path, "/posts/10.md");
  });

  it("mounts inside a MountRouter and rewrites search paths", async () => {
    const router = new MountRouter();
    router.mount(makeProvider());
    const hits = await router.search({ query: "oauth", subpath: "/" }, ctx);
    assert.equal(hits!.length, 1);
    assert.equal(hits![0]!.path, "/api/posts/10.md", "router prefixes with /api");

    const r = await router.read("/api/posts/10.md", ctx);
    assert.match(r.content, /hello oauth/);
  });
});
