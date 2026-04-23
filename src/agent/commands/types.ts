/**
 * CommandOptimizer interface and registry.
 *
 * Design principle: optimizers are OPTIONAL fast paths that intercept
 * specific bash commands and execute them via optimized database queries
 * instead of spawning a real subprocess + FUSE.
 *
 * If the backend doesn't support required capabilities, or if the
 * command pattern is too complex, the optimizer is skipped and the
 * command falls through to the real bash + FUSE path which is always correct.
 */

import type { VectorStore } from "../../types.js";

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface CommandOptimizer {
  /** Human-readable name for logging/debugging. */
  readonly name: string;

  /**
   * Return true if this optimizer should handle the given command.
   * Should be conservative — only match patterns you can correctly emulate.
   */
  match(command: string): boolean;

  /**
   * Execute the command via optimized database queries.
   * Must return a result isomorphic to what real bash would produce.
   */
  execute(command: string, store: VectorStore): Promise<CommandResult>;

  /**
   * Optional: backend capabilities required for this optimizer.
   * If store.capabilities doesn't satisfy all items, the optimizer is skipped.
   */
  readonly requiredCapabilities?: string[];
}

export class OptimizerRegistry {
  private optimizers: CommandOptimizer[] = [];

  register(optimizer: CommandOptimizer): void {
    this.optimizers.push(optimizer);
  }

  /**
   * Find the first optimizer that matches the command AND whose required
   * capabilities are satisfied by the store. Returns null if no match.
   */
  find(command: string, store: VectorStore): CommandOptimizer | null {
    for (const opt of this.optimizers) {
      if (!opt.match(command)) continue;
      if (opt.requiredCapabilities) {
        const caps = (store as any).capabilities ?? {};
        if (opt.requiredCapabilities.some((c) => !caps[c])) continue;
      }
      return opt;
    }
    return null;
  }

  list(): string[] {
    return this.optimizers.map((o) => o.name);
  }
}
