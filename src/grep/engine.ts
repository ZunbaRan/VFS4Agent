/**
 * Two-stage grep engine.
 *
 * Stage 1 (coarse, DB-side): VectorStore.searchText returns candidate pages.
 * Stage 2 (fine, in-memory): we read each candidate page via the VFS and
 * apply an exact JS RegExp to emit file:line:text hits.
 *
 * This is invoked by a custom `grep` command registered into just-bash
 * (see shell.ts), which replaces the default built-in so large recursive
 * queries don't hit readFile on every file.
 */

import type { VirtualFs } from "../fs/virtualFs.js";
import type { VectorStore } from "../types.js";

export interface GrepHit {
  file: string; // absolute path (within mount)
  line: number;
  text: string;
}

export interface GrepInvocation {
  pattern: string;
  paths: string[];        // absolute paths to search
  recursive: boolean;
  regex: boolean;         // -E / -P => regex semantics
  fixedString: boolean;   // -F
  ignoreCase: boolean;    // -i
  invert: boolean;        // -v
  wordRegexp: boolean;    // -w
  listFilesOnly: boolean; // -l
  countOnly: boolean;     // -c
  filesWithoutMatch: boolean; // -L
  lineNumber: boolean;    // -n  (default true for user friendliness)
  maxCount?: number;      // -m N
  include?: string;       // --include=GLOB (simple suffix match)
  exclude?: string;       // --exclude=GLOB
}

export async function runGrep(
  inv: GrepInvocation,
  vfs: VirtualFs,
  store: VectorStore,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  await vfs.init();

  const allowed = vfs.getAllowedSlugs();
  let jsRegex: RegExp;
  try {
    jsRegex = buildJsRegex(inv);
  } catch (e) {
    return {
      stdout: "",
      stderr: `grep: invalid regex: ${(e as Error).message}\n`,
      exitCode: 2,
    };
  }

  // Determine path prefix(es) for coarse filter.
  const prefixes = inv.paths.map((p) => vfsRelPrefix(p, vfs));

  // Run coarse filter per prefix, union the candidate slug set.
  const candidateSlugs = new Set<string>();
  for (const prefix of prefixes) {
    const slugs = await store.searchText({
      pattern: inv.fixedString ? inv.pattern : inv.pattern,
      regex: !inv.fixedString,
      ignoreCase: inv.ignoreCase,
      pathPrefix: prefix,
      allowedSlugs: allowed,
      limit: 5000,
    });
    for (const s of slugs) candidateSlugs.add(s);
  }

  // Apply --include/--exclude
  let candidates = Array.from(candidateSlugs);
  if (inv.include) candidates = candidates.filter((s) => matchGlob(s, inv.include!));
  if (inv.exclude) candidates = candidates.filter((s) => !matchGlob(s, inv.exclude!));

  // Bulk prefetch
  const pages = await store.bulkGetChunksByPages(candidates);

  // Fine filter line-by-line
  const hits: GrepHit[] = [];
  const fileHitCounts = new Map<string, number>();

  for (const slug of candidates.sort()) {
    const chunks = pages.get(slug);
    if (!chunks) continue;
    chunks.sort((a, b) => a.chunk_index - b.chunk_index);

    let lineNo = 1;
    for (const ch of chunks) {
      const lines = ch.content.split("\n");
      // Last entry may be partial continuation of next chunk; treat each
      // split entry as its own line for reporting purposes.
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // Avoid counting a trailing empty string from a terminal \n.
        if (i === lines.length - 1 && line === "" && i > 0) break;
        const isMatch = jsRegex.test(line);
        if (isMatch !== inv.invert) {
          hits.push({
            file: absolutePathForSlug(slug, vfs),
            line: lineNo,
            text: line,
          });
          fileHitCounts.set(slug, (fileHitCounts.get(slug) ?? 0) + 1);
          if (inv.maxCount && (fileHitCounts.get(slug) ?? 0) >= inv.maxCount) {
            break;
          }
        }
        lineNo++;
        jsRegex.lastIndex = 0;
      }
      if (inv.maxCount && (fileHitCounts.get(slug) ?? 0) >= inv.maxCount) break;
    }
  }

  // Emit
  let stdout = "";
  const multiFile = prefixes.length > 0 || candidates.length > 1 || inv.recursive;

  if (inv.listFilesOnly) {
    const files = Array.from(new Set(hits.map((h) => h.file))).sort();
    stdout = files.map((f) => f + "\n").join("");
  } else if (inv.filesWithoutMatch) {
    const hitFiles = new Set(hits.map((h) => h.file));
    const all = candidates.map((s) => absolutePathForSlug(s, vfs));
    const missing = all.filter((f) => !hitFiles.has(f));
    stdout = missing.sort().map((f) => f + "\n").join("");
  } else if (inv.countOnly) {
    const byFile = new Map<string, number>();
    for (const h of hits) byFile.set(h.file, (byFile.get(h.file) ?? 0) + 1);
    stdout = Array.from(byFile.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([f, n]) => `${f}:${n}\n`)
      .join("");
  } else {
    stdout = hits
      .map((h) => {
        const prefix = multiFile ? `${h.file}:` : "";
        const lineNum = inv.lineNumber ? `${h.line}:` : "";
        return `${prefix}${lineNum}${h.text}\n`;
      })
      .join("");
  }

  const exitCode = hits.length > 0 ? 0 : 1;
  return { stdout, stderr: "", exitCode };
}

function buildJsRegex(inv: GrepInvocation): RegExp {
  const flags = inv.ignoreCase ? "gi" : "g";
  let pat = inv.fixedString ? escapeRegExp(inv.pattern) : inv.pattern;
  if (inv.wordRegexp) pat = `\\b(?:${pat})\\b`;
  return new RegExp(pat, flags);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function matchGlob(slug: string, glob: string): boolean {
  // Minimal glob: *, ?, literal dots. Enough for --include="*.md".
  const re = new RegExp(
    "^" +
      glob
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, ".*")
        .replace(/\?/g, ".") +
      "$",
  );
  // Match against basename or full slug.
  const parts = slug.split("/");
  return re.test(slug) || re.test(parts[parts.length - 1]);
}

/** Convert absolute path into a slug prefix for coarse filtering, or "" for root. */
function vfsRelPrefix(absPath: string, vfs: VirtualFs): string {
  const mp = vfs.getMountPoint();
  const p = normalizePath(absPath);
  if (mp === "/" || mp === "") {
    return p === "/" ? "" : p.slice(1);
  }
  if (p === mp) return "";
  if (p.startsWith(mp + "/")) return p.slice(mp.length + 1);
  return p.startsWith("/") ? p.slice(1) : p;
}

function absolutePathForSlug(slug: string, vfs: VirtualFs): string {
  const mp = vfs.getMountPoint();
  const prefix = mp === "/" ? "" : mp;
  return `${prefix}/${slug}`;
}

function normalizePath(p: string): string {
  const parts: string[] = [];
  for (const seg of p.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return "/" + parts.join("/");
}
