/**
 * JSONPlaceholder provider — a real-world example of a non-vector-store
 * VfsProvider. Exposes https://jsonplaceholder.typicode.com as a tree:
 *
 *   /<mount>/users.md              — index of all users
 *   /<mount>/users/<id>.md         — single user profile
 *   /<mount>/users/<id>/posts.md   — posts by that user
 *   /<mount>/posts/<id>.md         — single post
 *   /<mount>/todos/<id>.md         — single todo
 *
 * Shape is intentionally small so the provider source is 100 lines of
 * readable TypeScript — this is the template authors should follow.
 *
 * Register from vfs.config.yaml:
 *
 *   - name: jsonplaceholder
 *     mountPrefix: /api
 *     driver: ./examples/providers/jsonplaceholder/provider.ts
 *     config:
 *       baseUrl: https://jsonplaceholder.typicode.com
 */

import {
  defineProvider,
  VfsError,
  type DirEntry,
  type FileStat,
  type ReadResult,
  type SearchHit,
  type SearchRequest,
  type VfsContext,
} from "../../../src/provider/types.js";

export interface JsonPlaceholderConfig {
  baseUrl?: string;
  /** Injected by tests. Node 22+ has a global `fetch`; we default to it. */
  fetch?: typeof globalThis.fetch;
  mountPrefix?: string;
  name?: string;
}

interface User {
  id: number;
  name: string;
  username: string;
  email: string;
  phone: string;
  website: string;
  company?: { name: string };
}
interface Post { id: number; userId: number; title: string; body: string }
interface Todo { id: number; userId: number; title: string; completed: boolean }

export default function createJsonPlaceholderProvider(spec: {
  name?: string;
  mountPrefix?: string;
  config?: JsonPlaceholderConfig;
}) {
  const cfg = spec.config ?? {};
  const baseUrl = (cfg.baseUrl ?? "https://jsonplaceholder.typicode.com").replace(/\/$/, "");
  const doFetch = cfg.fetch ?? globalThis.fetch;

  const cache = new Map<string, { expires: number; body: unknown }>();
  const TTL_MS = 30_000;

  async function getJson<T>(path: string): Promise<T> {
    const hit = cache.get(path);
    const now = Date.now();
    if (hit && hit.expires > now) return hit.body as T;
    const res = await doFetch(`${baseUrl}${path}`);
    if (res.status === 404) throw new VfsError("ENOENT", path);
    if (!res.ok) throw new VfsError("EIO", `upstream ${res.status} on ${path}`);
    const body = (await res.json()) as T;
    cache.set(path, { expires: now + TTL_MS, body });
    return body;
  }

  function normalize(subpath: string): string[] {
    const p = subpath.replace(/^\/+|\/+$/g, "");
    return p === "" ? [] : p.split("/");
  }
  function isId(s: string | undefined): s is string {
    return !!s && /^\d+$/.test(s);
  }
  function idFromSlug(name: string): string | null {
    const m = name.match(/^(\d+)\.md$/);
    return m ? m[1]! : null;
  }

  function renderUser(u: User): string {
    return (
      `# ${u.name} (@${u.username})\n\n` +
      `- id: ${u.id}\n- email: ${u.email}\n- phone: ${u.phone}\n- website: ${u.website}\n` +
      (u.company ? `- company: ${u.company.name}\n` : "")
    );
  }
  function renderPost(p: Post): string {
    return `# ${p.title}\n\n(post #${p.id} by user ${p.userId})\n\n${p.body}\n`;
  }
  function renderTodo(t: Todo): string {
    return `# todo #${t.id} (user ${t.userId})\n\n- [${t.completed ? "x" : " "}] ${t.title}\n`;
  }

  return defineProvider({
    name: spec.name ?? "jsonplaceholder",
    mountPrefix: spec.mountPrefix ?? "/api",

    async readdir(subpath: string, _ctx: VfsContext): Promise<DirEntry[]> {
      const segs = normalize(subpath);

      // /
      if (segs.length === 0) {
        return [
          { name: "users.md", type: "file" },
          { name: "users", type: "dir" },
          { name: "posts", type: "dir" },
          { name: "todos", type: "dir" },
        ];
      }

      const [top, sub, leaf] = segs;

      // /users
      if (top === "users" && sub === undefined) {
        const users = await getJson<User[]>("/users");
        const out: DirEntry[] = [];
        for (const u of users) out.push({ name: `${u.id}.md`, type: "file" });
        for (const u of users) out.push({ name: String(u.id), type: "dir" });
        return out;
      }
      // /users/<id>
      if (top === "users" && isId(sub) && leaf === undefined) {
        return [{ name: "posts.md", type: "file" }];
      }
      // /posts , /todos
      if ((top === "posts" || top === "todos") && sub === undefined) {
        const items = await getJson<{ id: number }[]>(`/${top}`);
        return items.map((it) => ({ name: `${it.id}.md`, type: "file" as const }));
      }

      throw new VfsError("ENOENT", subpath);
    },

    async read(subpath: string, _ctx: VfsContext): Promise<ReadResult> {
      const segs = normalize(subpath);

      // /users.md — index
      if (segs.length === 1 && segs[0] === "users.md") {
        const users = await getJson<User[]>("/users");
        const body = `# Users\n\n` + users.map((u) => `- ${u.id}: ${u.name} (@${u.username})`).join("\n") + "\n";
        return { content: body, mime: "text/markdown" };
      }

      const [top, sub, leaf] = segs;

      // /users/<id>.md
      if (top === "users" && segs.length === 2) {
        const id = idFromSlug(sub!);
        if (!id) throw new VfsError("ENOENT", subpath);
        const u = await getJson<User>(`/users/${id}`);
        return { content: renderUser(u), mime: "text/markdown" };
      }

      // /users/<id>/posts.md
      if (top === "users" && isId(sub) && leaf === "posts.md") {
        const posts = await getJson<Post[]>(`/users/${sub}/posts`);
        const body =
          `# Posts by user ${sub}\n\n` +
          posts.map((p) => `- ${p.id}: ${p.title}`).join("\n") + "\n";
        return { content: body, mime: "text/markdown" };
      }

      // /posts/<id>.md , /todos/<id>.md
      if ((top === "posts" || top === "todos") && segs.length === 2) {
        const id = idFromSlug(sub!);
        if (!id) throw new VfsError("ENOENT", subpath);
        if (top === "posts") {
          const p = await getJson<Post>(`/posts/${id}`);
          return { content: renderPost(p), mime: "text/markdown" };
        }
        const t = await getJson<Todo>(`/todos/${id}`);
        return { content: renderTodo(t), mime: "text/markdown" };
      }

      if (segs.length === 0) throw new VfsError("EISDIR");
      throw new VfsError("ENOENT", subpath);
    },

    async stat(subpath: string, ctx: VfsContext): Promise<FileStat> {
      const segs = normalize(subpath);
      if (segs.length === 0) return { type: "dir", size: 0, mtime: Date.now() };

      // Known file-endpoints end with `.md`.
      if (segs[segs.length - 1]!.endsWith(".md")) {
        // Prove the file exists by reading it (cache makes this cheap).
        const r = await this.read!(subpath, ctx);
        return { type: "file", size: Buffer.byteLength(r.content, "utf8"), mtime: Date.now() };
      }

      // Otherwise, verify via readdir of the parent.
      const parent = "/" + segs.slice(0, -1).join("/");
      const entries = await this.readdir!(parent, ctx);
      const child = entries.find((e) => e.name === segs[segs.length - 1]);
      if (!child) throw new VfsError("ENOENT", subpath);
      return { type: child.type, size: 0, mtime: Date.now() };
    },

    async search(req: SearchRequest, _ctx: VfsContext): Promise<SearchHit[] | null> {
      // JSONPlaceholder has no search endpoint — we do a small, bounded scan.
      const qre = new RegExp(req.query, req.caseInsensitive ? "i" : "");
      const hits: SearchHit[] = [];
      const cap = req.maxHits ?? 20;

      const posts = await getJson<Post[]>("/posts");
      for (const p of posts) {
        if (qre.test(p.title) || qre.test(p.body)) {
          hits.push({
            path: `/posts/${p.id}.md`,
            snippet: p.title,
          });
          if (hits.length >= cap) break;
        }
      }
      return hits;
    },
  });
}
