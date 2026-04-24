import Fuse from "fuse-native";
import { getRouter, getVfsContext } from "../context.js";
import { isVfsError } from "../../provider/types.js";
import { listResultFilenames } from "../search.js";

const TOP_LEVEL_VIRTUAL = ["search"];

export async function readdir(path: string, cb: (err: number, names?: string[]) => void): Promise<void> {
  try {
    // Virtual /search tree
    if (path === "/search") return cb(0, ["last_query", "results"]);
    if (path === "/search/results") return cb(0, listResultFilenames());
    if (path.startsWith("/search/")) return cb(Fuse.ENOTDIR);

    const router = getRouter();
    const ctx = getVfsContext();

    if (path === "/") {
      const entries = await router.readdir("/", ctx);
      const out = new Set<string>(TOP_LEVEL_VIRTUAL);
      for (const e of entries) out.add(e.name);
      return cb(0, Array.from(out));
    }

    const entries = await router.readdir(path, ctx);
    cb(0, entries.map((e) => e.name));
  } catch (e) {
    if (isVfsError(e)) {
      if (e.code === "ENOENT") return cb(Fuse.ENOENT);
      if (e.code === "ENOTDIR") return cb(Fuse.ENOTDIR);
      if (e.code === "EACCES") return cb(Fuse.EACCES);
    }
    console.error("[fuse] readdir error:", path, (e as Error).message);
    cb(Fuse.EIO);
  }
}
