/**
 * Public entrypoint for Command Optimizers.
 */

export type { CommandOptimizer, CommandResult } from "./types.js";
export { OptimizerRegistry } from "./types.js";
export { GrepOptimizer } from "./grep_optimizer.js";
export { FindOptimizer } from "./find_optimizer.js";
export { TreeOptimizer } from "./tree_optimizer.js";
export { WcOptimizer } from "./wc_optimizer.js";
export { LsRecursiveOptimizer } from "./ls_recursive_optimizer.js";
export { DuOptimizer } from "./du_optimizer.js";

import type { CommandOptimizer } from "./types.js";
import { OptimizerRegistry } from "./types.js";
import { GrepOptimizer } from "./grep_optimizer.js";
import { FindOptimizer } from "./find_optimizer.js";
import { TreeOptimizer } from "./tree_optimizer.js";
import { WcOptimizer } from "./wc_optimizer.js";
import { LsRecursiveOptimizer } from "./ls_recursive_optimizer.js";
import { DuOptimizer } from "./du_optimizer.js";

/** Map of short name -> factory. */
const FACTORIES: Record<string, () => CommandOptimizer> = {
  grep: () => new GrepOptimizer(),
  find: () => new FindOptimizer(),
  tree: () => new TreeOptimizer(),
  wc: () => new WcOptimizer(),
  ls: () => new LsRecursiveOptimizer(),
  du: () => new DuOptimizer(),
};

/**
 * Build a registry from the VFS_OPTIMIZERS env string.
 *   - ""         -> no optimizers (pure FUSE)
 *   - "none"     -> no optimizers
 *   - "all"      -> register every known optimizer
 *   - "grep,find"-> register only those
 */
export function buildRegistryFromEnv(value?: string): OptimizerRegistry {
  const reg = new OptimizerRegistry();
  const v = (value ?? "").trim().toLowerCase();
  if (!v || v === "none") return reg;

  const wanted =
    v === "all"
      ? Object.keys(FACTORIES)
      : v
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);

  for (const name of wanted) {
    const make = FACTORIES[name];
    if (!make) {
      console.warn(`[optimizers] unknown optimizer "${name}" — ignored`);
      continue;
    }
    reg.register(make());
  }
  return reg;
}
