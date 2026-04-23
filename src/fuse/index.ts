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
