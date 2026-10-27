/**
 * Embeddings support: Ollama HTTP client, Float32Array <-> BLOB serialization,
 * cosine similarity.
 *
 * The client talks directly to the configured Ollama base URL (`embeddingProvider`)
 * via `fetch` in the current process — no child processes. Only already sanitized
 * text must be passed to `embed` (memory.ts guarantees this).
 */
import type { MemoryConfig } from "./config.ts";
import type { EmbedFn } from "./memory.ts";

export const EMBED_TIMEOUT_MS = 15_000;

/** Serializes a vector for storage in a SQLite BLOB (little-endian float32, platform order). */
export function embeddingToBuffer(vector: Float32Array): Buffer {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
}

/** Deserializes a BLOB produced by `embeddingToBuffer`. Copies into an aligned buffer. */
export function bufferToEmbedding(blob: Uint8Array): Float32Array {
  if (blob.byteLength % 4 !== 0) {
    throw new Error(`pi-memory: invalid embedding blob length ${blob.byteLength}`);
  }
  const copy = new Uint8Array(blob.byteLength);
  copy.set(blob);
  return new Float32Array(copy.buffer);
}

/** Cosine similarity in [-1, 1]; null when dimensions differ; 0 for zero vectors. */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number | null {
  if (a.length !== b.length || a.length === 0) return null;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function combineSignals(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/**
 * Creates an EmbedFn for the Ollama `/api/embed` endpoint, or undefined when
 * embeddings are not configured. The returned function throws on network/HTTP/
 * format errors; callers (memory.ts) must handle that (entry is saved without embedding).
 */
export function createOllamaEmbed(
  config: Pick<MemoryConfig, "embeddingProvider" | "embeddingModel" | "embeddingDims">,
  fetchImpl: typeof fetch = fetch,
): EmbedFn | undefined {
  if (!config.embeddingProvider) return undefined;
  const endpoint = new URL("api/embed", config.embeddingProvider.endsWith("/") ? config.embeddingProvider : `${config.embeddingProvider}/`);
  return async (text: string, signal?: AbortSignal): Promise<Float32Array> => {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: config.embeddingModel, input: text }),
      signal: combineSignals(signal, EMBED_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`embeddings provider returned HTTP ${response.status}`);
    }
    const body = (await response.json()) as { embeddings?: unknown };
    const first = Array.isArray(body.embeddings) ? body.embeddings[0] : undefined;
    if (!Array.isArray(first) || !first.every((x) => typeof x === "number" && Number.isFinite(x))) {
      throw new Error("embeddings provider returned an unexpected response format");
    }
    if (first.length !== config.embeddingDims) {
      throw new Error(`embedding has ${first.length} dims, expected embeddingDims=${config.embeddingDims}`);
    }
    return Float32Array.from(first as number[]);
  };
}

/** Status check for `/memory`: tries to embed a short probe string. Never throws. */
export async function pingEmbeddings(
  embed: EmbedFn | undefined,
): Promise<{ ok: boolean; error?: string }> {
  if (!embed) return { ok: false, error: "not configured" };
  try {
    await embed("ping");
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
