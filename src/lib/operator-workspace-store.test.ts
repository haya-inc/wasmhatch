import { afterEach, describe, expect, it, vi } from "vitest";
import { createOperatorWorkspaceStore } from "./operator-workspace-store";

function localStorageStub() {
  const values = new Map<string, string>();
  return {
    values,
    api: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key)
    }
  };
}

describe("operator workspace store", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses isolated fallback keys and replaces the complete operator namespace", async () => {
    const storage = localStorageStub();
    vi.stubGlobal("navigator", {});
    vi.stubGlobal("localStorage", storage.api);
    const store = createOperatorWorkspaceStore();

    await store.writeFile("inputs/data.json", "one");
    await store.writeFile("outputs/report.md", "report");
    expect(await store.listFiles()).toEqual(["inputs/data.json", "outputs/report.md"]);
    expect(storage.values.has("wasmhatch-workspace-v1")).toBe(false);

    await store.replaceAll([{ path: "inputs/restored.json", content: "two" }]);
    expect(await store.listFiles()).toEqual(["inputs/restored.json"]);
    expect(await store.listBaselineFiles()).toEqual(["inputs/restored.json"]);
    await expect(store.readFile("outputs/report.md")).rejects.toThrow("not found");
  });

  it("rejects duplicate normalized paths and corrupt fallback state", async () => {
    const storage = localStorageStub();
    vi.stubGlobal("navigator", {});
    vi.stubGlobal("localStorage", storage.api);
    const store = createOperatorWorkspaceStore();
    await expect(store.replaceAll([
      { path: "inputs/data.json", content: "one" },
      { path: "./inputs/data.json", content: "two" }
    ])).rejects.toThrow("duplicate path");

    storage.values.set("wasmhatch-operator-workspace-v1", "not json");
    await expect(store.listFiles()).rejects.toThrow("invalid JSON");
  });

  it("clears only the operator fallback namespace", async () => {
    const storage = localStorageStub();
    storage.values.set("wasmhatch-workspace-v1", JSON.stringify({ "legacy.ts": "keep" }));
    vi.stubGlobal("navigator", {});
    vi.stubGlobal("localStorage", storage.api);
    const store = createOperatorWorkspaceStore();
    await store.writeFile("inputs/data.json", "data");
    await store.clear();
    expect(await store.listFiles()).toEqual([]);
    expect(storage.values.get("wasmhatch-workspace-v1")).toContain("legacy.ts");
  });
});
