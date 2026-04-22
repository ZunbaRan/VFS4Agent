/**
 * Build a preconfigured `Bash` instance:
 *   - /docs  -> VirtualFs over VectorStore (read-only, backed by DB)
 *   - /tmp, /home/user -> InMemoryFs (writable scratch)
 *
 * Custom commands:
 *   - grep  (overrides default; two-stage DB + in-memory)
 *   - tree  (pretty print directory tree from PathTree)
 */

import {
  Bash,
  InMemoryFs,
  MountableFs,
  defineCommand,
  type BashOptions,
  type CommandContext,
  type ExecResult,
} from "just-bash";
import yargsParser from "yargs-parser";

import { VirtualFs } from "./fs/virtualFs.js";
import type { Session, VectorStore } from "./types.js";
import { runGrep, type GrepInvocation } from "./grep/engine.js";
import {
  DEFAULT_ENV,
  buildRealismCommands,
  createRealismFs,
  type EnvProfile,
} from "./runner/realism.js";

export interface CreateShellOptions {
  store: VectorStore;
  session?: Session;
  /** Mount point for the docs VFS. Default: "/docs". */
  mountPoint?: string;
  /** Starting cwd. Default: the mount point. */
  cwd?: string;
  /**
   * Sandbox-realism layer: plausible /etc/*, /proc/*, uname, whoami, etc.
   * Set `false` to get a bare shell (useful for unit tests). Default: on.
   */
  realism?: boolean | EnvProfile;
  /** Additional options passed to `Bash`. */
  bashOptions?: Omit<BashOptions, "fs" | "customCommands" | "cwd">;
}

export interface Shell {
  bash: Bash;
  vfs: VirtualFs;
  close(): void;
}

export function createShell(opts: CreateShellOptions): Shell {
  const mountPoint = opts.mountPoint ?? "/docs";
  const vfs = new VirtualFs({
    store: opts.store,
    session: opts.session,
    mountPoint,
  });

  const realismMode = opts.realism ?? true;
  const env: EnvProfile | null =
    realismMode === false
      ? null
      : realismMode === true
        ? DEFAULT_ENV
        : realismMode;

  const fs = new MountableFs({
    base: env
      ? createRealismFs(env)
      : new InMemoryFs({
          "/home/user/.keep": "",
          "/tmp/.keep": "",
        }),
    mounts: [{ mountPoint, filesystem: vfs }],
  });

  const grepCmd = defineCommand("grep", async (args, ctx) =>
    execGrep(args, ctx, vfs, opts.store),
  );

  const treeCmd = defineCommand("tree", async (args, ctx) =>
    execTree(args, ctx, vfs),
  );

  const customCommands = [grepCmd, treeCmd];
  if (env) customCommands.push(...buildRealismCommands(env));

  // Baseline environment. Users of the shell often expect $HOME, $USER,
  // $HOSTNAME etc. to exist — without them even a casual `cd ~` fails.
  const baseEnv: Record<string, string> = env
    ? {
        HOME: `/home/${env.user}`,
        USER: env.user,
        LOGNAME: env.user,
        HOSTNAME: env.host,
        SHELL: "/bin/bash",
        TERM: "xterm-256color",
        LANG: "C.UTF-8",
        PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        PWD: opts.cwd ?? mountPoint,
      }
    : {};

  const bash = new Bash({
    fs,
    cwd: opts.cwd ?? mountPoint,
    customCommands,
    env: { ...baseEnv, ...(opts.bashOptions?.env ?? {}) },
    ...(opts.bashOptions ?? {}),
  });

  return {
    bash,
    vfs,
    close: () => opts.store.close(),
  };
}

// ============================================================
// grep override
// ============================================================

const GREP_FLAGS = {
  alias: {
    r: "recursive",
    R: "recursive",
    E: "extended-regexp",
    F: "fixed-strings",
    i: "ignore-case",
    v: "invert-match",
    w: "word-regexp",
    l: "files-with-matches",
    L: "files-without-match",
    c: "count",
    n: "line-number",
    m: "max-count",
    e: "regexp",
    h: "no-filename",
  },
  boolean: [
    "recursive",
    "extended-regexp",
    "fixed-strings",
    "ignore-case",
    "invert-match",
    "word-regexp",
    "files-with-matches",
    "files-without-match",
    "count",
    "line-number",
    "no-filename",
  ],
  string: ["max-count", "include", "exclude", "regexp"],
};

async function execGrep(
  args: string[],
  ctx: CommandContext,
  vfs: VirtualFs,
  store: VectorStore,
): Promise<ExecResult> {
  const parsed = yargsParser(args, GREP_FLAGS);
  const positionals = (parsed._ as (string | number)[]).map((x) => String(x));

  let pattern: string | undefined;
  if (parsed["regexp"]) pattern = String(parsed["regexp"]);
  else if (positionals.length > 0) pattern = positionals.shift();

  if (!pattern) {
    return { stdout: "", stderr: "grep: no pattern provided\n", exitCode: 2 };
  }

  const paths = positionals.length > 0 ? positionals : [ctx.cwd];
  const absPaths = paths.map((p) => resolveIn(ctx.cwd, p));

  const inv: GrepInvocation = {
    pattern,
    paths: absPaths,
    recursive: !!parsed.recursive,
    regex: !parsed["fixed-strings"],
    fixedString: !!parsed["fixed-strings"],
    ignoreCase: !!parsed["ignore-case"],
    invert: !!parsed["invert-match"],
    wordRegexp: !!parsed["word-regexp"],
    listFilesOnly: !!parsed["files-with-matches"],
    filesWithoutMatch: !!parsed["files-without-match"],
    countOnly: !!parsed["count"],
    lineNumber: parsed["line-number"] !== false,
    maxCount: parsed["max-count"] ? Number(parsed["max-count"]) : undefined,
    include: parsed["include"] ? String(parsed["include"]) : undefined,
    exclude: parsed["exclude"] ? String(parsed["exclude"]) : undefined,
  };

  // Only intercept when target lives inside the VFS mount — otherwise fall back
  // to default bash grep by returning a sentinel that triggers manual scan.
  const mp = (vfs as unknown as { mountPoint: string }).mountPoint;
  const allInMount =
    mp === "/" ||
    inv.paths.every((p) => p === mp || p.startsWith(mp + "/"));

  if (!allInMount) {
    return {
      stdout: "",
      stderr: `grep: only paths under ${mp} are supported by this shell\n`,
      exitCode: 2,
    };
  }

  const result = await runGrep(inv, vfs, store);
  // If the user piped stdin to grep (no files), default to stdin mode — but
  // we only intercept path-based grep; tell bash to fall back by returning
  // exit 2 with a hint.
  return result;
}

// ============================================================
// tree
// ============================================================

async function execTree(
  args: string[],
  ctx: CommandContext,
  vfs: VirtualFs,
): Promise<ExecResult> {
  await vfs.init();
  const target = args[0] ? resolveIn(ctx.cwd, args[0]) : ctx.cwd;
  const mp = (vfs as unknown as { mountPoint: string }).mountPoint ?? "/";

  if (mp !== "/" && target !== mp && !target.startsWith(mp + "/")) {
    return {
      stdout: "",
      stderr: `tree: ${target} is outside the VFS mount (${mp})\n`,
      exitCode: 2,
    };
  }

  let out = target + "\n";
  // VirtualFs methods now receive mount-relative paths (like MountableFs does).
  const toRel = (abs: string): string => {
    if (mp === "/" || mp === "") return abs;
    if (abs === mp) return "/";
    if (abs.startsWith(mp + "/")) return abs.slice(mp.length);
    return abs;
  };
  const render = async (abs: string, prefix: string) => {
    let entries: Awaited<ReturnType<VirtualFs["readdirWithFileTypes"]>>;
    try {
      entries = await vfs.readdirWithFileTypes(toRel(abs));
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      const last = i === entries.length - 1;
      const branch = last ? "└── " : "├── ";
      out += `${prefix}${branch}${e.name}${e.isDirectory ? "/" : ""}\n`;
      if (e.isDirectory) {
        const nextPrefix = prefix + (last ? "    " : "│   ");
        await render(abs === "/" ? `/${e.name}` : `${abs}/${e.name}`, nextPrefix);
      }
    }
  };
  await render(target, "");
  return { stdout: out, stderr: "", exitCode: 0 };
}

// ============================================================
// helpers
// ============================================================

function resolveIn(cwd: string, p: string): string {
  if (p.startsWith("/")) return normalize(p);
  return normalize(cwd + "/" + p);
}

function normalize(p: string): string {
  const parts: string[] = [];
  for (const seg of p.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return "/" + parts.join("/");
}
