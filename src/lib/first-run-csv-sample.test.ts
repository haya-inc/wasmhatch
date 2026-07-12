import { describe, expect, it } from "vitest";
import { validateCsvTextArtifact } from "./tabular-artifact";
import { FIRST_RUN_CSV_SAMPLE } from "./first-run-csv-sample";

describe("first-run CSV sample", () => {
  it("is a bounded, formula-free table for the real import worker path", () => {
    const parsed = validateCsvTextArtifact(FIRST_RUN_CSV_SAMPLE.content);

    expect(FIRST_RUN_CSV_SAMPLE.fileName).toBe("wasmhatch-pipeline-sample.csv");
    expect(parsed.formulaCells).toBe(0);
    expect(parsed.rows).toEqual([
      ["Owner", "Region", "Amount", "Stage"],
      ["  aya tanaka", " west ", "12,400", "won"],
      ["KEN ITO  ", "East", "8300", "OPEN"],
      [" mei sato ", " north", "6,250", " Won "]
    ]);
    expect(new TextEncoder().encode(FIRST_RUN_CSV_SAMPLE.content).byteLength).toBeLessThan(512);
    expect(Object.isFrozen(FIRST_RUN_CSV_SAMPLE)).toBe(true);
  });
});
