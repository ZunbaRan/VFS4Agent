import Fuse from "fuse-native";
import { emailToContent, getEmailById } from "../helpers.js";

/**
 * Read an email file, constructs our representation of the email.
 */
export async function read(path: string, fd: number, buf: Buffer, len: number, pos: number, cb: (err: number) => void) {
  const email = await getEmailById(fd);
  if (!email) {
    return cb(Fuse.ENOENT);
  }
  const content = emailToContent(email);
  const slice = content.slice(pos, pos + len);
  const bytesRead = buf.write(slice);
  cb(bytesRead);
}
