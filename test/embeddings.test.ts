import { describe, expect, it, vi } from "vitest";
import {
  bufferToEmbedding,
  cosineSimilarity,
  createOllamaEmbed,
  embeddingToBuffer,
  pingEmbeddings,
} from "../src/embeddings.ts";

const cfg = { embeddingProvider: "http://ollama:11434", embeddingModel: "nomic-embed-text", embeddingDims: 3 };

describe("embeddings", () => {
  it("round-trips Float32Array through a BLOB buffer", () => {
    const v = new Float32Array([0.5, -1.25, 3]);
    expect(bufferToEmbedding(embeddingToBuffer(v))).toEqual(v);
  });

  it("cosine similarity: identical, orthogonal, mismatched dims, zero vector", () => {
    expect(cosineSimilarity(new Float32Array([1, 2]), new Float32Array([2, 4]))).toBeCloseTo(1);
    expect(cosineSimilarity(new Float32Array([1, 0]), new Float32Array([0, 1]))).toBe(0);
    expect(cosineSimilarity(new Float32Array([1, 0]), new Float32Array([1, 0, 0]))).toBeNull();
    expect(cosineSimilarity(new Float32Array([0, 0]), new Float32Array([1, 0]))).toBe(0);
  });

  it("not configured => no embed function", () => {
    expect(createOllamaEmbed({ ...cfg, embeddingProvider: null })).toBeUndefined();
  });

  it("calls Ollama /api/embed with model and input", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ embeddings: [[0.1, 0.2, 0.3]] })));
    const embed = createOllamaEmbed(cfg, fetchMock as unknown as typeof fetch)!;
    const v = await embed("hello");
    expect(Array.from(v)).toEqual(Array.from(new Float32Array([0.1, 0.2, 0.3])));
    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(url)).toBe("http://ollama:11434/api/embed");
    expect(JSON.parse(String(init.body))).toEqual({ model: "nomic-embed-text", input: "hello" });
  });

  it("throws on HTTP error, bad format and wrong dims; ping reports it without throwing", async () => {
    const bad = [
      new Response("nope", { status: 500 }),
      new Response(JSON.stringify({ foo: 1 })),
      new Response(JSON.stringify({ embeddings: [[1, 2]] })),
    ];
    for (const r of bad) {
      const embed = createOllamaEmbed(cfg, (async () => r) as unknown as typeof fetch)!;
      await expect(embed("x")).rejects.toThrow();
    }
    const down = createOllamaEmbed(cfg, (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch);
    expect(await pingEmbeddings(down)).toEqual({ ok: false, error: "ECONNREFUSED" });
    expect(await pingEmbeddings(undefined)).toEqual({ ok: false, error: "not configured" });
  });
});
