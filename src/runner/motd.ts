/**
 * Render the shell "login banner" shown to the model as the first user turn.
 * Goal: make the model feel it just SSHed into a docs box.
 */

export interface MotdOptions {
  question: string;
  host?: string;
  user?: string;
  mount?: string;
  now?: Date;
}

export function renderMotd(opts: MotdOptions): string {
  const host = opts.host ?? "docs";
  const user = opts.user ?? "user";
  const mount = opts.mount ?? "/docs";
  const now = opts.now ?? new Date();
  const stamp = now.toUTCString();

  return [
    `Last login: ${stamp} from 10.0.0.1`,
    `Welcome to docs-shell — a read-only documentation filesystem.`,
    ``,
    `  * Docs mounted at   : ${mount}`,
    `  * Scratch (writable): /tmp`,
    `  * Type \`help\` to list commands.`,
    `  * When you have the final answer, run:`,
    `        answer '<your answer, cite file paths from ${mount}>'`,
    `    (use SINGLE quotes to avoid backtick/dollar expansion)`,
    ``,
    `### User question: ${opts.question}`,
    ``,
  ].join("\n");
}

export const SHELL_SYSTEM_PROMPT = `You are interacting via a real bash shell.
Each of your replies MUST be exactly one shell command line — no explanation,
no markdown fences, no prose. The session runs against a read-only documentation
filesystem mounted at /docs. /tmp is writable scratch space.

Your job: investigate the user's question by running shell commands, then
finalize by running \`answer '<your final answer>'\` with inline citations to
file paths like /docs/auth/oauth.md.

Tips:
  - Start with \`tree /docs\` or \`ls /docs\` to learn the layout.
  - Use \`grep -rni '<keyword>' /docs\` to locate relevant files.
  - Use \`cat /docs/<path>\` or \`head -n 80 /docs/<path>\` to read them.
  - Chain pipes: \`grep -rl oauth /docs | xargs head -n 5\`.
  - Do NOT invent commands. If a command is not found, try another approach.

When calling answer, follow these rules EXACTLY or your answer will be corrupted:
  - Wrap the whole answer in SINGLE QUOTES: answer '...'
  - Do NOT use backticks (\`) anywhere inside the answer — bash will treat
    them as command substitution and eat their content. Use plain text or
    single quotes instead.
  - Do NOT use \$variable references; bash expands them.
  - Keep the answer on a single line (no raw newlines inside the quotes).
  - Good:  answer 'POST /oauth/token with grant_type=refresh_token. See /docs/auth/token-refresh.md'
  - Bad:   answer "use \`grant_type=refresh_token\`"   (backticks eaten)
  - Bad:   answer 'costs $5'                           (no problem inside single quotes — this is fine)

Available commands: ls cat head tail wc find grep tree awk sed sort uniq cut tr
xargs basename dirname echo printf history help answer (plus standard bash
pipes |, redirects > to /tmp, and command substitution $(...)).`;

export function renderPrompt(cwd: string, host = "docs", user = "user"): string {
  return `${user}@${host}:${cwd}$ `;
}
