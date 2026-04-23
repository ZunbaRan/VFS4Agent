/**
 * Agent entrypoint: ingest config -> mount FUSE -> start REPL.
 *
 * Env:
 *   VFS_BACKEND          chroma | sqlite      (default: chroma)
 *   VFS_MOUNT            /vfs                 (default; overridable for local dev)
 *   OPENAI_API_KEY       required for the REPL
 *   OPENAI_BASE_URL      optional (e.g. https://dashscope.aliyuncs.com/compatible-mode/v1)
 *   OPENAI_MODEL         default "gpt-4o-mini"
 *   DASHSCOPE_API_KEY / DASHSCOPE_BASE_URL / QWEN_MODEL — alt env names also accepted
 */

import "dotenv/config";
import { createBackend } from "../backend/factory.js";
import { mount } from "../fuse/index.js";
import { startRepl } from "./repl.js";

function pickEnv(...names: string[]): string | undefined {
  for (const n of names) {
    const v = process.env[n];
    if (v && v.trim()) return v.trim();
  }
  return undefined;
}

async function main(): Promise<void> {
  const mountPoint = process.env.VFS_MOUNT ?? "/vfs";
  const { store, label } = createBackend();

  console.log(`vfs4agent: backend=${label}`);
  console.log(`vfs4agent: mounting FUSE at ${mountPoint}`);

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
    // Park forever so the user can poke at the mount.
    await new Promise(() => {});
    return;
  }

  const model = pickEnv("OPENAI_MODEL", "QWEN_MODEL") ?? "gpt-4o-mini";
  const baseURL = pickEnv("OPENAI_BASE_URL", "DASHSCOPE_BASE_URL");

  await startRepl({ cwd: mountPoint, model, baseURL, apiKey });
  await cleanup();
}

main().catch((e) => {
  console.error("vfs4agent failed:", e);
  process.exit(1);
});
