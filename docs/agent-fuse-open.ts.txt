import Fuse from "fuse-native";
import { getEmailByPath } from "../helpers.js";

/**
 * Opening an email file, returns existing id as file descriptor.
 */
export async function open(path: string, flags: number, cb: (err: number, fd?: number) => void) {
  const email = await getEmailByPath(path);
  if (!email) {
    return cb(Fuse.ENOENT);
  }
  cb(0, email.id);
}
