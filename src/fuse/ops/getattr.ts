import Fuse from "fuse-native";
import { utf8ByteLength } from "../helpers.js";
import {
  getCachedContent,
  getRouter,
  getVfsContext,
  setCachedContent,
} from "../context.js";
import { isVfsError } from "../../provider/types.js";
import {
  getLastQueryMtime,
  getLastQuerySize,
  getResultByPath,
  isResultPath,
} from "../search.js";

const VIRTUAL_DIRS = new Set(["/", "/search", "/search/results"]);

function dirStat(mtime: Date = new Date()): any {
  return {
    mtime,
    atime: mtime,
    ctime: mtime,
    size: 4096,
    mode: 0o40755,
    uid: process.getuid?.() ?? 0,
    gid: process.getgid?.() ?? 0,
    nlink: 2,
  };
}

function fileStat(size: number, mtime: Date): any {
  return {
    mtime,
    atime: mtime,
    ctime: mtime,
    size,
    mode: 0o100644,
    uid: process.getuid?.() ?? 0,
    gid: process.getgid?.() ?? 0,
    nlink: 1,
  };
}

export async function getattr(path: string, cb: (err: number, stat?: any) => void): Promise<void> {
  try {
    // 1. Virtual directories.
    if (VIRTUAL_DIRS.has(path)) return cb(0, dirStat());

    // 2. Search special files.
    if (path === "/search/last_query") {
      return cb(0, fileStat(getLastQuerySize(), getLastQueryMtime()));
    }
    if (isResultPath(path)) {
      const r = getResultByPath(path);
      if (!r) return cb(Fuse.ENOENT);
      return cb(0, fileStat(utf8ByteLength(r.content), getLastQueryMtime()));
    }
    if (path.startsWith("/search/")) return cb(Fuse.ENOENT);

    // 3. Provider-backed paths via router.
    const router = getRouter();
    const ctx = getVfsContext();
    const stat = await router.stat(path, ctx);
    const mtime = stat.mtime ? new Date(stat.mtime) : new Date();

    if (stat.type === "dir") return cb(0, dirStat(mtime));

    // File: if size is unknown (or 0 but might be nonzero), read content once
    // and cache so subsequent open() doesn't repeat the work.
    let size = stat.size;
    if (!size || size === 0) {
      const cached = getCachedContent(path);
      if (cached !== undefined) {
        size = utf8ByteLength(cached);
      } else {
        try {
          const r = await router.read(path, ctx);
          setCachedContent(path, r.content);
          size = r.size ?? utf8ByteLength(r.content);
        } catch {
          size = 0;
        }
      }
    }
    return cb(0, fileStat(size, mtime));
  } catch (e) {
    if (isVfsError(e)) {
      if (e.code === "ENOENT") return cb(Fuse.ENOENT);
      if (e.code === "EACCES") return cb(Fuse.EACCES);
      if (e.code === "ENOTDIR") return cb(Fuse.ENOTDIR);
      if (e.code === "EISDIR") return cb(Fuse.EISDIR);
    }
    console.error("[fuse] getattr error:", path, (e as Error).message);
    cb(Fuse.EIO);
  }
}
