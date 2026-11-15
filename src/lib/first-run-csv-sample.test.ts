import { describe, expect, it } from "vitest";
import { FIRST_RUN_CSV_SAMPLE, FIRST_RUN_SAMPLE_FILES } from "./first-run-csv-sample";

function parseSimpleCsv(text: string): string[][] {
  return text
    .trimEnd()
    .split("\n")
    .map((line) =>
      (line.match(/"[^"]*"|[^,]+/g) ?? []).map((cell) =>
        cell.startsWith('"') && cell.endsWith('"') ? cell.slice(1, -1) : cell
      )
    );
}

describe("first-run CSV sample", () => {
  it("is a bounded, formula-free table", () => {
    const rows = parseSimpleCsv(FIRST_RUN_CSV_SAMPLE.content);
    const formulaCells = rows.flat().filter((cell) => /^[=+\-@]/.test(cell.trimStart())).length;

    expect(FIRST_RUN_CSV_SAMPLE.fileName).toBe("wasmhatch-pipeline-sample.csv");
    expect(formulaCells).toBe(0);
    expect(rows).toEqual([
      ["Owner", "Region", "Amount", "Stage"],
      ["  aya tanaka", " west ", "12,400", "won"],
      ["KEN ITO  ", "East", "8300", "OPEN"],
      [" mei sato ", " north", "6,250", " Won "]
    ]);
    expect(new TextEncoder().encode(FIRST_RUN_CSV_SAMPLE.content).byteLength).toBeLessThan(512);
    expect(Object.isFrozen(FIRST_RUN_CSV_SAMPLE)).toBe(true);
  });

  it("ships the chat surface exactly one spreadsheet, matching the hero copy", () => {
    expect(FIRST_RUN_SAMPLE_FILES).toEqual([
      { path: FIRST_RUN_CSV_SAMPLE.fileName, content: FIRST_RUN_CSV_SAMPLE.content }
    ]);
    expect(Object.isFrozen(FIRST_RUN_SAMPLE_FILES)).toBe(true);
    expect(FIRST_RUN_SAMPLE_FILES.every((file) => Object.isFrozen(file))).toBe(true);
  });
});
