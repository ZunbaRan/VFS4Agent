import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  interpolateEnv,
  loadConfigFromString,
  resolveDriverSpec,
  validateConfig,
} from "./loader.js";

describe("config/loader", () => {
  describe("interpolateEnv", () => {
    it("substitutes ${FOO}", () => {
      assert.equal(
        interpolateEnv("hello ${NAME}!", { NAME: "world" }, true),
        "hello world!",
      );
    });
    it("falls back to ${FOO:default}", () => {
      assert.equal(
        interpolateEnv("u=${USER:alice}", {}, true),
        "u=alice",
      );
    });
    it("throws in strict mode when a required var is missing", () => {
      assert.throws(() => interpolateEnv("${MISSING}", {}, true), /MISSING/);
    });
    it("returns empty in non-strict mode when missing", () => {
      assert.equal(interpolateEnv("[${MISSING}]", {}, false), "[]");
    });
  });

  describe("validateConfig", () => {
    it("accepts a minimal well-formed config", () => {
      const cfg = validateConfig({
        providers: [{ name: "docs", mountPrefix: "/docs", driver: "builtin:vector-store" }],
      });
      assert.equal(cfg.providers.length, 1);
      assert.equal(cfg.providers[0]!.name, "docs");
    });
    it("rejects missing providers", () => {
      assert.throws(() => validateConfig({}), /providers.*array/);
    });
    it("rejects duplicate names", () => {
      assert.throws(() =>
        validateConfig({
          providers: [
            { name: "a", mountPrefix: "/a", driver: "builtin:vector-store" },
            { name: "a", mountPrefix: "/b", driver: "builtin:vector-store" },
          ],
        }), /duplicate provider name/);
    });
    it("rejects duplicate mountPrefix", () => {
      assert.throws(() =>
        validateConfig({
          providers: [
            { name: "a", mountPrefix: "/x", driver: "builtin:vector-store" },
            { name: "b", mountPrefix: "/x", driver: "builtin:vector-store" },
          ],
        }), /duplicate mountPrefix/);
    });
    it("rejects relative mountPrefix", () => {
      assert.throws(() =>
        validateConfig({
          providers: [{ name: "a", mountPrefix: "docs", driver: "builtin:vector-store" }],
        }), /mountPrefix must start with/);
    });
    it("rejects empty providers array", () => {
      assert.throws(() => validateConfig({ providers: [] }), /at least one provider/);
    });
  });

  describe("loadConfigFromString", () => {
    it("parses YAML with env interpolation", () => {
      const raw = `
providers:
  - name: docs
    mountPrefix: /docs
    driver: builtin:vector-store
    config:
      backend: \${BACKEND}
      path: \${DB_PATH:./data/default.db}
`;
      const cfg = loadConfigFromString(raw, {
        env: { BACKEND: "sqlite" } as NodeJS.ProcessEnv,
      });
      assert.equal(cfg.providers[0]!.config!.backend, "sqlite");
      assert.equal(cfg.providers[0]!.config!.path, "./data/default.db");
    });
    it("parses JSON when format=json", () => {
      const cfg = loadConfigFromString(
        JSON.stringify({
          providers: [{ name: "a", mountPrefix: "/", driver: "builtin:vector-store" }],
        }),
        { format: "json" },
      );
      assert.equal(cfg.providers[0]!.name, "a");
    });
  });

  describe("resolveDriverSpec", () => {
    it("leaves builtin: untouched", () => {
      assert.equal(resolveDriverSpec("builtin:vector-store", "/tmp"), "builtin:vector-store");
    });
    it("resolves relative paths to file URLs", () => {
      const out = resolveDriverSpec("./provider.js", "/tmp/cfg");
      assert.ok(out.startsWith("file:///"), out);
      assert.ok(out.endsWith("/tmp/cfg/provider.js"), out);
    });
    it("leaves bare specifiers untouched", () => {
      assert.equal(resolveDriverSpec("some-pkg", "/tmp"), "some-pkg");
    });
  });
});
