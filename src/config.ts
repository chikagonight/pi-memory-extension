/**
 * Configuration for pi-memory-extension.
 *
 * Source: `~/.pi/agent/memory.json` (all fields optional, see TZ.md section 5).
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * A privacy pattern is either a raw regex source string or a named pattern.
 * For raw strings the implementation derives a stable name (used in `[REDACTED:<name>]`).
 * A leading `(?i)` inline flag (not supported by JS RegExp) must be translated
 * into the `i` flag by the implementation.
 */
export type PrivacyPatternConfig = string | { name: string; pattern: string };

export interface MemoryConfig {
  enabled: boolean;
  /** Path to the SQLite file; `~` is expanded by `loadConfig`. */
  dbPath: string;
  maxTextLength: number;
  /** `<provider>/<modelId>` resolved through `ctx.modelRegistry.find`. */
  observerModel: string;
  /** Base URL of the embeddings provider (Ollama), or null when embeddings are disabled. */
  embeddingProvider: string | null;
  embeddingModel: string;
  embeddingDims: number;
  privacyPatterns: PrivacyPatternConfig[];
}

export const DEFAULT_CONFIG_PATH = join(homedir(), ".pi", "agent", "memory.json");

/**
 * Default secret patterns: TZ.md section 5, extended to cover TZ.md section 3.4
 * (token prefixes ghp_/sk-/glpat-, AWS secret access key, full PRIVATE KEY block).
 * Order matters: specific patterns run before the generic `KEY=`/`TOKEN=` one.
 */
export const DEFAULT_PRIVACY_PATTERNS: Array<{ name: string; pattern: string }> = [
  {
    // Whole PEM block, header to footer. Unterminated block => redact to the end (fail-closed).
    name: "private-key",
    pattern: "-----BEGIN[ A-Z0-9]*PRIVATE KEY-----[\\s\\S]*?(?:-----END[ A-Z0-9]*PRIVATE KEY-----|$)",
  },
  {
    name: "aws-secret-access-key",
    pattern: "(?i)aws_?secret(?:_?access)?_?key[\"']?\\s*[:=]\\s*[\"']?[A-Za-z0-9/+=]{20,}[\"']?",
  },
  { name: "aws-access-key-id", pattern: "(?:AKIA|ASIA)[0-9A-Z]{16}" },
  { name: "github-token", pattern: "\\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})" },
  { name: "gitlab-token", pattern: "\\bglpat-[A-Za-z0-9_-]{20,}" },
  { name: "openai-key", pattern: "\\bsk-[A-Za-z0-9_-]{20,}" },
  { name: "bearer-token", pattern: "Bearer\\s+[A-Za-z0-9._~+/=-]+" },
  {
    // `.env`-style and `key: value` assignments (KEY=, SSH_KEY=, API_KEY=, TOKEN=, SECRET=,
    // PASSWORD=, ...); quoted values are redacted whole, including backslash-escaped quotes.
    name: "secret-assignment",
    pattern:
      "(?i)((?:api[_-]?)?key|token|secret|password)[\"']?\\s*[:=]\\s*(?:\"(?:[^\"\\\\\\n]|\\\\.)*\"|'(?:[^'\\\\\\n]|\\\\.)*'|\\S+)",
  },
];

export const DEFAULT_CONFIG: MemoryConfig = {
  enabled: true,
  dbPath: "~/.pi-memory/memory.db",
  maxTextLength: 4000,
  observerModel: "openai-codex/gpt-6-luna",
  embeddingProvider: null,
  embeddingModel: "nomic-embed-text",
  embeddingDims: 768,
  privacyPatterns: DEFAULT_PRIVACY_PATTERNS.map((p) => ({ ...p })),
};

export function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function isPatternConfig(value: unknown): value is PrivacyPatternConfig {
  if (typeof value === "string") return value.length > 0;
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return isNonEmptyString(v.name) && isNonEmptyString(v.pattern);
}

function patternSource(p: PrivacyPatternConfig): string {
  return typeof p === "string" ? p : p.pattern;
}

/**
 * Reads the JSON config at `configPath`, merges it over DEFAULT_CONFIG and validates it.
 * - Missing file => defaults.
 * - Malformed JSON / non-object root => explicit error.
 * - Field with an invalid type/value => default for that field + warning via `onWarning`.
 * - `privacyPatterns` from the file EXTEND the defaults (they cannot remove built-in
 *   secret patterns); duplicates are dropped.
 * - Leading `~` in `dbPath` is expanded.
 */
export function loadConfig(
  configPath: string = DEFAULT_CONFIG_PATH,
  onWarning: (message: string) => void = (m) => console.warn(`[pi-memory] ${m}`),
): MemoryConfig {
  const config: MemoryConfig = {
    ...DEFAULT_CONFIG,
    privacyPatterns: [...DEFAULT_CONFIG.privacyPatterns],
  };

  let raw: string;
  try {
    raw = readFileSync(configPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      config.dbPath = expandHome(config.dbPath);
      return config;
    }
    throw new Error(`pi-memory: cannot read config ${configPath}: ${(error as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`pi-memory: invalid JSON in ${configPath}: ${(error as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`pi-memory: config ${configPath} must be a JSON object`);
  }
  const user = parsed as Record<string, unknown>;
  const invalid = (field: string) => onWarning(`invalid value for "${field}" in ${configPath}, using default`);

  if ("enabled" in user) {
    if (typeof user.enabled === "boolean") config.enabled = user.enabled;
    else invalid("enabled");
  }
  if ("dbPath" in user) {
    if (isNonEmptyString(user.dbPath)) config.dbPath = user.dbPath;
    else invalid("dbPath");
  }
  if ("maxTextLength" in user) {
    if (isPositiveInt(user.maxTextLength)) config.maxTextLength = user.maxTextLength;
    else invalid("maxTextLength");
  }
  if ("observerModel" in user) {
    if (typeof user.observerModel === "string" && /^[^/\s]+\/\S+$/.test(user.observerModel)) {
      config.observerModel = user.observerModel;
    } else invalid("observerModel");
  }
  if ("embeddingProvider" in user) {
    if (user.embeddingProvider === null) config.embeddingProvider = null;
    else if (typeof user.embeddingProvider === "string" && isHttpUrl(user.embeddingProvider)) {
      config.embeddingProvider = user.embeddingProvider;
    } else invalid("embeddingProvider");
  }
  if ("embeddingModel" in user) {
    if (isNonEmptyString(user.embeddingModel)) config.embeddingModel = user.embeddingModel;
    else invalid("embeddingModel");
  }
  if ("embeddingDims" in user) {
    if (isPositiveInt(user.embeddingDims)) config.embeddingDims = user.embeddingDims;
    else invalid("embeddingDims");
  }
  if ("privacyPatterns" in user) {
    if (Array.isArray(user.privacyPatterns)) {
      const known = new Set(config.privacyPatterns.map(patternSource));
      for (const p of user.privacyPatterns) {
        if (!isPatternConfig(p)) {
          invalid("privacyPatterns[]");
          continue;
        }
        if (known.has(patternSource(p))) continue;
        known.add(patternSource(p));
        config.privacyPatterns.push(p);
      }
    } else invalid("privacyPatterns");
  }

  config.dbPath = expandHome(config.dbPath);
  return config;
}
