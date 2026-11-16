/**
 * Pure RFC 4180 CSV/TSV/JSON tabular parser, column profiler, and
 * spreadsheet formula-injection guard for `wasmhatch:tabular:v1`.
 */

export const MAX_TABULAR_ROWS = 5_000;

export type TabularCellValue = string | number | boolean | null;
export type TabularColumnType = "number" | "boolean" | "text";

export interface TabularColumnDef {
  key: string;
  label: string;
  type: TabularColumnType;
}

export interface FormulaCellWarning {
  rowIndex: number;
  columnKey: string;
  rawValue: string;
}

export interface NormalizedTabularRow {
  /** Stable 0-based index in the source dataset so sorting preserves row identity. */
  rowIndex: number;
  cells: Record<string, TabularCellValue>;
  formulaColumns: ReadonlySet<string>;
}

export interface NormalizedTabularDataset {
  columns: TabularColumnDef[];
  rows: NormalizedTabularRow[];
  formulaWarnings: FormulaCellWarning[];
  totalRows: number;
  truncated: boolean;
}

export interface ColumnProfileSummary {
  key: string;
  label: string;
  type: TabularColumnType;
  nonNullCount: number;
  missingCount: number;
  distinctCount: number;
  formulaWarningCount: number;
  min?: number;
  max?: number;
  sum?: number;
  mean?: number;
}

const PLAIN_NEGATIVE_NUMBER_RE = /^-(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?\s*$/;
const STRICT_NUMBER_RE = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;

/**
 * Flags spreadsheet formula-injection payloads (`=`, `+`, `-`, `@`, leading tab/CR)
 * while allowing plain negative numeric literals like `-42` or `-3.14`.
 */
export function detectFormulaInjection(value: unknown): boolean {
  if (typeof value !== "string" || value.length === 0) return false;
  if (value.startsWith("\t") || value.startsWith("\r")) return true;
  const trimmedLeading = value.replace(/^[ ]+/, "");
  if (!trimmedLeading) return false;
  const first = trimmedLeading[0];
  if (first === "=" || first === "+" || first === "@") return true;
  if (first === "-") {
    return !PLAIN_NEGATIVE_NUMBER_RE.test(trimmedLeading);
  }
  return false;
}

/**
 * Neutralizes spreadsheet formula prefixes with a leading apostrophe (`'`)
 * when exporting CSV files for Excel / Google Sheets / LibreOffice Calc.
 */
export function neutralizeFormulaCell(value: string): string {
  return detectFormulaInjection(value) ? `'${value}` : value;
}

/**
 * Parses RFC 4180 delimited text (`,` or `\t`) into raw string matrix rows.
 */
export function parseDelimitedMatrix(
  rawText: string,
  delimiter: "," | "\t" = ",",
  maxDataRows = MAX_TABULAR_ROWS
): { headers: string[]; rows: string[][]; totalRows: number; truncated: boolean } {
  const text = rawText.startsWith("\uFEFF") ? rawText.slice(1) : rawText;
  if (!text.trim()) {
    return { headers: [], rows: [], totalRows: 0, truncated: false };
  }

  const matrix: string[][] = [];
  let currentRow: string[] = [];
  let currentCell = "";
  let inQuotes = false;
  let cellWasQuoted = false;

  const pushCell = () => {
    currentRow.push(cellWasQuoted ? currentCell : currentCell);
    currentCell = "";
    cellWasQuoted = false;
  };

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === "\"") {
        if (text[i + 1] === "\"") {
          currentCell += "\"";
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        currentCell += ch;
      }
      continue;
    }

    if (ch === "\"" && currentCell.length === 0) {
      inQuotes = true;
      cellWasQuoted = true;
      continue;
    }
    if (ch === delimiter) {
      pushCell();
      continue;
    }
    if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && text[i + 1] === "\n") i += 1;
      pushCell();
      if (currentRow.length > 1 || (currentRow.length === 1 && currentRow[0] !== "")) {
        matrix.push(currentRow);
      }
      currentRow = [];
      continue;
    }
    currentCell += ch;
  }

  if (inQuotes || currentCell.length > 0 || currentRow.length > 0) {
    pushCell();
    if (currentRow.length > 1 || (currentRow.length === 1 && currentRow[0] !== "")) {
      matrix.push(currentRow);
    }
  }

  if (matrix.length === 0) {
    return { headers: [], rows: [], totalRows: 0, truncated: false };
  }

  const rawHeaders = matrix[0];
  const seen = new Map<string, number>();
  const headers = rawHeaders.map((raw, idx) => {
    const base = raw.trim() || `column_${idx + 1}`;
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count === 0 ? base : `${base}_${count + 1}`;
  });

  const dataRows = matrix.slice(1);
  const totalRows = dataRows.length;
  const truncated = totalRows > maxDataRows;
  const boundedRows = truncated ? dataRows.slice(0, maxDataRows) : dataRows;

  return { headers, rows: boundedRows, totalRows, truncated };
}

function coerceCsvScalar(raw: string): TabularCellValue {
  if (raw === "") return null;
  if (detectFormulaInjection(raw)) return raw;
  const trimmed = raw.trim();
  if (!trimmed) return raw;
  if (STRICT_NUMBER_RE.test(trimmed)) {
    const num = Number(trimmed);
    if (Number.isFinite(num)) return num;
  }
  const lower = trimmed.toLowerCase();
  if (lower === "true") return true;
  if (lower === "false") return false;
  return raw;
}

function normalizeCellValue(raw: unknown): TabularCellValue {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : String(raw);
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "string") return raw;
  try {
    return JSON.stringify(raw);
  } catch {
    return String(raw);
  }
}

function inferColumnType(rows: readonly NormalizedTabularRow[], key: string): TabularColumnType {
  let sawNonNull = false;
  let allNumbers = true;
  let allBooleans = true;
  for (const row of rows) {
    const val = row.cells[key];
    if (val === null || val === undefined || val === "") continue;
    sawNonNull = true;
    if (typeof val !== "number") allNumbers = false;
    if (typeof val !== "boolean") allBooleans = false;
    if (!allNumbers && !allBooleans) return "text";
  }
  if (!sawNonNull) return "text";
  if (allNumbers) return "number";
  if (allBooleans) return "boolean";
  return "text";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseExplicitColumns(rawColumns: unknown): TabularColumnDef[] | null {
  if (!Array.isArray(rawColumns) || rawColumns.length === 0) return null;
  const defs: TabularColumnDef[] = [];
  for (const entry of rawColumns) {
    if (typeof entry === "string" && entry.trim()) {
      const key = entry.trim();
      defs.push({ key, label: key, type: "text" });
    } else if (isPlainObject(entry) && typeof entry.key === "string" && entry.key.trim()) {
      const key = entry.key.trim();
      const label = typeof entry.label === "string" && entry.label.trim() ? entry.label.trim() : key;
      const type: TabularColumnType =
        entry.type === "number" || entry.type === "boolean" || entry.type === "text"
          ? entry.type
          : "text";
      defs.push({ key, label, type });
    }
  }
  return defs.length > 0 ? defs : null;
}

/**
 * Normalizes CSV/TSV text, JSON record arrays, or `{ columns, rows }` envelopes
 * into a uniform dataset with column types and formula-injection warnings.
 */
export function normalizeTabularDataset(
  input: unknown,
  explicitColumns?: unknown,
  maxRows = MAX_TABULAR_ROWS
): NormalizedTabularDataset {
  if (typeof input === "string") {
    const trimmed = input.trim();
    if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
      try {
        const parsedJson = JSON.parse(trimmed);
        return normalizeTabularDataset(parsedJson, explicitColumns, maxRows);
      } catch {
        // Fall through to delimited parser.
      }
    }
    const delimiter: "," | "\t" =
      input.includes("\t") && !input.split("\n")[0]?.includes(",") ? "\t" : ",";
    const matrix = parseDelimitedMatrix(input, delimiter, maxRows);
    const formulaWarnings: FormulaCellWarning[] = [];
    const rows: NormalizedTabularRow[] = matrix.rows.map((rawCells, rowIndex) => {
      const cells: Record<string, TabularCellValue> = {};
      const formulaCols = new Set<string>();
      matrix.headers.forEach((header, colIdx) => {
        const rawCell = rawCells[colIdx] ?? "";
        if (detectFormulaInjection(rawCell)) {
          formulaCols.add(header);
          formulaWarnings.push({ rowIndex, columnKey: header, rawValue: rawCell });
        }
        cells[header] = coerceCsvScalar(rawCell);
      });
      return { rowIndex, cells, formulaColumns: formulaCols };
    });

    const explicit = parseExplicitColumns(explicitColumns);
    const columns: TabularColumnDef[] = explicit
      ? explicit.map((col) => ({
          ...col,
          type: col.type !== "text" ? col.type : inferColumnType(rows, col.key)
        }))
      : matrix.headers.map((key) => ({
          key,
          label: key,
          type: inferColumnType(rows, key)
        }));

    return {
      columns,
      rows,
      formulaWarnings,
      totalRows: matrix.totalRows,
      truncated: matrix.truncated
    };
  }

  let rawRows: unknown[] = [];
  let envelopeColumns = explicitColumns;
  let explicitTotalRows: number | undefined;
  let explicitTruncated = false;

  if (Array.isArray(input)) {
    rawRows = input;
  } else if (isPlainObject(input)) {
    if (Array.isArray(input.rows)) {
      rawRows = input.rows;
      if (envelopeColumns === undefined && input.columns !== undefined) {
        envelopeColumns = input.columns;
      }
      if (typeof input.totalRows === "number" && Number.isFinite(input.totalRows)) {
        explicitTotalRows = input.totalRows;
      }
      if (input.truncated === true) explicitTruncated = true;
    } else if (Array.isArray(input.values)) {
      rawRows = input.values;
    }
  }

  const totalRows = explicitTotalRows ?? rawRows.length;
  const truncated = explicitTruncated || rawRows.length > maxRows;
  const boundedRawRows = rawRows.length > maxRows ? rawRows.slice(0, maxRows) : rawRows;

  const explicit = parseExplicitColumns(envelopeColumns);
  const discoveredKeys: string[] = [];
  const discoveredSet = new Set<string>();

  if (explicit) {
    for (const col of explicit) {
      discoveredKeys.push(col.key);
      discoveredSet.add(col.key);
    }
  }

  for (const item of boundedRawRows) {
    if (isPlainObject(item)) {
      const source = isPlainObject(item.cells) && Object.keys(item).length <= 3 ? item.cells : item;
      for (const key of Object.keys(source)) {
        if (key === "_rowIndex" || key === "formulaColumns") continue;
        if (!discoveredSet.has(key)) {
          discoveredSet.add(key);
          discoveredKeys.push(key);
        }
      }
    } else if (Array.isArray(item) && discoveredKeys.length < item.length) {
      for (let idx = discoveredKeys.length; idx < item.length; idx += 1) {
        const key = `column_${idx + 1}`;
        discoveredSet.add(key);
        discoveredKeys.push(key);
      }
    }
  }

  const formulaWarnings: FormulaCellWarning[] = [];
  const rows: NormalizedTabularRow[] = boundedRawRows.map((item, rowIndex) => {
    const cells: Record<string, TabularCellValue> = {};
    const formulaCols = new Set<string>();
    if (isPlainObject(item)) {
      const source = isPlainObject(item.cells) && Object.keys(item).length <= 3 ? item.cells : item;
      for (const key of discoveredKeys) {
        const normalized = normalizeCellValue(source[key]);
        if (typeof normalized === "string" && detectFormulaInjection(normalized)) {
          formulaCols.add(key);
          formulaWarnings.push({ rowIndex, columnKey: key, rawValue: normalized });
        }
        cells[key] = normalized;
      }
    } else if (Array.isArray(item)) {
      discoveredKeys.forEach((key, colIdx) => {
        const normalized = normalizeCellValue(item[colIdx]);
        if (typeof normalized === "string" && detectFormulaInjection(normalized)) {
          formulaCols.add(key);
          formulaWarnings.push({ rowIndex, columnKey: key, rawValue: normalized });
        }
        cells[key] = normalized;
      });
    }
    return { rowIndex, cells, formulaColumns: formulaCols };
  });

  const columns: TabularColumnDef[] = explicit
    ? explicit.map((col) => ({
        ...col,
        type: col.type !== "text" ? col.type : inferColumnType(rows, col.key)
      }))
    : discoveredKeys.map((key) => ({
        key,
        label: key,
        type: inferColumnType(rows, key)
      }));

  return {
    columns,
    rows,
    formulaWarnings,
    totalRows,
    truncated
  };
}

/**
 * Parses a workspace file's raw text based on its extension (`.csv`, `.tsv`, `.json`, `.jsonl`).
 */
export function parseWorkspaceTabularFile(
  path: string,
  content: string,
  maxRows = MAX_TABULAR_ROWS
): NormalizedTabularDataset {
  const lower = path.toLowerCase();
  if (lower.endsWith(".json")) {
    const parsed = JSON.parse(content);
    return normalizeTabularDataset(parsed, undefined, maxRows);
  }
  if (lower.endsWith(".jsonl") || lower.endsWith(".ndjson")) {
    const lines = content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    return normalizeTabularDataset(lines, undefined, maxRows);
  }
  const delimiter: "," | "\t" = lower.endsWith(".tsv") ? "\t" : ",";
  const matrix = parseDelimitedMatrix(content, delimiter, maxRows);
  const formulaWarnings: FormulaCellWarning[] = [];
  const rows: NormalizedTabularRow[] = matrix.rows.map((rawCells, rowIndex) => {
    const cells: Record<string, TabularCellValue> = {};
    const formulaCols = new Set<string>();
    matrix.headers.forEach((header, colIdx) => {
      const rawCell = rawCells[colIdx] ?? "";
      if (detectFormulaInjection(rawCell)) {
        formulaCols.add(header);
        formulaWarnings.push({ rowIndex, columnKey: header, rawValue: rawCell });
      }
      cells[header] = coerceCsvScalar(rawCell);
    });
    return { rowIndex, cells, formulaColumns: formulaCols };
  });
  const columns: TabularColumnDef[] = matrix.headers.map((key) => ({
    key,
    label: key,
    type: inferColumnType(rows, key)
  }));
  return {
    columns,
    rows,
    formulaWarnings,
    totalRows: matrix.totalRows,
    truncated: matrix.truncated
  };
}

/**
 * Computes summary statistics and formula-injection counts per column.
 */
export function profileTabularDataset(dataset: NormalizedTabularDataset): ColumnProfileSummary[] {
  return dataset.columns.map((col) => {
    let nonNullCount = 0;
    let missingCount = 0;
    let formulaWarningCount = 0;
    const distinct = new Set<string>();
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    let sum = 0;
    let numericCount = 0;

    for (const row of dataset.rows) {
      const val = row.cells[col.key];
      if (row.formulaColumns.has(col.key)) formulaWarningCount += 1;
      if (val === null || val === undefined || val === "") {
        missingCount += 1;
        continue;
      }
      nonNullCount += 1;
      distinct.add(String(val));
      if (typeof val === "number" && Number.isFinite(val)) {
        numericCount += 1;
        if (val < min) min = val;
        if (val > max) max = val;
        sum += val;
      }
    }

    const summary: ColumnProfileSummary = {
      key: col.key,
      label: col.label,
      type: col.type,
      nonNullCount,
      missingCount,
      distinctCount: distinct.size,
      formulaWarningCount
    };

    if (col.type === "number" && numericCount > 0) {
      summary.min = min;
      summary.max = max;
      summary.sum = Number(sum.toFixed(6));
      summary.mean = Number((sum / numericCount).toFixed(6));
    }

    return summary;
  });
}

function escapeCsvCell(raw: string): string {
  if (/[",\r\n]/.test(raw)) {
    return `"${raw.replace(/"/g, "\"\"")}"`;
  }
  return raw;
}

/**
 * Serializes a normalized dataset (or subset of rows) to RFC 4180 CSV,
 * neutralizing formula-injection prefixes by default.
 */
export function serializeSafeCsv(
  columns: readonly TabularColumnDef[],
  rows: readonly NormalizedTabularRow[],
  options: { neutralizeFormulas?: boolean } = {}
): string {
  const neutralize = options.neutralizeFormulas !== false;
  const headerLine = columns
    .map((col) => escapeCsvCell(neutralize ? neutralizeFormulaCell(col.label) : col.label))
    .join(",");

  const bodyLines = rows.map((row) =>
    columns
      .map((col) => {
        const val = row.cells[col.key];
        if (val === null || val === undefined) return "";
        const str = String(val);
        return escapeCsvCell(neutralize ? neutralizeFormulaCell(str) : str);
      })
      .join(",")
  );

  return [headerLine, ...bodyLines].join("\r\n") + "\r\n";
}
