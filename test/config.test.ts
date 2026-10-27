import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, loadConfig } from "../src/config.ts";

describe("loadConfig", () => {
  let dir: string;
  const warnings: string[] = [];
  const warn = (m: string) => warnings.push(m);
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pi-memory-config-"));
    warnings.length = 0;
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function write(content: string): string {
    const path = join(dir, "memory.json");
    writeFileSync(path, content);
    return path;
  }

  it("missing file => defaults with expanded dbPath", () => {
    const config = loadConfig(join(dir, "nope.json"), warn);
    expect(config.dbPath).toBe(join(homedir(), ".pi-memory", "memory.db"));
    expect(config.embeddingProvider).toBeNull();
    expect(config.privacyPatterns).toEqual(DEFAULT_CONFIG.privacyPatterns);
  });

  it("malformed JSON => explicit error", () => {
    expect(() => loadConfig(write("{ not json"), warn)).toThrow(/invalid JSON/);
  });

  it("merges valid fields and falls back to defaults for invalid ones", () => {
    const config = loadConfig(
      write(
        JSON.stringify({
          maxTextLength: 1000,
          embeddingProvider: "http://192.0.2.10:11434",
          dbPath: "~/x/m.db",
          embeddingDims: -1,
          enabled: "yes",
        }),
      ),
      warn,
    );
    expect(config.maxTextLength).toBe(1000);
    expect(config.embeddingProvider).toBe("http://192.0.2.10:11434");
    expect(config.dbPath).toBe(join(homedir(), "x", "m.db"));
    expect(config.embeddingDims).toBe(DEFAULT_CONFIG.embeddingDims);
    expect(config.enabled).toBe(true);
    expect(warnings).toHaveLength(2);
  });

  it("rejects a non-http embeddingProvider", () => {
    const config = loadConfig(write(JSON.stringify({ embeddingProvider: "file:///etc/passwd" })), warn);
    expect(config.embeddingProvider).toBeNull();
    expect(warnings).toHaveLength(1);
  });

  it("user privacyPatterns extend (do not replace) the defaults", () => {
    const config = loadConfig(write(JSON.stringify({ privacyPatterns: ["INT-[0-9]{4}"] })), warn);
    expect(config.privacyPatterns.length).toBe(DEFAULT_CONFIG.privacyPatterns.length + 1);
    expect(config.privacyPatterns).toContain("INT-[0-9]{4}");
  });
});
