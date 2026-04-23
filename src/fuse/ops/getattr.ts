import Fuse from "fuse-native";
import { fusePathToSlug, isDirectoryInTree, utf8ByteLength, assembleChunks } from "../helpers.js";
import { getCachedContent, getContext, getPathTree, setCachedContent } from "../context.js";
import {
  getLastQueryMtime,
  getLastQuerySize,
  getResultByPath,
  isResultPath,
  listResultFilenames,
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

function fileStat(size: number, mtime: Date, writable = false): any {
  return {
    mtime,
    atime: mtime,
    ctime: mtime,
    size,
    mode: writable ? 0o100644 : 0o100644,
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
      return cb(0, fileStat(getLastQuerySize(), getLastQueryMtime(), true));
    }
    if (isResultPath(path)) {
      const r = getResultByPath(path);
      if (!r) return cb(Fuse.ENOENT);
      return cb(0, fileStat(utf8ByteLength(r.content), getLastQueryMtime()));
    }
    if (path.startsWith("/search/")) return cb(Fuse.ENOENT);

    // 3. PathTree-backed paths.
    const tree = await getPathTree();
    const slug = fusePathToSlug(path);

    const entry = tree[slug];
    if (entry) {
      const mtime = entry.mtime ? new Date(entry.mtime) : new Date();
      let size = entry.size;
      if (size === undefined) {
        // Fall back to assembling chunks once and caching.
        const cached = getCachedContent(slug);
        if (cached !== undefined) {
          size = utf8ByteLength(cached);
        } else {
          const chunks = await getContext().store.getChunksByPage(slug);
          const content = assembleChunks(chunks);
          setCachedContent(slug, content);
          size = utf8ByteLength(content);
        }
      }
      return cb(0, fileStat(size, mtime));
    }

    if (isDirectoryInTree(slug, tree)) return cb(0, dirStat());

    return cb(Fuse.ENOENT);
  } catch (e) {
    console.error("[fuse] getattr error:", path, (e as Error).message);
    cb(Fuse.EIO);
  }
}
