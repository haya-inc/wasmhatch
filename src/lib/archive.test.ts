import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createZipArchive,
  fetchGitHubRepository,
  isSupportedGitHubPath,
  parseGitHubRepository,
  readZipArchive
} from "./archive";

describe("archive utilities", () => {
  afterEach(() => vi.unstubAllGlobals());
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

  it("resolves an explicit Git ref before fetching text files", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ default_branch: "main" }))
      .mockResolvedValueOnce(Response.json({ sha: "abc123" }))
      .mockResolvedValueOnce(Response.json({
        truncated: false,
        tree: [{ path: "README.md", type: "blob", size: 8 }]
      }))
      .mockResolvedValueOnce(new Response("# Hatch\n"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchGitHubRepository("haya-inc/wasmhatch", "v0.2.0")).resolves.toEqual([
      { path: "README.md", content: "# Hatch\n" }
    ]);
    expect(fetchMock.mock.calls[1][0]).toContain("/commits/v0.2.0");
    expect(fetchMock.mock.calls[3][0]).toBe(
      "https://raw.githubusercontent.com/haya-inc/wasmhatch/abc123/README.md"
    );
  });
});
