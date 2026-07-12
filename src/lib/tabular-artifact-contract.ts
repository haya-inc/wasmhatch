import type { SpreadsheetRows } from "./spreadsheet";

export const TABULAR_ARTIFACT_LIMITS = Object.freeze({
  sourceBytes: 8 * 1024 * 1024,
  expandedBytes: 32 * 1024 * 1024,
  entryBytes: 16 * 1024 * 1024,
  entries: 512,
  sheets: 64,
  rows: 5_000,
  columns: 200,
  cells: 200_000,
  cellCharacters: 32_767,
  sharedStrings: 200_000
});

export type TabularArtifactFormat = "csv" | "xlsx";

export interface TabularSheetInfo {
  name: string;
  visibility: "visible" | "hidden" | "veryHidden";
}

export interface TabularArtifactProvenance {
  sourceName: string;
  mediaType: string;
  sourceBytes: number;
  sourceSha256: string;
  format: TabularArtifactFormat;
  sheetName: string;
  sheets: readonly TabularSheetInfo[];
  hiddenSheets: number;
  rows: number;
  columns: number;
  cells: number;
  formulaCells: number;
  externalLinks: number;
  warnings: readonly string[];
}

export interface TabularArtifactSnapshot {
  rows: SpreadsheetRows;
  provenance: TabularArtifactProvenance;
}

export interface TabularArtifactInput {
  name: string;
  mediaType?: string;
  bytes: Uint8Array;
  sheetName?: string;
}

export interface TabularArtifactExport {
  bytes: Uint8Array;
  fileName: string;
  mediaType: string;
  format: TabularArtifactFormat;
  neutralizedFormulaCells: number;
}
