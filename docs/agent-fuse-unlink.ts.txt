import Fuse from "fuse-native";
import { eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { emailsTable } from "../../db/schema.js";
import { getEmailByPath, VIRTUAL_FOLDERS } from "../helpers.js";

/**
 * Remove symlink from an email,
 * this means unsetting an attribute like 'starred' or 'needsAction'
 */
export async function unlink(path: string, cb: (err: number) => void) {
  const lastSlash = path.lastIndexOf("/");
  const dirPath = lastSlash === 0 ? "/" : path.slice(0, lastSlash);

  if (!VIRTUAL_FOLDERS[dirPath]) {
    return cb(Fuse.EPERM);
  }

  const email = await getEmailByPath(path);
  if (!email) {
    return cb(Fuse.ENOENT);
  }

  if (dirPath === "/Starred") {
    await db.update(emailsTable).set({ starred: false }).where(eq(emailsTable.id, email.id));
  } else if (dirPath === "/Needs_Action") {
    await db.update(emailsTable).set({ needsAction: false }).where(eq(emailsTable.id, email.id));
  }

  cb(0);
}
