/**
 * Memory business logic (save/search/get) on top of db.ts and privacy.ts.
 * Tool wrappers (memory_save/memory_search/memory_get) in extensions/ call this.
 *
 * NOTE: `project` is a convenience tag, NOT a security boundary (memory is global).
 */
import { basename } from "node:path";
import type { MemoryConfig } from "./config.ts";
import {
  getEntriesByIds,
  insertEntry,
  listEntriesWithEmbedding,
  searchKeyword,
  type DatabaseHandle,
  type EntryRow,
  type EntrySource,
} from "./db.ts";
import { cosineSimilarity } from "./embeddings.ts";
import { compilePatterns, sanitizeText, type CompiledPrivacyPattern } from "./privacy.ts";

export type SearchMode = "keyword" | "semantic" | "hybrid";

/** Returns an embedding for the text. May throw (network etc.). */
export type EmbedFn = (text: string, signal?: AbortSignal) => Promise<Float32Array>;

export interface MemoryServiceOptions {
  db: DatabaseHandle;
  config: MemoryConfig;
  /** Present only when `config.embeddingProvider` is configured. */
  embed?: EmbedFn;
}

export interface SaveInput {
  text: string;
  title?: string;
  tags?: string[];
  /** Default "manual". */
  source?: EntrySource;
  /** Derived by the caller from cwd/git remote; not accepted from the LLM in memory_save. */
  project?: string | null;
}

export interface SearchInput {
  query: string;
  mode?: SearchMode;
  /** Default 10. */
  limit?: number;
  project?: string;
}

export type SearchHit = Omit<EntryRow, "embedding"> & { score: number };

export interface SearchResult {
  /** Mode actually used (may differ from requested, e.g. fallback to keyword). */
  mode: SearchMode;
  hits: SearchHit[];
  /** Human-readable note, e.g. when semantic was requested but embeddings are not configured. */
  warning?: string;
}

export interface GetResult {
  /** Found entries, in request order, deduplicated. */
  entries: Omit<EntryRow, "embedding">[];
  /** Requested ids that do not exist. */
  missing: string[];
}

export interface MemoryService {
  save(input: SaveInput, signal?: AbortSignal): Promise<EntryRow>;
  search(input: SearchInput, signal?: AbortSignal): Promise<SearchResult>;
  get(input: { ids: string[] }): GetResult;
}

export const TITLE_MAX_LENGTH = 200;

export const TAG_MAX_LENGTH = 50;
export const MAX_TAGS = 20;
export const DEFAULT_SEARCH_LIMIT = 10;
export const MAX_SEARCH_LIMIT = 100;

/**
 * Convenience project tag from the working directory: normalized basename(cwd).
 * NOT a security boundary — memory is global and shared by design.
 */
export function projectFromCwd(cwd: string): string | null {
  const slug = basename(cwd)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 100);
  return slug.length > 0 ? slug : null;
}

function stripEmbedding(row: EntryRow): Omit<EntryRow, "embedding"> {
  const { embedding: _embedding, ...rest } = row;
  return rest;
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_SEARCH_LIMIT;
  return Math.min(MAX_SEARCH_LIMIT, Math.max(1, Math.floor(limit)));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createMemoryService(options: MemoryServiceOptions): MemoryService {
  const { db, config, embed } = options;
  const patterns: CompiledPrivacyPattern[] = compilePatterns(config.privacyPatterns);
  const sanitize = (text: string, maxTextLength: number) => sanitizeText(text, { patterns, maxTextLength });

  async function embedQuery(query: string, signal?: AbortSignal): Promise<Float32Array> {
    // The query is sanitized too: secrets must not leave the process even in a search.
    // The task prefix (e.g. "search_query: ") is only for the embedding model.
    return embed!(config.embeddingQueryPrefix + sanitize(query, config.maxTextLength).text, signal);
  }

  function keyword(query: string, limit: number, project?: string): SearchHit[] {
    return searchKeyword(db, query, { limit, project }).map((h) => {
      const { embedding: _embedding, ...rest } = h;
      return rest;
    });
  }

  function semantic(queryVector: Float32Array, limit: number, project?: string): SearchHit[] {
    const scored: SearchHit[] = [];
    for (const row of listEntriesWithEmbedding(db, { project })) {
      const score = row.embedding ? cosineSimilarity(queryVector, row.embedding) : null;
      if (score === null) continue; // dimension mismatch (e.g. embedding model changed)
      scored.push({ ...stripEmbedding(row), score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }

  /** Simple hybrid ranking: max-normalized keyword score + clamped cosine, averaged. */
  function hybrid(kw: SearchHit[], sem: SearchHit[], limit: number): SearchHit[] {
    const maxKw = Math.max(0, ...kw.map((h) => h.score));
    const merged = new Map<string, SearchHit>();
    for (const h of kw) {
      merged.set(h.id, { ...h, score: maxKw > 0 ? (0.5 * h.score) / maxKw : 0.5 });
    }
    for (const h of sem) {
      const semScore = 0.5 * Math.max(0, h.score);
      const existing = merged.get(h.id);
      if (existing) existing.score += semScore;
      else merged.set(h.id, { ...h, score: semScore });
    }
    return [...merged.values()].sort((a, b) => b.score - a.score).slice(0, limit);
  }

  return {
    async save(input, signal) {
      if (typeof input.text !== "string" || input.text.trim().length === 0) {
        throw new Error("memory text is empty");
      }
      const text = sanitize(input.text, config.maxTextLength);
      if (text.text.trim().length === 0) {
        throw new Error("memory text is empty after privacy filtering");
      }

      let redacted = text.redacted;
      let title: string;
      const explicitTitle = input.title === undefined ? "" : sanitize(input.title, TITLE_MAX_LENGTH * 4);
      if (explicitTitle && explicitTitle.text.trim().length > 0) {
        redacted ||= explicitTitle.redacted;
        title = explicitTitle.text.trim();
      } else {
        title = text.text.split("\n").find((line) => line.trim().length > 0)?.trim() ?? "";
      }
      title = title.replace(/\s+/g, " ").slice(0, TITLE_MAX_LENGTH);

      const tags: string[] = [];
      for (const rawTag of (input.tags ?? []).slice(0, MAX_TAGS)) {
        if (typeof rawTag !== "string") continue;
        const tag = sanitize(rawTag, TAG_MAX_LENGTH);
        redacted ||= tag.redacted;
        const value = tag.text.trim();
        if (value && !tags.includes(value)) tags.push(value);
      }

      let embedding: Float32Array | null = null;
      if (embed) {
        try {
          // The task prefix (e.g. "search_document: ") goes only to the embedding model, not to the DB.
          embedding = await embed(config.embeddingDocumentPrefix + text.text, signal);
        } catch (error) {
          // Embeddings are optional: keep the entry, searchable by keyword.
          console.warn(`[pi-memory] embedding failed, saving without it: ${errorMessage(error)}`);
          embedding = null;
        }
      }

      return insertEntry(db, {
        source: input.source ?? "manual",
        title,
        text: text.text,
        tags,
        project: input.project ?? null,
        embedding,
        redacted,
      });
    },

    async search(input, signal) {
      const limit = clampLimit(input.limit);
      const requested: SearchMode = input.mode ?? (embed ? "hybrid" : "keyword");
      const query = typeof input.query === "string" ? input.query : "";
      if (query.trim().length === 0) return { mode: embed ? requested : "keyword", hits: [] };

      if (requested === "keyword") {
        return { mode: "keyword", hits: keyword(query, limit, input.project) };
      }
      if (!embed) {
        return {
          mode: "keyword",
          hits: keyword(query, limit, input.project),
          warning: `mode "${requested}" requires embeddings (embeddingProvider is not configured); used keyword search`,
        };
      }

      let queryVector: Float32Array;
      try {
        queryVector = await embedQuery(query, signal);
      } catch (error) {
        return {
          mode: "keyword",
          hits: keyword(query, limit, input.project),
          warning: `embeddings provider failed (${errorMessage(error)}); used keyword search`,
        };
      }
      const sem = semantic(queryVector, limit, input.project);
      if (requested === "semantic") return { mode: "semantic", hits: sem };
      return { mode: "hybrid", hits: hybrid(keyword(query, limit, input.project), sem, limit) };
    },

    get(input) {
      const ids = [...new Set((input.ids ?? []).filter((id): id is string => typeof id === "string"))];
      const found = new Map(getEntriesByIds(db, ids).map((row) => [row.id, row]));
      const entries: Omit<EntryRow, "embedding">[] = [];
      const missing: string[] = [];
      for (const id of ids) {
        const row = found.get(id);
        if (row) entries.push(stripEmbedding(row));
        else missing.push(id);
      }
      return { entries, missing };
    },
  };
}
