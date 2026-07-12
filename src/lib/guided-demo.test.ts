import { describe, expect, it } from "vitest";
import { guidedDemoDefinition, resolveGuidedDemo } from "./guided-demo";

describe("guided demo definitions", () => {
  it("resolves the default and reconciliation deep links without enabling unrelated queries", () => {
    expect(resolveGuidedDemo("?view=operator")).toMatchObject({ id: "normalization", showGuide: false });
    expect(resolveGuidedDemo("?view=operator&demo=local")).toMatchObject({ id: "normalization", showGuide: true });
    expect(resolveGuidedDemo("?view=operator&demo=reconciliation")).toMatchObject({ id: "reconciliation", showGuide: true });
    expect(resolveGuidedDemo("?view=operator&demo=unknown")).toMatchObject({ id: "normalization", showGuide: false });
  });

  it("publishes frozen bounded synthetic workflows", () => {
    const normalization = guidedDemoDefinition("normalization");
    const reconciliation = guidedDemoDefinition("reconciliation");
    expect(normalization.rows).toHaveLength(4);
    expect(normalization.expectedChangedCells).toBe(12);
    expect(reconciliation.rows).toEqual([
      ["Invoice", "ERP Amount", "Payout Amount", "Variance", "Status"],
      ["INV-101", 1250, 1250, null, null],
      ["INV-102", 980, 930, null, null],
      ["INV-103", 450, 450, null, null],
      ["INV-104", 1200, null, null, null]
    ]);
    expect(reconciliation.expectedChangedCells).toBe(7);
    expect(Object.isFrozen(reconciliation)).toBe(true);
    expect(Object.isFrozen(reconciliation.rows)).toBe(true);
    expect(Object.isFrozen(reconciliation.rows[0])).toBe(true);
  });
});
