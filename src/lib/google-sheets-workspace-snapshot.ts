import { GOOGLE_SHEETS_MANIFEST } from "./connector";
import {
  validateSpreadsheetRows,
  type SpreadsheetRows,
  type SpreadsheetSnapshot
} from "./spreadsheet";
import { hashWorkspaceContent } from "./workspace-script";

export const GOOGLE_SHEETS_WORKSPACE_SNAPSHOT_SCHEMA = "wasmhatch.google-sheets-snapshot.v1" as const;
export const GOOGLE_SHEETS_WORKSPACE_SNAPSHOT_LIMITS = Object.freeze({ bytes: 512 * 1024 });

export interface GoogleSheetsWorkspaceSnapshot {
  readonly schema: typeof GOOGLE_SHEETS_WORKSPACE_SNAPSHOT_SCHEMA;
  readonly connector: {
    readonly id: typeof GOOGLE_SHEETS_MANIFEST.id;
    readonly version: string;
  };
  readonly target: {
    readonly spreadsheetIdSha256: string;
    readonly range: string;
  };
  readonly rows: SpreadsheetRows;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.values(value as Record<string, unknown>).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
}

function assertExactKeys(value: Record<string, unknown>, keys: readonly string[], label: string) {
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) {
    throw new Error(`${label} contains missing or unsupported fields.`);
  }
}

function requireText(value: unknown, label: string, maximum: number) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required.`);
  const text = value.trim();
  if (text.length > maximum || /[\u0000-\u001f\u007f]/.test(text)) throw new Error(`${label} is invalid.`);
  return text;
}

export async function createGoogleSheetsWorkspaceSnapshot(snapshot: SpreadsheetSnapshot): Promise<GoogleSheetsWorkspaceSnapshot> {
  const spreadsheetId = requireText(snapshot.spreadsheetId, "Google Sheets spreadsheet ID", 256);
  const range = requireText(snapshot.range, "Google Sheets range", 256);
  const rows = validateSpreadsheetRows(snapshot.values).map((row) => [...row]);
  rows.forEach(Object.freeze);
  Object.freeze(rows);
  return deepFreeze({
    schema: GOOGLE_SHEETS_WORKSPACE_SNAPSHOT_SCHEMA,
    connector: { id: GOOGLE_SHEETS_MANIFEST.id, version: GOOGLE_SHEETS_MANIFEST.version },
    target: {
      spreadsheetIdSha256: await hashWorkspaceContent(spreadsheetId),
      range
    },
    rows
  });
}

export function serializeGoogleSheetsWorkspaceSnapshot(snapshot: GoogleSheetsWorkspaceSnapshot) {
  return `${JSON.stringify(parseGoogleSheetsWorkspaceSnapshot(snapshot), null, 2)}\n`;
}

export function parseGoogleSheetsWorkspaceSnapshot(value: unknown): GoogleSheetsWorkspaceSnapshot {
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { throw new Error("Google Sheets workspace snapshot contains invalid JSON."); }
  }
  assertRecord(value, "Google Sheets workspace snapshot");
  assertExactKeys(value, ["schema", "connector", "target", "rows"], "Google Sheets workspace snapshot");
  if (value.schema !== GOOGLE_SHEETS_WORKSPACE_SNAPSHOT_SCHEMA) throw new Error("Google Sheets workspace snapshot schema is unsupported.");
  assertRecord(value.connector, "Google Sheets workspace connector");
  assertExactKeys(value.connector, ["id", "version"], "Google Sheets workspace connector");
  if (value.connector.id !== GOOGLE_SHEETS_MANIFEST.id || value.connector.version !== GOOGLE_SHEETS_MANIFEST.version) {
    throw new Error("Google Sheets workspace snapshot connector is unsupported.");
  }
  assertRecord(value.target, "Google Sheets workspace target");
  assertExactKeys(value.target, ["spreadsheetIdSha256", "range"], "Google Sheets workspace target");
  if (typeof value.target.spreadsheetIdSha256 !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value.target.spreadsheetIdSha256)) {
    throw new Error("Google Sheets workspace target hash is invalid.");
  }
  const range = requireText(value.target.range, "Google Sheets workspace range", 256);
  const rows = validateSpreadsheetRows(value.rows).map((row) => [...row]);
  rows.forEach(Object.freeze);
  Object.freeze(rows);
  return deepFreeze({
    schema: GOOGLE_SHEETS_WORKSPACE_SNAPSHOT_SCHEMA,
    connector: { id: GOOGLE_SHEETS_MANIFEST.id, version: GOOGLE_SHEETS_MANIFEST.version },
    target: { spreadsheetIdSha256: value.target.spreadsheetIdSha256, range },
    rows
  });
}

export async function googleSheetsWorkspaceSnapshotArtifact(snapshot: SpreadsheetSnapshot) {
  const value = await createGoogleSheetsWorkspaceSnapshot(snapshot);
  const content = serializeGoogleSheetsWorkspaceSnapshot(value);
  const sha256 = await hashWorkspaceContent(content);
  const bytes = new TextEncoder().encode(content).byteLength;
  if (bytes > GOOGLE_SHEETS_WORKSPACE_SNAPSHOT_LIMITS.bytes) {
    throw new Error("Google Sheets workspace snapshot exceeds the 512 KB artifact limit.");
  }
  return deepFreeze({
    path: `inputs/google-sheets-${sha256.slice(-12)}.json`,
    mediaType: "application/json" as const,
    bytes,
    sha256,
    tabularSnapshot: false as const,
    content,
    snapshot: value
  });
}
