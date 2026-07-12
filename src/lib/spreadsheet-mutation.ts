import {
  diffSpreadsheetRows,
  validateSpreadsheetCell,
  validateSpreadsheetRows,
  type SpreadsheetCell,
  type SpreadsheetRows
} from "./spreadsheet";

export type SpreadsheetInputMode = "RAW" | "USER_ENTERED";
export type SpreadsheetCellMutationKind = "cell.set" | "cell.set-formula";

export interface SpreadsheetCellMutation {
  readonly kind: SpreadsheetCellMutationKind;
  readonly row: number;
  readonly column: number;
  readonly before: SpreadsheetCell;
  readonly after: SpreadsheetCell;
}

export interface SpreadsheetMutationBundle {
  readonly schemaVersion: 1;
  readonly operation: "tabular.cells.update";
  readonly mutations: readonly SpreadsheetCellMutation[];
}

export class UnsupportedTabularEffectError extends Error {
  constructor(
    readonly code: "structural_change" | "formula_write_requires_capability",
    message: string
  ) {
    super(message);
    this.name = "UnsupportedTabularEffectError";
  }
}

const MAX_MUTATIONS = 100_000;

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.values(value as Record<string, unknown>).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

function assertExactKeys(value: unknown, expectedKeys: readonly string[], label: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} contains missing or unsupported fields.`);
  }
}

function requireCoordinate(value: unknown, label: string) {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new Error(`${label} must be a non-negative integer.`);
  }
  return value as number;
}

function requireInputMode(value: unknown): SpreadsheetInputMode {
  if (value !== "RAW" && value !== "USER_ENTERED") {
    throw new Error("Spreadsheet mutation input mode is unsupported.");
  }
  return value;
}

function isFormula(value: SpreadsheetCell, inputMode: SpreadsheetInputMode) {
  return inputMode === "USER_ENTERED" && typeof value === "string" && value.startsWith("=");
}

function mutationKind(value: SpreadsheetCell, inputMode: SpreadsheetInputMode): SpreadsheetCellMutationKind {
  return isFormula(value, inputMode) ? "cell.set-formula" : "cell.set";
}

function cloneRows(value: unknown) {
  return validateSpreadsheetRows(value).map((row) => [...row]);
}

function assertSameShape(before: SpreadsheetRows, after: SpreadsheetRows) {
  if (before.length !== after.length) {
    throw new UnsupportedTabularEffectError(
      "structural_change",
      "Spreadsheet row insertion or deletion is not supported by the cell-update operation."
    );
  }
  for (let row = 0; row < before.length; row += 1) {
    if (before[row].length !== after[row].length) {
      throw new UnsupportedTabularEffectError(
        "structural_change",
        `Spreadsheet column structure changed in row ${row + 1}; prepare a structural operation instead.`
      );
    }
  }
}

export function createSpreadsheetMutationBundle(
  beforeValue: SpreadsheetRows,
  afterValue: SpreadsheetRows,
  inputMode: SpreadsheetInputMode
): SpreadsheetMutationBundle {
  const before = cloneRows(beforeValue);
  const after = cloneRows(afterValue);
  const validatedInputMode = requireInputMode(inputMode);
  assertSameShape(before, after);
  const changes = diffSpreadsheetRows(before, after);
  if (changes.length > MAX_MUTATIONS) {
    throw new Error(`Spreadsheet effect exceeds ${MAX_MUTATIONS} cell mutations.`);
  }
  return deepFreeze({
    schemaVersion: 1,
    operation: "tabular.cells.update",
    mutations: changes.map((change) => ({
      kind: mutationKind(change.after, validatedInputMode),
      row: change.row,
      column: change.column,
      before: change.before,
      after: change.after
    }))
  });
}

export function validateSpreadsheetMutationBundle(
  baseValue: SpreadsheetRows,
  bundle: SpreadsheetMutationBundle,
  inputMode: SpreadsheetInputMode
) {
  const base = cloneRows(baseValue);
  const validatedInputMode = requireInputMode(inputMode);
  assertExactKeys(bundle, ["schemaVersion", "operation", "mutations"], "Spreadsheet mutation bundle");
  if (bundle.schemaVersion !== 1 || bundle.operation !== "tabular.cells.update") {
    throw new Error("Unsupported spreadsheet mutation bundle schema or operation.");
  }
  if (!Array.isArray(bundle.mutations)) throw new Error("Spreadsheet mutations must be an array.");
  if (bundle.mutations.length > MAX_MUTATIONS) {
    throw new Error(`Spreadsheet effect exceeds ${MAX_MUTATIONS} cell mutations.`);
  }

  let previousRow = -1;
  let previousColumn = -1;
  for (const rawMutation of bundle.mutations) {
    assertExactKeys(rawMutation, ["kind", "row", "column", "before", "after"], "Spreadsheet cell mutation");
    const mutation = rawMutation as SpreadsheetCellMutation;
    const row = requireCoordinate(mutation.row, "Spreadsheet mutation row");
    const column = requireCoordinate(mutation.column, "Spreadsheet mutation column");
    if (!base[row] || column >= base[row].length) {
      throw new Error("Spreadsheet mutation is outside the base table shape.");
    }
    if (row < previousRow || (row === previousRow && column <= previousColumn)) {
      throw new Error("Spreadsheet mutations must be unique and ordered by row and column.");
    }
    previousRow = row;
    previousColumn = column;

    const before = validateSpreadsheetCell(mutation.before);
    const after = validateSpreadsheetCell(mutation.after);
    if (!Object.is(base[row][column], before)) {
      throw new Error("Spreadsheet mutation before-value does not match the base table.");
    }
    if (Object.is(before, after)) throw new Error("Spreadsheet mutations must change a cell value.");
    if (mutation.kind !== mutationKind(after, validatedInputMode)) {
      throw new Error("Spreadsheet mutation kind does not match its value and input mode.");
    }
  }
}

export function applySpreadsheetMutationBundle(
  baseValue: SpreadsheetRows,
  bundle: SpreadsheetMutationBundle,
  inputMode: SpreadsheetInputMode
): SpreadsheetRows {
  validateSpreadsheetMutationBundle(baseValue, bundle, inputMode);
  const result = cloneRows(baseValue);
  for (const mutation of bundle.mutations) result[mutation.row][mutation.column] = mutation.after;
  return result;
}

export function invertSpreadsheetMutationBundle(
  baseValue: SpreadsheetRows,
  bundle: SpreadsheetMutationBundle,
  inputMode: SpreadsheetInputMode
) {
  const result = applySpreadsheetMutationBundle(baseValue, bundle, inputMode);
  return createSpreadsheetMutationBundle(result, cloneRows(baseValue), inputMode);
}

export function countFormulaMutations(bundle: SpreadsheetMutationBundle) {
  return bundle.mutations.filter((mutation) => mutation.kind === "cell.set-formula").length;
}
