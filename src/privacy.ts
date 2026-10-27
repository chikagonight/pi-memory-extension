/**
 * Privacy filtering: `<private>` tag stripping, regex secret redaction, truncation.
 *
 * Applied to EVERY text that is stored or sent to an LLM (TZ.md section 3.3/3.4):
 * - memory_save input (text/title/tags),
 * - the serialized conversation (prompt) sent to the observer model,
 * - the observer model output before it is saved.
 */
import type { PrivacyPatternConfig } from "./config.ts";

export interface CompiledPrivacyPattern {
  /** Name used in the replacement marker `[REDACTED:<name>]`. */
  name: string;
  /** Global regex (flag `g` always set; `i` set when the source had a leading `(?i)`). */
  regex: RegExp;
}

export interface SanitizeOptions {
  patterns: CompiledPrivacyPattern[];
  maxTextLength: number;
}

export interface SanitizeResult {
  text: string;
  /** True when at least one privacy pattern matched. */
  redacted: boolean;
  /** Names of patterns that matched (deduplicated). */
  matchedPatterns: string[];
  /** True when the text was cut to maxTextLength. */
  truncated: boolean;
}

const INLINE_FLAGS = /^\(\?([a-z]+)\)/;
const SUPPORTED_INLINE_FLAGS = new Set(["i", "m", "s"]);

/**
 * Compiles config patterns into global RegExps.
 * - Leading inline flags `(?i)` (also `m`/`s`) => stripped and added as JS flags.
 * - Raw string => name `custom-<index>`; named pattern => its name.
 * - Invalid regex / unsupported inline flag => explicit error naming the pattern.
 */
export function compilePatterns(patterns: PrivacyPatternConfig[]): CompiledPrivacyPattern[] {
  return patterns.map((p, index) => {
    const name = typeof p === "string" ? `custom-${index}` : p.name;
    let source = typeof p === "string" ? p : p.pattern;
    const flags = new Set(["g"]);
    const inline = INLINE_FLAGS.exec(source);
    if (inline) {
      for (const f of inline[1]) {
        if (!SUPPORTED_INLINE_FLAGS.has(f)) {
          throw new Error(`pi-memory: unsupported inline flag "${f}" in privacy pattern "${name}"`);
        }
        flags.add(f);
      }
      source = source.slice(inline[0].length);
    }
    let regex: RegExp;
    try {
      regex = new RegExp(source, [...flags].join(""));
    } catch (error) {
      throw new Error(`pi-memory: invalid privacy pattern "${name}": ${(error as Error).message}`);
    }
    if (regex.test("")) {
      throw new Error(`pi-memory: privacy pattern "${name}" matches the empty string`);
    }
    return { name, regex };
  });
}

const PRIVATE_TAG = /<(\/?)private\b[^>]*>/gi;

/**
 * Removes every `<private>...</private>` block (tags + content, multiline,
 * multiple and nested blocks, case-insensitive). An unclosed `<private>`
 * removes everything until the end of the text (fail-closed). Stray closing
 * tags are dropped.
 */
export function stripPrivateTags(text: string): string {
  const re = new RegExp(PRIVATE_TAG.source, PRIVATE_TAG.flags);
  let out = "";
  let depth = 0;
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (depth === 0) out += text.slice(last, m.index);
    if (m[1] === "/") {
      if (depth > 0) depth--;
    } else {
      depth++;
    }
    last = m.index + m[0].length;
  }
  if (depth === 0) out += text.slice(last);
  return out;
}

/** Replaces every match of every pattern with `[REDACTED:<name>]`. */
export function redactSecrets(
  text: string,
  patterns: CompiledPrivacyPattern[],
): { text: string; redacted: boolean; matchedPatterns: string[] } {
  const matched: string[] = [];
  let result = text;
  for (const p of patterns) {
    // Fresh RegExp per call: no shared `lastIndex` state between calls.
    const re = new RegExp(p.regex.source, p.regex.flags.includes("g") ? p.regex.flags : `${p.regex.flags}g`);
    let hit = false;
    result = result.replace(re, () => {
      hit = true;
      return `[REDACTED:${p.name}]`;
    });
    if (hit && !matched.includes(p.name)) matched.push(p.name);
  }
  return { text: result, redacted: matched.length > 0, matchedPatterns: matched };
}

/**
 * Returns `text` unchanged when `text.length <= maxLength`, otherwise
 * `text.slice(0, maxLength)` (no marker); a trailing lone high surrogate is dropped.
 */
export function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  let cut = text.slice(0, Math.max(0, maxLength));
  const lastCode = cut.charCodeAt(cut.length - 1);
  if (lastCode >= 0xd800 && lastCode <= 0xdbff) cut = cut.slice(0, -1);
  return cut;
}

/**
 * Full pipeline: stripPrivateTags -> redactSecrets -> truncate
 * (redaction BEFORE truncation, so a secret straddling the limit cannot leak partially).
 */
export function sanitizeText(text: string, options: SanitizeOptions): SanitizeResult {
  const stripped = stripPrivateTags(text);
  const redaction = redactSecrets(stripped, options.patterns);
  const truncated = truncate(redaction.text, options.maxTextLength);
  return {
    text: truncated,
    redacted: redaction.redacted,
    matchedPatterns: redaction.matchedPatterns,
    truncated: truncated.length !== redaction.text.length,
  };
}
