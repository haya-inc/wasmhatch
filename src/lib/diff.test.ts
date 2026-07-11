import { describe, expect, it } from "vitest";
import { createReadableDiff } from "./diff";

describe("createReadableDiff", () => {
  it("shows focused additions and removals", () => {
    const diff = createReadableDiff("greet.ts", "hello\nworld\n", "hello\nfriend\n");
    expect(diff).toContain("-world");
    expect(diff).toContain("+friend");
    expect(diff).toContain("--- a/greet.ts");
  });

  it("reports unchanged content", () => {
    expect(createReadableDiff("same.ts", "same", "same")).toContain("(no changes)");
  });
});
