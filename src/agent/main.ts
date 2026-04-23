/**
 * Agent entrypoint: create backend -> mount FUSE -> start REPL.
 *
 * Env:
 *   VFS_MODE             embedded | server   (default: embedded)
 *                        - embedded: mount FUSE + run REPL in this process.
 *                        - server:   delegate to `pnpm server` (HTTP sandbox).
 *   VFS_BACKEND          chroma | sqlite     (default via factory)
 *   VFS_MOUNT            /vfs                (default; overridable for local dev)
 *   VFS_OPTIMIZERS       ""|none|all|csv     (default "" = no optimizers)
 *                        e.g. "grep,find,tree"
 *   OPENAI_API_KEY / OPENAI_BASE_URL / OPENAI_MODEL
 *   DASHSCOPE_API_KEY / DASHSCOPE_BASE_URL / QWEN_MODEL  (alt)
 */

import "dotenv/config";
import { createBackend } from "../backend/factory.js";
import { mount } from "../fuse/index.js";
import { startRepl } from "./repl.js";
import { buildRegistryFromEnv } from "./commands/index.js";

function pickEnv(...names: string[]): string | undefined {
  for (const n of names) {
    const v = process.env[n];
    if (v && v.trim()) return v.trim();
  }
  return undefined;
}

async function main(): Promise<void> {
  const mode = (process.env.VFS_MODE ?? "embedded").toLowerCase();

  if (mode === "server") {
    console.log(
      "vfs4agent: VFS_MODE=server — this entrypoint is for embedded mode only.\n" +
        "  Run the HTTP sandbox with:   pnpm server\n" +
        "  (mounts FUSE + exposes POST /v1/bash and /v1/fs/* endpoints).",
    );
    process.exit(0);
  }

  if (mode !== "embedded") {
    console.error(`vfs4agent: unknown VFS_MODE=${mode}. Use 'embedded' or 'server'.`);
    process.exit(2);
  }

  const mountPoint = process.env.VFS_MOUNT ?? "/vfs";
  const { store, label } = createBackend();
  const registry = buildRegistryFromEnv(process.env.VFS_OPTIMIZERS);

  console.log(`vfs4agent: backend=${label}`);
  console.log(`vfs4agent: mounting FUSE at ${mountPoint}`);
  console.log(
    `vfs4agent: optimizers=${registry.list().length > 0 ? registry.list().join(",") : "none"}`,
  );

  const m = await mount({ store, mountPoint });

  const cleanup = async () => {
    console.log("\nvfs4agent: unmounting...");
    await m.unmount();
    store.close();
    process.exit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  const apiKey = pickEnv("OPENAI_API_KEY", "DASHSCOPE_API_KEY");
  if (!apiKey) {
    console.warn(
      "[warn] OPENAI_API_KEY (or DASHSCOPE_API_KEY) not set — FUSE is mounted but REPL will fail.",
    );
    console.warn(`       Inspect manually: ls ${mountPoint}/  ;  cat ${mountPoint}/...`);
    console.warn(`       Press Ctrl+C to unmount and exit.`);
    await new Promise(() => {});
    return;
  }

  const model = pickEnv("OPENAI_MODEL", "QWEN_MODEL") ?? "gpt-4o-mini";
  const baseURL = pickEnv("OPENAI_BASE_URL", "DASHSCOPE_BASE_URL");

  await startRepl({ cwd: mountPoint, model, baseURL, apiKey, registry, store });
  await cleanup();
}

main().catch((e) => {
  console.error("vfs4agent failed:", e);
  process.exit(1);
});
