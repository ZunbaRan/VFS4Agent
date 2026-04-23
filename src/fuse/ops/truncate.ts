import Fuse from "fuse-native";
import { getHandle } from "../context.js";

/**
 * truncate / ftruncate — only valid on writable handles (i.e. /search/last_query).
 * For everything else return EROFS.
 */
export function truncate(path: string, size: number, cb: (err: number) => void): void {
  if (path !== "/search/last_query") return cb(Fuse.EROFS);
  // Path-level truncate without an open fd: nothing in-flight to resize.
  if (size !== 0) return cb(0);
  cb(0);
}

export function ftruncate(
  path: string,
  fd: number,
  size: number,
  cb: (err: number) => void,
): void {
  const h = getHandle(fd);
  if (!h || !h.writable) return cb(Fuse.EROFS);
  h.content = h.content.slice(0, size);
  cb(0);
}
