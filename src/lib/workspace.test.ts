import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createWorkspaceStore,
  formatBytes,
  measureWorkspaceUsage,
  normalizeWorkspacePath,
  type WorkspaceStore
} from "./workspace";

describe("normalizeWorkspacePath", () => {
  it("normalizes separators", () => {
    expect(normalizeWorkspacePath("src\\main.ts")).toBe("src/main.ts");
  });

  it("rejects paths outside the workspace", () => {
    expect(() => normalizeWorkspacePath("../secret")).toThrow(/traversal/i);
    expect(() => normalizeWorkspacePath("/etc/passwd")).toThrow(/relative/i);
  });
});

describe("measureWorkspaceUsage", () => {
  it("counts UTF-8 content in the working tree and baseline", async () => {
    const store: WorkspaceStore = {
      listFiles: vi.fn().mockResolvedValue(["a.txt", "b.txt"]),
      listBaselineFiles: vi.fn().mockResolvedValue(["a.txt"]),
      readFile: vi.fn().mockImplementation(async (path) => path === "a.txt" ? "hello" : "日本"),
      readBaselineFile: vi.fn().mockResolvedValue("hi"),
      writeFile: vi.fn(),
      replaceBaseline: vi.fn(),
      replaceAll: vi.fn(),
      clear: vi.fn()
    };

    await expect(measureWorkspaceUsage(store)).resolves.toEqual({
      workingBytes: 11,
      baselineBytes: 2,
      totalBytes: 13
    });
  });
});

describe("workspace clearing", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("removes both localStorage trees", async () => {
    const values = new Map<string, string>();
    const removeItem = vi.fn((key: string) => values.delete(key));
    vi.stubGlobal("navigator", {});
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem
    });
    const store = createWorkspaceStore();
    await store.replaceAll([{ path: "README.md", content: "private" }]);

    await store.clear();

    await expect(store.listFiles()).resolves.toEqual([]);
    await expect(store.listBaselineFiles()).resolves.toEqual([]);
    expect(removeItem).toHaveBeenCalledTimes(2);
  });
});

describe("formatBytes", () => {
  it("formats compact storage values", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(10 * 1024)).toBe("10 KB");
  });
});
