import { describe, expect, it } from "vitest";
import {
  UnsupportedTabularEffectError,
  applySpreadsheetMutationBundle,
  countFormulaMutations,
  createSpreadsheetMutationBundle,
  invertSpreadsheetMutationBundle,
  validateSpreadsheetMutationBundle
} from "./spreadsheet-mutation";

const BASE = [["Owner", "Amount"], [" Aya ", 4]] as const;
const DESIRED = [["Owner", "Amount"], ["Aya", 5]] as const;

function cloneRows(rows: readonly (readonly (string | number)[])[]) {
  return rows.map((row) => [...row]);
}

describe("spreadsheet mutation bundles", () => {
  it("creates an ordered, deeply frozen cell mutation bundle", () => {
    const bundle = createSpreadsheetMutationBundle(cloneRows(BASE), cloneRows(DESIRED), "RAW");

    expect(bundle).toEqual({
      schemaVersion: 1,
      operation: "tabular.cells.update",
      mutations: [
        { kind: "cell.set", row: 1, column: 0, before: " Aya ", after: "Aya" },
        { kind: "cell.set", row: 1, column: 1, before: 4, after: 5 }
      ]
    });
    expect(Object.isFrozen(bundle)).toBe(true);
    expect(Object.isFrozen(bundle.mutations)).toBe(true);
    expect(Object.isFrozen(bundle.mutations[0])).toBe(true);
    expect(applySpreadsheetMutationBundle(cloneRows(BASE), bundle, "RAW")).toEqual(DESIRED);
  });

  it("classifies formula writes separately from literal writes", () => {
    const bundle = createSpreadsheetMutationBundle(
      [["Label", "Value"], ["Total", 4]],
      [["Label", "Value"], ["Total", "=SUM(B2:B2)"]],
      "USER_ENTERED"
    );

    expect(bundle.mutations[0]).toMatchObject({ kind: "cell.set-formula", after: "=SUM(B2:B2)" });
    expect(countFormulaMutations(bundle)).toBe(1);
    expect(createSpreadsheetMutationBundle(
      [["Label", "Value"], ["Total", 4]],
      [["Label", "Value"], ["Total", "=SUM(B2:B2)"]],
      "RAW"
    ).mutations[0].kind).toBe("cell.set");
  });

  it("rejects structural changes instead of previewing an update the provider cannot perform", () => {
    for (const desired of [
      [["Owner", "Amount"]],
      [["Owner"], ["Aya"]]
    ]) {
      try {
        createSpreadsheetMutationBundle(cloneRows(BASE), desired, "RAW");
        throw new Error("Expected structural change rejection.");
      } catch (error) {
        expect(error).toBeInstanceOf(UnsupportedTabularEffectError);
        expect(error).toMatchObject({ code: "structural_change" });
      }
    }
  });

  it("rejects unknown fields, duplicate coordinates, stale before-values, and forged kinds", () => {
    const bundle = createSpreadsheetMutationBundle(cloneRows(BASE), cloneRows(DESIRED), "RAW");
    const copies = [
      { ...bundle, hidden: true },
      { ...bundle, mutations: [bundle.mutations[0], bundle.mutations[0]] },
      { ...bundle, mutations: [{ ...bundle.mutations[0], before: "Mallory" }] },
      { ...bundle, mutations: [{ ...bundle.mutations[0], kind: "cell.set-formula" }] }
    ];

    expect(() => validateSpreadsheetMutationBundle(cloneRows(BASE), copies[0] as never, "RAW"))
      .toThrow("missing or unsupported fields");
    expect(() => validateSpreadsheetMutationBundle(cloneRows(BASE), copies[1] as never, "RAW"))
      .toThrow("unique and ordered");
    expect(() => validateSpreadsheetMutationBundle(cloneRows(BASE), copies[2] as never, "RAW"))
      .toThrow("before-value");
    expect(() => validateSpreadsheetMutationBundle(cloneRows(BASE), copies[3] as never, "RAW"))
      .toThrow("kind does not match");
    expect(() => createSpreadsheetMutationBundle(cloneRows(BASE), cloneRows(DESIRED), "INVALID" as never))
      .toThrow("input mode is unsupported");
  });

  it("generates inverse metadata that reconstructs the exact base table", () => {
    const base = cloneRows(BASE);
    const bundle = createSpreadsheetMutationBundle(base, cloneRows(DESIRED), "RAW");
    const committed = applySpreadsheetMutationBundle(base, bundle, "RAW");
    const inverse = invertSpreadsheetMutationBundle(base, bundle, "RAW");

    expect(inverse.mutations).toEqual([
      { kind: "cell.set", row: 1, column: 0, before: "Aya", after: " Aya " },
      { kind: "cell.set", row: 1, column: 1, before: 5, after: 4 }
    ]);
    expect(applySpreadsheetMutationBundle(committed, inverse, "RAW")).toEqual(BASE);
  });

  it("copies caller-owned rows before freezing the mutation bundle", () => {
    const base = cloneRows(BASE);
    const desired = cloneRows(DESIRED);
    const bundle = createSpreadsheetMutationBundle(base, desired, "RAW");
    base[1][0] = "changed outside";
    desired[1][0] = "changed outside";

    expect(bundle.mutations[0]).toMatchObject({ before: " Aya ", after: "Aya" });
  });
});
