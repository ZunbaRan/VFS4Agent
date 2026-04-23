import nodePath from "node:path";
import Fuse from "fuse-native";
import { getEmailByPath, emailToFilename, VIRTUAL_FOLDERS } from "../helpers.js";


/**
 * Resolving symlinks (used for virtual folders)
 */
export async function readlink(path: string, cb: (err: number, linkPath?: string) => void) {
  const lastSlash = path.lastIndexOf("/");
  const dirPath = lastSlash === 0 ? "/" : path.slice(0, lastSlash);

  if (!VIRTUAL_FOLDERS[dirPath]) {
    return cb(Fuse.EINVAL);
  }

  const email = await getEmailByPath(path);
  if (!email) {
    return cb(Fuse.ENOENT);
  }

  const targetPath = nodePath.posix.join(email.folderPath, emailToFilename(email));
  const relativePath = nodePath.posix.relative(dirPath, targetPath);
  cb(0, relativePath);
}
