/**
 * Google Workspace agent tools over direct googleapis.com REST calls.
 *
 * Scope discipline: every tool here works under ONLY the non-sensitive
 * `https://www.googleapis.com/auth/drive.file` scope — files WasmHatch
 * creates, plus reading and updating those files. There is deliberately no
 * whole-Drive listing or search and no opening of arbitrary user files by
 * URL or ID; those need Sensitive scopes that unlock only after Google's
 * verification clears. Advertise the boundary, never discover it.
 *
 * The access token is supplied per call by a GoogleTokenAccessor, travels
 * only in the Authorization header, and never appears in tool results,
 * errors, or logs.
 */

import type { AgentToolDefinition, AgentToolExecutor, AgentToolOutcome } from "./agent-core/types";

export type GoogleTokenAccessor = (signal?: AbortSignal) => Promise<string>;

const DRIVE_FILES_URL = "https://www.googleapis.com/drive/v3/files";
const SHEETS_BASE_URL = "https://sheets.googleapis.com/v4/spreadsheets";
const DOCS_BASE_URL = "https://docs.googleapis.com/v1/documents";

const TITLE_MAX_LENGTH = 512;
const TEXT_MAX_LENGTH = 100_000;
const RANGE_MAX_LENGTH = 256;
const MAX_VALUE_ROWS = 1_000;
const MAX_VALUE_CELLS = 10_000;
const CELL_MAX_LENGTH = 4_000;
const FILE_ID_PATTERN = /^[A-Za-z0-9_-]{10,256}$/;
const DEFAULT_READ_RANGE = "A1:Z1000";

export const GOOGLE_CONNECTOR_TOOLS: readonly AgentToolDefinition[] = [
  {
    name: "create_google_doc",
    description:
      "Create a new Google Doc in the user's Drive (drive.file scope: WasmHatch can only touch files it " +
      "created). Optionally insert initial text. Returns the document id and link.",
    inputSchema: {
      type: "object",
      properties: { title: { type: "string" }, text: { type: "string" } },
      required: ["title"],
      additionalProperties: false
    }
  },
  {
    name: "create_google_sheet",
    description:
      "Create a new Google Sheet in the user's Drive. Optionally write initial rows starting at A1. " +
      "Returns the spreadsheet id and link.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        rows: { type: "array", items: { type: "array", items: { type: "string" } } }
      },
      required: ["title"],
      additionalProperties: false
    }
  },
  {
    name: "create_google_slides",
    description: "Create a new Google Slides presentation in the user's Drive. Returns the presentation id and link.",
    inputSchema: {
      type: "object",
      properties: { title: { type: "string" } },
      required: ["title"],
      additionalProperties: false
    }
  },
  {
    name: "read_google_sheet_values",
    description:
      "Read cell values from a spreadsheet WasmHatch created this session (drive.file scope). " +
      "Range uses A1 notation; defaults to A1:Z1000.",
    inputSchema: {
      type: "object",
      properties: { spreadsheetId: { type: "string" }, range: { type: "string" } },
      required: ["spreadsheetId"],
      additionalProperties: false
    }
  },
  {
    name: "update_google_sheet_values",
    description:
      "Overwrite a cell range in a spreadsheet WasmHatch created. Values are written RAW, exactly as given.",
    inputSchema: {
      type: "object",
      properties: {
        spreadsheetId: { type: "string" },
        range: { type: "string" },
        values: { type: "array", items: { type: "array", items: { type: "string" } } }
      },
      required: ["spreadsheetId", "range", "values"],
      additionalProperties: false
    }
  },
  {
    name: "append_google_doc_text",
    description: "Append text to the end of a Google Doc WasmHatch created.",
    inputSchema: {
      type: "object",
      properties: { documentId: { type: "string" }, text: { type: "string" } },
      required: ["documentId", "text"],
      additionalProperties: false
    }
  }
];

function ok(payload: unknown): AgentToolOutcome {
  return { content: JSON.stringify(payload) };
}

function fail(content: string): AgentToolOutcome {
  return { content, isError: true };
}

function invalid(message: string): never {
  throw new ArgumentError(message);
}

class ArgumentError extends Error {}

function requireTitle(args: Record<string, unknown>): string {
  const title = typeof args.title === "string" ? args.title.trim() : "";
  if (!title) invalid("title must be a non-empty string.");
  if (title.length > TITLE_MAX_LENGTH) invalid(`title exceeds the ${TITLE_MAX_LENGTH}-character limit.`);
  return title;
}

function requireFileId(args: Record<string, unknown>, field: string): string {
  const value = typeof args[field] === "string" ? (args[field] as string).trim() : "";
  if (!FILE_ID_PATTERN.test(value)) invalid(`${field} must be a valid Google file ID.`);
  return value;
}

function optionalText(args: Record<string, unknown>, field: string): string | undefined {
  const value = args[field];
  if (value === undefined) return undefined;
  if (typeof value !== "string") invalid(`${field} must be a string.`);
  if ((value as string).length > TEXT_MAX_LENGTH) invalid(`${field} exceeds the ${TEXT_MAX_LENGTH.toLocaleString()}-character limit.`);
  return value as string;
}

function requireRange(args: Record<string, unknown>, fallback?: string): string {
  const value = args.range === undefined && fallback !== undefined ? fallback : args.range;
  if (typeof value !== "string" || !value.trim()) invalid("range must be a non-empty A1-notation string.");
  const range = (value as string).trim();
  if (range.length > RANGE_MAX_LENGTH || /[\u0000-\u001f\u007f]/.test(range)) invalid("range is not a valid A1-notation string.");
  return range;
}

function requireValues(args: Record<string, unknown>, field: string, options: { optional?: boolean } = {}): string[][] | undefined {
  const value = args[field];
  if (value === undefined) {
    if (options.optional) return undefined;
    invalid(`${field} is required.`);
  }
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_VALUE_ROWS) {
    invalid(`${field} must be 1 to ${MAX_VALUE_ROWS.toLocaleString()} rows.`);
  }
  let cells = 0;
  const rows = (value as unknown[]).map((row) => {
    if (!Array.isArray(row)) invalid(`${field} must be an array of rows (arrays of strings).`);
    return (row as unknown[]).map((cell) => {
      if (typeof cell !== "string") invalid(`${field} cells must be strings.`);
      if ((cell as string).length > CELL_MAX_LENGTH) invalid(`${field} cells are limited to ${CELL_MAX_LENGTH.toLocaleString()} characters.`);
      cells += 1;
      return cell as string;
    });
  });
  if (cells > MAX_VALUE_CELLS) invalid(`${field} exceeds the ${MAX_VALUE_CELLS.toLocaleString()}-cell limit.`);
  return rows;
}

async function readApiErrorDetail(response: Response): Promise<string> {
  try {
    const body = await response.json() as { error?: { message?: unknown } };
    if (typeof body.error?.message === "string") {
      return `: ${body.error.message.replace(/\s+/g, " ").slice(0, 200)}`;
    }
  } catch { /* The status alone is enough when the body is not JSON. */ }
  return "";
}

async function httpFailure(response: Response): Promise<AgentToolOutcome> {
  if (response.status === 401) return fail("Google authorization expired or is missing. Reconnect Google and retry.");
  if (response.status === 403) {
    return fail(`Google denied this request (insufficient scope or permission)${await readApiErrorDetail(response)}`);
  }
  if (response.status === 404) {
    return fail(
      "That Google file was not found or WasmHatch does not have access to it " +
      "(drive.file only covers files WasmHatch created)."
    );
  }
  if (response.status === 429) return fail("Google rate limit reached. Wait briefly and retry.");
  if (response.status >= 500) return fail(`Google is temporarily unavailable (${response.status}). Retry shortly.`);
  return fail(`Google request failed (${response.status})${await readApiErrorDetail(response)}`);
}

interface GoogleRequestContext {
  getToken: GoogleTokenAccessor;
  fetchImpl: typeof fetch;
  signal?: AbortSignal;
}

async function googleFetch(
  context: GoogleRequestContext,
  url: string,
  init: { method: string; body?: unknown }
): Promise<Response> {
  if (context.signal?.aborted) throw new DOMException("Aborted", "AbortError");
  const token = await context.getToken(context.signal);
  return context.fetchImpl(url, {
    method: init.method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.body === undefined ? {} : { "content-type": "application/json" })
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: context.signal,
    cache: "no-store",
    credentials: "omit"
  });
}

interface CreatedFile {
  id: string;
  name: string;
  webViewLink: string | null;
}

async function createDriveFile(context: GoogleRequestContext, title: string, mimeType: string): Promise<CreatedFile | AgentToolOutcome> {
  const response = await googleFetch(context, `${DRIVE_FILES_URL}?fields=id,name,webViewLink`, {
    method: "POST",
    body: { name: title, mimeType }
  });
  if (!response.ok) return httpFailure(response);
  const body = await response.json() as { id?: unknown; name?: unknown; webViewLink?: unknown };
  if (typeof body.id !== "string" || !body.id) return fail("Google returned an invalid file-creation response.");
  return {
    id: body.id,
    name: typeof body.name === "string" ? body.name : title,
    webViewLink: typeof body.webViewLink === "string" ? body.webViewLink : null
  };
}

function isOutcome(value: CreatedFile | AgentToolOutcome): value is AgentToolOutcome {
  return "content" in value;
}

async function docEndIndex(context: GoogleRequestContext, documentId: string): Promise<number | AgentToolOutcome> {
  const response = await googleFetch(context, `${DOCS_BASE_URL}/${documentId}?fields=body(content(endIndex))`, { method: "GET" });
  if (!response.ok) return httpFailure(response);
  const body = await response.json() as { body?: { content?: Array<{ endIndex?: unknown }> } };
  const indexes = (body.body?.content ?? [])
    .map((element) => element.endIndex)
    .filter((value): value is number => typeof value === "number" && Number.isSafeInteger(value));
  // A document body always ends with a final newline that cannot be inserted
  // after, so append happens just before the last end index.
  const end = indexes.length ? Math.max(...indexes) : 1;
  return Math.max(1, end - 1);
}

export function createGoogleConnectorExecutor(
  getToken: GoogleTokenAccessor,
  options: { fetchImpl?: typeof fetch } = {}
): AgentToolExecutor {
  const fetchImpl = options.fetchImpl ?? fetch;

  return async (name, args, { signal }) => {
    const context: GoogleRequestContext = { getToken, fetchImpl, signal };
    try {
      if (name === "create_google_doc") {
        const title = requireTitle(args);
        const text = optionalText(args, "text");
        const created = await createDriveFile(context, title, "application/vnd.google-apps.document");
        if (isOutcome(created)) return created;
        if (text?.length) {
          const update = await googleFetch(context, `${DOCS_BASE_URL}/${created.id}:batchUpdate`, {
            method: "POST",
            body: { requests: [{ insertText: { location: { index: 1 }, text } }] }
          });
          if (!update.ok) return httpFailure(update);
        }
        return ok(created);
      }

      if (name === "create_google_sheet") {
        const title = requireTitle(args);
        const rows = requireValues(args, "rows", { optional: true });
        const created = await createDriveFile(context, title, "application/vnd.google-apps.spreadsheet");
        if (isOutcome(created)) return created;
        if (rows?.length) {
          const append = await googleFetch(
            context,
            `${SHEETS_BASE_URL}/${created.id}/values/${encodeURIComponent("A1")}:append?valueInputOption=RAW`,
            { method: "POST", body: { values: rows } }
          );
          if (!append.ok) return httpFailure(append);
        }
        return ok(created);
      }

      if (name === "create_google_slides") {
        const title = requireTitle(args);
        const created = await createDriveFile(context, title, "application/vnd.google-apps.presentation");
        return isOutcome(created) ? created : ok(created);
      }

      if (name === "read_google_sheet_values") {
        const spreadsheetId = requireFileId(args, "spreadsheetId");
        const range = requireRange(args, DEFAULT_READ_RANGE);
        const response = await googleFetch(
          context,
          `${SHEETS_BASE_URL}/${spreadsheetId}/values/${encodeURIComponent(range)}`,
          { method: "GET" }
        );
        if (!response.ok) return httpFailure(response);
        const body = await response.json() as { range?: unknown; values?: unknown };
        return ok({
          range: typeof body.range === "string" ? body.range : range,
          values: Array.isArray(body.values) ? body.values : []
        });
      }

      if (name === "update_google_sheet_values") {
        const spreadsheetId = requireFileId(args, "spreadsheetId");
        const range = requireRange(args);
        const values = requireValues(args, "values")!;
        const response = await googleFetch(
          context,
          `${SHEETS_BASE_URL}/${spreadsheetId}/values/${encodeURIComponent(range)}?valueInputOption=RAW`,
          { method: "PUT", body: { range, values, majorDimension: "ROWS" } }
        );
        if (!response.ok) return httpFailure(response);
        const body = await response.json() as { updatedCells?: unknown };
        return ok({ updatedCells: typeof body.updatedCells === "number" ? body.updatedCells : 0 });
      }

      if (name === "append_google_doc_text") {
        const documentId = requireFileId(args, "documentId");
        const text = optionalText(args, "text");
        if (!text?.length) return fail("text must be a non-empty string.");
        const end = await docEndIndex(context, documentId);
        if (typeof end !== "number") return end;
        const update = await googleFetch(context, `${DOCS_BASE_URL}/${documentId}:batchUpdate`, {
          method: "POST",
          body: { requests: [{ insertText: { location: { index: end }, text } }] }
        });
        if (!update.ok) return httpFailure(update);
        return ok({ documentId });
      }

      return fail(`Unknown tool: ${name}`);
    } catch (error) {
      if (error instanceof ArgumentError) return fail(error.message);
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      // Auth-session errors (e.g. expired grant) carry safe, user-facing
      // messages; surface them so the model can ask the user to reconnect.
      if (error instanceof Error && error.name === "GoogleOAuthReauthorizationRequiredError") {
        return fail(error.message);
      }
      return fail("Google request failed before completion. Check the connection and retry.");
    }
  };
}
