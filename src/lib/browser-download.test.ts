import { describe, expect, it } from "vitest";
import { basenameOfPath, mimeTypeForPath } from "./browser-download";

describe("browser-download helpers", () => {
  it("resolves known MIME types by extension and falls back to text/plain", () => {
    expect(mimeTypeForPath("reports/summary.csv")).toBe("text/csv");
    expect(mimeTypeForPath("notes/plan.MD")).toBe("text/markdown");
    expect(mimeTypeForPath("data/config.yaml")).toBe("text/yaml");
    expect(mimeTypeForPath("README")).toBe("text/plain");
    expect(mimeTypeForPath("archive.unknown")).toBe("text/plain");
  });

  it("extracts the basename from nested workspace paths", () => {
    expect(basenameOfPath("reports/q3/summary.html")).toBe("summary.html");
    expect(basenameOfPath("notes.txt")).toBe("notes.txt");
  });
});
