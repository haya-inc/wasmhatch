import { strToU8, unzipSync, zipSync } from "fflate";
import { SaxesParser, type SaxesTagNS } from "saxes";
import { validateSpreadsheetRows, type SpreadsheetCell, type SpreadsheetRows } from "./spreadsheet";
import {
  TABULAR_ARTIFACT_LIMITS,
  type TabularArtifactExport,
  type TabularArtifactFormat,
  type TabularArtifactInput,
  type TabularArtifactSnapshot,
  type TabularSheetInfo
} from "./tabular-artifact-contract";

export { TABULAR_ARTIFACT_LIMITS } from "./tabular-artifact-contract";
export type {
  TabularArtifactExport,
  TabularArtifactFormat,
  TabularArtifactInput,
  TabularArtifactProvenance,
  TabularArtifactSnapshot,
  TabularSheetInfo
} from "./tabular-artifact-contract";

const CSV_MEDIA_TYPE = "text/csv;charset=utf-8";
const XLSX_MEDIA_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const FORMULA_PREFIX = /^[\t ]*[=+\-@]/;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

class TabularArtifactSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TabularArtifactSafetyError";
  }
}

function requireSourceName(value: string) {
  const name = value.trim();
  if (!name || name.length > 255 || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new TabularArtifactSafetyError("The source filename is missing or unsafe.");
  }
  return name;
}

function detectFormat(name: string, mediaType: string, bytes: Uint8Array): TabularArtifactFormat {
  const lowerName = name.toLowerCase();
  const normalizedType = mediaType.split(";", 1)[0].trim().toLowerCase();
  const looksLikeZip = bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b &&
    ((bytes[2] === 0x03 && bytes[3] === 0x04) || (bytes[2] === 0x05 && bytes[3] === 0x06));

  if (lowerName.endsWith(".xlsx") || normalizedType === XLSX_MEDIA_TYPE) {
    if (!looksLikeZip) throw new TabularArtifactSafetyError("The XLSX file is not a valid ZIP-based workbook.");
    return "xlsx";
  }
  if (lowerName.endsWith(".csv") || normalizedType === "text/csv" || normalizedType === "application/csv") {
    if (looksLikeZip) throw new TabularArtifactSafetyError("The CSV file contains ZIP data.");
    return "csv";
  }
  throw new TabularArtifactSafetyError("Choose a .csv or .xlsx file.");
}

function assertSourceSize(bytes: Uint8Array) {
  if (!bytes.byteLength) throw new TabularArtifactSafetyError("The selected file is empty.");
  if (bytes.byteLength > TABULAR_ARTIFACT_LIMITS.sourceBytes) {
    throw new TabularArtifactSafetyError("The selected file exceeds the 8 MB compressed input limit.");
  }
}

function spreadsheetDimensions(rows: SpreadsheetRows) {
  const columns = rows.reduce((maximum, row) => Math.max(maximum, row.length), 0);
  const cells = rows.reduce((total, row) => total + row.length, 0);
  return { rows: rows.length, columns, cells };
}

function assertCellText(value: string) {
  if (value.length > TABULAR_ARTIFACT_LIMITS.cellCharacters) {
    throw new TabularArtifactSafetyError("A cell exceeds the 32,767 character limit.");
  }
  return value;
}

function assertTableBounds(rows: SpreadsheetRows) {
  const dimensions = spreadsheetDimensions(rows);
  if (dimensions.rows > TABULAR_ARTIFACT_LIMITS.rows) {
    throw new TabularArtifactSafetyError("The table exceeds 5,000 rows.");
  }
  if (dimensions.columns > TABULAR_ARTIFACT_LIMITS.columns) {
    throw new TabularArtifactSafetyError("The table exceeds 200 columns.");
  }
  if (dimensions.cells > TABULAR_ARTIFACT_LIMITS.cells) {
    throw new TabularArtifactSafetyError("The table exceeds 200,000 cells.");
  }
  return dimensions;
}

function parseCsv(bytes: Uint8Array) {
  let source: string;
  try {
    source = UTF8_DECODER.decode(bytes);
  } catch {
    throw new TabularArtifactSafetyError("CSV must be valid UTF-8 text.");
  }
  if (source.charCodeAt(0) === 0xfeff) source = source.slice(1);
  if (source.includes("\0")) throw new TabularArtifactSafetyError("CSV contains a NUL byte.");

  const rows: SpreadsheetRows = [];
  let row: SpreadsheetCell[] = [];
  let field = "";
  let inQuotes = false;
  let afterQuote = false;
  let fieldStarted = false;
  let formulaCells = 0;
  let cellCount = 0;

  const pushField = () => {
    const value = assertCellText(field);
    if (FORMULA_PREFIX.test(value)) formulaCells += 1;
    row.push(value);
    cellCount += 1;
    if (row.length > TABULAR_ARTIFACT_LIMITS.columns) {
      throw new TabularArtifactSafetyError("CSV exceeds 200 columns.");
    }
    if (cellCount > TABULAR_ARTIFACT_LIMITS.cells) {
      throw new TabularArtifactSafetyError("CSV exceeds 200,000 cells.");
    }
    field = "";
    fieldStarted = false;
    afterQuote = false;
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
    if (rows.length > TABULAR_ARTIFACT_LIMITS.rows) {
      throw new TabularArtifactSafetyError("CSV exceeds 5,000 rows.");
    }
    row = [];
  };

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (inQuotes) {
      if (character === '"') {
        if (source[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
          afterQuote = true;
        }
      } else {
        field += character;
      }
      continue;
    }
    if (afterQuote && character !== "," && character !== "\r" && character !== "\n") {
      throw new TabularArtifactSafetyError("CSV has characters after a closing quote.");
    }
    if (character === '"') {
      if (fieldStarted || field) throw new TabularArtifactSafetyError("CSV has a quote inside an unquoted field.");
      inQuotes = true;
      fieldStarted = true;
    } else if (character === ",") {
      pushField();
    } else if (character === "\r" || character === "\n") {
      if (character === "\r" && source[index + 1] === "\n") index += 1;
      pushRow();
    } else {
      field += character;
      fieldStarted = true;
    }
  }
  if (inQuotes) throw new TabularArtifactSafetyError("CSV ends inside a quoted field.");
  if (row.length || field.length || fieldStarted || !rows.length) pushRow();

  return { rows: validateSpreadsheetRows(rows), formulaCells };
}

function normalizeZipPath(input: string) {
  const path = input.replaceAll("\\", "/").replace(/^\/+/, "");
  const parts = path.split("/");
  if (!path || input.includes("\0") || parts.some((part) => !part || part === "." || part === "..")) {
    throw new TabularArtifactSafetyError("XLSX contains an unsafe ZIP path.");
  }
  return parts.join("/");
}

interface XlsxEntries {
  files: Map<string, Uint8Array>;
  externalLinks: number;
}

function readXlsxEntries(bytes: Uint8Array): XlsxEntries {
  let entries = 0;
  let expandedBytes = 0;
  let externalLinks = 0;
  let hasMacro = false;
  const canonicalPaths = new Set<string>();
  let unzipped: Record<string, Uint8Array>;
  try {
    unzipped = unzipSync(bytes, {
      filter: (entry) => {
        entries += 1;
        if (entries > TABULAR_ARTIFACT_LIMITS.entries) {
          throw new TabularArtifactSafetyError("XLSX contains more than 512 ZIP entries.");
        }
        const isDirectory = entry.name.endsWith("/");
        const path = normalizeZipPath(isDirectory ? entry.name.slice(0, -1) : entry.name);
        if (isDirectory) return false;
        const canonical = path.toLowerCase();
        if (canonicalPaths.has(canonical)) {
          throw new TabularArtifactSafetyError("XLSX contains duplicate or case-ambiguous ZIP paths.");
        }
        canonicalPaths.add(canonical);
        if (!Number.isSafeInteger(entry.originalSize) || entry.originalSize < 0) {
          throw new TabularArtifactSafetyError("XLSX contains an invalid ZIP entry size.");
        }
        if (entry.originalSize > TABULAR_ARTIFACT_LIMITS.entryBytes) {
          throw new TabularArtifactSafetyError("An XLSX entry exceeds the 16 MB limit.");
        }
        expandedBytes += entry.originalSize;
        if (expandedBytes > TABULAR_ARTIFACT_LIMITS.expandedBytes) {
          throw new TabularArtifactSafetyError("XLSX expands beyond the 32 MB limit.");
        }
        if (/vbaProject\.bin$/i.test(path) || /(^|\/)macrosheets\//i.test(path)) hasMacro = true;
        if (/^xl\/externalLinks\//i.test(path)) externalLinks += 1;
        return /^(\[Content_Types\]\.xml|_rels\/\.rels|xl\/workbook\.xml|xl\/_rels\/workbook\.xml\.rels|xl\/sharedStrings\.xml|xl\/styles\.xml|xl\/worksheets\/[^/]+\.xml)$/i.test(path);
      }
    });
  } catch (error) {
    if (error instanceof TabularArtifactSafetyError) throw error;
    throw new TabularArtifactSafetyError("XLSX is not a valid or supported ZIP workbook.");
  }
  if (hasMacro) throw new TabularArtifactSafetyError("Macro-enabled workbook content is not accepted.");
  const files = new Map(Object.entries(unzipped).map(([path, contents]) => [normalizeZipPath(path).toLowerCase(), contents]));
  return { files, externalLinks };
}

function requireXml(files: Map<string, Uint8Array>, path: string) {
  const bytes = files.get(path.toLowerCase());
  if (!bytes) throw new TabularArtifactSafetyError(`XLSX is missing ${path}.`);
  try {
    return UTF8_DECODER.decode(bytes);
  } catch {
    throw new TabularArtifactSafetyError(`${path} is not valid UTF-8 XML.`);
  }
}

function attribute(tag: SaxesTagNS, localName: string) {
  for (const value of Object.values(tag.attributes)) {
    if (value.local === localName) return value.value;
  }
  return undefined;
}

function strictXmlParser() {
  const parser = new SaxesParser({ xmlns: true });
  parser.on("doctype", () => {
    throw new TabularArtifactSafetyError("XLSX XML document types are not accepted.");
  });
  parser.on("processinginstruction", () => {
    throw new TabularArtifactSafetyError("XLSX XML processing instructions are not accepted.");
  });
  parser.on("error", () => {
    throw new TabularArtifactSafetyError("XLSX contains malformed XML.");
  });
  return parser;
}

interface WorkbookSheet extends TabularSheetInfo {
  relationshipId: string;
}

function parseWorkbook(xml: string): WorkbookSheet[] {
  const sheets: WorkbookSheet[] = [];
  const names = new Set<string>();
  const parser = strictXmlParser();
  parser.on("opentag", (tag) => {
    if (tag.local !== "sheet") return;
    const name = attribute(tag, "name")?.trim() ?? "";
    const relationshipId = attribute(tag, "id") ?? "";
    const state = attribute(tag, "state") ?? "visible";
    if (!name || name.length > 31 || !relationshipId || !["visible", "hidden", "veryHidden"].includes(state)) {
      throw new TabularArtifactSafetyError("XLSX contains invalid worksheet metadata.");
    }
    const canonicalName = name.toLocaleLowerCase();
    if (names.has(canonicalName)) throw new TabularArtifactSafetyError("XLSX contains duplicate worksheet names.");
    names.add(canonicalName);
    sheets.push({ name, relationshipId, visibility: state as TabularSheetInfo["visibility"] });
    if (sheets.length > TABULAR_ARTIFACT_LIMITS.sheets) {
      throw new TabularArtifactSafetyError("XLSX contains more than 64 worksheets.");
    }
  });
  parser.write(xml).close();
  if (!sheets.length) throw new TabularArtifactSafetyError("XLSX contains no worksheets.");
  return sheets;
}

interface WorkbookRelationship {
  id: string;
  target: string;
  external: boolean;
  type: string;
}

function parseRelationships(xml: string): WorkbookRelationship[] {
  const relationships: WorkbookRelationship[] = [];
  const ids = new Set<string>();
  const parser = strictXmlParser();
  parser.on("opentag", (tag) => {
    if (tag.local !== "Relationship") return;
    const id = attribute(tag, "Id") ?? attribute(tag, "id") ?? "";
    const target = attribute(tag, "Target") ?? attribute(tag, "target") ?? "";
    const external = (attribute(tag, "TargetMode") ?? "").toLowerCase() === "external";
    const type = attribute(tag, "Type") ?? attribute(tag, "type") ?? "";
    if (!id || !target || ids.has(id)) throw new TabularArtifactSafetyError("XLSX contains invalid relationships.");
    ids.add(id);
    relationships.push({ id, target, external, type });
  });
  parser.write(xml).close();
  return relationships;
}

function assertNoMacroContentTypes(xml: string) {
  const parser = strictXmlParser();
  parser.on("opentag", (tag) => {
    if (tag.local !== "Default" && tag.local !== "Override") return;
    const contentType = attribute(tag, "ContentType") ?? attribute(tag, "contentType") ?? "";
    if (/macroenabled|vbaproject/i.test(contentType)) {
      throw new TabularArtifactSafetyError("Macro-enabled workbook content is not accepted.");
    }
  });
  parser.write(xml).close();
}

function resolveWorkbookTarget(target: string) {
  const decoded = target.replaceAll("\\", "/");
  if (/^[a-z][a-z0-9+.-]*:/i.test(decoded)) {
    throw new TabularArtifactSafetyError("XLSX worksheet relationships must stay inside the workbook.");
  }
  const combined = decoded.startsWith("/") ? decoded.slice(1) : `xl/${decoded}`;
  const output: string[] = [];
  for (const part of combined.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!output.length) throw new TabularArtifactSafetyError("XLSX relationship escapes the workbook.");
      output.pop();
    } else output.push(part);
  }
  const path = output.join("/");
  if (!/^xl\/worksheets\/[^/]+\.xml$/i.test(path)) {
    throw new TabularArtifactSafetyError("XLSX worksheet relationship points to an unsupported part.");
  }
  return path.toLowerCase();
}

function parseSharedStrings(xml: string | undefined) {
  if (!xml) return [] as string[];
  const strings: string[] = [];
  let inItem = false;
  let textDepth = 0;
  let current = "";
  const parser = strictXmlParser();
  parser.on("opentag", (tag) => {
    if (tag.local === "si") {
      if (inItem) throw new TabularArtifactSafetyError("XLSX contains nested shared strings.");
      inItem = true;
      current = "";
    } else if (inItem && tag.local === "t") textDepth += 1;
  });
  parser.on("text", (text) => {
    if (inItem && textDepth) current += text;
  });
  parser.on("cdata", (text) => {
    if (inItem && textDepth) current += text;
  });
  parser.on("closetag", (tag) => {
    if (inItem && tag.local === "t") textDepth -= 1;
    if (tag.local === "si") {
      strings.push(assertCellText(current));
      if (strings.length > TABULAR_ARTIFACT_LIMITS.sharedStrings) {
        throw new TabularArtifactSafetyError("XLSX contains more than 200,000 shared strings.");
      }
      inItem = false;
      current = "";
    }
  });
  parser.write(xml).close();
  return strings;
}

function cellCoordinates(reference: string) {
  const match = reference.match(/^([A-Z]{1,3})([1-9][0-9]*)$/i);
  if (!match) throw new TabularArtifactSafetyError("XLSX contains an invalid cell reference.");
  let column = 0;
  for (const letter of match[1].toUpperCase()) column = column * 26 + letter.charCodeAt(0) - 64;
  const row = Number(match[2]);
  if (!Number.isSafeInteger(row) || row > TABULAR_ARTIFACT_LIMITS.rows || column > TABULAR_ARTIFACT_LIMITS.columns) {
    throw new TabularArtifactSafetyError("XLSX cell reference exceeds the 5,000 × 200 table limit.");
  }
  return { row: row - 1, column: column - 1 };
}

function parseNumber(raw: string) {
  if (!raw.trim()) return null;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new TabularArtifactSafetyError("XLSX contains a non-finite number.");
  return value;
}

function cellValue(type: string, raw: string, inline: string, sharedStrings: readonly string[]): SpreadsheetCell {
  if (type === "inlineStr") return assertCellText(inline);
  if (type === "s") {
    if (!/^(0|[1-9][0-9]*)$/.test(raw.trim())) throw new TabularArtifactSafetyError("XLSX shared string index is invalid.");
    const value = sharedStrings[Number(raw.trim())];
    if (value === undefined) throw new TabularArtifactSafetyError("XLSX references a missing shared string.");
    return value;
  }
  if (type === "b") {
    if (raw.trim() === "1") return true;
    if (raw.trim() === "0") return false;
    throw new TabularArtifactSafetyError("XLSX contains an invalid boolean value.");
  }
  if (type === "str" || type === "e" || type === "d") return assertCellText(raw);
  if (type === "n" || !type) return parseNumber(raw);
  throw new TabularArtifactSafetyError(`XLSX cell type ${type} is not supported.`);
}

function parseWorksheet(xml: string, sharedStrings: readonly string[]) {
  const rows: SpreadsheetRows = [];
  const seen = new Set<string>();
  let current: { reference: string; type: string; raw: string; inline: string; formula: boolean; hidden: boolean } | null = null;
  let valueDepth = 0;
  let inlineDepth = 0;
  let hiddenRow = false;
  const hiddenColumns: Array<readonly [number, number]> = [];
  let formulaCells = 0;
  let hiddenCells = 0;
  let cells = 0;
  const parser = strictXmlParser();
  parser.on("opentag", (tag) => {
    if (tag.local === "col" && ["1", "true"].includes((attribute(tag, "hidden") ?? "").toLowerCase())) {
      const minimum = Number(attribute(tag, "min"));
      const maximum = Number(attribute(tag, "max"));
      if (!Number.isSafeInteger(minimum) || !Number.isSafeInteger(maximum) || minimum < 1 || maximum < minimum || maximum > 16_384) {
        throw new TabularArtifactSafetyError("XLSX contains an invalid hidden-column range.");
      }
      hiddenColumns.push([minimum - 1, maximum - 1]);
    } else if (tag.local === "row") {
      hiddenRow = ["1", "true"].includes((attribute(tag, "hidden") ?? "").toLowerCase());
    } else if (tag.local === "c") {
      if (current) throw new TabularArtifactSafetyError("XLSX contains nested cells.");
      const reference = attribute(tag, "r") ?? "";
      const coordinates = cellCoordinates(reference);
      if (seen.has(reference.toUpperCase())) throw new TabularArtifactSafetyError("XLSX contains a duplicate cell.");
      seen.add(reference.toUpperCase());
      current = {
        reference,
        type: attribute(tag, "t") ?? "",
        raw: "",
        inline: "",
        formula: false,
        hidden: hiddenRow || hiddenColumns.some(([minimum, maximum]) => coordinates.column >= minimum && coordinates.column <= maximum)
      };
      cells += 1;
      if (cells > TABULAR_ARTIFACT_LIMITS.cells) {
        throw new TabularArtifactSafetyError("XLSX exceeds 200,000 cells.");
      }
    } else if (current && tag.local === "v") valueDepth += 1;
    else if (current && tag.local === "t") inlineDepth += 1;
    else if (current && tag.local === "f") {
      if (!current.formula) formulaCells += 1;
      current.formula = true;
    }
  });
  parser.on("text", (text) => {
    if (!current) return;
    if (valueDepth) current.raw += text;
    if (inlineDepth) current.inline += text;
  });
  parser.on("cdata", (text) => {
    if (current && inlineDepth) current.inline += text;
  });
  parser.on("closetag", (tag) => {
    if (tag.local === "row") {
      hiddenRow = false;
      return;
    }
    if (!current) return;
    if (tag.local === "v") valueDepth -= 1;
    else if (tag.local === "t") inlineDepth -= 1;
    else if (tag.local === "c") {
      const { row, column } = cellCoordinates(current.reference);
      if (current.hidden) hiddenCells += 1;
      else {
        rows[row] ??= [];
        while (rows[row].length < column) rows[row].push(null);
        rows[row][column] = cellValue(current.type, current.raw, current.inline, sharedStrings);
      }
      current = null;
      valueDepth = 0;
      inlineDepth = 0;
    }
  });
  parser.write(xml).close();
  for (let index = 0; index < rows.length; index += 1) rows[index] ??= [];
  for (const row of rows) {
    while (row.length && row[row.length - 1] === null) row.pop();
  }
  while (rows.length && !rows[rows.length - 1].length) rows.pop();
  return { rows: validateSpreadsheetRows(rows), formulaCells, hiddenCells };
}

function parseXlsx(bytes: Uint8Array, requestedSheetName?: string) {
  const { files, externalLinks: entryExternalLinks } = readXlsxEntries(bytes);
  assertNoMacroContentTypes(requireXml(files, "[Content_Types].xml"));
  const sheets = parseWorkbook(requireXml(files, "xl/workbook.xml"));
  const relationships = parseRelationships(requireXml(files, "xl/_rels/workbook.xml.rels"));
  if (relationships.some((relationship) => /vbaproject|macrosheet/i.test(relationship.type))) {
    throw new TabularArtifactSafetyError("Macro-enabled workbook content is not accepted.");
  }
  const relationshipMap = new Map(relationships.map((relationship) => [relationship.id, relationship]));
  const externalRelationships = relationships.filter((relationship) => relationship.external).length;
  const selected = requestedSheetName
    ? sheets.find((sheet) => sheet.name === requestedSheetName)
    : sheets.find((sheet) => sheet.visibility === "visible");
  if (!selected) throw new TabularArtifactSafetyError("The requested worksheet does not exist or no visible worksheet is available.");
  if (selected.visibility !== "visible") throw new TabularArtifactSafetyError("Hidden worksheets cannot be imported in P0.");
  const relationship = relationshipMap.get(selected.relationshipId);
  if (!relationship || relationship.external) {
    throw new TabularArtifactSafetyError("The selected worksheet relationship is missing or external.");
  }
  const worksheetPath = resolveWorkbookTarget(relationship.target);
  const sharedStringsBytes = files.get("xl/sharedstrings.xml");
  const sharedStrings = parseSharedStrings(sharedStringsBytes ? requireXml(files, "xl/sharedStrings.xml") : undefined);
  const table = parseWorksheet(requireXml(files, worksheetPath), sharedStrings);
  const warnings = ["Formatting, comments, charts, and merged-cell layout are not preserved."];
  if (table.formulaCells) warnings.push("Formula cells were not evaluated; only cached values were imported and may be stale.");
  const externalLinks = entryExternalLinks + externalRelationships;
  if (externalLinks) warnings.push("External workbook links were ignored.");
  const hiddenSheets = sheets.filter((sheet) => sheet.visibility !== "visible").length;
  if (hiddenSheets) warnings.push(`${hiddenSheets} hidden worksheet${hiddenSheets === 1 ? " was" : "s were"} excluded.`);
  if (table.hiddenCells) warnings.push(`${table.hiddenCells} cell${table.hiddenCells === 1 ? " was" : "s were"} excluded from hidden rows or columns.`);
  const visibleSheets = sheets.filter((sheet) => sheet.visibility === "visible");
  if (!requestedSheetName && visibleSheets.length > 1) {
    warnings.push(`Workbook has ${visibleSheets.length} visible worksheets; ${selected.name} was selected first.`);
  }
  return {
    ...table,
    sheets: visibleSheets.map(({ name, visibility }) => ({ name, visibility })),
    hiddenSheets,
    sheetName: selected.name,
    externalLinks,
    warnings
  };
}

async function sha256(bytes: Uint8Array) {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy.buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function freezeSnapshot(snapshot: TabularArtifactSnapshot): TabularArtifactSnapshot {
  for (const row of snapshot.rows) Object.freeze(row);
  Object.freeze(snapshot.rows);
  for (const sheet of snapshot.provenance.sheets) Object.freeze(sheet);
  Object.freeze(snapshot.provenance.sheets);
  Object.freeze(snapshot.provenance.warnings);
  Object.freeze(snapshot.provenance);
  return Object.freeze(snapshot);
}

export async function importTabularArtifact(input: TabularArtifactInput): Promise<TabularArtifactSnapshot> {
  const sourceName = requireSourceName(input.name);
  assertSourceSize(input.bytes);
  const mediaType = input.mediaType?.trim() || "application/octet-stream";
  const format = detectFormat(sourceName, mediaType, input.bytes);
  const parsed = format === "csv"
    ? {
        ...parseCsv(input.bytes),
        sheets: [{ name: "CSV", visibility: "visible" as const }],
        hiddenSheets: 0,
        sheetName: "CSV",
        externalLinks: 0,
        warnings: ["CSV fields are imported as literal strings; formatting and types are not inferred."]
      }
    : parseXlsx(input.bytes, input.sheetName);
  const dimensions = assertTableBounds(parsed.rows);
  const sourceSha256 = await sha256(input.bytes);
  return freezeSnapshot({
    rows: parsed.rows,
    provenance: {
      sourceName,
      mediaType,
      sourceBytes: input.bytes.byteLength,
      sourceSha256,
      format,
      sheetName: parsed.sheetName,
      sheets: parsed.sheets,
      hiddenSheets: parsed.hiddenSheets,
      ...dimensions,
      formulaCells: parsed.formulaCells,
      externalLinks: parsed.externalLinks,
      warnings: parsed.warnings
    }
  });
}

function csvField(value: SpreadsheetCell) {
  let text = value === null ? "" : typeof value === "boolean" ? (value ? "TRUE" : "FALSE") : String(value);
  let neutralized = false;
  if (typeof value === "string" && FORMULA_PREFIX.test(text)) {
    text = `'${text}`;
    neutralized = true;
  }
  const encoded = /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  return { encoded, neutralized };
}

function exportCsv(rows: SpreadsheetRows) {
  let neutralizedFormulaCells = 0;
  const lines = rows.map((row) => row.map((cell) => {
    const field = csvField(cell);
    if (field.neutralized) neutralizedFormulaCells += 1;
    return field.encoded;
  }).join(","));
  return {
    bytes: strToU8(`\ufeff${lines.join("\r\n")}\r\n`),
    neutralizedFormulaCells
  };
}

function xml(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function columnLabel(index: number) {
  let label = "";
  for (let value = index + 1; value > 0; value = Math.floor((value - 1) / 26)) {
    label = String.fromCharCode(65 + ((value - 1) % 26)) + label;
  }
  return label;
}

function xlsxCell(value: SpreadsheetCell, row: number, column: number) {
  if (value === null) return "";
  const reference = `${columnLabel(column)}${row + 1}`;
  if (typeof value === "number") return `<c r="${reference}" t="n"><v>${value}</v></c>`;
  if (typeof value === "boolean") return `<c r="${reference}" t="b"><v>${value ? 1 : 0}</v></c>`;
  return `<c r="${reference}" t="inlineStr"><is><t xml:space="preserve">${xml(value)}</t></is></c>`;
}

function exportXlsx(rows: SpreadsheetRows) {
  const sheetRows = rows.map((row, rowIndex) => {
    const cells = row.map((cell, columnIndex) => xlsxCell(cell, rowIndex, columnIndex)).join("");
    return `<row r="${rowIndex + 1}">${cells}</row>`;
  }).join("");
  const worksheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData></worksheet>`;
  if (strToU8(worksheet).byteLength > TABULAR_ARTIFACT_LIMITS.entryBytes) {
    throw new TabularArtifactSafetyError("The value-only XLSX worksheet exceeds the 16 MB expanded limit.");
  }
  const entries = {
    "[Content_Types].xml": strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>'),
    "_rels/.rels": strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'),
    "xl/workbook.xml": strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>'),
    "xl/_rels/workbook.xml.rels": strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'),
    "xl/worksheets/sheet1.xml": strToU8(worksheet)
  };
  return zipSync(entries, { level: 6 });
}

function safeExportName(value: string) {
  const stem = value.replace(/\.(csv|xlsx)$/i, "").trim().replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "");
  return (stem || "wasmhatch-output").slice(0, 120);
}

export function exportTabularArtifact(
  inputRows: SpreadsheetRows,
  format: TabularArtifactFormat,
  baseName = "wasmhatch-output"
): TabularArtifactExport {
  const rows = validateSpreadsheetRows(inputRows.map((row) => [...row]));
  assertTableBounds(rows);
  const fileStem = safeExportName(baseName);
  if (format === "csv") {
    const result = exportCsv(rows);
    return { ...result, fileName: `${fileStem}.csv`, mediaType: CSV_MEDIA_TYPE, format };
  }
  return {
    bytes: exportXlsx(rows),
    fileName: `${fileStem}.xlsx`,
    mediaType: XLSX_MEDIA_TYPE,
    format,
    neutralizedFormulaCells: 0
  };
}
