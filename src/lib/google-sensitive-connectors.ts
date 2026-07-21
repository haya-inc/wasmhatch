/**
 * Google Workspace agent tools that require Sensitive scopes.
 *
 * Unlike google-connectors.ts (which stays inside the non-sensitive
 * `drive.file` boundary), every tool here opens a file the user *references* by
 * URL or ID — a Sheet, Doc, or Slides deck WasmHatch did not create — or reads
 * and writes Calendar events. Those are exactly the capabilities `drive.file`
 * cannot serve, so each tool needs its matching Sensitive scope:
 *
 *   - spreadsheets      → read_google_sheet, write_google_sheet
 *   - documents         → read_google_doc, append_google_doc
 *   - presentations     → read_google_slides, add_google_slide
 *   - calendar.events   → list_calendar_events, create_calendar_event
 *
 * These tools are exposed ONLY when the deployment opts into Sensitive scopes
 * (see google-scopes.ts); production launches without them. As everywhere, the
 * access token travels only in the Authorization header and never appears in a
 * tool result, error, or log.
 */

import type { AgentToolDefinition, AgentToolExecutor, AgentToolOutcome } from "./agent-core/types";
import {
  CALENDAR_BASE_URL,
  DEFAULT_READ_RANGE,
  DOCS_BASE_URL,
  SHEETS_BASE_URL,
  SLIDES_BASE_URL,
  TITLE_MAX_LENGTH,
  type GoogleRequestContext,
  type GoogleTokenAccessor,
  fail,
  googleFetch,
  httpFailure,
  ok,
  optionalText,
  requireRange,
  requireText,
  requireTitle,
  requireValues,
  invalid,
  resolveFetch,
  toToolFailure
} from "./google-rest";
import { parseWorkspaceReference } from "./google-workspace-url";

const MAX_CALENDAR_RESULTS = 50;
const DEFAULT_CALENDAR_RESULTS = 10;
const DATETIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const TIMEZONE_PATTERN = /^[A-Za-z][A-Za-z0-9+_/-]{0,63}$/;
const DOC_TEXT_MAX_LENGTH = 100_000;
const MAX_SLIDES_LISTED = 200;

export type SlidesIdFactory = () => string;

export interface GoogleSensitiveOptions {
  fetchImpl?: typeof fetch;
  idFactory?: SlidesIdFactory;
}

export const GOOGLE_SENSITIVE_TOOLS: readonly AgentToolDefinition[] = [
  {
    name: "read_google_sheet",
    description:
      "Read cell values from a Google Sheet the user references by URL or ID (spreadsheets scope — this is " +
      "how WasmHatch opens a spreadsheet it did not create). Range uses A1 notation; defaults to A1:Z1000.",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string" }, range: { type: "string" } },
      required: ["url"],
      additionalProperties: false
    }
  },
  {
    name: "write_google_sheet",
    description:
      "Overwrite a cell range in a Google Sheet the user references by URL or ID. Values are written RAW, " +
      "exactly as given. Surface the exact change to the user before calling this.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string" },
        range: { type: "string" },
        values: { type: "array", items: { type: "array", items: { type: "string" } } }
      },
      required: ["url", "range", "values"],
      additionalProperties: false
    }
  },
  {
    name: "read_google_doc",
    description:
      "Read the plain text of a Google Doc the user references by URL or ID (documents scope). " +
      "Returns the title and body text.",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string" } },
      required: ["url"],
      additionalProperties: false
    }
  },
  {
    name: "append_google_doc",
    description: "Append text to the end of a Google Doc the user references by URL or ID (documents scope).",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string" }, text: { type: "string" } },
      required: ["url", "text"],
      additionalProperties: false
    }
  },
  {
    name: "read_google_slides",
    description:
      "Read a Google Slides presentation the user references by URL or ID (presentations scope). " +
      "Returns the title and slide count.",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string" } },
      required: ["url"],
      additionalProperties: false
    }
  },
  {
    name: "add_google_slide",
    description:
      "Append a titled slide (optional body text) to a Google Slides presentation the user references by " +
      "URL or ID (presentations scope). Returns the new slide's object id.",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string" }, title: { type: "string" }, body: { type: "string" } },
      required: ["url", "title"],
      additionalProperties: false
    }
  },
  {
    name: "list_calendar_events",
    description:
      "List events on the user's primary Google Calendar (calendar.events scope). Optional RFC3339 timeMin " +
      "and timeMax bound the window; maxResults defaults to 10 (max 50).",
    inputSchema: {
      type: "object",
      properties: {
        timeMin: { type: "string" },
        timeMax: { type: "string" },
        maxResults: { type: "number" }
      },
      required: [],
      additionalProperties: false
    }
  },
  {
    name: "create_calendar_event",
    description:
      "Create an event on the user's primary Google Calendar (calendar.events scope). Times are RFC3339 " +
      "date-times. No attendees are invited and no notifications are sent. Show the full details to the " +
      "user before calling this.",
    inputSchema: {
      type: "object",
      properties: {
        summary: { type: "string" },
        startDateTime: { type: "string" },
        endDateTime: { type: "string" },
        description: { type: "string" },
        timeZone: { type: "string" }
      },
      required: ["summary", "startDateTime", "endDateTime"],
      additionalProperties: false
    }
  }
];

function requireSummary(args: Record<string, unknown>): string {
  const summary = typeof args.summary === "string" ? args.summary.trim() : "";
  if (!summary) invalid("summary must be a non-empty string.");
  if (summary.length > TITLE_MAX_LENGTH) invalid(`summary exceeds the ${TITLE_MAX_LENGTH}-character limit.`);
  return summary;
}

function requireDateTime(args: Record<string, unknown>, field: string): string {
  const value = typeof args[field] === "string" ? (args[field] as string).trim() : "";
  if (!DATETIME_PATTERN.test(value)) invalid(`${field} must be an RFC3339 date-time (e.g. 2026-07-21T14:00:00+09:00).`);
  return value;
}

function optionalDateTime(args: Record<string, unknown>, field: string): string | undefined {
  if (args[field] === undefined) return undefined;
  return requireDateTime(args, field);
}

function optionalTimeZone(args: Record<string, unknown>): string | undefined {
  const value = args.timeZone;
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !TIMEZONE_PATTERN.test(value.trim())) invalid("timeZone must be an IANA time zone name.");
  return value.trim();
}

function resolveMaxResults(args: Record<string, unknown>): number {
  const value = args.maxResults;
  if (value === undefined) return DEFAULT_CALENDAR_RESULTS;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_CALENDAR_RESULTS) {
    invalid(`maxResults must be an integer from 1 to ${MAX_CALENDAR_RESULTS}.`);
  }
  return value;
}

function extractDocText(body: unknown): string {
  const content = (body as { body?: { content?: unknown[] } }).body?.content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  let length = 0;
  for (const element of content) {
    const paragraphElements = (element as { paragraph?: { elements?: unknown[] } }).paragraph?.elements;
    if (!Array.isArray(paragraphElements)) continue;
    for (const run of paragraphElements) {
      const text = (run as { textRun?: { content?: unknown } }).textRun?.content;
      if (typeof text === "string") {
        parts.push(text);
        length += text.length;
        if (length > DOC_TEXT_MAX_LENGTH) return parts.join("").slice(0, DOC_TEXT_MAX_LENGTH);
      }
    }
  }
  return parts.join("");
}

async function docEndIndex(context: GoogleRequestContext, documentId: string): Promise<number | AgentToolOutcome> {
  const response = await googleFetch(context, `${DOCS_BASE_URL}/${documentId}?fields=body(content(endIndex))`, { method: "GET" });
  if (!response.ok) return httpFailure(response);
  const body = await response.json() as { body?: { content?: Array<{ endIndex?: unknown }> } };
  const indexes = (body.body?.content ?? [])
    .map((element) => element.endIndex)
    .filter((value): value is number => typeof value === "number" && Number.isSafeInteger(value));
  const end = indexes.length ? Math.max(...indexes) : 1;
  return Math.max(1, end - 1);
}

function defaultIdFactory(): string {
  return `wh${Math.random().toString(36).slice(2, 12)}`;
}

export function createGoogleSensitiveExecutor(
  getToken: GoogleTokenAccessor,
  options: GoogleSensitiveOptions = {}
): AgentToolExecutor {
  const fetchImpl = resolveFetch(options.fetchImpl);
  const nextId = options.idFactory ?? defaultIdFactory;

  return async (name, args, { signal }) => {
    const context: GoogleRequestContext = { getToken, fetchImpl, signal };
    try {
      if (name === "read_google_sheet") {
        const spreadsheetId = parseWorkspaceReference(args.url, "spreadsheet");
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

      if (name === "write_google_sheet") {
        const spreadsheetId = parseWorkspaceReference(args.url, "spreadsheet");
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

      if (name === "read_google_doc") {
        const documentId = parseWorkspaceReference(args.url, "document");
        const response = await googleFetch(
          context,
          `${DOCS_BASE_URL}/${documentId}?fields=title,body(content(paragraph(elements(textRun(content)))))`,
          { method: "GET" }
        );
        if (!response.ok) return httpFailure(response);
        const body = await response.json() as { title?: unknown };
        return ok({
          title: typeof body.title === "string" ? body.title : "",
          text: extractDocText(body)
        });
      }

      if (name === "append_google_doc") {
        const documentId = parseWorkspaceReference(args.url, "document");
        const text = requireText(args, "text");
        const end = await docEndIndex(context, documentId);
        if (typeof end !== "number") return end;
        const update = await googleFetch(context, `${DOCS_BASE_URL}/${documentId}:batchUpdate`, {
          method: "POST",
          body: { requests: [{ insertText: { location: { index: end }, text } }] }
        });
        if (!update.ok) return httpFailure(update);
        return ok({ documentId });
      }

      if (name === "read_google_slides") {
        const presentationId = parseWorkspaceReference(args.url, "presentation");
        const response = await googleFetch(
          context,
          `${SLIDES_BASE_URL}/${presentationId}?fields=title,slides(objectId)`,
          { method: "GET" }
        );
        if (!response.ok) return httpFailure(response);
        const body = await response.json() as { title?: unknown; slides?: unknown };
        const slides = Array.isArray(body.slides) ? body.slides : [];
        return ok({
          title: typeof body.title === "string" ? body.title : "",
          slideCount: slides.length,
          slideObjectIds: slides
            .slice(0, MAX_SLIDES_LISTED)
            .map((slide) => (slide as { objectId?: unknown }).objectId)
            .filter((id): id is string => typeof id === "string")
        });
      }

      if (name === "add_google_slide") {
        const presentationId = parseWorkspaceReference(args.url, "presentation");
        const title = requireTitle(args);
        const body = optionalText(args, "body");
        const slideId = nextId();
        const titleId = nextId();
        const bodyId = nextId();
        const requests: unknown[] = [
          {
            createSlide: {
              objectId: slideId,
              slideLayoutReference: { predefinedLayout: "TITLE_AND_BODY" },
              placeholderIdMappings: [
                { layoutPlaceholder: { type: "TITLE", index: 0 }, objectId: titleId },
                { layoutPlaceholder: { type: "BODY", index: 0 }, objectId: bodyId }
              ]
            }
          },
          { insertText: { objectId: titleId, text: title } }
        ];
        if (body?.length) requests.push({ insertText: { objectId: bodyId, text: body } });
        const update = await googleFetch(context, `${SLIDES_BASE_URL}/${presentationId}:batchUpdate`, {
          method: "POST",
          body: { requests }
        });
        if (!update.ok) return httpFailure(update);
        return ok({ presentationId, slideObjectId: slideId });
      }

      if (name === "list_calendar_events") {
        const timeMin = optionalDateTime(args, "timeMin");
        const timeMax = optionalDateTime(args, "timeMax");
        const maxResults = resolveMaxResults(args);
        const query = new URLSearchParams({
          singleEvents: "true",
          orderBy: "startTime",
          maxResults: String(maxResults)
        });
        if (timeMin) query.set("timeMin", timeMin);
        if (timeMax) query.set("timeMax", timeMax);
        const response = await googleFetch(
          context,
          `${CALENDAR_BASE_URL}/calendars/primary/events?${query.toString()}`,
          { method: "GET" }
        );
        if (!response.ok) return httpFailure(response);
        const body = await response.json() as { items?: unknown };
        const items = Array.isArray(body.items) ? body.items : [];
        return ok({
          events: items.slice(0, maxResults).map((item) => {
            const event = item as { id?: unknown; summary?: unknown; start?: unknown; end?: unknown; htmlLink?: unknown };
            return {
              id: typeof event.id === "string" ? event.id : "",
              summary: typeof event.summary === "string" ? event.summary : "(no title)",
              start: event.start ?? null,
              end: event.end ?? null,
              htmlLink: typeof event.htmlLink === "string" ? event.htmlLink : null
            };
          })
        });
      }

      if (name === "create_calendar_event") {
        const summary = requireSummary(args);
        const startDateTime = requireDateTime(args, "startDateTime");
        const endDateTime = requireDateTime(args, "endDateTime");
        const description = optionalText(args, "description");
        const timeZone = optionalTimeZone(args);
        const event: Record<string, unknown> = {
          summary,
          start: { dateTime: startDateTime, ...(timeZone ? { timeZone } : {}) },
          end: { dateTime: endDateTime, ...(timeZone ? { timeZone } : {}) }
        };
        if (description?.length) event.description = description;
        // sendUpdates=none: never email anyone as a side effect of a tool call.
        const response = await googleFetch(
          context,
          `${CALENDAR_BASE_URL}/calendars/primary/events?sendUpdates=none`,
          { method: "POST", body: event }
        );
        if (!response.ok) return httpFailure(response);
        const body = await response.json() as { id?: unknown; htmlLink?: unknown };
        return ok({
          id: typeof body.id === "string" ? body.id : "",
          htmlLink: typeof body.htmlLink === "string" ? body.htmlLink : null,
          summary
        });
      }

      return fail(`Unknown tool: ${name}`);
    } catch (error) {
      return toToolFailure(error);
    }
  };
}
