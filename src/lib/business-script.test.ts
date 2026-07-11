import { describe, expect, it } from "vitest";
import { executeBusinessScript } from "./business-script";

describe("executeBusinessScript", () => {
  it("transforms spreadsheet-shaped JSON inside QuickJS Wasm", async () => {
    const result = await executeBusinessScript(
      `(rows) => rows.map((row, index) => index === 0
        ? row
        : [String(row[0]).trim(), String(row[1]).trim().toUpperCase(), Number(row[2])])`,
      [["Owner", "Region", "Amount"], ["  Aya ", " west ", "42"]]
    );

    expect(result.output).toEqual([
      ["Owner", "Region", "Amount"],
      ["Aya", "WEST", 42]
    ]);
    expect(result.inputBytes).toBeGreaterThan(0);
    expect(result.outputBytes).toBeGreaterThan(0);
  });

  it("does not expose browser or Node host capabilities", async () => {
    const result = await executeBusinessScript(
      `() => ({ fetch: typeof fetch, process: typeof process, document: typeof document })`,
      null
    );

    expect(result.output).toEqual({ fetch: "undefined", process: "undefined", document: "undefined" });
  });

  it("interrupts non-terminating scripts", async () => {
    await expect(executeBusinessScript(`() => { while (true) {} }`, null, { timeoutMs: 20 }))
      .rejects.toThrow("execution time limit");
  });

  it("rejects oversized inputs before starting the runtime", async () => {
    await expect(executeBusinessScript(`(value) => value`, "oversized", { maxInputBytes: 4 }))
      .rejects.toThrow("Script input exceeds");
  });
});
