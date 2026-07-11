import { describe, expect, it, vi } from "vitest";
import { buildWorkspacePatch } from "./patch";
import type { WorkspaceStore } from "./workspace";

describe("buildWorkspacePatch", () => {
  it("compares persisted baseline and current workspace files", async () => {
    const current = new Map([
      ["changed.ts", "export const changed = 2;\n"],
      ["new.ts", "export const added = true;\n"]
    ]);
    const baseline = new Map([
      ["changed.ts", "export const changed = 1;\n"],
      ["deleted.ts", "export const removed = true;\n"]
    ]);
    const read = async (files: Map<string, string>, path: string) => {
      const value = files.get(path);
      if (value === undefined) throw new Error("missing");
      return value;
    };
    const store: WorkspaceStore = {
      listFiles: vi.fn().mockResolvedValue([...current.keys()]),
      listBaselineFiles: vi.fn().mockResolvedValue([...baseline.keys()]),
      readFile: (path) => read(current, path),
      readBaselineFile: (path) => read(baseline, path),
      writeFile: vi.fn(),
      replaceBaseline: vi.fn(),
      replaceAll: vi.fn(),
      clear: vi.fn()
    };

    const result = await buildWorkspacePatch(store);
    expect(result.changedFileCount).toBe(3);
    expect(result.patch).toContain("+++ b/new.ts");
    expect(result.patch).toContain("--- a/deleted.ts");
    expect(result.patch).toContain("+++ /dev/null");
  });
});
