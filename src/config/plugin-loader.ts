/**
 * Plugin loader — turns a `ProviderSpec` into an instantiated `VfsProvider`.
 *
 * Driver resolution rules (see config/loader.ts:resolveDriverSpec):
 *
 *   "builtin:vector-store"  → VectorStoreProvider over createBackend()
 *   "file://..."            → dynamic import of the file URL
 *   "npm:pkg" / bare        → dynamic import of the bare specifier
 *
 * The module's default export must be either:
 *   (a) a ready VfsProvider (already constructed)
 *   (b) a factory `(spec) => VfsProvider | Promise<VfsProvider>`
 *   (c) a class with `new Class(spec.config)` signature
 *
 * Detection order: if it's callable and has no `readdir` method, treat as
 * factory/class; otherwise treat as provider instance. `defineProvider` is
 * the preferred authoring style — it emits option (a).
 */

import { createBackend } from "../backend/factory.js";
import { VectorStoreProvider } from "../provider/vector-store-provider.js";
import { MountRouter } from "../provider/router.js";
import type { VfsProvider } from "../provider/types.js";
import { resolveDriverSpec } from "./loader.js";
import type { ProviderSpec, VfsConfig } from "./schema.js";

export interface LoadPluginOptions {
  /** Directory to resolve relative driver paths against. Usually the config dir. */
  baseDir: string;
}

export async function loadProvider(
  spec: ProviderSpec,
  opts: LoadPluginOptions,
): Promise<VfsProvider> {
  // ── Builtin: vector-store ──────────────────────────────────────────────
  if (spec.driver === "builtin:vector-store") {
    const cfg = (spec.config ?? {}) as { backend?: string; path?: string };
    // Set env so factory sees the right backend; avoid mutating global env
    // permanently.
    const prevBackend = process.env.VFS_BACKEND;
    const prevSqlitePath = process.env.VFS_SQLITE_PATH;
    try {
      if (cfg.backend) process.env.VFS_BACKEND = cfg.backend;
      if (cfg.path) process.env.VFS_SQLITE_PATH = cfg.path;
      const { store } = createBackend();
      return new VectorStoreProvider(store, {
        name: spec.name,
        mountPrefix: spec.mountPrefix,
      });
    } finally {
      process.env.VFS_BACKEND = prevBackend;
      process.env.VFS_SQLITE_PATH = prevSqlitePath;
    }
  }

  // ── External: filesystem or bare specifier ─────────────────────────────
  const resolved = resolveDriverSpec(spec.driver, opts.baseDir);
  const realSpec = resolved.startsWith("npm:") ? resolved.slice(4) : resolved;

  let mod: unknown;
  try {
    mod = await import(realSpec);
  } catch (e) {
    throw new Error(
      `config: failed to import provider driver ${JSON.stringify(spec.driver)} ` +
        `(resolved to ${realSpec}): ${(e as Error).message}`,
    );
  }

  const fallback = (mod as { default?: unknown }).default ?? mod;
  const provider = await instantiate(fallback, spec);

  // Enforce mountPrefix from config (providers sometimes hardcode their own).
  if (provider.mountPrefix !== spec.mountPrefix) {
    return Object.create(provider, {
      mountPrefix: { value: spec.mountPrefix, enumerable: true },
      name: { value: spec.name, enumerable: true },
    }) as VfsProvider;
  }
  return provider;
}

async function instantiate(exported: unknown, spec: ProviderSpec): Promise<VfsProvider> {
  // Case (a): already a provider instance
  if (isProvider(exported)) return exported;

  // Case (b) or (c): callable → factory / class
  if (typeof exported === "function") {
    let instance: unknown;
    try {
      // Try factory first (no `new`); fall back to constructor
      instance = (exported as (s: ProviderSpec) => unknown)(spec);
      if (instance instanceof Promise) instance = await instance;
      if (!isProvider(instance)) {
        // Try as a class
        instance = new (exported as new (cfg: unknown) => unknown)(spec.config ?? {});
      }
    } catch {
      instance = new (exported as new (cfg: unknown) => unknown)(spec.config ?? {});
    }
    if (!isProvider(instance)) {
      throw new Error(
        `config: driver for "${spec.name}" did not produce a valid VfsProvider`,
      );
    }
    return instance;
  }

  throw new Error(
    `config: driver for "${spec.name}" must export a VfsProvider, a factory, or a class`,
  );
}

function isProvider(v: unknown): v is VfsProvider {
  if (!v || typeof v !== "object") return false;
  const p = v as Record<string, unknown>;
  return (
    typeof p.name === "string" &&
    typeof p.mountPrefix === "string" &&
    typeof p.readdir === "function" &&
    typeof p.read === "function" &&
    typeof p.stat === "function"
  );
}

/** High-level: config → MountRouter ready to mount. */
export async function buildRouterFromConfig(
  cfg: VfsConfig,
  opts: LoadPluginOptions,
): Promise<MountRouter> {
  const router = new MountRouter();
  for (const spec of cfg.providers) {
    const provider = await loadProvider(spec, opts);
    router.mount(provider);
  }
  return router;
}
