/**
 * HTTP sandbox service — mounts FUSE in-process, exposes POST /v1/bash.
 */

import "dotenv/config";
import Fastify from "fastify";
import cors from "@fastify/cors";
import * as fsp from "node:fs/promises";
import * as path from "node:path";

import { createBackend } from "./backend/factory.js";
import { mount } from "./fuse/index.js";
import { createBashRunner } from "./agent/bash.js";
import { buildRegistryFromEnv } from "./agent/commands/index.js";
import type { Mount } from "./fuse/index.js";

const PORT = Number(process.env.VFS_PORT ?? 7801);
const MOUNT_POINT = process.env.VFS_MOUNT ?? "/vfs";
const TOKEN = process.env.VFS_SESSION_TOKEN;

const startedAt = Date.now();
const { store, label: backendLabel } = createBackend();
const registry = buildRegistryFromEnv(process.env.VFS_OPTIMIZERS);

console.log(`[server] backend=${backendLabel}`);
console.log(`[server] optimizers=${registry.list().length > 0 ? registry.list().join(",") : "none"}`);
console.log(`[server] mounting FUSE at ${MOUNT_POINT}...`);

const mountInstance: Mount = await mount({ store, mountPoint: MOUNT_POINT });
console.log(`[server] FUSE mounted.`);

const exec = createBashRunner({
  cwd: MOUNT_POINT,
  registry,
  store,
  logger: (m) => console.log(m),
});

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });
await app.register(cors, { origin: true });

app.addHook("onRequest", async (req, reply) => {
  if (!TOKEN) return;
  if (req.headers["x-vfs-session"] !== TOKEN) {
    reply.code(401).send({ error: "unauthorized" });
  }
});

app.get("/v1/health", async () => ({
  status: "ok",
  backend: backendLabel,
  mount: MOUNT_POINT,
  optimizers: registry.list(),
  uptime: Math.round((Date.now() - startedAt) / 1000),
}));

app.post<{ Body: { command?: string } }>("/v1/bash", async (req, reply) => {
  const command = req.body?.command;
  if (typeof command !== "string" || !command.trim()) {
    return reply.code(400).send({ error: "missing 'command' in body" });
  }
  const t0 = Date.now();
  const result = await exec(command);
  app.log.info({ cmd: command.slice(0, 80), exit: result.exitCode, ms: Date.now() - t0 }, "/v1/bash");
  return result;
});

function resolveMountPath(p: string): string {
  const clean = p.startsWith("/") ? p.slice(1) : p;
  const abs = path.resolve(MOUNT_POINT, clean);
  if (!abs.startsWith(MOUNT_POINT)) throw new Error("path traversal rejected");
  return abs;
}

app.post<{ Body: { path?: string } }>("/v1/fs/ls", async (req, reply) => {
  const p = req.body?.path;
  if (typeof p !== "string") return reply.code(400).send({ error: "path required" });
  try {
    const entries = await fsp.readdir(resolveMountPath(p));
    return { entries };
  } catch (e: unknown) {
    return reply.code(404).send({ error: (e as Error).message });
  }
});

app.post<{ Body: { path?: string } }>("/v1/fs/cat", async (req, reply) => {
  const p = req.body?.path;
  if (typeof p !== "string") return reply.code(400).send({ error: "path required" });
  try {
    const content = await fsp.readFile(resolveMountPath(p), "utf8");
    return { content };
  } catch (e: unknown) {
    return reply.code(404).send({ error: (e as Error).message });
  }
});

app.post<{ Body: { pattern?: string; prefix?: string; ignoreCase?: boolean; regex?: boolean; limit?: number } }>(
  "/v1/fs/grep",
  async (req, reply) => {
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
  },
);

await app.listen({ port: PORT, host: "0.0.0.0" });
console.log(`[server] listening on :${PORT}`);

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[server] received ${signal}, shutting down...`);
  try { await app.close(); } catch (e) { console.error("[server] app.close:", (e as Error).message); }
  try { await mountInstance.unmount(); } catch (e) { console.error("[server] unmount:", (e as Error).message); }
  try { store.close(); } catch (e) { console.error("[server] store.close:", (e as Error).message); }
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
