import Fuse from "fuse-native";
import { fusePathToSlug, getDirectoryEntries, isDirectoryInTree } from "../helpers.js";
import { getPathTree } from "../context.js";
import { listResultFilenames } from "../search.js";

const TOP_LEVEL_VIRTUAL = ["search"];

export async function readdir(path: string, cb: (err: number, names?: string[]) => void): Promise<void> {
  try {
    if (path === "/") {
      const tree = await getPathTree();
      const top = new Set<string>(TOP_LEVEL_VIRTUAL);
      for (const key of Object.keys(tree)) {
        const head = key.split("/")[0];
        if (head) top.add(head);
      }
      return cb(0, Array.from(top));
    }

    if (path === "/search") return cb(0, ["last_query", "results"]);
    if (path === "/search/results") return cb(0, listResultFilenames());
    if (path.startsWith("/search/")) return cb(Fuse.ENOTDIR);

    const tree = await getPathTree();
    const slug = fusePathToSlug(path);

    const entries = getDirectoryEntries(slug, tree);
    if (entries.length === 0 && !isDirectoryInTree(slug, tree)) {
      return cb(Fuse.ENOENT);
    }
    cb(0, entries);
  } catch (e) {
    console.error("[fuse] readdir error:", path, (e as Error).message);
    cb(Fuse.EIO);
  }
}
