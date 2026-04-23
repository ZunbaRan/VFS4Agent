import { freeHandle, getContext } from "../context.js";
import { runSearch } from "../search.js";

/**
 * Free the FD. If this was a /search/last_query write handle, trigger the
 * search side-effect now so subsequent readdir on /search/results/ shows
 * fresh results.
 */
export async function release(_path: string, fd: number, cb: (err: number) => void): Promise<void> {
  const h = freeHandle(fd);
  if (!h) return cb(0);
  if (h.searchQueryWrite) {
    try {
      await runSearch(h.content, getContext().store);
    } catch (e) {
      console.error("[fuse] search trigger failed:", (e as Error).message);
    }
  }
  cb(0);
}
