import Fuse from "fuse-native";
import { like } from "drizzle-orm";
import { db } from "../../db/index.js";
import { foldersTable } from "../../db/schema.js";
import { getFolder, getEmailsWithSender, emailToFilename, VIRTUAL_FOLDERS } from "../helpers.js";

/**
 * Listing everything in a folder. Includes emails and subfolders.
 */
export async function readdir(path: string, cb: (err: number, names?: string[]) => void) {
  const folder = await getFolder(path);
  if (!folder) {
    return cb(Fuse.ENOENT);
  }

  const entries = new Set<string>();
  const emails = await getEmailsWithSender();

  if (VIRTUAL_FOLDERS[path]) {
    const filtered = emails.filter(VIRTUAL_FOLDERS[path]);
    for (const email of filtered) {
      entries.add(emailToFilename(email));
    }
    return cb(0, Array.from(entries));
  }

  for (const email of emails) {
    if (email.folderId === folder.id) {
      entries.add(emailToFilename(email));
    }
  }

  const prefix = path === "/" ? "/" : path + "/";
  const folders = await db.select().from(foldersTable).where(like(foldersTable.path, `${prefix}%`));
  for (const f of folders) {
    if (f.path !== path) {
      const rest = f.path.slice(prefix.length);
      const name = rest.split("/")[0];
      if (name) entries.add(name);
    }
  }

  cb(0, Array.from(entries));
}


