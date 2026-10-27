import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { DEFAULT_CONFIG, type MemoryConfig } from "../src/config.ts";
import { countEntries, openDatabase, type DatabaseHandle } from "../src/db.ts";
import { createCompactHandler, type CompactHandlerDeps } from "../src/extractor.ts";
import { createMemoryService, type MemoryService } from "../src/memory.ts";

const AWS_KEY = "AKIAIOSFODNN7EXAMPLE";
const FAKE_MODEL = { provider: "openai-codex", id: "gpt-6-luna", api: "openai-responses" };

function config(overrides: Partial<MemoryConfig> = {}): MemoryConfig {
  return { ...DEFAULT_CONFIG, dbPath: ":memory:", ...overrides };
}

function userMessage(text: string) {
  return { role: "user", content: text, timestamp: Date.now() };
}

function assistantMessage(text: string) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-responses",
    provider: "openai-codex",
    model: "gpt-6-luna",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function completion(text: string, stopReason: string = "stop") {
  return { ...assistantMessage(text), stopReason };
}

function makeEvent(messages: unknown[]) {
  const controller = new AbortController();
  return {
    type: "session_before_compact",
    preparation: {
      firstKeptEntryId: "entry-1",
      messagesToSummarize: messages,
      turnPrefixMessages: [],
      isSplitTurn: false,
      tokensBefore: 1000,
      fileOps: { read: new Set(), written: new Set(), edited: new Set() },
      settings: { enabled: true, reserveTokens: 1000, keepRecentTokens: 1000 },
    },
    branchEntries: [],
    reason: "threshold",
    willRetry: false,
    signal: controller.signal,
  } as any;
}

function makeCtx(complete: (...args: any[]) => any) {
  return {
    cwd: "/home/user/projects/demo-project",
    hasUI: false,
    model: undefined,
    modelRegistry: {
      find: vi.fn(() => FAKE_MODEL),
      complete: vi.fn(complete),
    },
    ui: { notify: vi.fn() },
  } as any;
}

/** Concatenated text of everything sent to the model (system prompt + messages). */
function sentText(context: any): string {
  return JSON.stringify(context);
}

function messagesTextLength(context: any): number {
  let total = 0;
  for (const m of context.messages ?? []) {
    if (typeof m.content === "string") total += m.content.length;
    else for (const part of m.content ?? []) if (part.type === "text") total += part.text.length;
  }
  return total;
}

describe("session_before_compact extractor", () => {
  let db: DatabaseHandle;
  let memory: MemoryService;
  let onError: Mock<(error: unknown) => void>;
  let deps: CompactHandlerDeps;
  const conversation = [userMessage("Let's use PostgreSQL 16 for the store."), assistantMessage("Agreed, PostgreSQL 16.")];

  beforeEach(() => {
    db = openDatabase(":memory:");
    memory = createMemoryService({ db, config: config() });
    onError = vi.fn();
    deps = { config: config(), getService: () => memory, onError, resolveProject: () => "demo-project" };
  });
  afterEach(() => db?.close());

  describe("LLM / infrastructure failures never break compaction", () => {
    it("complete() rejecting: handler resolves to undefined, error is reported, nothing saved", async () => {
      const ctx = makeCtx(async () => {
        throw new Error("model unavailable");
      });
      const handler = createCompactHandler(deps);
      await expect(handler(makeEvent(conversation), ctx)).resolves.toBeUndefined();
      expect(ctx.modelRegistry.complete).toHaveBeenCalledTimes(1);
      expect(onError).toHaveBeenCalled();
      expect(countEntries(db)).toBe(0);
    });

    it("complete() throwing synchronously: handler still resolves to undefined", async () => {
      const ctx = makeCtx(() => {
        throw new Error("sync boom");
      });
      const handler = createCompactHandler(deps);
      await expect(handler(makeEvent(conversation), ctx)).resolves.toBeUndefined();
      expect(countEntries(db)).toBe(0);
    });

    it("complete() returning stopReason=error: nothing saved, no throw", async () => {
      const ctx = makeCtx(async () => completion("partial garbage", "error"));
      const handler = createCompactHandler(deps);
      await expect(handler(makeEvent(conversation), ctx)).resolves.toBeUndefined();
      expect(countEntries(db)).toBe(0);
    });

    it("modelRegistry.find throwing: handler resolves to undefined", async () => {
      const ctx = makeCtx(async () => completion("fact"));
      ctx.modelRegistry.find.mockImplementation(() => {
        throw new Error("registry broken");
      });
      const handler = createCompactHandler(deps);
      await expect(handler(makeEvent(conversation), ctx)).resolves.toBeUndefined();
      expect(countEntries(db)).toBe(0);
    });

    it("observer model not found: model is not called, handler resolves to undefined", async () => {
      const ctx = makeCtx(async () => completion("fact"));
      ctx.modelRegistry.find.mockReturnValue(undefined);
      const handler = createCompactHandler(deps);
      await expect(handler(makeEvent(conversation), ctx)).resolves.toBeUndefined();
      expect(ctx.modelRegistry.complete).not.toHaveBeenCalled();
    });

    it("memory service unavailable (getService throws): handler resolves to undefined", async () => {
      const ctx = makeCtx(async () => completion("Decision: PostgreSQL 16."));
      const handler = createCompactHandler({
        ...deps,
        getService: () => {
          throw new Error("cannot open db");
        },
      });
      await expect(handler(makeEvent(conversation), ctx)).resolves.toBeUndefined();
      expect(onError).toHaveBeenCalled();
    });

    it("save() rejecting: handler resolves to undefined", async () => {
      const ctx = makeCtx(async () => completion("Decision: PostgreSQL 16."));
      const failing: MemoryService = { ...memory, save: vi.fn(async () => Promise.reject(new Error("disk full"))) };
      const handler = createCompactHandler({ ...deps, getService: () => failing });
      await expect(handler(makeEvent(conversation), ctx)).resolves.toBeUndefined();
      expect(onError).toHaveBeenCalled();
    });

    it("works without an explicit onError (default sink) and still does not throw", async () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const ctx = makeCtx(async () => {
          throw new Error("model unavailable");
        });
        const handler = createCompactHandler({ ...deps, onError: undefined });
        await expect(handler(makeEvent(conversation), ctx)).resolves.toBeUndefined();
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe("normal operation", () => {
    it("calls the configured observer model in-process with the compaction abort signal", async () => {
      const ctx = makeCtx(async () => completion("skip"));
      const event = makeEvent(conversation);
      await createCompactHandler(deps)(event, ctx);
      expect(ctx.modelRegistry.find).toHaveBeenCalledWith("openai-codex", "gpt-6-luna");
      const [model, context, options] = ctx.modelRegistry.complete.mock.calls[0];
      expect(model).toBe(FAKE_MODEL);
      expect(sentText(context)).toContain("PostgreSQL 16");
      expect(options?.signal).toBe(event.signal);
    });

    it.each(["skip", "SKIP", "  skip\n"])("model answer %j saves nothing", async (answer) => {
      const ctx = makeCtx(async () => completion(answer));
      await expect(createCompactHandler(deps)(makeEvent(conversation), ctx)).resolves.toBeUndefined();
      expect(countEntries(db)).toBe(0);
    });

    it("saves a meaningful answer as an auto entry with the resolved project", async () => {
      const ctx = makeCtx(async () => completion("Decision: the store uses PostgreSQL 16."));
      await expect(createCompactHandler(deps)(makeEvent(conversation), ctx)).resolves.toBeUndefined();
      expect(countEntries(db)).toBeGreaterThanOrEqual(1);
      const { hits } = await memory.search({ query: "PostgreSQL" });
      expect(hits.length).toBeGreaterThanOrEqual(1);
      expect(hits[0]).toMatchObject({ source: "auto", project: "demo-project" });
      expect(hits[0].text).toContain("PostgreSQL 16");
    });

    it("filters the PROMPT: <private> content and secrets never reach the model", async () => {
      const ctx = makeCtx(async () => completion("skip"));
      const messages = [
        userMessage("My token is <private>super-private-value</private>, and key " + AWS_KEY),
        assistantMessage("Noted. DB_PASSWORD=hunter2hunter2 is in .env"),
      ];
      await createCompactHandler(deps)(makeEvent(messages), ctx);
      expect(ctx.modelRegistry.complete).toHaveBeenCalledTimes(1);
      const [, context] = ctx.modelRegistry.complete.mock.calls[0];
      const text = sentText(context);
      expect(text).not.toContain("super-private-value");
      expect(text).not.toContain(AWS_KEY);
      expect(text).not.toContain("hunter2hunter2");
    });

    it("filters the PROMPT field by field: tool-call args/results with spaces, quotes and PEM blocks never leak", async () => {
      const ctx = makeCtx(async () => completion("skip"));
      const pem = [
        "-----BEGIN RSA PRIVATE KEY-----",
        "MIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgOEePzNm0tRgeLezV6ffAt0gun",
        "-----END RSA PRIVATE KEY-----",
      ].join("\n");
      const assistantWithTool = {
        ...assistantMessage("Running the commands."),
        content: [
          { type: "text", text: "Running the commands." },
          {
            type: "toolCall",
            id: "call-1",
            name: "bash",
            arguments: {
              command: 'echo PASSWORD="two words secret" && export API_KEY=\'single quoted words\'',
              env: { DB_PASSWORD: "spaced db pass", nested: [`cat <<EOF\n${pem}\nEOF`] },
              password: 'quote"inside value',
              note: "<private>hidden note words</private> visible-arg",
            },
          },
        ],
        stopReason: "toolUse",
      };
      const toolResult = {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "bash",
        content: [{ type: "text", text: `out: SSH_KEY="result side words"\n${pem}\nvisible-result` }],
        isError: false,
        timestamp: Date.now(),
      };
      await createCompactHandler(deps)(makeEvent([userMessage("run it"), assistantWithTool, toolResult]), ctx);
      expect(ctx.modelRegistry.complete).toHaveBeenCalledTimes(1);
      const [, context] = ctx.modelRegistry.complete.mock.calls[0];
      const text = sentText(context);
      for (const leak of [
        "two words secret",
        "words secret",
        "single quoted words",
        "spaced db pass",
        "quote",
        "inside value",
        "hidden note words",
        "result side words",
        "MIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgOEePzNm0tRgeLezV6ffAt0gun",
      ]) {
        expect(text).not.toContain(leak);
      }
      expect(text).toContain("visible-arg");
      expect(text).toContain("visible-result");
      expect(text).toContain("[REDACTED:");
    });

    it("truncates the PROMPT conversation to maxTextLength before sending it to the model", async () => {
      const ctx = makeCtx(async () => completion("skip"));
      const long = [userMessage("x".repeat(10_000)), assistantMessage("y".repeat(10_000))];
      await createCompactHandler({ ...deps, config: config({ maxTextLength: 4000 }) })(makeEvent(long), ctx);
      const [, context] = ctx.modelRegistry.complete.mock.calls[0];
      // Allow a small wrapper around the conversation; 20k chars must not get through.
      expect(messagesTextLength(context)).toBeLessThanOrEqual(4000 + 1000);
    });

    it("filters the OUTPUT: <private> and secrets in the model answer are not stored", async () => {
      const ctx = makeCtx(async () =>
        completion(`Fact: staging bucket is s3://demo. <private>owner phone 555-0100</private> Key ${AWS_KEY}`),
      );
      await createCompactHandler(deps)(makeEvent(conversation), ctx);
      const dump = JSON.stringify(db.prepare("SELECT title, text FROM entries").all());
      expect(dump).toContain("s3://demo");
      expect(dump).not.toContain("555-0100");
      expect(dump).not.toContain(AWS_KEY);
    });

    it("disabled config: model is never called", async () => {
      const ctx = makeCtx(async () => completion("fact"));
      await expect(
        createCompactHandler({ ...deps, config: config({ enabled: false }) })(makeEvent(conversation), ctx),
      ).resolves.toBeUndefined();
      expect(ctx.modelRegistry.complete).not.toHaveBeenCalled();
    });

    it("no messages to summarize: model is never called", async () => {
      const ctx = makeCtx(async () => completion("fact"));
      await expect(createCompactHandler(deps)(makeEvent([]), ctx)).resolves.toBeUndefined();
      expect(ctx.modelRegistry.complete).not.toHaveBeenCalled();
    });
  });
});
