import type { BusinessValue } from "./business-script";

export type SpreadsheetCell = null | boolean | number | string;
export type SpreadsheetRows = SpreadsheetCell[][];

export interface SpreadsheetRange {
  spreadsheetId: string;
  range: string;
}

export interface SpreadsheetSnapshot extends SpreadsheetRange {
  values: SpreadsheetRows;
}

export interface SpreadsheetWrite extends SpreadsheetSnapshot {
  inputMode?: "RAW" | "USER_ENTERED";
}

export interface SpreadsheetWriteResult {
  updatedRange: string;
  updatedRows: number;
  updatedColumns: number;
  updatedCells: number;
}

export interface SpreadsheetConnector {
  readonly id: string;
  readonly label: string;
  read(request: SpreadsheetRange, signal?: AbortSignal): Promise<SpreadsheetSnapshot>;
  write(request: SpreadsheetWrite, signal?: AbortSignal): Promise<SpreadsheetWriteResult>;
}

const MAX_SPREADSHEET_ID_LENGTH = 256;
const MAX_RANGE_LENGTH = 256;
const MAX_ROWS = 5_000;
const MAX_COLUMNS = 200;

function requireText(value: string, label: string, maxLength: number) {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required.`);
  if (normalized.length > maxLength) throw new Error(`${label} is too long.`);
  if(/[\u0000-\u001f\u007f]/.test(normalized)) throw new Error(`${label} contains control characters.`);
  return normalized;
}

function validateCell(value: unknown): SpreadsheetCell {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw new Error("Spreadsheet values must contain only strings, finite numbers, booleans, or null.");
}

export function validateSpreadsheetRows(value: unknown): SpreadsheetRows {
  if (!Array.isArray(value)) throw new Error("Spreadsheet values must be an array of rows.");
  if (value.length > MAX_ROWS) throw new Error(`Spreadsheet data exceeds ${MAX_ROWS} rows.`);
  return value.map((row) => {
    if (!Array.isArray(row)) throw new Error("Each spreadsheet row must be an array.");
    if (row.length > MAX_COLUMNS) throw new Error(`Spreadsheet data exceeds ${MAX_COLUMNS} columns.`);
    return row.map(validateCell);
  });
}

function parseJson(response: Response) {
  return response.json().catch(() => {
    throw new Error("Spreadsheet API returned unreadable JSON.");
  }) as Promise<unknown>;
}

function apiError(status: number) {
  if (status === 401) return new Error("Google Sheets authorization expired or is invalid.");
  if (status === 403) return new Error("Google Sheets denied this operation. Check the granted scope and sheet access.");
  if (status === 404) return new Error("Google Sheets could not find that spreadsheet or range.");
  if (status === 429) return new Error("Google Sheets rate limit reached. Wait briefly and try again.");
  return new Error(`Google Sheets request failed (${status}).`);
}

export class GoogleSheetsConnector implements SpreadsheetConnector {
  readonly id = "google-sheets";
  readonly label = "Google Sheets";

  constructor(
    private readonly accessToken: string,
    private readonly fetcher: typeof fetch = fetch
  ) {
    if (!accessToken.trim()) throw new Error("Google Sheets access token is required.");
  }

  private endpoint(request: SpreadsheetRange) {
    const spreadsheetId = requireText(request.spreadsheetId, "Spreadsheet ID", MAX_SPREADSHEET_ID_LENGTH);
    const range = requireText(request.range, "Spreadsheet range", MAX_RANGE_LENGTH);
    return `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}`;
  }

  async read(request: SpreadsheetRange, signal?: AbortSignal): Promise<SpreadsheetSnapshot> {
    const endpoint = new URL(this.endpoint(request));
    endpoint.searchParams.set("majorDimension", "ROWS");
    endpoint.searchParams.set("valueRenderOption", "UNFORMATTED_VALUE");
    const response = await this.fetcher(endpoint, {
      headers: { authorization: `Bearer ${this.accessToken}` },
      signal
    });
    if (!response.ok) throw apiError(response.status);
    const body = await parseJson(response);
    const values = validateSpreadsheetRows(
      body && typeof body === "object" && "values" in body ? (body as { values?: unknown }).values ?? [] : []
    );
    return {
      spreadsheetId: request.spreadsheetId.trim(),
      range: body && typeof body === "object" && typeof (body as { range?: unknown }).range === "string"
        ? (body as { range: string }).range
        : request.range.trim(),
      values
    };
  }

  async write(request: SpreadsheetWrite, signal?: AbortSignal): Promise<SpreadsheetWriteResult> {
    const values = validateSpreadsheetRows(request.values);
    const endpoint = new URL(this.endpoint(request));
    endpoint.searchParams.set("valueInputOption", request.inputMode ?? "USER_ENTERED");
    const response = await this.fetcher(endpoint, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${this.accessToken}`,
        "content-type": "application/json"
      },
      signal,
      body: JSON.stringify({ range: request.range.trim(), majorDimension: "ROWS", values })
    });
    if (!response.ok) throw apiError(response.status);
    const body = await parseJson(response);
    const result = body && typeof body === "object" ? body as Record<string, unknown> : {};
    return {
      updatedRange: typeof result.updatedRange === "string" ? result.updatedRange : request.range.trim(),
      updatedRows: typeof result.updatedRows === "number" ? result.updatedRows : 0,
      updatedColumns: typeof result.updatedColumns === "number" ? result.updatedColumns : 0,
      updatedCells: typeof result.updatedCells === "number" ? result.updatedCells : 0
    };
  }
}

export function spreadsheetRowsFromBusinessValue(value: BusinessValue): SpreadsheetRows {
  return validateSpreadsheetRows(value);
}

export interface SpreadsheetChange {
  row: number;
  column: number;
  before: SpreadsheetCell;
  after: SpreadsheetCell;
}

export function diffSpreadsheetRows(before: SpreadsheetRows, after: SpreadsheetRows): SpreadsheetChange[] {
  const changes: SpreadsheetChange[] = [];
  const rowCount = Math.max(before.length, after.length);
  for (let row = 0; row < rowCount; row += 1) {
    const columnCount = Math.max(before[row]?.length ?? 0, after[row]?.length ?? 0);
    for (let column = 0; column < columnCount; column += 1) {
      const previous = before[row]?.[column] ?? null;
      const next = after[row]?.[column] ?? null;
      if (!Object.is(previous, next)) changes.push({ row, column, before: previous, after: next });
    }
  }
  return changes;
}
