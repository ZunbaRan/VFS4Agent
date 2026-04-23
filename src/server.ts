/**
 * Optional HTTP bridge for non-TS Agent frameworks (CrewAI, LangChain Python, ...).
 *
 * In the FUSE-first architecture this server is a thin wrapper over the
 * VectorStore — it does NOT spawn a shell or interact with the FUSE mount.
 * Frameworks that want bash semantics should run inside the same container as
 * the FUSE mount and shell out directly. This bridge is for use cases where
 * the agent only needs cheap read access (ls/cat/search).
 */

import "dotenv/config";
import Fastify from "fastify";
import cors from "@fastify/cors";
import { createBackend } from "./backend/factory.js";
import {
  assembleChunks,
  fusePathToSlug,
  getDirectoryEntries,
  isDirectoryInTree,
} from "./fuse/helpers.js";

const PORT = Number(process.env.VFS_PORT ?? 7801);
const TOKEN = process.env.VFS_SESSION_TOKEN;

const { store, label: backendLabel } = createBackend();

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });
await app.register(cors, { origin: true });

app.addHook("onRequest", async (req, reply) => {
  if (!TOKEN) return;
  if (req.headers["x-vfs-session"] !== TOKEN) {
    reply.code(401).send({ error: "unauthorized" });
  }
});

app.get("/v1/health", async () => ({ ok: true, backend: backendLabel }));

app.post<{ Body: { path: string } }>("/v1/fs/ls", async (req, reply) => {
  const p = req.body?.path;
  if (typeof p !== "string") return reply.code(400).send({ error: "path required" });
  const tree = await store.getPathTree();
  const slug = fusePathToSlug(p);
  if (slug !== "" && !isDirectoryInTree(slug, tree) && !tree[slug]) {
    return reply.code(404).send({ error: "ENOENT" });
  }
  return { entries: getDirectoryEntries(slug, tree) };
});

app.post<{ Body: { path: string } }>("/v1/fs/cat", async (req, reply) => {
  const p = req.body?.path;
  if (typeof p !== "string") return reply.code(400).send({ error: "path required" });
  const slug = fusePathToSlug(p);
  const tree = await store.getPathTree();
  if (!tree[slug]) return reply.code(404).send({ error: "ENOENT" });
  const chunks = await store.getChunksByPage(slug);
  return { content: assembleChunks(chunks) };
});

app.post<{
  Body: {
    pattern: string;
    prefix?: string;
    ignoreCase?: boolean;
    regex?: boolean;
    limit?: number;
  };
}>("/v1/fs/grep", async (req, reply) => {
  const { pattern, prefix, ignoreCase, regex, limit } = req.body ?? {};
  if (typeof pattern !== "string") return reply.code(400).send({ error: "pattern required" });
  const slugs = await store.searchText({
    pattern,
    pathPrefix: prefix,
    ignoreCase,
    regex,
    limit: limit ?? 50,
  });
  return { slugs };
});

app
  .listen({ port: PORT, host: "0.0.0.0" })
  .then((addr) => app.log.info(`vfs-server listening on ${addr}`))
  .catch((e) => {
    app.log.error(e);
    process.exit(1);
  });

process.on("SIGINT", async () => {
  await app.close();
  store.close();
  process.exit(0);
});
