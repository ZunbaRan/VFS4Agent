/**
 * Config schema for the Provider-plugin system.
 *
 * A vfs.config.(yaml|yml|json) file describes which providers to mount at
 * which paths, optionally with provider-specific configuration.
 *
 * Example:
 *
 *   providers:
 *     - name: docs
 *       mountPrefix: /docs
 *       driver: builtin:vector-store
 *       config:
 *         backend: sqlite
 *         path: ./data/docs.db
 *     - name: crm
 *       mountPrefix: /crm
 *       driver: ./examples/providers/jsonplaceholder/provider.js
 *       config:
 *         baseUrl: ${CRM_BASE_URL}
 *
 * Environment variables referenced as `${NAME}` are interpolated at load time.
 */

export interface ProviderSpec {
  /** Short identifier, used in logs and errors. */
  name: string;
  /** Absolute mount prefix. Use "/" for a sole root-mounted provider. */
  mountPrefix: string;
  /**
   * Driver identifier. Supported forms:
   *   - "builtin:vector-store"        → src/provider/vector-store-provider.ts
   *   - "./path/to/module.js|ts"      → filesystem import (resolved from CWD)
   *   - "file:///abs/path/module.js"  → absolute file URL
   *   - "npm:some-pkg" / "some-pkg"   → bare specifier (node resolve)
   */
  driver: string;
  /** Arbitrary JSON-serializable config passed to the provider factory. */
  config?: Record<string, unknown>;
}

export interface VfsConfig {
  providers: ProviderSpec[];
}
