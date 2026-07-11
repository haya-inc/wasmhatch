import { describe, expect, it } from "vitest";
import { createBadgeMarkdown, createWorkspaceShareUrl } from "./share";

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
});
