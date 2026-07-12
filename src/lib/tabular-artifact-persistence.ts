import { validateSpreadsheetRows } from "./spreadsheet";
import {
  TABULAR_ARTIFACT_LIMITS,
  type TabularArtifactProvenance,
  type TabularArtifactSnapshot,
  type TabularSheetInfo
} from "./tabular-artifact-contract";

function safePathPart(value: string) {
  const stem = value.replace(/\.(csv|xlsx)$/i, "").trim().replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "");
  return (stem || "wasmhatch-artifact").slice(0, 120);
}

export function normalizedArtifactJson(snapshot: TabularArtifactSnapshot) {
  return `${JSON.stringify({
    schema: "wasmhatch.tabular-snapshot.v1",
    provenance: snapshot.provenance,
    rows: snapshot.rows
  }, null, 2)}\n`;
}

export function normalizedArtifactPath(snapshot: TabularArtifactSnapshot) {
  const stem = safePathPart(snapshot.provenance.sourceName);
  const sheet = safePathPart(snapshot.provenance.sheetName);
  return `inputs/${stem}--${sheet}--${snapshot.provenance.sourceSha256.slice(0, 12)}.json`;
}

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
}

function assertExactKeys(value: Record<string, unknown>, keys: readonly string[], label: string) {
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) {
    throw new Error(`${label} contains missing or unsupported fields.`);
  }
}

function requireString(value: unknown, label: string, maximum: number) {
  if (typeof value !== "string") throw new Error(`${label} must be a string.`);
  const text = value.trim();
  if (!text || text.length > maximum || /[\u0000-\u001f\u007f]/.test(text)) throw new Error(`${label} is invalid.`);
  return text;
}

function requireInteger(value: unknown, label: string, minimum: number, maximum: number) {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${label} is outside its supported range.`);
  }
  return value as number;
}

function parseSheets(value: unknown): readonly TabularSheetInfo[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > TABULAR_ARTIFACT_LIMITS.sheets) {
    throw new Error("Normalized artifact sheet metadata is invalid.");
  }
  const names = new Set<string>();
  return value.map((item, index) => {
    assertRecord(item, `Normalized artifact sheet ${index + 1}`);
    assertExactKeys(item, ["name", "visibility"], `Normalized artifact sheet ${index + 1}`);
    const name = requireString(item.name, `Normalized artifact sheet ${index + 1} name`, 255);
    if (names.has(name)) throw new Error("Normalized artifact sheet names contain duplicates.");
    names.add(name);
    if (item.visibility !== "visible" && item.visibility !== "hidden" && item.visibility !== "veryHidden") {
      throw new Error(`Normalized artifact sheet ${index + 1} visibility is invalid.`);
    }
    return Object.freeze({ name, visibility: item.visibility });
  });
}

function parseProvenance(value: unknown, rows: TabularArtifactSnapshot["rows"]): TabularArtifactProvenance {
  assertRecord(value, "Normalized artifact provenance");
  assertExactKeys(value, [
    "sourceName", "mediaType", "sourceBytes", "sourceSha256", "format", "sheetName", "sheets",
    "hiddenSheets", "rows", "columns", "cells", "formulaCells", "externalLinks", "warnings"
  ], "Normalized artifact provenance");
  const sourceName = requireString(value.sourceName, "Normalized artifact source name", 255);
  const mediaType = requireString(value.mediaType, "Normalized artifact media type", 255);
  const sourceBytes = requireInteger(value.sourceBytes, "Normalized artifact source bytes", 1, TABULAR_ARTIFACT_LIMITS.sourceBytes);
  if (typeof value.sourceSha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.sourceSha256)) {
    throw new Error("Normalized artifact source hash is invalid.");
  }
  if (value.format !== "csv" && value.format !== "xlsx") throw new Error("Normalized artifact format is invalid.");
  const sheetName = requireString(value.sheetName, "Normalized artifact active sheet", 255);
  const sheets = parseSheets(value.sheets);
  if (!sheets.some((sheet) => sheet.name === sheetName && sheet.visibility === "visible")) {
    throw new Error("Normalized artifact active sheet is not visible in its sheet metadata.");
  }
  const dimensions = {
    rows: rows.length,
    columns: rows.reduce((maximum, row) => Math.max(maximum, row.length), 0),
    cells: rows.reduce((total, row) => total + row.length, 0)
  };
  if (dimensions.cells > TABULAR_ARTIFACT_LIMITS.cells) throw new Error("Normalized artifact exceeds the cell limit.");
  for (const row of rows) {
    for (const cell of row) {
      if (typeof cell === "string" && cell.length > TABULAR_ARTIFACT_LIMITS.cellCharacters) {
        throw new Error("Normalized artifact contains an oversized cell.");
      }
    }
  }
  if (
    requireInteger(value.rows, "Normalized artifact rows", 0, TABULAR_ARTIFACT_LIMITS.rows) !== dimensions.rows ||
    requireInteger(value.columns, "Normalized artifact columns", 0, TABULAR_ARTIFACT_LIMITS.columns) !== dimensions.columns ||
    requireInteger(value.cells, "Normalized artifact cells", 0, TABULAR_ARTIFACT_LIMITS.cells) !== dimensions.cells
  ) throw new Error("Normalized artifact dimensions do not match its rows.");
  const hiddenSheets = requireInteger(value.hiddenSheets, "Normalized artifact hidden sheet count", 0, TABULAR_ARTIFACT_LIMITS.sheets);
  const formulaCells = requireInteger(value.formulaCells, "Normalized artifact formula cell count", 0, dimensions.cells);
  const externalLinks = requireInteger(value.externalLinks, "Normalized artifact external link count", 0, TABULAR_ARTIFACT_LIMITS.entries);
  if (!Array.isArray(value.warnings) || value.warnings.length > 128) throw new Error("Normalized artifact warnings are invalid.");
  const warnings = value.warnings.map((warning, index) => requireString(warning, `Normalized artifact warning ${index + 1}`, 1_024));
  return Object.freeze({
    sourceName,
    mediaType,
    sourceBytes,
    sourceSha256: value.sourceSha256,
    format: value.format,
    sheetName,
    sheets: Object.freeze(sheets),
    hiddenSheets,
    rows: dimensions.rows,
    columns: dimensions.columns,
    cells: dimensions.cells,
    formulaCells,
    externalLinks,
    warnings: Object.freeze(warnings)
  });
}

export function parseNormalizedArtifactJson(content: string): TabularArtifactSnapshot {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw new Error("Normalized artifact contains invalid JSON.");
  }
  assertRecord(value, "Normalized artifact");
  assertExactKeys(value, ["schema", "provenance", "rows"], "Normalized artifact");
  if (value.schema !== "wasmhatch.tabular-snapshot.v1") throw new Error("Normalized artifact schema is unsupported.");
  const rows = validateSpreadsheetRows(value.rows).map((row) => [...row]);
  rows.forEach(Object.freeze);
  Object.freeze(rows);
  const provenance = parseProvenance(value.provenance, rows);
  return Object.freeze({ rows, provenance });
}
