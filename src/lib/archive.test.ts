import { describe, expect, it } from "vitest";
import {
  createZipArchive,
  isSupportedGitHubPath,
  parseGitHubRepository,
  readZipArchive
} from "./archive";

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

  it("filters common binary repository files", () => {
    expect(isSupportedGitHubPath("src/main.ts")).toBe(true);
    expect(isSupportedGitHubPath("assets/hero.png")).toBe(false);
    expect(isSupportedGitHubPath("fonts/mono.woff2")).toBe(false);
  });
});
