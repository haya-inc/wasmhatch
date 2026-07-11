import { describe, expect, it } from "vitest";
import { exampleTasks, getExampleIssueNumber } from "./examples";

describe("exampleTasks", () => {
  it("contains three unique, revision-pinned contribution tasks", () => {
    expect(exampleTasks).toHaveLength(3);
    expect(new Set(exampleTasks.map((example) => example.repository)).size).toBe(3);
    for (const example of exampleTasks) {
      expect(example.ref).toMatch(/^[a-f0-9]{40}$/);
      expect(example.task.length).toBeGreaterThan(80);
    }
    expect(exampleTasks[0].issueUrl).toBe("https://github.com/haya-inc/wasmhatch/issues/11");
  });

  it("derives a display number only from canonical GitHub issue URLs", () => {
    expect(getExampleIssueNumber("https://github.com/haya-inc/wasmhatch/issues/42")).toBe("42");
    expect(getExampleIssueNumber("https://example.com/haya-inc/wasmhatch/issues/42")).toBe("");
    expect(getExampleIssueNumber("https://github.com/haya-inc/wasmhatch/pull/42")).toBe("");
    expect(getExampleIssueNumber()).toBe("");
  });
});
