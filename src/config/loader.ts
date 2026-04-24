/**
 * Config loader — reads a YAML or JSON config file, interpolates `${ENV}`
 * references, and validates the top-level shape.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";

import type { ProviderSpec, VfsConfig } from "./schema.js";

const ENV_REF = /\$\{([A-Z_][A-Z0-9_]*)(?::([^}]*))?\}/g;

export interface LoadOptions {
  /** Map used for `${FOO}` interpolation; defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Disallow missing env vars (without a `:default`). Default: true. */
  strictEnv?: boolean;
}

/**
 * Load a config file by path. The file extension decides the parser:
 *   .yaml/.yml → YAML
 *   .json      → JSON
 */
export async function loadConfigFromFile(
  filePath: string,
  opts: LoadOptions = {},
): Promise<VfsConfig> {
  const raw = await fs.promises.readFile(filePath, "utf8");
  return loadConfigFromString(raw, {
    ...opts,
    format: filePath.endsWith(".json") ? "json" : "yaml",
  });
}

/** Load config from an in-memory string. Mostly exists for unit tests. */
export function loadConfigFromString(
  raw: string,
  opts: LoadOptions & { format?: "yaml" | "json" } = {},
): VfsConfig {
  const interpolated = interpolateEnv(raw, opts.env ?? process.env, opts.strictEnv ?? true);
  const parsed = opts.format === "json" ? JSON.parse(interpolated) : parseYaml(interpolated);
  return validateConfig(parsed);
}

/**
 * Substitute `${VAR}` and `${VAR:default}` tokens inside a string.
 * This happens BEFORE parsing, so it works for both YAML and JSON.
 */
export function interpolateEnv(
  input: string,
  env: NodeJS.ProcessEnv,
  strict: boolean,
): string {
  return input.replace(ENV_REF, (match, name: string, def?: string) => {
    const v = env[name];
    if (v !== undefined && v !== "") return v;
    if (def !== undefined) return def;
    if (strict) {
      throw new Error(`config: required env var ${name} is not set (in ${match})`);
    }
    return "";
  });
}

/**
 * Structural validation (no runtime dep on zod). Returns the same object
 * (already shaped as VfsConfig), or throws a descriptive Error.
 */
export function validateConfig(raw: unknown): VfsConfig {
  if (!raw || typeof raw !== "object") {
    throw new Error("config: top-level must be an object");
  }
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.providers)) {
    throw new Error("config: `providers` must be an array");
  }

  const providers: ProviderSpec[] = [];
  const seenNames = new Set<string>();
  const seenPrefixes = new Set<string>();

  for (const [i, p] of (obj.providers as unknown[]).entries()) {
    if (!p || typeof p !== "object") {
      throw new Error(`config: providers[${i}] must be an object`);
    }
    const spec = p as Record<string, unknown>;
    const name = requireString(spec.name, `providers[${i}].name`);
    if (seenNames.has(name)) {
      throw new Error(`config: duplicate provider name "${name}"`);
    }
    seenNames.add(name);

    const mountPrefix = requireString(spec.mountPrefix, `providers[${i}].mountPrefix`);
    if (!mountPrefix.startsWith("/")) {
      throw new Error(`config: providers[${i}].mountPrefix must start with "/"`);
    }
    if (seenPrefixes.has(mountPrefix)) {
      throw new Error(`config: duplicate mountPrefix "${mountPrefix}"`);
    }
    seenPrefixes.add(mountPrefix);

    const driver = requireString(spec.driver, `providers[${i}].driver`);

    let config: Record<string, unknown> | undefined;
    if (spec.config !== undefined) {
      if (!spec.config || typeof spec.config !== "object" || Array.isArray(spec.config)) {
        throw new Error(`config: providers[${i}].config must be an object`);
      }
      config = spec.config as Record<string, unknown>;
    }

    providers.push({ name, mountPrefix, driver, config });
  }

  if (providers.length === 0) {
    throw new Error("config: at least one provider is required");
  }

  return { providers };
}

function requireString(v: unknown, label: string): string {
  if (typeof v !== "string" || v.trim() === "") {
    throw new Error(`config: ${label} must be a non-empty string`);
  }
  return v;
}

/**
 * Resolve a `driver` spec relative to a base directory (usually the config
 * file's directory). Leaves bare specifiers and builtin:/file: unchanged.
 */
export function resolveDriverSpec(driver: string, baseDir: string): string {
  if (driver.startsWith("builtin:")) return driver;
  if (driver.startsWith("file:")) return driver;
  if (driver.startsWith("npm:")) return driver;
  if (driver.startsWith("./") || driver.startsWith("../") || driver.startsWith("/")) {
    const abs = path.resolve(baseDir, driver);
    return "file://" + abs;
  }
  // bare specifier → leave for node's resolver
  return driver;
}
