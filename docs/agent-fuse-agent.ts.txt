import * as readline from "readline";
import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";

const SYSTEM_PROMPT = `You are an email assistant helping the user manage their inbox.

You have access to a filesystem at /workspace representing their email:
- Folders: Inbox, Sent, Orders, Customers, etc.
- Emails: .eml files named "Subject (sender@email.com).eml"
- Filenames contain spaces (from email subjects), so always quote paths in shell commands
- Starred/Needs_Action: contain symlinks to flagged emails

Commands you use internally:
- ls, cat, find → browse emails
- mv → move emails between folders  
- ln -s <email> /Starred/ → star an email
- rm /Starred/<email> → unstar an email
- mkdir → create folders

When responding to the user:
- Describe emails by subject and sender, not filenames
- Say "starred" not "created symlink"
- Say "moved to Orders" not "mv to /Orders/"
- Summarize what you found/did in plain language`;

const OPTIONS = {
  cwd: "/workspace",
  systemPrompt: SYSTEM_PROMPT,
  stderr: (data: string) => console.error("[stderr]", data),
  allowedTools: ["Bash", "Read", "Edit", "Grep", "Glob"],
  sandbox: {
    enabled: true,
    autoAllowBashIfSandboxed: true,
  },
};

function formatToolUse(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case "Bash":
      return `[Bash] ${input.command}`;
    case "Read":
      return `[Read] ${input.file_path}`;
    case "Edit":
      return `[Edit] ${input.file_path}`;
    case "Grep":
      return `[Grep] ${input.pattern} ${input.path || ""}`;
    case "Glob":
      return `[Glob] ${input.pattern}`;
    default:
      return `[${name}]`;
  }
}

function handleMessage(message: SDKMessage): string | undefined {
  switch (message.type) {
    case "assistant":
      for (const block of message.message.content) {
        if (block.type === "text") {
          console.log("\n" + block.text);
        } else if (block.type === "tool_use") {
          const input = block.input as Record<string, unknown>;
          console.log(`\n${formatToolUse(block.name, input)}`);
        }
      }
      return message.session_id;

    case "result":
      if (message.subtype !== "success") {
        console.log("\n[Error]", message.errors);
      }
      return message.session_id;

    case "system":
      if (message.subtype === "init") {
        return message.session_id;
      }
      break;
  }
  return undefined;
}

async function runTurn(prompt: string, sessionId?: string): Promise<string | undefined> {
  const result = query({
    prompt,
    options: sessionId ? { ...OPTIONS, resume: sessionId } : OPTIONS,
  });

  let lastSessionId: string | undefined;
  for await (const message of result) {
    const id = handleMessage(message);
    if (id) lastSessionId = id;
  }
  return lastSessionId;
}

function createPrompt(rl: readline.Interface) {
  return (question: string): Promise<string> =>
    new Promise((resolve) => rl.question(question, resolve));
}

export async function startRepl() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("Error: ANTHROPIC_API_KEY environment variable is not set.");
    process.exit(1);
  }

  console.log("Starting agent REPL...\n");

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  // Handle Ctrl+D
  rl.on("close", () => {
    console.log("\nGoodbye!");
    process.exit(0);
  });

  const prompt = createPrompt(rl);
  let sessionId: string | undefined;

  while (true) {
    let input: string;
    try {
      input = await prompt("\n> ");
    } catch {
      break; // readline closed (Ctrl+D)
    }

    const trimmed = input.trim().toLowerCase();
    if (trimmed === "exit" || trimmed === "quit") {
      console.log("\nGoodbye!");
      process.exit(0);
    }

    try {
      sessionId = await runTurn(input, sessionId);
    } catch (error) {
      console.error("Agent error:", error);
    }
  }
}
