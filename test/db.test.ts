import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  countEntries,
  getEntriesByIds,
  getLatestEntry,
  insertEntry,
  listEntriesWithEmbedding,
  openDatabase,
  searchKeyword,
  type DatabaseHandle,
  type NewEntry,
} from "../src/db.ts";

function entry(overrides: Partial<NewEntry> = {}): NewEntry {
  return {
    source: "manual",
    title: "untitled",
    text: "some text",
    tags: [],
    project: null,
    embedding: null,
    redacted: false,
    ...overrides,
  };
}

/** Payloads that would alter SQL / FTS5 semantics if concatenated into a query. */
const INJECTIONS = [
  "' OR '1'='1",
  "\" OR \"1\"=\"1",
  "\"; DROP TABLE entries; --",
  "'); DROP TABLE entries; --",
  "1 OR 1=1",
  "% _ *",
  "x' UNION SELECT * FROM entries --",
  "NEAR(alpha beta)",
  "title:alpha",
  "\\'; --",
];

function tableExists(db: DatabaseHandle, name: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE name = ?").get(name) !== undefined;
}

describe("db: schema and storage", () => {
  let db: DatabaseHandle;
  beforeEach(() => {
    db = openDatabase(":memory:");
  });
  afterEach(() => db?.close());

  it("creates entries table, FTS5 table and indexes on created_at and project", () => {
    expect(tableExists(db, "entries")).toBe(true);
    expect(tableExists(db, "entries_fts")).toBe(true);
    const indexes = db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'entries' AND sql IS NOT NULL")
      .all() as Array<{ sql: string }>;
    const sqls = indexes.map((i) => i.sql).join("\n");
    expect(sqls).toMatch(/created_at/);
    expect(sqls).toMatch(/project/);
  });

  it("round-trips all fields of an entry", () => {
    const embedding = new Float32Array([0.1, -0.2, 0.3]);
    const saved = insertEntry(
      db,
      entry({
        source: "auto",
        title: "Decision",
        text: "Use PostgreSQL",
        tags: ["db", "decision"],
        project: "my-proj",
        embedding,
        redacted: true,
      }),
    );
    expect(typeof saved.id).toBe("string");
    expect(saved.id.length).toBeGreaterThan(0);
    expect(new Date(saved.created_at).toISOString()).toBe(saved.created_at);

    const [row] = getEntriesByIds(db, [saved.id]);
    expect(row).toEqual({
      id: saved.id,
      created_at: saved.created_at,
      source: "auto",
      title: "Decision",
      text: "Use PostgreSQL",
      tags: ["db", "decision"],
      project: "my-proj",
      embedding,
      redacted: true,
    });
  });

  it("generates unique ids", () => {
    const a = insertEntry(db, entry());
    const b = insertEntry(db, entry());
    expect(a.id).not.toBe(b.id);
  });

  it("empty DB: count 0, no latest entry, searches and lookups return []", () => {
    expect(countEntries(db)).toBe(0);
    expect(getLatestEntry(db)).toBeUndefined();
    expect(searchKeyword(db, "anything", { limit: 10 })).toEqual([]);
    expect(getEntriesByIds(db, ["no-such-id"])).toEqual([]);
    expect(listEntriesWithEmbedding(db)).toEqual([]);
  });

  it("getEntriesByIds([]) returns [] (no `IN ()` syntax error)", () => {
    insertEntry(db, entry());
    expect(getEntriesByIds(db, [])).toEqual([]);
  });

  it("getLatestEntry returns the most recent entry by created_at", () => {
    insertEntry(db, entry({ title: "old", created_at: "2024-01-01T00:00:00.000Z" }));
    insertEntry(db, entry({ title: "new", created_at: "2025-06-01T00:00:00.000Z" }));
    insertEntry(db, entry({ title: "mid", created_at: "2024-06-01T00:00:00.000Z" }));
    expect(getLatestEntry(db)?.title).toBe("new");
    expect(countEntries(db)).toBe(3);
  });

  it("listEntriesWithEmbedding returns only rows with an embedding", () => {
    const withEmb = insertEntry(db, entry({ embedding: new Float32Array([1, 0]) }));
    insertEntry(db, entry({ embedding: null }));
    expect(listEntriesWithEmbedding(db).map((e) => e.id)).toEqual([withEmb.id]);
  });
});

describe("db: keyword search (FTS5)", () => {
  let db: DatabaseHandle;
  beforeEach(() => {
    db = openDatabase(":memory:");
  });
  afterEach(() => db?.close());

  it("finds entries by words in title or text, case-insensitively", () => {
    const a = insertEntry(db, entry({ title: "Deploy process", text: "We deploy via ArgoCD" }));
    insertEntry(db, entry({ title: "Unrelated", text: "Coffee preferences" }));
    expect(searchKeyword(db, "argocd", { limit: 10 }).map((h) => h.id)).toEqual([a.id]);
    expect(searchKeyword(db, "DEPLOY", { limit: 10 }).map((h) => h.id)).toEqual([a.id]);
  });

  it("supports Cyrillic text", () => {
    const a = insertEntry(db, entry({ title: "Решение", text: "Решили использовать PostgreSQL" }));
    expect(searchKeyword(db, "решили", { limit: 10 }).map((h) => h.id)).toEqual([a.id]);
  });

  it("respects limit and returns a numeric score", () => {
    for (let i = 0; i < 5; i++) insertEntry(db, entry({ text: `common word ${i}` }));
    const hits = searchKeyword(db, "common", { limit: 2 });
    expect(hits).toHaveLength(2);
    for (const h of hits) expect(typeof h.score).toBe("number");
  });

  it("filters by project (exact match)", () => {
    const a = insertEntry(db, entry({ text: "shared fact", project: "proj-a" }));
    insertEntry(db, entry({ text: "shared fact", project: "proj-b" }));
    insertEntry(db, entry({ text: "shared fact", project: null }));
    expect(searchKeyword(db, "shared", { limit: 10, project: "proj-a" }).map((h) => h.id)).toEqual([a.id]);
    expect(searchKeyword(db, "shared", { limit: 10 })).toHaveLength(3);
  });

  it("empty or punctuation-only query returns [] without throwing", () => {
    insertEntry(db, entry({ text: "alpha" }));
    expect(searchKeyword(db, "", { limit: 10 })).toEqual([]);
    expect(searchKeyword(db, "   ", { limit: 10 })).toEqual([]);
    expect(searchKeyword(db, "\"'*():-^", { limit: 10 })).toEqual([]);
  });
});

describe("db: SQL / FTS injection via parameters is treated as plain data", () => {
  let db: DatabaseHandle;
  let alpha: { id: string };
  let beta: { id: string };

  beforeEach(() => {
    db = openDatabase(":memory:");
    alpha = insertEntry(db, entry({ title: "alpha note", text: "alpha apple", project: "proj-a" }));
    beta = insertEntry(db, entry({ title: "beta note", text: "beta banana", project: "proj-b" }));
  });
  afterEach(() => db?.close());

  function assertIntact(expectedCount = 2) {
    expect(tableExists(db, "entries")).toBe(true);
    expect(tableExists(db, "entries_fts")).toBe(true);
    expect(countEntries(db)).toBe(expectedCount);
  }

  describe("query", () => {
    for (const payload of INJECTIONS) {
      it(`does not throw, match everything or modify the DB: ${JSON.stringify(payload)}`, () => {
        let hits: Array<{ id: string }> = [];
        expect(() => {
          hits = searchKeyword(db, payload, { limit: 10 });
        }).not.toThrow();
        // None of the payloads consists only of words present in BOTH entries,
        // so returning both entries would mean the payload changed query semantics.
        expect(hits.length).toBeLessThan(2);
        assertIntact();
      });
    }

    it("FTS operators are not interpreted: 'alpha OR beta' does not return both entries", () => {
      const ids = searchKeyword(db, "alpha OR beta", { limit: 10 }).map((h) => h.id);
      expect(ids).not.toContain(beta.id);
      expect(ids).not.toEqual(expect.arrayContaining([alpha.id, beta.id]));
    });

    it("FTS prefix operator is not interpreted: 'alph*' does not match 'alpha'", () => {
      expect(searchKeyword(db, "alph*", { limit: 10 })).toEqual([]);
    });

    it("FTS column filter is not interpreted: 'title:beta' is not a column query", () => {
      // As plain data this requires the word "title" as well, which no entry contains.
      expect(searchKeyword(db, "title:beta", { limit: 10 })).toEqual([]);
    });

    it("unbalanced quote is tolerated and the word still matches", () => {
      expect(searchKeyword(db, "\"alpha", { limit: 10 }).map((h) => h.id)).toEqual([alpha.id]);
    });

    it("a stored literal SQL-looking payload is found as data, and only that entry", () => {
      const lit = insertEntry(db, entry({ text: "payload ' OR '1'='1 stored verbatim" }));
      const ids = searchKeyword(db, "' OR '1'='1", { limit: 10 }).map((h) => h.id);
      expect(ids).toEqual([lit.id]);
      assertIntact(3);
    });
  });

  describe("project", () => {
    for (const payload of INJECTIONS) {
      it(`search with project=${JSON.stringify(payload)} returns nothing and does not throw`, () => {
        expect(searchKeyword(db, "note", { limit: 10, project: payload })).toEqual([]);
        expect(listEntriesWithEmbedding(db, { project: payload })).toEqual([]);
        assertIntact();
      });
    }

    it("'proj-a' OR ... payload does not widen the filter", () => {
      expect(searchKeyword(db, "note", { limit: 10, project: "proj-a' OR '1'='1" })).toEqual([]);
    });

    it("a project value containing SQL is stored verbatim and matched exactly", () => {
      const weird = "x' OR '1'='1\"; DROP TABLE entries; --";
      const e = insertEntry(db, entry({ text: "weird project note", project: weird }));
      expect(getEntriesByIds(db, [e.id])[0].project).toBe(weird);
      expect(searchKeyword(db, "note", { limit: 10, project: weird }).map((h) => h.id)).toEqual([e.id]);
      assertIntact(3);
    });
  });

  describe("id", () => {
    for (const payload of INJECTIONS) {
      it(`getEntriesByIds([${JSON.stringify(payload)}]) returns [] and does not throw`, () => {
        expect(getEntriesByIds(db, [payload])).toEqual([]);
        assertIntact();
      });
    }

    it("mixing a valid id with injection payloads returns only the valid entry", () => {
      const rows = getEntriesByIds(db, [alpha.id, "' OR '1'='1", "\"); DROP TABLE entries; --"]);
      expect(rows.map((r) => r.id)).toEqual([alpha.id]);
      assertIntact();
    });
  });

  describe("stored values", () => {
    it("title/text/tags containing SQL are stored and returned verbatim", () => {
      const e = insertEntry(
        db,
        entry({
          title: "t'); DROP TABLE entries; --",
          text: "\"; DELETE FROM entries; --",
          tags: ["' OR '1'='1", "\"quoted\""],
        }),
      );
      const [row] = getEntriesByIds(db, [e.id]);
      expect(row.title).toBe("t'); DROP TABLE entries; --");
      expect(row.text).toBe("\"; DELETE FROM entries; --");
      expect(row.tags).toEqual(["' OR '1'='1", "\"quoted\""]);
      assertIntact(3);
    });
  });
});

describe("db: file storage and permissions (TZ 3.6)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pi-memory-test-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("creates the parent dir with 0700 and the DB file with 0600 even under a permissive umask", () => {
    const dbPath = join(dir, "nested", "memory.db");
    let previousUmask: number | undefined;
    try {
      previousUmask = process.umask(0o000);
    } catch {
      // process.umask() is unavailable in worker threads; still check the final modes.
    }
    try {
      const db = openDatabase(dbPath);
      db.close();
    } finally {
      if (previousUmask !== undefined) process.umask(previousUmask);
    }
    expect(statSync(join(dir, "nested")).mode & 0o777).toBe(0o700);
    expect(statSync(dbPath).mode & 0o777).toBe(0o600);
  });

  it("forces 0700 on a pre-existing insecure default ~/.pi-memory directory", () => {
    const previousHome = process.env.HOME;
    process.env.HOME = dir; // os.homedir() honours $HOME: never touch the real home
    try {
      const memDir = join(dir, ".pi-memory");
      mkdirSync(memDir);
      chmodSync(memDir, 0o777);
      const dbPath = join(memDir, "memory.db");
      openDatabase(dbPath).close();
      expect(statSync(memDir).mode & 0o777).toBe(0o700);
      expect(statSync(dbPath).mode & 0o777).toBe(0o600);

      // Nested dirs under ~/.pi-memory are forced to 0700 too, up to ~/.pi-memory.
      chmodSync(memDir, 0o777);
      mkdirSync(join(memDir, "sub"));
      chmodSync(join(memDir, "sub"), 0o777);
      openDatabase(join(memDir, "sub", "memory.db")).close();
      expect(statSync(memDir).mode & 0o777).toBe(0o700);
      expect(statSync(join(memDir, "sub")).mode & 0o777).toBe(0o700);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  });

  it.each([0o777, 0o1777, 0o770])(
    "refuses a custom dbPath whose pre-existing directory is group/world-writable (mode %o) and does not chmod it",
    (mode) => {
      const shared = join(dir, "shared");
      mkdirSync(shared);
      chmodSync(shared, mode);
      const dbPath = join(shared, "memory.db");
      expect(() => openDatabase(dbPath)).toThrow(/refusing to use DB directory.*writable/);
      expect(statSync(shared).mode & 0o7777).toBe(mode);
      expect(existsSync(dbPath)).toBe(false);
    },
  );

  it("accepts a custom dbPath in a pre-existing private directory without changing its mode", () => {
    const own = join(dir, "own");
    mkdirSync(own);
    chmodSync(own, 0o755);
    openDatabase(join(own, "memory.db")).close();
    expect(statSync(own).mode & 0o777).toBe(0o755);
  });

  it("persists data across reopen (schema creation is idempotent)", () => {
    const dbPath = join(dir, "memory.db");
    const db1 = openDatabase(dbPath);
    const saved = insertEntry(db1, entry({ title: "persisted", text: "survives restart" }));
    db1.close();

    const db2 = openDatabase(dbPath);
    try {
      expect(countEntries(db2)).toBe(1);
      expect(getEntriesByIds(db2, [saved.id])[0].title).toBe("persisted");
      expect(searchKeyword(db2, "restart", { limit: 10 }).map((h) => h.id)).toEqual([saved.id]);
    } finally {
      db2.close();
    }
  });
});
