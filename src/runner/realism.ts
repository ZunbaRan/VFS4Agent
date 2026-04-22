/**
 * Sandbox realism layer.
 *
 * The shell-native agent loop works by making the LLM think it's sitting at a
 * real bash prompt. A naive setup fails as soon as the model pokes at the
 * environment (uname / whoami / cat /etc/os-release / cat /proc/version),
 * because a bare just-bash instance returns "command not found" — an immediate
 * tell that the shell is a toy. This module plugs those specific holes:
 *
 *   1. A small in-memory tree of plausible /etc, /proc, /home metadata files
 *      that gets mounted alongside /docs and /tmp.
 *   2. Custom commands `uname`, `whoami`, `hostname`, `id`, `help` whose
 *      outputs are drawn from an EnvProfile.
 *
 * No attempt is made to fake the *entire* Linux surface — only the probes a
 * fresh SSH user would naturally try in the first few turns.
 */

import {
  defineCommand,
  InMemoryFs,
  type ExecResult,
} from "just-bash";

export interface EnvProfile {
  host: string;
  user: string;
  uid: number;
  gid: number;
  groups: string[];
  kernel: string; // e.g. "Linux docs 5.15.0-1048-aws"
  osRelease: string; // /etc/os-release body
  procVersion: string; // /proc/version body
  motd: string; // /etc/motd body
}

export const DEFAULT_ENV: EnvProfile = {
  host: "docs",
  user: "user",
  uid: 1000,
  gid: 1000,
  groups: ["users", "docs-readers"],
  kernel:
    "Linux docs 5.15.0-1048-aws #53-Ubuntu SMP Wed Jan 17 15:24:36 UTC 2026 x86_64 x86_64 x86_64 GNU/Linux",
  osRelease: [
    'NAME="Ubuntu"',
    'VERSION="22.04.4 LTS (Jammy Jellyfish)"',
    "ID=ubuntu",
    "ID_LIKE=debian",
    'PRETTY_NAME="Ubuntu 22.04.4 LTS"',
    'VERSION_ID="22.04"',
    'HOME_URL="https://www.ubuntu.com/"',
    'SUPPORT_URL="https://help.ubuntu.com/"',
    'BUG_REPORT_URL="https://bugs.launchpad.net/ubuntu/"',
    "VERSION_CODENAME=jammy",
    "UBUNTU_CODENAME=jammy",
    "",
  ].join("\n"),
  procVersion:
    "Linux version 5.15.0-1048-aws (buildd@lcy02-amd64-048) (gcc (Ubuntu 11.4.0-1ubuntu1~22.04) 11.4.0, GNU ld (GNU Binutils for Ubuntu) 2.38) #53-Ubuntu SMP Wed Jan 17 15:24:36 UTC 2026\n",
  motd: [
    "Welcome to docs-shell — a read-only documentation filesystem.",
    "",
    "  * Docs mounted at   : /docs",
    "  * Scratch (writable): /tmp",
    "  * Type `help` to list docs-shell commands.",
    "  * When you have the final answer, run: answer '<your answer>'",
    "",
  ].join("\n"),
};

/**
 * Build an InMemoryFs that prefills the small set of probe-target files an
 * agent is most likely to `cat` to verify the environment. Returned as an
 * InMemoryFs so the caller can compose it via MountableFs.
 */
export function createRealismFs(env: EnvProfile = DEFAULT_ENV): InMemoryFs {
  return new InMemoryFs({
    "/etc/motd": env.motd,
    "/etc/os-release": env.osRelease,
    "/etc/hostname": env.host + "\n",
    "/etc/hosts": [
      "127.0.0.1\tlocalhost",
      `127.0.1.1\t${env.host}`,
      "",
    ].join("\n"),
    "/etc/passwd": [
      "root:x:0:0:root:/root:/bin/bash",
      `${env.user}:x:${env.uid}:${env.gid}:${env.user}:/home/${env.user}:/bin/bash`,
      "",
    ].join("\n"),
    "/proc/version": env.procVersion,
    "/proc/uptime": "12847.42 12344.88\n",
    "/proc/cpuinfo": [
      "processor\t: 0",
      "vendor_id\t: GenuineIntel",
      "cpu family\t: 6",
      "model name\t: Intel(R) Xeon(R) Platinum 8375C CPU @ 2.90GHz",
      "cpu MHz\t\t: 2900.000",
      "cache size\t: 54272 KB",
      "",
    ].join("\n"),
    [`/home/${env.user}/.keep`]: "",
    "/home/user/.keep": "",
    "/tmp/.keep": "",
  });
}

/** Pack the four classic probe commands + an in-shell `help`. */
export function buildRealismCommands(env: EnvProfile = DEFAULT_ENV) {
  const uname = defineCommand(
    "uname",
    async (args: string[]): Promise<ExecResult> => {
      // Very small subset of GNU coreutils uname flags.
      const fields = parseUname(args, env);
      return { stdout: fields.join(" ") + "\n", stderr: "", exitCode: 0 };
    },
  );

  const whoami = defineCommand(
    "whoami",
    async (): Promise<ExecResult> => ({
      stdout: env.user + "\n",
      stderr: "",
      exitCode: 0,
    }),
  );

  const hostname = defineCommand(
    "hostname",
    async (args: string[]): Promise<ExecResult> => {
      if (args.includes("-I") || args.includes("--all-ip-addresses")) {
        return { stdout: "10.0.0.1 \n", stderr: "", exitCode: 0 };
      }
      if (args.includes("-f") || args.includes("--fqdn")) {
        return { stdout: `${env.host}.docs.internal\n`, stderr: "", exitCode: 0 };
      }
      return { stdout: env.host + "\n", stderr: "", exitCode: 0 };
    },
  );

  const id = defineCommand(
    "id",
    async (args: string[]): Promise<ExecResult> => {
      if (args.includes("-u")) return num(env.uid);
      if (args.includes("-g")) return num(env.gid);
      if (args.includes("-un")) return str(env.user);
      if (args.includes("-gn")) return str(env.groups[0] ?? "users");
      const groupsStr = env.groups
        .map((g, i) => `${1000 + i}(${g})`)
        .join(",");
      const out = `uid=${env.uid}(${env.user}) gid=${env.gid}(${env.groups[0] ?? "users"}) groups=${groupsStr}\n`;
      return { stdout: out, stderr: "", exitCode: 0 };
    },
  );

  // Note: `help` is a bash builtin that takes precedence over custom commands
  // in just-bash, so we intentionally don't override it. The MOTD explains
  // the docs-specific commands instead. Leaving `help` as the real bash
  // builtin is actually *more* realistic, not less.

  return [uname, whoami, hostname, id];
}

// ------------------------------------------------------------------
// helpers
// ------------------------------------------------------------------

function parseUname(args: string[], env: EnvProfile): string[] {
  // Decompose the canonical uname -a output so flags can compose cleanly.
  // "Linux docs 5.15.0-1048-aws #53-Ubuntu ... x86_64 GNU/Linux"
  const toks = env.kernel.split(/\s+/);
  const sysname = toks[0] ?? "Linux";
  const nodename = toks[1] ?? env.host;
  const release = toks[2] ?? "5.15.0";
  // everything between release and the final 3 tokens is the version
  const tail = toks.slice(-3); // machine, processor, hwplatform-ish
  const version = toks.slice(3, -3).join(" ") || "#1 SMP";
  const machine = tail[0] ?? "x86_64";
  const os = "GNU/Linux";

  const flags = new Set(
    args.flatMap((a) =>
      a.startsWith("--")
        ? [a]
        : a.startsWith("-")
          ? a.slice(1).split("").map((c) => "-" + c)
          : [],
    ),
  );

  const wantAll = flags.has("-a") || flags.has("--all") || flags.size === 0;
  // Default `uname` (no flags) prints just the kernel name.
  if (!wantAll && flags.size === 0) return [sysname];

  const out: string[] = [];
  if (flags.has("-a") || flags.has("-s") || flags.has("--kernel-name"))
    out.push(sysname);
  if (flags.has("-a") || flags.has("-n") || flags.has("--nodename"))
    out.push(nodename);
  if (flags.has("-a") || flags.has("-r") || flags.has("--kernel-release"))
    out.push(release);
  if (flags.has("-a") || flags.has("-v") || flags.has("--kernel-version"))
    out.push(version);
  if (flags.has("-a") || flags.has("-m") || flags.has("--machine"))
    out.push(machine);
  if (flags.has("-a") || flags.has("-o") || flags.has("--operating-system"))
    out.push(os);
  return out.length ? out : [sysname];
}

function num(n: number): ExecResult {
  return { stdout: String(n) + "\n", stderr: "", exitCode: 0 };
}
function str(s: string): ExecResult {
  return { stdout: s + "\n", stderr: "", exitCode: 0 };
}
