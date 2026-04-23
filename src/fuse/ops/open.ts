import Fuse from "fuse-native";
import {
  allocHandle,
  getCachedContent,
  getContext,
  getPathTree,
  setCachedContent,
} from "../context.js";
import { fusePathToSlug, assembleChunks } from "../helpers.js";
import { getResultByPath, isResultPath, getLastQueryContent } from "../search.js";

// POSIX flag bits we care about.
const O_ACCMODE = 0o0003;
const O_RDONLY = 0o0000;
const O_WRONLY = 0o0001;
const O_RDWR = 0o0002;
const O_TRUNC = 0o1000;

function accessMode(flags: number): "r" | "w" | "rw" {
  const mode = flags & O_ACCMODE;
  if (mode === O_WRONLY) return "w";
  if (mode === O_RDWR) return "rw";
  return "r";
}

export async function open(
  path: string,
  flags: number,
  cb: (err: number, fd?: number) => void,
): Promise<void> {
  try {
    const mode = accessMode(flags);

    // /search/last_query — readable AND writable.
    if (path === "/search/last_query") {
      const writable = mode !== "r";
      const truncate = (flags & O_TRUNC) !== 0;
      const initial = writable && (truncate || mode === "w") ? "" : getLastQueryContent();
      const fd = allocHandle({
        path,
        content: initial,
        writable,
        searchQueryWrite: writable,
      });
      return cb(0, fd);
    }

    // /search/results/<filename> — read-only virtual files.
    if (isResultPath(path)) {
      if (mode !== "r") return cb(Fuse.EROFS);
      const r = getResultByPath(path);
      if (!r) return cb(Fuse.ENOENT);
      const fd = allocHandle({
        path,
        content: r.content,
        writable: false,
        searchQueryWrite: false,
      });
      return cb(0, fd);
    }

    if (path.startsWith("/search/")) return cb(Fuse.ENOENT);

    // PathTree-backed file — read-only.
    if (mode !== "r") return cb(Fuse.EROFS);

    const slug = fusePathToSlug(path);
    const tree = await getPathTree();
    if (!tree[slug]) return cb(Fuse.ENOENT);

    let content = getCachedContent(slug);
    if (content === undefined) {
      const chunks = await getContext().store.getChunksByPage(slug);
      content = assembleChunks(chunks);
      setCachedContent(slug, content);
    }

    const fd = allocHandle({ path, content, writable: false, searchQueryWrite: false });
    cb(0, fd);
  } catch (e) {
    console.error("[fuse] open error:", path, (e as Error).message);
    cb(Fuse.EIO);
  }
}
