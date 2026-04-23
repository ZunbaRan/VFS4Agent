import { getHandle } from "../context.js";

/**
 * Read bytes [pos, pos+len) from the in-memory buffer associated with `fd`.
 * The callback is the unusual fuse-native single-arg form: cb(bytesRead).
 */
export function read(
  _path: string,
  fd: number,
  buf: Buffer,
  len: number,
  pos: number,
  cb: (bytesRead: number) => void,
): void {
  const h = getHandle(fd);
  if (!h) return cb(0);
  const data = Buffer.from(h.content, "utf8");
  if (pos >= data.length) return cb(0);
  const end = Math.min(pos + len, data.length);
  const slice = data.subarray(pos, end);
  slice.copy(buf, 0, 0, slice.length);
  cb(slice.length);
}
