import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createReadableDiff, createWorkspacePatch } from "./diff";

describe("createReadableDiff", () => {
  it("shows focused additions and removals", () => {
    const diff = createReadableDiff("greet.ts", "hello\nworld\n", "hello\nfriend\n");
    expect(diff).toContain("-world");
    expect(diff).toContain("+friend");
    expect(diff).toContain("--- a/greet.ts");
    expect(diff).toContain("@@ -1,2 +1,2 @@");
  });

  it("reports unchanged content", () => {
    expect(createReadableDiff("same.ts", "same", "same")).toContain("(no changes)");
  });

  it("creates a multi-file patch and omits unchanged files", () => {
    const patch = createWorkspacePatch([
      { path: "a.ts", before: "export const a = 1;\n", after: "export const a = 2;\n" },
      { path: "same.ts", before: "same\n", after: "same\n" },
      { path: "new.ts", before: "", after: "export const created = true;\n" }
    ]);
    expect(patch).toContain("--- a/a.ts");
    expect(patch).toContain("--- /dev/null");
    expect(patch).toContain("+++ b/new.ts");
    expect(patch).not.toContain("same.ts");
  });

  it("produces a patch accepted by git apply", () => {
    const directory = mkdtempSync(join(tmpdir(), "wasmhatch-patch-"));
    try {
      writeFileSync(join(directory, "a.ts"), "export const a = 1;\n");
      const patch = createWorkspacePatch([
        { path: "a.ts", before: "export const a = 1;\n", after: "export const a = 2;\n" },
        { path: "new.ts", before: "", after: "export const created = true;\n" }
      ]);
      writeFileSync(join(directory, "change.patch"), `${patch}\n`);
      execFileSync("git", ["apply", "--check", "change.patch"], { cwd: directory });
      execFileSync("git", ["apply", "change.patch"], { cwd: directory });
      expect(readFileSync(join(directory, "a.ts"), "utf8")).toBe("export const a = 2;\n");
      expect(readFileSync(join(directory, "new.ts"), "utf8")).toBe("export const created = true;\n");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
