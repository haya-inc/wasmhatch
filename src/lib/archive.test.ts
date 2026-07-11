import { afterEach, describe, expect, it, vi } from "vitest";
import { strToU8, zipSync } from "fflate";
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

  it("normalizes malformed input to a stable error", () => {
    const cases = [
      new Uint8Array(),
      new Uint8Array([0x50, 0x4b, 0x03]),
      new Uint8Array([1, 2, 3, 4, 5])
    ];
    let seed = 0x5eed;
    for (let index = 0; index < 64; index += 1) {
      const bytes = new Uint8Array(1 + index * 3);
      for (let offset = 0; offset < bytes.length; offset += 1) {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        bytes[offset] = seed & 0xff;
      }
      cases.push(bytes);
    }

    for (const bytes of cases) {
      expect(() => readZipArchive(bytes)).toThrow("Archive is not a valid ZIP file.");
    }
  });

  it("rejects traversal and duplicate normalized paths", () => {
    expect(() => readZipArchive(zipSync({ "../secret.txt": strToU8("secret") })))
      .toThrow("Archive contains an unsafe path.");
    expect(() => readZipArchive(zipSync({
      "a.txt": strToU8("first"),
      "./a.txt": strToU8("second")
    }))).toThrow("Archive contains a duplicate path: a.txt");
  });

  it("rejects excessive file counts before import", () => {
    const entries = Object.fromEntries(
      Array.from({ length: 501 }, (_, index) => [`files/${index}.txt`, new Uint8Array()])
    );
    expect(() => readZipArchive(zipSync(entries))).toThrow("Archive contains more than 500 files.");
  });

  it("rejects archives whose accepted files expand beyond 20 MB", () => {
    const twoMegabytes = new Uint8Array(2 * 1024 * 1024);
    const entries = Object.fromEntries(
      Array.from({ length: 11 }, (_, index) => [`files/${index}.txt`, twoMegabytes])
    );
    expect(() => readZipArchive(zipSync(entries, { level: 9 })))
      .toThrow("Archive expands beyond the 20 MB limit.");
  });

  it("parses GitHub repository references", () => {
    expect(parseGitHubRepository("haya-inc/wasmhatch")).toEqual({ owner: "haya-inc", repo: "wasmhatch" });
    expect(parseGitHubRepository("https://github.com/haya-inc/wasmhatch.git")).toEqual({ owner: "haya-inc", repo: "wasmhatch" });
    expect(parseGitHubRepository("https://github.com/haya-inc/wasmhatch.git/")).toEqual({ owner: "haya-inc", repo: "wasmhatch" });
    expect(parseGitHubRepository("haya-inc/wasmhatch.git/")).toEqual({ owner: "haya-inc", repo: "wasmhatch" });
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
