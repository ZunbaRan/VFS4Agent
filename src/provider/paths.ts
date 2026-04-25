/**
 * Path helpers for provider subpaths and mount prefixes.
 *
 * Conventions (enforced here):
 *   - mountPrefix always starts with "/" and has no trailing slash
 *     (except the root router, which is "").
 *   - subpath is provider-relative, starts with "/", no trailing slash
 *     (except root "/"). Forward slashes only.
 */

export function normalizeMountPrefix(prefix: string): string {
  if (!prefix || prefix === "/") return "";
  if (!prefix.startsWith("/")) throw new Error(`mount prefix must start with "/", got ${prefix}`);
  // strip trailing slashes
  return prefix.replace(/\/+$/, "");
}

export function normalizeAbsPath(path: string): string {
  if (!path) return "/";
  if (!path.startsWith("/")) path = "/" + path;
  // collapse duplicate slashes
  path = path.replace(/\/+/g, "/");
  // drop trailing slash (except root)
  if (path.length > 1) path = path.replace(/\/+$/, "");
  return path;
}

/**
 * Split an absolute path into (mountPrefix, subpath). Given the set of
 * registered mount prefixes, find the longest one that matches.
 *
 * Returns `null` when no mount matches AND the path is not the literal root.
 */
export function matchMount(
  absPath: string,
  mounts: Iterable<string>,
): { mountPrefix: string; subpath: string } | null {
  const abs = normalizeAbsPath(absPath);
  let best: string | null = null;
  for (const m of mounts) {
    const mp = normalizeMountPrefix(m);
    if (mp === "") continue; // root mount handled separately
    if (abs === mp || abs.startsWith(mp + "/")) {
      if (best === null || mp.length > best.length) best = mp;
    }
  }
  if (best === null) return null;
  const subpath = abs.slice(best.length) || "/";
  return { mountPrefix: best, subpath };
}

/** First path segment after "/". "/foo/bar" → "foo". "/" → "". */
export function topSegment(absPath: string): string {
  const n = normalizeAbsPath(absPath);
  if (n === "/") return "";
  return n.slice(1).split("/")[0];
}

/** Join a mount prefix and a provider-relative subpath into an absolute VFS path. */
export function joinMount(mountPrefix: string, subpath: string): string {
  const mp = normalizeMountPrefix(mountPrefix);
  const sp = subpath === "/" || subpath === "" ? "" : normalizeAbsPath(subpath);
  return (mp + sp) || "/";
}
