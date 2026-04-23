/**
 * Fastify HTTP bridge for non-TS Agent frameworks (CrewAI, LangChain Python, ...).
 *
 * Endpoints (all JSON):
 *   POST /v1/bash       { command }          -> { stdout, stderr, exitCode }
 *   POST /v1/fs/ls      { path }             -> { entries: DirentEntry[] }
 *   POST /v1/fs/cat     { path }             -> { content }
 *   POST /v1/fs/grep    { pattern, path, ignoreCase?, regex?, listFilesOnly? }
 *   GET  /v1/health
 *
 * Auth (optional): `X-VFS-Session: <token>` compared to VFS_SESSION_TOKEN env.
 */

import Fastify from "fastify";
import cors from "@fastify/cors";
import { createBackend } from "./backend/factory.js";
import { createShell } from "./shell.js";

const MOUNT = process.env.VFS_MOUNT ?? "/docs";
const PORT = Number(process.env.VFS_PORT ?? 7801);
const TOKEN = process.env.VFS_SESSION_TOKEN;

const { store, label: backendLabel } = createBackend();
const { bash, vfs } = createShell({ store, mountPoint: MOUNT });

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });
await app.register(cors, { origin: true });

app.addHook("onRequest", async (req, reply) => {
  if (!TOKEN) return;
  const header = req.headers["x-vfs-session"];
  if (header !== TOKEN) {
    reply.code(401).send({ error: "unauthorized" });
  }
});

app.get("/v1/health", async () => ({ ok: true, mount: MOUNT, backend: backendLabel }));

app.post<{ Body: { command: string } }>(
  "/v1/bash",
  async (req, reply) => {
    const { command } = req.body ?? ({} as { command: string });
    if (typeof command !== "string") {
      return reply.code(400).send({ error: "command must be a string" });
    }
    const r = await bash.exec(command);
    return { stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode };
  },
);

app.post<{ Body: { path: string } }>(
  "/v1/fs/ls",
  async (req, reply) => {
    const { path: p } = req.body ?? ({} as { path: string });
    if (typeof p !== "string") return reply.code(400).send({ error: "path required" });
    try {
      const entries = await vfs.readdirWithFileTypes(vfs.toMountRelative(p));
      return { entries };
    } catch (e) {
      return reply
        .code(404)
        .send({ error: (e as Error).message, code: (e as { code?: string }).code });
    }
  },
);

app.post<{ Body: { path: string } }>(
  "/v1/fs/cat",
  async (req, reply) => {
    const { path: p } = req.body ?? ({} as { path: string });
    if (typeof p !== "string") return reply.code(400).send({ error: "path required" });
    try {
      const content = await vfs.readFile(vfs.toMountRelative(p), "utf8");
      return { content };
    } catch (e) {
      return reply
        .code(404)
        .send({ error: (e as Error).message, code: (e as { code?: string }).code });
    }
  },
);

app.post<{
  Body: {
    pattern: string;
    path?: string;
    ignoreCase?: boolean;
    regex?: boolean;
    listFilesOnly?: boolean;
  };
}>("/v1/fs/grep", async (req, reply) => {
  const { pattern, path: p, ignoreCase, regex, listFilesOnly } = req.body ?? {};
  if (typeof pattern !== "string") {
    return reply.code(400).send({ error: "pattern required" });
  }
  // grep runs inside the shell sandbox — it expects a shell-absolute path.
  // Accept both mount-rooted and mount-relative inputs by promoting the latter.
  const target = resolveShellPath(p ?? MOUNT, MOUNT);
  const flags: string[] = ["-rn"];
  if (ignoreCase) flags.push("-i");
  if (listFilesOnly) flags.push("-l");
  if (regex === false) flags.push("-F");
  const cmd = `grep ${flags.join(" ")} ${shellQuote(pattern)} ${shellQuote(target)}`;
  const r = await bash.exec(cmd);
  return { stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode };
});

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Turn a caller path into a shell-absolute path. If the caller passed a
 * mount-relative path (e.g. `auth/oauth.md` or `/auth/oauth.md`), prepend the
 * mount. Paths already rooted at the mount pass through unchanged.
 */
function resolveShellPath(p: string, mount: string): string {
  const norm = p.startsWith("/") ? p : "/" + p;
  if (mount === "/" || mount === "") return norm;
  if (norm === mount || norm.startsWith(mount + "/")) return norm;
  // Treat as mount-relative.
  return mount + norm;
}

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
