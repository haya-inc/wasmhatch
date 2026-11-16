import { describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import { createZipArchive, readZipArchive } from "./archive";

describe("archive utilities", () => {
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

  it("skips binary extensions and UTF-16 files that would import as mojibake", () => {
    const utf16 = new Uint8Array([0xff, 0xfe, 0x42, 0x30, 0x44, 0x30]);
    const archive = zipSync({
      "hero.png": new Uint8Array([1, 2, 3]),
      "utf16.txt": utf16,
      "utf8.txt": strToU8("plain\n")
    });
    expect(readZipArchive(archive)).toEqual([{ path: "utf8.txt", content: "plain\n" }]);
  });

  it("rejects deflated entries whose ZIP header lies about uncompressed size", () => {
    const payload = new Uint8Array(64 * 1024).fill(0x61);
    const archive = Uint8Array.from(zipSync({ "bomb.txt": payload }, { level: 9 }));
    const view = new DataView(archive.buffer);
    // Patch uncompressed size in both Local File Header (offset 22) and Central Directory.
    view.setUint32(22, 4, true);
    for (let i = archive.length - 22; i >= 0; i -= 1) {
      if (view.getUint32(i, true) === 0x02014b50) {
        view.setUint32(i + 24, 4, true);
        break;
      }
    }
    expect(() => readZipArchive(archive)).toThrow(/exceeds its declared size|beyond/);
  });
});
