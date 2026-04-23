/**
 * GrepOptimizer — intercepts recursive grep commands and executes them via
 * VectorStore.searchText() + bulkGetChunksByPages() instead of spawning
 * real bash + FUSE (which would cause N database queries).
 *
 * Three-stage model:
 *   Stage 1: Coarse filter — store.searchText() → candidate slug list
 *   Stage 2: Prefetch — store.bulkGetChunksByPages() → all candidate content
 *   Stage 3: Fine filter — in-process JS RegExp on each line
 *
 * Supported flags: -r/-R, -n, -i, -l, -H, -v, -F
 * Unsupported (falls through to FUSE): -A, -B, -C, -P, -z, --color, -Z
 */

import type { CommandOptimizer, CommandResult } from "./types.js";
import type { VectorStore } from "../../types.js";
import { assembleChunks } from "../../fuse/helpers.js";

// ---------------------------------------------------------------------------
// Command parsing
// ---------------------------------------------------------------------------

interface ParsedGrep {
  flags: string;
  pattern: string;
  vfsPath: string;
}

function parseGrepCommand(cmd: string): ParsedGrep | null {
  // grep [-flags] "pattern" /vfs/...path
  // grep [-flags] 'pattern' /vfs/...path
  // grep [-flags] pattern /vfs/...path  (unquoted, only if no spaces)
  const m = cmd.match(
    /^grep\s+(?:-([a-zA-Z-]+)\s+)?(?:"([^"]*)"|'([^']*)'|(\S+))\s+(\/vfs\/\S*)$/,
  );
  if (!m) return null;
  return {
    flags: m[1] ?? "",
    pattern: m[2] ?? m[3] ?? m[4],
    vfsPath: m[5],
  };
}

// ---------------------------------------------------------------------------
// Flag analysis
// ---------------------------------------------------------------------------

/** Flags that the optimizer can correctly emulate. */
const SUPPORTED_FLAGS_RE = /^[rRnliHFv]*$/;

/** Flags that require falling through to real bash. */
function hasUnsupportedFlags(flags: string): boolean {
  // Long options always unsupported
  if (flags.includes("--")) return true;
  return !SUPPORTED_FLAGS_RE.test(flags);
}

// ---------------------------------------------------------------------------
// RegExp builder
// ---------------------------------------------------------------------------

function buildRegExp(pattern: string, flags: string): RegExp {
  // -F: fixed string (escape all regex metacharacters)
  const effective = flags.includes("F")
    ? pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    : pattern;
  const reFlags = flags.includes("i") ? "gi" : "g";
  return new RegExp(effective, reFlags);
}

// ---------------------------------------------------------------------------
// GrepOptimizer
// ---------------------------------------------------------------------------

export class GrepOptimizer implements CommandOptimizer {
  readonly name = "grep-optimizer";
  readonly requiredCapabilities = ["supportsTextSearch", "supportsBulkPrefetch"];

  match(command: string): boolean {
    if (!command.startsWith("grep ")) return false;
    if (!command.includes("/vfs/")) return false;

    const parsed = parseGrepCommand(command);
    if (!parsed) return false;

    // Must be recursive
    if (!parsed.flags.includes("r") && !parsed.flags.includes("R")) {
      return false;
    }

    // No unsupported flags
    if (hasUnsupportedFlags(parsed.flags)) return false;

    return true;
  }

  async execute(command: string, store: VectorStore): Promise<CommandResult> {
    const parsed = parseGrepCommand(command);
    if (!parsed) {
      return { stdout: "", stderr: "grep: failed to parse command\n", exitCode: 2 };
    }

    const { flags, pattern, vfsPath } = parsed;
    const slugPrefix = vfsPath.replace("/vfs/", "").replace(/\/+$/, "");

    // --- Stage 1: Coarse filter (database-side) ---
    // Always use substring match for the coarse filter — it's fast and
    // over-matching is fine (we re-filter in Stage 3).
    const candidateSlugs = await store.searchText({
      pattern,
      regex: false,
      ignoreCase: flags.includes("i"),
      pathPrefix: slugPrefix,
      limit: 200,
    });

    if (candidateSlugs.length === 0) {
      return { stdout: "", stderr: "", exitCode: 1 };
    }

    // --- Stage 2: Prefetch (batch fetch) ---
    const chunksMap = await store.bulkGetChunksByPages(candidateSlugs);

    // --- Stage 3: Fine filter (in-process JS RegExp) ---
    const regex = buildRegExp(pattern, flags);
    const invertMatch = flags.includes("v");
    const showLineNumbers = flags.includes("n");
    const showFilenamesOnly = flags.includes("l");
    const singleFile = chunksMap.size <= 1 && !flags.includes("H");

    const matches: Array<{ slug: string; lineNum: number; line: string }> = [];

    for (const [slug, chunks] of chunksMap) {
      const content = assembleChunks(chunks);
      const lines = content.split("\n");

      for (let i = 0; i < lines.length; i++) {
        const matched = regex.test(lines[i]);
        if (matched !== invertMatch) {
          matches.push({ slug, lineNum: i + 1, line: lines[i] });
          // -l: only need to know the file matched, skip rest
          if (showFilenamesOnly) break;
        }
      }
    }

    if (matches.length === 0) {
      return { stdout: "", stderr: "", exitCode: 1 };
    }

    // --- Format output (match real grep exactly) ---
    if (showFilenamesOnly) {
      const uniqueFiles = [...new Set(matches.map((m) => m.slug))];
      return {
        stdout: uniqueFiles.map((f) => `/vfs/${f}`).join("\n") + "\n",
        stderr: "",
        exitCode: 0,
      };
    }

    const outputLines = matches.map((m) => {
      let prefix = singleFile ? "" : `/vfs/${m.slug}:`;
      if (showLineNumbers) prefix += `${m.lineNum}:`;
      return `${prefix}${m.line}`;
    });

    return {
      stdout: outputLines.join("\n") + "\n",
      stderr: "",
      exitCode: 0,
    };
  }
}
