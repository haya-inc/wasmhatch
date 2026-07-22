import { describe, expect, it } from "vitest";
import {
  createHatchling,
  DEFAULT_LOOP_PROMPT,
  HATCHLING_NAMES,
  loadThreads,
  MAIN_THREAD_ID,
  MAX_HATCHLINGS,
  mainHatchling,
  parseThreads,
  SCHEDULE_LIMITS,
  serializeThreads,
  SPECIES_COUNT,
  workspaceRootsForThread,
  type HatchlingThread
} from "./agent-threads";
import { MemoryTextStore } from "./opfs-kv";
import { DEFAULT_WORKSPACE_ROOTS } from "./workspace";

describe("hatchling registry", () => {
  it("seeds a first run with the main hatchling over the legacy roots", async () => {
    const store = new MemoryTextStore();
    const threads = await loadThreads(store);
    expect(threads).toHaveLength(1);
    expect(threads[0].id).toBe(MAIN_THREAD_ID);
    expect(threads[0].schedule.enabled).toBe(false);
    expect(threads[0].schedule.prompt).toBe(DEFAULT_LOOP_PROMPT);
    // The seed persists so the next visit sees the same registry.
    expect(parseThreads(await store.read("threads"))).not.toBeNull();
  });

  it("maps main to the legacy workspace roots and new threads to their own pair", () => {
    expect(workspaceRootsForThread(MAIN_THREAD_ID)).toEqual(DEFAULT_WORKSPACE_ROOTS);
    const roots = workspaceRootsForThread("h-abc123");
    expect(roots.working).toBe("wasmhatch-ws-h-abc123");
    expect(roots.baseline).toBe("wasmhatch-bl-h-abc123");
    expect(() => workspaceRootsForThread("../escape")).toThrow();
    expect(() => workspaceRootsForThread("UPPER")).toThrow();
  });

  it("creates hatchlings with unique ids, fresh names, and cycling species", () => {
    const threads: HatchlingThread[] = [mainHatchling()];
    while (threads.length < MAX_HATCHLINGS) threads.push(createHatchling(threads));
    const ids = new Set(threads.map((thread) => thread.id));
    const names = new Set(threads.map((thread) => thread.name));
    expect(ids.size).toBe(MAX_HATCHLINGS);
    expect(names.size).toBe(MAX_HATCHLINGS);
    expect(threads.every((thread, index) => index === 0 || /^h-[a-z0-9]{6}$/.test(thread.id))).toBe(true);
    expect(threads.map((thread) => thread.species)).toEqual(
      threads.map((_, index) => index % SPECIES_COUNT)
    );
    expect(() => createHatchling(threads)).toThrow(/nest is full/);
  });

  it("skips names the user has already given to other hatchlings", () => {
    // Seven threads occupy the first seven pool names (e.g. via renames);
    // the next hatchling gets the eighth name, never a duplicate.
    const threads: HatchlingThread[] = HATCHLING_NAMES.slice(0, 7).map((name, index) => ({
      ...mainHatchling(),
      id: index === 0 ? MAIN_THREAD_ID : `h-name0${index}`,
      name
    }));
    const next = createHatchling(threads);
    expect(next.name).toBe(HATCHLING_NAMES[7]);
  });

  it("round-trips through serialize and parse", () => {
    const threads = [mainHatchling(), createHatchling([mainHatchling()])];
    threads[1].schedule = { ...threads[1].schedule, enabled: true, intervalMinutes: 5, autoRuns: 3 };
    const parsed = parseThreads(serializeThreads(threads));
    expect(parsed).toEqual(threads);
  });

  it("drops malformed entries and clamps schedule numbers into legal ranges", () => {
    const raw = JSON.stringify({
      schemaVersion: 1,
      threads: [
        { id: "main", name: "  Pip  ", species: 99, schedule: { enabled: true, intervalMinutes: 0, maxAutoRuns: 9999, autoRuns: -5, consecutiveFailures: 42, prompt: "" } },
        { id: "../evil", name: "Bad" },
        { id: "h-ok1234", name: "x".repeat(100), schedule: null },
        "not an object",
        { id: "main", name: "Duplicate" }
      ]
    });
    const parsed = parseThreads(raw);
    expect(parsed).not.toBeNull();
    expect(parsed!.map((thread) => thread.id)).toEqual(["main", "h-ok1234"]);
    const main = parsed![0];
    expect(main.name).toBe("Pip");
    expect(main.species).toBe(SPECIES_COUNT - 1);
    expect(main.schedule.intervalMinutes).toBe(SCHEDULE_LIMITS.minIntervalMinutes);
    expect(main.schedule.maxAutoRuns).toBe(SCHEDULE_LIMITS.maxMaxAutoRuns);
    expect(main.schedule.autoRuns).toBe(0);
    expect(main.schedule.consecutiveFailures).toBe(SCHEDULE_LIMITS.maxConsecutiveFailures);
    expect(main.schedule.prompt).toBe(DEFAULT_LOOP_PROMPT);
    expect(parsed![1].name).toHaveLength(24);
  });

  it("returns null for corrupt registries and re-seeds main on load", async () => {
    expect(parseThreads("{not json")).toBeNull();
    expect(parseThreads(JSON.stringify({ schemaVersion: 2, threads: [] }))).toBeNull();
    const store = new MemoryTextStore();
    await store.write("threads", JSON.stringify({
      schemaVersion: 1,
      threads: [{ id: "h-solo11", name: "Solo" }]
    }));
    const threads = await loadThreads(store);
    expect(threads[0].id).toBe(MAIN_THREAD_ID);
    expect(threads.map((thread) => thread.id)).toContain("h-solo11");
  });
});
