import Fuse from "fuse-native";
import { allocHandle } from "../context.js";

/**
 * `create` is invoked when an app does `open(path, O_CREAT|O_WRONLY)` on a
 * non-existent file. We only allow creation of /search/last_query (re-create
 * is a no-op write target).
 */
export function create(path: string, _mode: number, cb: (err: number, fd?: number) => void): void {
  if (path !== "/search/last_query") return cb(Fuse.EROFS);
  const fd = allocHandle({ path, content: "", writable: true, searchQueryWrite: true });
  cb(0, fd);
}
