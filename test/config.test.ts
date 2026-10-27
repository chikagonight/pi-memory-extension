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

  it("embedding task prefixes: nomic defaults, derived from model, explicit override", () => {
    expect(DEFAULT_CONFIG.embeddingQueryPrefix).toBe("search_query: ");
    expect(DEFAULT_CONFIG.embeddingDocumentPrefix).toBe("search_document: ");

    const missing = loadConfig(join(dir, "nope.json"), warn);
    expect(missing.embeddingQueryPrefix).toBe("search_query: ");
    expect(missing.embeddingDocumentPrefix).toBe("search_document: ");

    const tagged = loadConfig(write(JSON.stringify({ embeddingModel: "nomic-embed-text:v1.5" })), warn);
    expect(tagged.embeddingQueryPrefix).toBe("search_query: ");
    expect(tagged.embeddingDocumentPrefix).toBe("search_document: ");

    // Another model without explicit prefixes => no prefixes (do not alter its embeddings).
    const other = loadConfig(write(JSON.stringify({ embeddingModel: "mxbai-embed-large" })), warn);
    expect(other.embeddingQueryPrefix).toBe("");
    expect(other.embeddingDocumentPrefix).toBe("");

    const explicit = loadConfig(
      write(JSON.stringify({ embeddingModel: "e5-large", embeddingQueryPrefix: "query: ", embeddingDocumentPrefix: "passage: " })),
      warn,
    );
    expect(explicit.embeddingQueryPrefix).toBe("query: ");
    expect(explicit.embeddingDocumentPrefix).toBe("passage: ");

    const disabled = loadConfig(write(JSON.stringify({ embeddingQueryPrefix: "", embeddingDocumentPrefix: "" })), warn);
    expect(disabled.embeddingQueryPrefix).toBe("");
    expect(disabled.embeddingDocumentPrefix).toBe("");
    expect(warnings).toHaveLength(0);

    const invalid = loadConfig(write(JSON.stringify({ embeddingQueryPrefix: 42, embeddingDocumentPrefix: "x".repeat(500) })), warn);
    expect(invalid.embeddingQueryPrefix).toBe("search_query: ");
    expect(invalid.embeddingDocumentPrefix).toBe("search_document: ");
    expect(warnings).toHaveLength(2);
  });

  it("user privacyPatterns extend (do not replace) the defaults", () => {
    const config = loadConfig(write(JSON.stringify({ privacyPatterns: ["INT-[0-9]{4}"] })), warn);
    expect(config.privacyPatterns.length).toBe(DEFAULT_CONFIG.privacyPatterns.length + 1);
    expect(config.privacyPatterns).toContain("INT-[0-9]{4}");
  });
});
