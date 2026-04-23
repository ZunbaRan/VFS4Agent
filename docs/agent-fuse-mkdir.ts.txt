import Fuse from "fuse-native";
import { db } from "../../db/index.js";
import { foldersTable } from "../../db/schema.js";
import { getFolder, VIRTUAL_FOLDERS } from "../helpers.js";

export async function mkdir(path: string, mode: number, cb: (err: number) => void) {
  if (VIRTUAL_FOLDERS[path]) {
    return cb(Fuse.EEXIST);
  }

  const existing = await getFolder(path);
  if (existing) {
    return cb(Fuse.EEXIST);
  }

  const lastSlash = path.lastIndexOf("/");
  const parentPath = lastSlash === 0 ? "/" : path.slice(0, lastSlash);
  const parent = await getFolder(parentPath);
  if (!parent) {
    return cb(Fuse.ENOENT);
  }

  await db.insert(foldersTable).values({ path });
  cb(0);
}
