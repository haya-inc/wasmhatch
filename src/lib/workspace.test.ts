import { describe, expect, it } from "vitest";
import { normalizeWorkspacePath } from "./workspace";

describe("normalizeWorkspacePath", () => {
  it("normalizes separators", () => {
    expect(normalizeWorkspacePath("src\\main.ts")).toBe("src/main.ts");
  });

  it("rejects paths outside the workspace", () => {
    expect(() => normalizeWorkspacePath("../secret")).toThrow(/traversal/i);
    expect(() => normalizeWorkspacePath("/etc/passwd")).toThrow(/relative/i);
  });
});
