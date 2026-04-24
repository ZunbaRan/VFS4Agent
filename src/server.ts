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
import { loadConfigFromFile } from "./config/loader.js";
import { buildRouterFromConfig } from "./config/plugin-loader.js";
import { MountRouter } from "./provider/router.js";
import { VectorStoreProvider } from "./provider/vector-store-provider.js";
import type { VectorStore } from "./types.js";

const PORT = Number(process.env.VFS_PORT ?? 7801);
const MOUNT_POINT = process.env.VFS_MOUNT ?? "/vfs";
const TOKEN = process.env.VFS_SESSION_TOKEN;
const CONFIG_PATH = process.env.VFS_CONFIG;

const startedAt = Date.now();

// Path A (default): single backend → wrapped as a root-mounted VectorStoreProvider.
// Path B (VFS_CONFIG set): load providers from a YAML/JSON config.
let router: MountRouter;
let primaryStore: VectorStore | null = null;
let backendLabel: string;

if (CONFIG_PATH) {
  console.log(`[server] loading providers from ${CONFIG_PATH}`);
  const cfg = await loadConfigFromFile(CONFIG_PATH);
  const baseDir = path.dirname(path.resolve(CONFIG_PATH));
  router = await buildRouterFromConfig(cfg, { baseDir });
  backendLabel = `config:${cfg.providers.map((p) => `${p.name}@${p.mountPrefix}`).join(",")}`;
} else {
  const created = createBackend();
  primaryStore = created.store;
  backendLabel = created.label;
  router = new MountRouter();
  router.mount(new VectorStoreProvider(created.store, { mountPrefix: "/" }));
}

const registry = buildRegistryFromEnv(process.env.VFS_OPTIMIZERS);

console.log(`[server] backend=${backendLabel}`);
console.log(`[server] optimizers=${registry.list().length > 0 ? registry.list().join(",") : "none"}`);
console.log(`[server] mounting FUSE at ${MOUNT_POINT}...`);

const mountInstance: Mount = await mount({ router, mountPoint: MOUNT_POINT });
console.log(`[server] FUSE mounted.`);

const exec = createBashRunner({
  cwd: MOUNT_POINT,
  registry,
  // Legacy optimizers still want a store reference; pass the primary one if we
  // have it, otherwise a null-shaped fallback (grep_optimizer will skip).
  store: primaryStore ?? ({ capabilities: {} } as VectorStore),
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
    const hits = await router.search(
      {
        query: pattern,
        subpath: prefix ? (prefix.startsWith("/") ? prefix : "/" + prefix) : "/",
        regex,
        caseInsensitive: ignoreCase,
        maxHits: limit ?? 50,
      },
      { sessionId: "http" },
    );
    // Legacy shape preserved: return slugs (path w/o leading "/").
    const slugs = (hits ?? []).map((h) =>
      h.path.startsWith("/") ? h.path.slice(1) : h.path,
    );
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
  try { await router.close(); } catch (e) { console.error("[server] router.close:", (e as Error).message); }
  if (primaryStore) {
    try { primaryStore.close(); } catch (e) { console.error("[server] store.close:", (e as Error).message); }
  }
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
