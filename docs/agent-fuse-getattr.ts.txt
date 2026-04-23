import nodePath from "node:path";
import Fuse from "fuse-native";
import { isDirectory, getEmailByPath, emailToContent, emailToFilename, VIRTUAL_FOLDERS } from "../helpers.js";

/**
 * Getting file attributes.
 * Needs to handle both files, folders and symlinks.
 */
export async function getattr(path: string, cb: (err: number, stat?: any) => void) {
  const isDir = await isDirectory(path);

  if (isDir) {
    return cb(0, {
      mtime: new Date(),
      atime: new Date(),
      ctime: new Date(),
      size: 4096, // made up value
      mode: 0o40755,
    });
  }
  
  const email = await getEmailByPath(path);

  if (!email) {
    return cb(Fuse.ENOENT);
  }

  const lastSlash = path.lastIndexOf("/");
  const dirPath = lastSlash === 0 ? "/" : path.slice(0, lastSlash);
  const isSymlink = email && VIRTUAL_FOLDERS[dirPath];

  let mode: number;
  let size: number;

  if (isSymlink) {
    mode = 0o120777;
    const fullTarget = nodePath.posix.join(email.folderPath, emailToFilename(email));
    const targetPath = nodePath.posix.relative(dirPath, fullTarget);
    size = Buffer.byteLength(targetPath);
  } else {
    mode = 0o100644;
    size = Buffer.byteLength(emailToContent(email!));
  }

  cb(0, {
    mtime: email.sentAt,
    atime: email.sentAt,
    ctime: email.sentAt,
    size: size,
    mode: mode,
    uid: process.getuid(),
    gid: process.getgid(),
    nlink: 1,
  });
}
