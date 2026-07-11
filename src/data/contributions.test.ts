import { describe, expect, it } from "vitest";
import { contributionTasks } from "./contributions";
import { createWorkspaceShareUrl } from "../lib/share";

describe("contributionTasks", () => {
  it("publishes unique, revision-pinned issue lanes", () => {
    expect(contributionTasks.length).toBeGreaterThanOrEqual(5);
    expect(new Set(contributionTasks.map((task) => task.issueNumber)).size).toBe(contributionTasks.length);
    for (const task of contributionTasks) {
      expect(task.repository).toBe("haya-inc/wasmhatch");
      expect(task.ref).toMatch(/^[0-9a-f]{40}$/);
      expect(task.task.length).toBeGreaterThan(80);
      expect(task.scope).toBeTruthy();
      const issueUrl = `https://github.com/haya-inc/wasmhatch/issues/${task.issueNumber}`;
      const url = createWorkspaceShareUrl(
        "https://haya-inc.github.io/wasmhatch/",
        task.repository,
        task.task,
        task.ref,
        issueUrl
      );
      expect(url).toContain(`issue=${encodeURIComponent(issueUrl)}`);
    }
  });
});
