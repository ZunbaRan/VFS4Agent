import path from "node:path";
import Fuse from "fuse-native";
import { eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { emailsTable } from "../../db/schema.js";
import { getEmailByPath, VIRTUAL_FOLDERS } from "../helpers.js";

/**
 * Create symlink to an email,
 * this means setting an attribute like 'starred' or 'needsAction'
 */
export async function symlink(target: string, linkPath: string, cb: (err: number) => void) {
  const lastSlash = linkPath.lastIndexOf("/");
  const dirPath = lastSlash === 0 ? "/" : linkPath.slice(0, lastSlash);

  if (!VIRTUAL_FOLDERS[dirPath]) {
    return cb(Fuse.EPERM);
  }

  const resolvedTarget = path.posix.resolve(dirPath, target);
  const email = await getEmailByPath(resolvedTarget);
  if (!email) {
    return cb(Fuse.ENOENT);
  }

  if (dirPath === "/Starred") {
    await db.update(emailsTable).set({ starred: true }).where(eq(emailsTable.id, email.id));
  } else if (dirPath === "/Needs_Action") {
    await db.update(emailsTable).set({ needsAction: true }).where(eq(emailsTable.id, email.id));
  }

  cb(0);
}
