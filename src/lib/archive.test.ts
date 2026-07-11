import { describe, expect, it } from "vitest";
import { createZipArchive, parseGitHubRepository, readZipArchive } from "./archive";

describe("archive utilities", () => {
  it("round-trips text files", () => {
    const files = [
      { path: "README.md", content: "# Hatch\n" },
      { path: "src/index.ts", content: "export const value = 1;\n" }
    ];
    expect(readZipArchive(createZipArchive(files))).toEqual(files);
  });

  it("parses GitHub repository references", () => {
    expect(parseGitHubRepository("haya-inc/wasmhatch")).toEqual({ owner: "haya-inc", repo: "wasmhatch" });
    expect(parseGitHubRepository("https://github.com/haya-inc/wasmhatch.git")).toEqual({ owner: "haya-inc", repo: "wasmhatch" });
  });
});
