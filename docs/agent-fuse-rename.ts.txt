import Fuse from "fuse-native";
import { eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { emailsTable } from "../../db/schema.js";
import { getEmailByPath, getFolder, VIRTUAL_FOLDERS } from "../helpers.js";

/**
 * Moving email between folders.
 */
export async function rename(src: string, dest: string, cb: (err: number) => void) {
  const srcLastSlash = src.lastIndexOf("/");
  const srcDir = srcLastSlash === 0 ? "/" : src.slice(0, srcLastSlash);

  const destLastSlash = dest.lastIndexOf("/");
  const destDir = destLastSlash === 0 ? "/" : dest.slice(0, destLastSlash);

  if (VIRTUAL_FOLDERS[srcDir]) {
    return cb(Fuse.EPERM);
  }

  if (VIRTUAL_FOLDERS[destDir]) {
    return cb(Fuse.EPERM);
  }

  const email = await getEmailByPath(src);
  if (!email) {
    return cb(Fuse.ENOENT);
  }

  const destFolder = await getFolder(destDir);
  if (!destFolder) {
    return cb(Fuse.ENOENT);
  }

  await db.update(emailsTable).set({ folderId: destFolder.id }).where(eq(emailsTable.id, email.id));
  cb(0);
}
