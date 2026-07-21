/**
 * Google Workspace agent tools over direct googleapis.com REST calls.
 *
 * Scope discipline: every tool here works under ONLY the non-sensitive
 * `https://www.googleapis.com/auth/drive.file` scope — files WasmHatch
 * creates, plus reading and updating those files. There is deliberately no
 * whole-Drive listing or search and no opening of arbitrary user files by
 * URL or ID; those need Sensitive scopes and live in
 * google-sensitive-connectors.ts, gated behind verification. Advertise the
 * boundary, never discover it.
 *
 * The access token is supplied per call by a GoogleTokenAccessor, travels
 * only in the Authorization header, and never appears in tool results,
 * errors, or logs.
 */

import type { AgentToolDefinition, AgentToolExecutor, AgentToolOutcome } from "./agent-core/types";
import {
  DEFAULT_READ_RANGE,
  DOCS_BASE_URL,
  DRIVE_FILES_URL,
  SHEETS_BASE_URL,
  type GoogleRequestContext,
  type GoogleTokenAccessor,
  fail,
  googleFetch,
  httpFailure,
  isOutcome,
  ok,
  optionalText,
  requireFileId,
  requireRange,
  requireTitle,
  requireValues,
  toToolFailure
} from "./google-rest";

export type { GoogleTokenAccessor } from "./google-rest";

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

// drive.file only reaches files WasmHatch created; a 404 almost always means
// the model reached for a file outside that boundary, so say so plainly.
const DRIVE_FILE_NOT_FOUND =
  "That Google file was not found or WasmHatch does not have access to it " +
  "(drive.file only covers files WasmHatch created).";

function driveHttpFailure(response: Response): Promise<AgentToolOutcome> {
  return httpFailure(response, DRIVE_FILE_NOT_FOUND);
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
  if (!response.ok) return driveHttpFailure(response);
  const body = await response.json() as { id?: unknown; name?: unknown; webViewLink?: unknown };
  if (typeof body.id !== "string" || !body.id) return fail("Google returned an invalid file-creation response.");
  return {
    id: body.id,
    name: typeof body.name === "string" ? body.name : title,
    webViewLink: typeof body.webViewLink === "string" ? body.webViewLink : null
  };
}

async function docEndIndex(context: GoogleRequestContext, documentId: string): Promise<number | AgentToolOutcome> {
  const response = await googleFetch(context, `${DOCS_BASE_URL}/${documentId}?fields=body(content(endIndex))`, { method: "GET" });
  if (!response.ok) return driveHttpFailure(response);
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
          if (!update.ok) return driveHttpFailure(update);
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
          if (!append.ok) return driveHttpFailure(append);
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
        if (!response.ok) return driveHttpFailure(response);
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
        if (!response.ok) return driveHttpFailure(response);
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
        if (!update.ok) return driveHttpFailure(update);
        return ok({ documentId });
      }

      return fail(`Unknown tool: ${name}`);
    } catch (error) {
      return toToolFailure(error);
    }
  };
}
