import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentProvider, ProviderStreamEvent } from "./agent-core/types";
import { HatchlingSwarm, type RunConfig } from "./agent-session";
import { MAIN_THREAD_ID } from "./agent-threads";
import { i18n } from "./i18n";
import { MemoryTextStore } from "./opfs-kv";

function defaultConfig(overrides: Partial<RunConfig> = {}): RunConfig {
  return {
    provider: "anthropic",
    apiKey: "sk-ant-test-key",
    model: "claude-sonnet-4-6",
    webSearch: false,
    writeMode: "autonomous",
    builtinAvailability: "unavailable",
    ...overrides
  };
}

function scriptedProvider(turns: ProviderStreamEvent[][]): AgentProvider {
  let index = 0;
  return {
    id: "anthropic",
    async *stream() {
      const events = turns[index] ?? [{ type: "text-delta", text: "Done." }, { type: "message-end", stopReason: "end-turn" }];
      index += 1;
      for (const event of events) yield event;
    }
  };
}

describe("HatchlingSwarm", () => {
  beforeEach(() => {
    i18n.load("en", {});
    i18n.activate("en");
    const values = new Map<string, string>();
    vi.stubGlobal("navigator", {});
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
      clear: () => values.clear()
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("hydrates the main thread, hatches and removes coworkers, and guards main from removal", async () => {
    const now = 1_000;
    const swarm = new HatchlingSwarm({
      getConfig: () => defaultConfig(),
      gate: async () => "allow-once",
      onArtifact: () => {},
      google: { isConnected: () => false, sensitiveEnabled: false, getToken: async () => "" },
      metaStore: new MemoryTextStore(),
      now: () => now,
      createTicker: () => ({ dispose: () => {} })
    });
    await swarm.ready;

    expect(swarm.listThreads()).toHaveLength(1);
    expect(swarm.selectedThreadId).toBe(MAIN_THREAD_ID);

    const secondId = await swarm.hatch({ name: "Mame" }, [
      { path: "seed.csv", content: "a,b\n1,2\n" },
      { path: ".env", content: "SECRET=blocked" }
    ]);
    expect(swarm.listThreads().map((entry) => entry.thread.name)).toEqual(["Pip", "Mame"]);
    expect(await swarm.workspaceFor(secondId).listFiles()).toEqual(["seed.csv"]);

    swarm.select(secondId);
    expect(swarm.selectedThreadId).toBe(secondId);

    await expect(swarm.removeHatchling(MAIN_THREAD_ID)).rejects.toThrow(/cannot be removed/);
    await swarm.removeHatchling(secondId);
    expect(swarm.selectedThreadId).toBe(MAIN_THREAD_ID);
    expect(swarm.listThreads()).toHaveLength(1);
    swarm.dispose();
  });

  it("runs a multi-turn write flow, records the journal, reverts edits, and decays mood on tick", async () => {
    let now = 10_000;
    let tickHandler: () => void = () => {};
    const meta = new MemoryTextStore();
    const provider = scriptedProvider([
      [
        { type: "tool-call-start", index: 0, callId: "call-1", name: "write_file" },
        { type: "tool-call-args-delta", index: 0, argsJsonDelta: JSON.stringify({ path: "report.md", content: "# Updated\n" }) },
        { type: "tool-call-end", index: 0 },
        { type: "message-end", stopReason: "tool-use" }
      ],
      [
        { type: "citation", url: "https://example.com/q3", title: "Q3 Source" },
        { type: "text-delta", text: "Updated the report." },
        { type: "message-end", stopReason: "end-turn" }
      ]
    ]);

    const swarm = new HatchlingSwarm({
      getConfig: () => defaultConfig(),
      gate: async () => "allow-once",
      onArtifact: () => {},
      google: { isConnected: () => false, sensitiveEnabled: false, getToken: async () => "" },
      metaStore: meta,
      now: () => now,
      createTicker: (onTick) => {
        tickHandler = onTick;
        return { dispose: () => {} };
      },
      createCloudProvider: () => provider
    });
    await swarm.ready;
    await swarm.workspaceFor(MAIN_THREAD_ID).writeFile("report.md", "# Original\n");

    await swarm.send(MAIN_THREAD_ID, "Update report.md");

    const state = swarm.getState(MAIN_THREAD_ID)!;
    expect(state.mood).toBe("done");
    expect(await swarm.workspaceFor(MAIN_THREAD_ID).readFile("report.md")).toBe("# Updated\n");
    expect(state.items.map((item) => item.kind)).toEqual(["user", "tool", "write", "assistant", "sources"]);

    const writeItem = state.items.find((item) => item.kind === "write")!;
    expect(await swarm.revertWrite(MAIN_THREAD_ID, writeItem.id)).toBe(true);
    expect(await swarm.workspaceFor(MAIN_THREAD_ID).readFile("report.md")).toBe("# Original\n");

    const exported = swarm.exportRunJournal(MAIN_THREAD_ID);
    expect(exported).not.toBeNull();
    expect(exported!.json).not.toContain("sk-ant-test-key");

    // Advance past DONE_MOOD_DECAY_MS (45s) and trigger ticker.
    now += 50_000;
    tickHandler();
    await vi.waitFor(() => expect(swarm.getState(MAIN_THREAD_ID)?.mood).toBe("idle"));
    swarm.dispose();
  });

  it("blocks scheduled auto runs in careful mode with an explicit autoSkipNote", async () => {
    const now = 5_000;
    let tickHandler: () => void = () => {};
    let config = defaultConfig({ writeMode: "careful" });

    const swarm = new HatchlingSwarm({
      getConfig: () => config,
      gate: async () => "reject",
      onArtifact: () => {},
      google: { isConnected: () => false, sensitiveEnabled: false, getToken: async () => "" },
      metaStore: new MemoryTextStore(),
      now: () => now,
      createTicker: (onTick) => {
        tickHandler = onTick;
        return { dispose: () => {} };
      }
    });
    await swarm.ready;
    await swarm.setSchedule(MAIN_THREAD_ID, { enabled: true, intervalMinutes: 5 });

    tickHandler();
    await vi.waitFor(() => {
      expect(swarm.getState(MAIN_THREAD_ID)?.autoSkipNote).toMatch(/Fast \(autonomous\) mode/);
    });

    config = defaultConfig({ writeMode: "autonomous", apiKey: "" });
    tickHandler();
    await vi.waitFor(() => {
      expect(swarm.getState(MAIN_THREAD_ID)?.autoSkipNote).toMatch(/Add an API key/);
    });
    swarm.dispose();
  });
});
