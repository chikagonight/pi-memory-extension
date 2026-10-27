import { beforeEach, describe, expect, it, vi } from "vitest";
import * as configModule from "../src/config.ts";
import memoryExtension from "../extensions/index.ts";

// Never depend on the real ~/.pi/agent/memory.json of the machine running the tests.
vi.mock("../src/config.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/config.ts")>();
  return { ...actual, loadConfig: vi.fn() };
});

const loadConfig = vi.mocked(configModule.loadConfig);

function register() {
  const tools: string[] = [];
  const commands: string[] = [];
  const events: string[] = [];
  const pi = {
    registerTool: vi.fn((t: { name: string }) => tools.push(t.name)),
    registerCommand: vi.fn((name: string) => commands.push(name)),
    on: vi.fn((event: string) => events.push(event)),
  };
  // `pi` exposes only these three methods: any other API (sendMessage, etc.) would throw here.
  memoryExtension(pi as any);
  return { tools, commands, events };
}

describe("extension entry point", () => {
  beforeEach(() => loadConfig.mockReset());

  it("enabled config: registers explicit tools/commands and never hooks prompt-building events (no auto-injection)", () => {
    loadConfig.mockReturnValue({ ...configModule.DEFAULT_CONFIG, dbPath: ":memory:" });
    const { tools, commands, events } = register();
    expect(loadConfig).toHaveBeenCalledTimes(1);
    expect(tools.sort()).toEqual(["memory_get", "memory_save", "memory_search"]);
    expect(commands.sort()).toEqual(["memory", "remember"]);
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) expect(["session_before_compact", "session_shutdown"]).toContain(e);
  });

  it("disabled config: only the /memory status command, no tools, no hooks into prompts", () => {
    loadConfig.mockReturnValue({ ...configModule.DEFAULT_CONFIG, enabled: false, dbPath: ":memory:" });
    const { tools, commands, events } = register();
    expect(tools).toEqual([]);
    expect(commands).toEqual(["memory"]);
    for (const e of events) expect(["session_before_compact", "session_shutdown"]).toContain(e);
  });
});
