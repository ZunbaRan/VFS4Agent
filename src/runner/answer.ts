/**
 * `answer` — the only command that "breaks out" of the shell loop.
 *
 * When the model runs `answer "..."`, the command stashes the text on a shared
 * `AnswerSlot` and returns a normal exit(0). The outer runner polls the slot
 * after every `bash.exec()` and terminates the loop when it is set.
 *
 * We deliberately don't throw, because just-bash's exec() wraps custom
 * commands in try/catch and converts exceptions into exit codes — a thrown
 * signal would become "answer: error" and confuse the model.
 */

import { defineCommand, type Bash } from "just-bash";

export interface AnswerSlot {
  value: string | null;
}

export function createAnswerSlot(): AnswerSlot {
  return { value: null };
}

export function installAnswerCommand(bash: Bash, slot: AnswerSlot): void {
  const cmd = defineCommand("answer", async (args) => {
    // Join args with spaces; quote stripping is handled by the bash parser
    // before the args reach us.
    const text = args.join(" ").trim();
    if (!text) {
      return {
        stdout: "",
        stderr: 'answer: missing text. Usage: answer "<your final answer>"\n',
        exitCode: 2,
      };
    }
    slot.value = text;
    return {
      stdout: "[answer recorded; session will end]\n",
      stderr: "",
      exitCode: 0,
    };
  });
  bash.registerCommand(cmd);
}
