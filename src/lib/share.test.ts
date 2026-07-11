import { describe, expect, it } from "vitest";
import { createBadgeMarkdown, createWorkspaceShareUrl, normalizeGitHubIssueUrl } from "./share";

describe("share links", () => {
  it("creates an encoded workspace URL", () => {
    const url = createWorkspaceShareUrl(
      "https://example.com/wasmhatch/",
      "haya-inc/wasmhatch",
      "Improve the README & docs",
      "v0.2.0"
    );
    expect(url).toBe(
      "https://example.com/wasmhatch/?view=workspace&repo=haya-inc%2Fwasmhatch&ref=v0.2.0&task=Improve+the+README+%26+docs"
    );
  });

  it("creates reusable badge markdown", () => {
    expect(createBadgeMarkdown("https://example.com/task", "https://example.com/badge.svg")).toBe(
      "[![Open in WasmHatch](https://example.com/badge.svg)](https://example.com/task)"
    );
  });

  it("keeps a canonical GitHub issue with the task context", () => {
    const url = createWorkspaceShareUrl(
      "https://example.com/wasmhatch/",
      "haya-inc/wasmhatch",
      "Fix the parser",
      "abc123",
      "https://github.com/haya-inc/wasmhatch/issues/1/?utm_source=test#comment"
    );
    expect(url).toContain(
      "issue=https%3A%2F%2Fgithub.com%2Fhaya-inc%2Fwasmhatch%2Fissues%2F1"
    );
  });

  it("rejects non-issue and non-GitHub destinations", () => {
    expect(normalizeGitHubIssueUrl("javascript:alert(1)")).toBe("");
    expect(normalizeGitHubIssueUrl("https://example.com/owner/repo/issues/1")).toBe("");
    expect(normalizeGitHubIssueUrl("https://github.com/owner/repo/pull/1")).toBe("");
    expect(normalizeGitHubIssueUrl("https://github.com/owner/repo/issues/42/"))
      .toBe("https://github.com/owner/repo/issues/42");
  });
});
