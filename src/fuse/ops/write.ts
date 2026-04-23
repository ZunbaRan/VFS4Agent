import Fuse from "fuse-native";
import { getHandle } from "../context.js";

/**
 * Only /search/last_query is writable. Everything else returns EROFS.
 * The callback is the fuse-native single-arg form: cb(bytesWritten).
 * Use a negative value (e.g. -EROFS) to surface an error.
 */
export function write(
  _path: string,
  fd: number,
  buf: Buffer,
  len: number,
  pos: number,
  cb: (bytesWritten: number) => void,
): void {
  const h = getHandle(fd);
  if (!h || !h.writable) return cb(-Fuse.EROFS);

  const incoming = buf.slice(0, len).toString("utf8");
  if (pos === 0 && (h.content === "" || incoming.length >= h.content.length)) {
    h.content = incoming;
  } else {
    const before = h.content.slice(0, pos);
    const after = h.content.slice(pos + incoming.length);
    h.content = before + incoming + after;
  }
  cb(len);
}
