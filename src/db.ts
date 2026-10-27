/**
 * SQLite storage (better-sqlite3). Schema: TZ.md section 4.1.
 *
 * SECURITY: every query MUST use `?` placeholders. No string concatenation of
 * user/LLM-provided values (project, id, query, title, text, tags) into SQL.
 * FTS5 MATCH input must additionally be escaped so FTS query syntax
 * (quotes, OR/AND/NOT/NEAR, `*`, `column:`) is treated as plain data.
 *
 * NOTE: `project` is a convenience tag for filtering, NOT a security boundary.
 * Memory is global and shared by design.
 */
import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import Database from "better-sqlite3";
import { bufferToEmbedding, embeddingToBuffer } from "./embeddings.ts";

export type DatabaseHandle = Database.Database;

export type EntrySource = "manual" | "auto";

export interface EntryRow {
  id: string;
  created_at: string;
  source: EntrySource;
  title: string;
  text: string;
  tags: string[];
  project: string | null;
  embedding: Float32Array | null;
  redacted: boolean;
}

export interface NewEntry {
  source: EntrySource;
  title: string;
  text: string;
  tags: string[];
  project: string | null;
  embedding?: Float32Array | null;
  redacted: boolean;
  /** Optional explicit timestamp (ISO); defaults to now. */
  created_at?: string;
}

export interface KeywordSearchOptions {
  limit: number;
  /** Exact-match project filter; undefined = all projects. */
  project?: string;
}

export interface KeywordHit extends EntryRow {
  /** Higher = more relevant. */
  score: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS entries (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('manual', 'auto')),
  title TEXT NOT NULL,
  text TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  project TEXT,
  embedding BLOB,
  redacted INTEGER NOT NULL DEFAULT 0 CHECK (redacted IN (0, 1))
);
CREATE INDEX IF NOT EXISTS idx_entries_created_at ON entries (created_at);
CREATE INDEX IF NOT EXISTS idx_entries_project ON entries (project);
CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(
  entry_id UNINDEXED,
  title,
  text,
  tokenize = 'unicode61 remove_diacritics 2'
);
CREATE TRIGGER IF NOT EXISTS entries_fts_ai AFTER INSERT ON entries BEGIN
  INSERT INTO entries_fts (entry_id, title, text) VALUES (new.id, new.title, new.text);
END;
CREATE TRIGGER IF NOT EXISTS entries_fts_ad AFTER DELETE ON entries BEGIN
  DELETE FROM entries_fts WHERE entry_id = old.id;
END;
CREATE TRIGGER IF NOT EXISTS entries_fts_au AFTER UPDATE OF id, title, text ON entries BEGIN
  DELETE FROM entries_fts WHERE entry_id = old.id;
  INSERT INTO entries_fts (entry_id, title, text) VALUES (new.id, new.title, new.text);
END;
`;

/** Constant column list (no user data is ever interpolated into SQL text). */
const COLUMNS = "e.id, e.created_at, e.source, e.title, e.text, e.tags, e.project, e.embedding, e.redacted";

interface RawRow {
  id: string;
  created_at: string;
  source: EntrySource;
  title: string;
  text: string;
  tags: string;
  project: string | null;
  embedding: Buffer | null;
  redacted: number;
}

function parseTags(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === "string") : [];
  } catch {
    return [];
  }
}

function toEntry(row: RawRow): EntryRow {
  return {
    id: row.id,
    created_at: row.created_at,
    source: row.source,
    title: row.title,
    text: row.text,
    tags: parseTags(row.tags),
    project: row.project,
    embedding: row.embedding ? bufferToEmbedding(row.embedding) : null,
    redacted: row.redacted === 1,
  };
}

/** The dedicated memory directory (`~/.pi-memory`), resolved at call time. */
export function managedDbDirectory(): string {
  return resolve(join(homedir(), ".pi-memory"));
}

/** True when `dir` is `managed` itself or lies inside it. */
function isWithin(dir: string, managed: string): boolean {
  const rel = relative(managed, dir);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Pre-existing directory outside `~/.pi-memory`: we must not chmod it (it may be
 * $HOME, /tmp or a shared dir), so refuse to use it when other local users could
 * replace/pre-create the DB file in it.
 */
function assertSafeExistingDirectory(dir: string): void {
  const st = statSync(dir);
  if (!st.isDirectory()) throw new Error(`pi-memory: DB parent ${dir} is not a directory`);
  const mode = st.mode & 0o777;
  if (mode & 0o022) {
    throw new Error(
      `pi-memory: refusing to use DB directory ${dir}: it is group/world-writable (mode ${mode.toString(8)}); ` +
        `use a private directory (chmod 700) or the default ~/.pi-memory`,
    );
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (uid !== undefined && st.uid !== uid && st.uid !== 0) {
    throw new Error(`pi-memory: refusing to use DB directory ${dir}: it is owned by another user (uid ${st.uid})`);
  }
}

/**
 * Prepares the DB directory (umask-proof):
 * - inside the dedicated `~/.pi-memory`: created if needed and ALWAYS forced to 0700
 *   (every level from the DB dir up to `~/.pi-memory`), even when it already existed;
 * - elsewhere: directories created by this call get 0700; a pre-existing directory is
 *   never chmod-ed but rejected when group/world-writable or owned by another user.
 */
function ensureDbDirectory(dir: string): void {
  const managed = managedDbDirectory();
  if (isWithin(dir, managed)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (let current = dir; ; current = dirname(current)) {
      chmodSync(current, 0o700);
      if (current === managed) break;
    }
    return;
  }
  if (existsSync(dir)) {
    assertSafeExistingDirectory(dir);
    return;
  }
  const firstCreated = mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!firstCreated) return;
  let current = dir;
  const root = resolve(firstCreated);
  // chmod every directory created by this call, from the leaf up to the first created one.
  for (;;) {
    chmodSync(current, 0o700);
    if (resolve(current) === root) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

/**
 * Opens/creates the DB and initializes the schema idempotently.
 * - `":memory:"` supported (tests).
 * - File path: the DB file gets 0600 and directories created by us get 0700 (set
 *   explicitly with chmod, independent of umask). The dedicated `~/.pi-memory` is
 *   always forced to 0700; other pre-existing directories are not chmod-ed but
 *   rejected with an error when group/world-writable (see ensureDbDirectory).
 */
export function openDatabase(dbPath: string): DatabaseHandle {
  if (dbPath === ":memory:") {
    const db = new Database(":memory:");
    db.exec(SCHEMA);
    return db;
  }
  const absolute = resolve(dbPath);
  ensureDbDirectory(dirname(absolute));
  if (!existsSync(absolute)) {
    // Pre-create the file with restrictive mode so it is never world-readable.
    closeSync(openSync(absolute, "a", 0o600));
  }
  chmodSync(absolute, 0o600);
  const db = new Database(absolute);
  try {
    db.exec(SCHEMA);
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}

/** Parameterized INSERT (FTS kept in sync by trigger). Generates a uuid id. Returns the stored row. */
export function insertEntry(db: DatabaseHandle, entry: NewEntry): EntryRow {
  const row: EntryRow = {
    id: randomUUID(),
    created_at: entry.created_at ?? new Date().toISOString(),
    source: entry.source,
    title: entry.title,
    text: entry.text,
    tags: [...entry.tags],
    project: entry.project,
    embedding: entry.embedding ?? null,
    redacted: entry.redacted,
  };
  db.prepare(
    `INSERT INTO entries (id, created_at, source, title, text, tags, project, embedding, redacted)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.created_at,
    row.source,
    row.title,
    row.text,
    JSON.stringify(row.tags),
    row.project,
    row.embedding ? embeddingToBuffer(row.embedding) : null,
    row.redacted ? 1 : 0,
  );
  return row;
}

/**
 * `SELECT ... WHERE id IN (?, ?, ...)` with one placeholder per id (placeholders
 * only — no id value is ever placed in the SQL text). Empty array => [] without querying.
 */
export function getEntriesByIds(db: DatabaseHandle, ids: string[]): EntryRow[] {
  if (ids.length === 0) return [];
  const result: EntryRow[] = [];
  // Chunk to stay below SQLite's host-parameter limit.
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const placeholders = chunk.map(() => "?").join(", ");
    const rows = db
      .prepare(`SELECT ${COLUMNS} FROM entries e WHERE e.id IN (${placeholders}) ORDER BY e.seq`)
      .all(...chunk) as RawRow[];
    result.push(...rows.map(toEntry));
  }
  return result;
}

/**
 * Turns arbitrary user input into a safe FTS5 query: only letter/digit runs are
 * kept, each one is quoted as an FTS5 string, and they are joined with spaces
 * (implicit AND). FTS operators (OR/AND/NOT/NEAR, `*`, `^`, `column:`, quotes)
 * therefore become plain words or disappear. Returns null when nothing is left.
 */
export function buildFtsQuery(query: string): string | null {
  const tokens = query.match(/[\p{L}\p{N}\p{M}]+/gu);
  if (!tokens || tokens.length === 0) return null;
  return tokens.slice(0, 64).map((t) => `"${t.replaceAll('"', '""')}"`).join(" ");
}

/**
 * FTS5 keyword search via `MATCH ?` (escaped query), optional `project = ?`,
 * ordered by bm25 relevance. Never throws on user query content.
 */
export function searchKeyword(db: DatabaseHandle, query: string, options: KeywordSearchOptions): KeywordHit[] {
  const fts = buildFtsQuery(query);
  if (fts === null) return [];
  const limit = Math.max(1, Math.floor(options.limit));
  const params: unknown[] = [fts];
  let projectClause = "";
  if (options.project !== undefined) {
    projectClause = "AND e.project = ?";
    params.push(options.project);
  }
  params.push(limit);
  const rows = db
    .prepare(
      `SELECT ${COLUMNS}, bm25(entries_fts) AS rank
       FROM entries_fts f
       JOIN entries e ON e.id = f.entry_id
       WHERE entries_fts MATCH ? ${projectClause}
       ORDER BY rank ASC, e.seq DESC
       LIMIT ?`,
    )
    .all(...params) as Array<RawRow & { rank: number }>;
  return rows.map((r) => ({ ...toEntry(r), score: -r.rank }));
}

/** All rows with a non-null embedding (optional `project = ?`). For semantic search. */
export function listEntriesWithEmbedding(db: DatabaseHandle, options: { project?: string } = {}): EntryRow[] {
  if (options.project !== undefined) {
    return (
      db
        .prepare(`SELECT ${COLUMNS} FROM entries e WHERE e.embedding IS NOT NULL AND e.project = ? ORDER BY e.seq`)
        .all(options.project) as RawRow[]
    ).map(toEntry);
  }
  return (
    db.prepare(`SELECT ${COLUMNS} FROM entries e WHERE e.embedding IS NOT NULL ORDER BY e.seq`).all() as RawRow[]
  ).map(toEntry);
}

export function countEntries(db: DatabaseHandle): number {
  const row = db.prepare("SELECT COUNT(*) AS n FROM entries").get() as { n: number };
  return row.n;
}

/** Latest row by created_at (ties: last inserted), or undefined. For `/memory`. */
export function getLatestEntry(db: DatabaseHandle): EntryRow | undefined {
  const row = db.prepare(`SELECT ${COLUMNS} FROM entries e ORDER BY e.created_at DESC, e.seq DESC LIMIT 1`).get() as
    | RawRow
    | undefined;
  return row ? toEntry(row) : undefined;
}
