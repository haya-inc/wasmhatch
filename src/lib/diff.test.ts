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

  it("marks a missing final newline on both sides", () => {
    const diff = createReadableDiff("greet.ts", "hello\nworld", "hello\nfriend");
    expect(diff).toBe([
      "--- a/greet.ts",
      "+++ b/greet.ts",
      "@@ -1,2 +1,2 @@",
      " hello",
      "-world",
      "\\ No newline at end of file",
      "+friend",
      "\\ No newline at end of file"
    ].join("\n"));
  });

  it("treats a final-newline-only change as a real change", () => {
    const diff = createReadableDiff("greet.ts", "hello", "hello\n");
    expect(diff).toBe([
      "--- a/greet.ts",
      "+++ b/greet.ts",
      "@@ -1,1 +1,1 @@",
      "-hello",
      "\\ No newline at end of file",
      "+hello"
    ].join("\n"));
  });

  it("marks a missing final newline on a trailing context line", () => {
    const diff = createReadableDiff("greet.ts", "old\nshared", "new\nshared");
    expect(diff).toBe([
      "--- a/greet.ts",
      "+++ b/greet.ts",
      "@@ -1,2 +1,2 @@",
      "-old",
      "+new",
      " shared",
      "\\ No newline at end of file"
    ].join("\n"));
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
      // Pin autocrlf off so the assertion is byte-exact even when the
      // contributor's global Git config rewrites line endings (Windows default).
      execFileSync("git", ["-c", "core.autocrlf=false", "apply", "--check", "change.patch"], { cwd: directory });
      execFileSync("git", ["-c", "core.autocrlf=false", "apply", "change.patch"], { cwd: directory });
      expect(readFileSync(join(directory, "a.ts"), "utf8")).toBe("export const a = 2;\n");
      expect(readFileSync(join(directory, "new.ts"), "utf8")).toBe("export const created = true;\n");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("produces a git-appliable patch for files without a final newline", () => {
    const directory = mkdtempSync(join(tmpdir(), "wasmhatch-patch-"));
    try {
      writeFileSync(join(directory, "no-eol.ts"), "export const a = 1;");
      writeFileSync(join(directory, "gains-eol.ts"), "export const b = 1;");
      const patch = createWorkspacePatch([
        { path: "no-eol.ts", before: "export const a = 1;", after: "export const a = 2;" },
        { path: "gains-eol.ts", before: "export const b = 1;", after: "export const b = 1;\n" }
      ]);
      writeFileSync(join(directory, "change.patch"), `${patch}\n`);
      execFileSync("git", ["-c", "core.autocrlf=false", "apply", "--check", "change.patch"], { cwd: directory });
      execFileSync("git", ["-c", "core.autocrlf=false", "apply", "change.patch"], { cwd: directory });
      expect(readFileSync(join(directory, "no-eol.ts"), "utf8")).toBe("export const a = 2;");
      expect(readFileSync(join(directory, "gains-eol.ts"), "utf8")).toBe("export const b = 1;\n");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
