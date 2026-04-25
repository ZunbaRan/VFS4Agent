/**
 * Public entry point for the provider plugin system.
 *
 * External plugin authors import from this module:
 *   import { defineProvider, VfsError } from "vfs4agent/provider";
 */

export * from "./types.js";
export { MountRouter } from "./router.js";
export { VectorStoreProvider } from "./vector-store-provider.js";
export {
  joinMount,
  matchMount,
  normalizeAbsPath,
  normalizeMountPrefix,
  topSegment,
} from "./paths.js";
