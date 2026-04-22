/**
 * Probe the sandbox disguise. Runs the classic environment probes an LLM
 * would use to verify it's in a real shell and prints the transcript so you
 * can eyeball (or diff) the illusion.
 *
 *     pnpm probe
 *
 * Exits 0 if every probe returned plausible Linux output (non-empty, no
 * "command not found" on the well-known commands), 1 otherwise.
 */

import { createBackend } from "../backend/factory.js";
import { createShell } from "../shell.js";

const PROBES: Array<{
  cmd: string;
  must: (out: { stdout: string; stderr: string; exitCode: number }) => string | null;
}> = [
  { cmd: "uname -a",           must: (o) => (/Linux\s+\S+\s+\S+.*x86_64/.test(o.stdout) ? null : "uname -a did not mention kernel/x86_64") },
  { cmd: "whoami",             must: (o) => (o.stdout.trim() === "user" ? null : `whoami returned ${JSON.stringify(o.stdout.trim())}`) },
  { cmd: "hostname",           must: (o) => (o.stdout.trim().length > 0 ? null : "hostname empty") },
  { cmd: "id",                 must: (o) => (/uid=\d+\(.+?\)/.test(o.stdout) ? null : "id did not produce uid=N(name)") },
  { cmd: "cat /etc/os-release",must: (o) => (/Ubuntu|NAME=/.test(o.stdout) ? null : "os-release missing") },
  { cmd: "cat /proc/version",  must: (o) => (/Linux version/.test(o.stdout) ? null : "proc/version missing") },
  { cmd: "cat /etc/hostname",  must: (o) => (o.stdout.trim().length > 0 ? null : "hostname file empty") },
  { cmd: "echo $HOME",         must: (o) => (/^\/home\//.test(o.stdout.trim()) ? null : `HOME=${JSON.stringify(o.stdout.trim())} (expected /home/...)`) },
  { cmd: "ls /etc",            must: (o) => (o.stdout.trim().length > 0 ? null : "/etc empty") },
  { cmd: "pwd",                must: (o) => (o.stdout.trim() === "/docs" ? null : `pwd returned ${JSON.stringify(o.stdout.trim())}`) },
  { cmd: "ls /docs",           must: (o) => (o.stdout.trim().length > 0 ? null : "/docs empty — did you run ingest?") },
];

const SOFT_FAIL = new Set<string>();

async function main() {
  const { store, label } = createBackend();
  const { bash, close } = createShell({ store, mountPoint: "/docs" });

  const failures: string[] = [];
  const soft: string[] = [];

  console.log(`[probe] backend=${label}`);
  console.log("─".repeat(60));

  for (const p of PROBES) {
    const r = await bash.exec(p.cmd);
    const stdoutTrim = r.stdout.replace(/\n+$/, "");
    const stderrTrim = r.stderr.replace(/\n+$/, "");
    const header = `$ ${p.cmd}`;
    console.log(header);
    if (stdoutTrim) console.log(indent(stdoutTrim));
    if (stderrTrim) console.log(indent("[stderr] " + stderrTrim));
    console.log(`  [exit ${r.exitCode}]`);

    // Hard illusion-break: command not found on a command we expect to exist.
    if (/command not found/.test(r.stderr)) {
      failures.push(`${p.cmd}: command not found — illusion broken`);
      continue;
    }
    const why = p.must({ stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode });
    if (why) {
      if (SOFT_FAIL.has(why)) soft.push(`${p.cmd}: ${why}`);
      else failures.push(`${p.cmd}: ${why}`);
    }
  }

  console.log("─".repeat(60));
  if (soft.length) {
    console.log(`[probe] soft warnings: ${soft.length}`);
    for (const s of soft) console.log(`  • ${s}`);
  }
  if (failures.length === 0) {
    console.log(`[probe] PASS — ${PROBES.length} probes, sandbox disguise holds.`);
    close();
    process.exit(0);
  }
  console.log(`[probe] FAIL — ${failures.length}/${PROBES.length} probes broke the illusion:`);
  for (const f of failures) console.log(`  • ${f}`);
  close();
  process.exit(1);
}

function indent(s: string): string {
  return s
    .split("\n")
    .map((l) => "  " + l)
    .join("\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
