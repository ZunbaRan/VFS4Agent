/**
 * FUSE mount entrypoint.
 *
 * ⚠️ DEADLOCK WARNING ⚠️
 * Never use execSync/spawnSync or any blocking subprocess API to run commands
 * that access the mount point from the SAME process that owns the FUSE mount.
 *
 * Why: FUSE callbacks (getattr/readdir/read/...) run on the Node.js event loop.
 * If you block the event loop with a Sync call, the FUSE callback can never
 * respond to kernel requests → permanent deadlock.
 *
 * ✅ Use spawn() (async) — see src/agent/bash.ts
 * ❌ Never use execSync()/spawnSync() in the mount-owner process
 *
 * For testing, use process isolation: mount in a detached container,
 * then `docker exec` to run bash commands.
 */
import * as fs from "node:fs";
import Fuse from "fuse-native";
import type { VectorStore } from "../types.js";
import { ops } from "./ops/index.js";
import { initContext } from "./context.js";

export interface MountOptions {
  store: VectorStore;
  /** Mount point (must already exist or `mkdir: true` will create it). */
  mountPoint: string;
  debug?: boolean;
  /** Allow other users to access the mount (requires user_allow_other in fuse.conf). */
  allowOther?: boolean;
}

export interface Mount {
  mountPoint: string;
  unmount: () => Promise<void>;
}

export async function mount(opts: MountOptions): Promise<Mount> {
  const { store, mountPoint, debug = false, allowOther = false } = opts;

  initContext(store);

  fs.mkdirSync(mountPoint, { recursive: true });

  const fuse = new Fuse(mountPoint, ops, {
    debug,
    force: true,
    mkdir: true,
    allowOther,
    autoUnmount: true,
    displayFolder: true,
  });

  await new Promise<void>((resolve, reject) => {
    fuse.mount((err) => (err ? reject(err) : resolve()));
  });

  const unmount = () =>
    new Promise<void>((resolve) => {
      fuse.unmount((err) => {
        if (err) console.error("[fuse] unmount error:", err.message);
        resolve();
      });
    });

  return { mountPoint, unmount };
}
