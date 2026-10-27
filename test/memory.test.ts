import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG, type MemoryConfig } from "../src/config.ts";
import { countEntries, openDatabase, type DatabaseHandle } from "../src/db.ts";
import { createMemoryService, TITLE_MAX_LENGTH, type EmbedFn, type MemoryService } from "../src/memory.ts";

const AWS_KEY = "AKIAIOSFODNN7EXAMPLE";

function config(overrides: Partial<MemoryConfig> = {}): MemoryConfig {
  return { ...DEFAULT_CONFIG, dbPath: ":memory:", ...overrides };
}

/** All persisted columns of all rows (entries + FTS), to assert nothing leaked anywhere. */
function dumpDb(db: DatabaseHandle): string {
  const entries = db.prepare("SELECT id, title, text, tags, project FROM entries").all();
  const fts = db.prepare("SELECT title, text FROM entries_fts").all();
  return JSON.stringify({ entries, fts });
}

describe("memory service without embeddings", () => {
  let db: DatabaseHandle;
  let memory: MemoryService;

  beforeEach(() => {
    db = openDatabase(":memory:");
    memory = createMemoryService({ db, config: config() });
  });
  afterEach(() => db?.close());

  describe("save", () => {
    it("happy path: stores a manual entry with title, tags and project", async () => {
      const saved = await memory.save({
        text: "We deploy the backend via ArgoCD",
        title: "Deploy",
        tags: ["infra", "deploy"],
        project: "pi-memory-extension",
      });
      expect(saved).toMatchObject({
        source: "manual",
        title: "Deploy",
        text: "We deploy the backend via ArgoCD",
        tags: ["infra", "deploy"],
        project: "pi-memory-extension",
        redacted: false,
        embedding: null,
      });
      expect(countEntries(db)).toBe(1);
      expect(memory.get({ ids: [saved.id] }).entries[0].text).toBe("We deploy the backend via ArgoCD");
    });

    it("defaults: source=manual, tags=[], project=null, title derived from the first line", async () => {
      const saved = await memory.save({ text: "\n  First line fact\nsecond line" });
      expect(saved.source).toBe("manual");
      expect(saved.tags).toEqual([]);
      expect(saved.project).toBeNull();
      expect(saved.title).toBe("First line fact");
    });

    it("keeps source=auto when requested (auto extraction path)", async () => {
      const saved = await memory.save({ text: "auto fact", source: "auto" });
      expect(saved.source).toBe("auto");
    });

    it(`cuts the title to ${TITLE_MAX_LENGTH} characters (explicit and derived)`, async () => {
      const explicit = await memory.save({ text: "body", title: "t".repeat(500) });
      expect(explicit.title).toBe("t".repeat(TITLE_MAX_LENGTH));
      const derived = await memory.save({ text: "d".repeat(500) });
      expect(derived.title.length).toBeLessThanOrEqual(TITLE_MAX_LENGTH);
    });

    it("strips <private> from the input text and title before storing", async () => {
      const saved = await memory.save({
        text: "Server is fast <private>root pw is qwerty123</private> and stable",
        title: "Server <private>at 10.1.2.3</private>",
      });
      expect(saved.text).not.toContain("qwerty123");
      expect(saved.text).toContain("and stable");
      expect(saved.title).not.toContain("10.1.2.3");
      expect(dumpDb(db)).not.toContain("qwerty123");
      expect(dumpDb(db)).not.toContain("10.1.2.3");
    });

    it("redacts secrets (no <private> tag) in text and title, marks redacted=true, nothing leaks into DB/FTS", async () => {
      const saved = await memory.save({
        text: `CI uses ${AWS_KEY} and DB_PASSWORD=hunter2hunter2`,
        title: `creds ${AWS_KEY}`,
      });
      expect(saved.redacted).toBe(true);
      expect(saved.text).toMatch(/\[REDACTED:[^\]]+\]/);
      expect(saved.text).not.toContain(AWS_KEY);
      expect(saved.text).not.toContain("hunter2hunter2");
      expect(saved.title).not.toContain(AWS_KEY);
      const dump = dumpDb(db);
      expect(dump).not.toContain(AWS_KEY);
      expect(dump).not.toContain("hunter2hunter2");
      expect((await memory.search({ query: AWS_KEY })).hits).toEqual([]);
    });

    it("truncates text to maxTextLength before storing (boundary: limit and limit+1)", async () => {
      memory = createMemoryService({ db, config: config({ maxTextLength: 50 }) });
      const atLimit = await memory.save({ text: "a".repeat(50) });
      expect(atLimit.text).toBe("a".repeat(50));
      const overLimit = await memory.save({ text: "b".repeat(51) });
      expect(overLimit.text).toBe("b".repeat(50));
    });

    // Decision: empty input is a caller error -> explicit exception, nothing is written.
    it.each([
      ["empty string", ""],
      ["whitespace only", "   \n\t "],
      ["only a <private> block (empty after filtering)", "<private>all of it is private</private>"],
    ])("rejects %s with an explicit error and writes nothing", async (_label, text) => {
      await expect(memory.save({ text })).rejects.toThrow(/empty/i);
      expect(countEntries(db)).toBe(0);
    });
  });

  describe("search (keyword-only, embeddings not configured)", () => {
    it("empty DB returns no hits", async () => {
      const result = await memory.search({ query: "anything" });
      expect(result.hits).toEqual([]);
      expect(result.mode).toBe("keyword");
    });

    it("happy path: default mode is keyword and finds a saved entry", async () => {
      const saved = await memory.save({ text: "Prefer pnpm over npm in this repo", title: "Package manager" });
      await memory.save({ text: "Unrelated coffee note" });
      const result = await memory.search({ query: "pnpm" });
      expect(result.mode).toBe("keyword");
      expect(result.hits.map((h) => h.id)).toEqual([saved.id]);
      expect(result.hits[0]).toMatchObject({ title: "Package manager", text: "Prefer pnpm over npm in this repo" });
      expect(result.hits[0]).not.toHaveProperty("embedding");
      expect(typeof result.hits[0].score).toBe("number");
    });

    it.each(["semantic", "hybrid"] as const)(
      "mode=%s without embeddings falls back to keyword with a warning",
      async (mode) => {
        const saved = await memory.save({ text: "fallback works" });
        const result = await memory.search({ query: "fallback", mode });
        expect(result.mode).toBe("keyword");
        expect(result.warning).toBeTruthy();
        expect(result.hits.map((h) => h.id)).toEqual([saved.id]);
      },
    );

    it("empty query returns no hits without throwing", async () => {
      await memory.save({ text: "something" });
      expect((await memory.search({ query: "" })).hits).toEqual([]);
      expect((await memory.search({ query: "   " })).hits).toEqual([]);
    });

    it("respects explicit limit and the default limit of 10", async () => {
      for (let i = 0; i < 12; i++) await memory.save({ text: `repeated keyword ${i}` });
      expect((await memory.search({ query: "repeated", limit: 3 })).hits).toHaveLength(3);
      expect((await memory.search({ query: "repeated" })).hits).toHaveLength(10);
    });

    it("filters by project tag", async () => {
      const a = await memory.save({ text: "project scoped fact", project: "a" });
      await memory.save({ text: "project scoped fact", project: "b" });
      const result = await memory.search({ query: "scoped", project: "a" });
      expect(result.hits.map((h) => h.id)).toEqual([a.id]);
    });

    it.each(["' OR '1'='1", "\"; DROP TABLE entries; --", "alpha OR beta*"])(
      "query %j is treated as data (no throw, DB intact)",
      async (query) => {
        await memory.save({ text: "alpha" });
        await memory.save({ text: "beta" });
        const result = await memory.search({ query });
        expect(result.hits.length).toBeLessThan(2);
        expect(countEntries(db)).toBe(2);
      },
    );

    it("project injection payload does not widen the filter", async () => {
      await memory.save({ text: "secretless fact", project: "a" });
      const result = await memory.search({ query: "fact", project: "a' OR '1'='1" });
      expect(result.hits).toEqual([]);
    });
  });

  describe("get", () => {
    it("happy path: returns full entries without embeddings", async () => {
      const a = await memory.save({ text: "first", title: "A", tags: ["x"] });
      const result = memory.get({ ids: [a.id] });
      expect(result.missing).toEqual([]);
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0]).toMatchObject({ id: a.id, title: "A", text: "first", tags: ["x"] });
      expect(result.entries[0]).not.toHaveProperty("embedding");
    });

    it("empty DB / nonexistent ids: no entries, all ids reported as missing", () => {
      expect(memory.get({ ids: ["nope-1", "nope-2"] })).toEqual({ entries: [], missing: ["nope-1", "nope-2"] });
    });

    it("empty ids list returns nothing", () => {
      expect(memory.get({ ids: [] })).toEqual({ entries: [], missing: [] });
    });

    it("preserves request order, dedupes ids and reports missing ones", async () => {
      const a = await memory.save({ text: "first" });
      const b = await memory.save({ text: "second" });
      const result = memory.get({ ids: [b.id, "nope", a.id, b.id] });
      expect(result.entries.map((e) => e.id)).toEqual([b.id, a.id]);
      expect(result.missing).toEqual(["nope"]);
    });

    it("injection payloads in ids are just missing ids", async () => {
      await memory.save({ text: "first" });
      const payloads = ["' OR '1'='1", "\"); DROP TABLE entries; --"];
      expect(memory.get({ ids: payloads })).toEqual({ entries: [], missing: payloads });
      expect(countEntries(db)).toBe(1);
    });
  });
});

describe("memory service with embeddings (optional semantic mode)", () => {
  let db: DatabaseHandle;
  afterEach(() => db?.close());

  const vectors: Record<string, number[]> = {
    cats: [1, 0, 0],
    dogs: [0, 1, 0],
    kitten: [0.9, 0.1, 0],
  };
  function fakeEmbed(): EmbedFn & ReturnType<typeof vi.fn> {
    return vi.fn(async (text: string) => {
      const key = Object.keys(vectors).find((k) => text.toLowerCase().includes(k));
      return new Float32Array(key ? vectors[key] : [0, 0, 1]);
    }) as unknown as EmbedFn & ReturnType<typeof vi.fn>;
  }

  beforeEach(() => {
    db = openDatabase(":memory:");
  });

  it("stores the embedding and sends only sanitized text to the embeddings provider", async () => {
    const embed = fakeEmbed();
    const memory = createMemoryService({ db, config: config({ embeddingProvider: "http://ollama" }), embed });
    const saved = await memory.save({ text: `cats like boxes <private>my secret note</private> ${AWS_KEY}` });
    expect(saved.embedding).toEqual(new Float32Array([1, 0, 0]));
    expect(embed).toHaveBeenCalled();
    for (const call of embed.mock.calls) {
      expect(call[0]).not.toContain("my secret note");
      expect(call[0]).not.toContain(AWS_KEY);
    }
  });

  it("still saves (embedding=null) when the embeddings provider fails", async () => {
    const embed = vi.fn(async () => {
      throw new Error("ollama down");
    });
    const memory = createMemoryService({ db, config: config({ embeddingProvider: "http://ollama" }), embed });
    const saved = await memory.save({ text: "resilient fact" });
    expect(saved.embedding).toBeNull();
    expect(countEntries(db)).toBe(1);
  });

  it("semantic search ranks by cosine similarity, descending", async () => {
    const embed = fakeEmbed();
    const memory = createMemoryService({ db, config: config({ embeddingProvider: "http://ollama" }), embed });
    const dogs = await memory.save({ text: "dogs bark at night" });
    const cats = await memory.save({ text: "cats sleep all day" });
    const result = await memory.search({ query: "kitten", mode: "semantic" });
    expect(result.mode).toBe("semantic");
    expect(result.hits.map((h) => h.id)).toEqual([cats.id, dogs.id]);
    expect(result.hits[0].score).toBeGreaterThan(result.hits[1].score);
  });
});
