/**
 * Shared, scope-agnostic plumbing for WasmHatch's Google Workspace agent tools.
 *
 * This module holds only the neutral HTTP transport and argument validation
 * that both the non-sensitive `drive.file` connectors (google-connectors.ts)
 * and the Sensitive-scope connectors (google-sensitive-connectors.ts) reuse.
 * The access token is supplied per call by a GoogleTokenAccessor, travels only
 * in the Authorization header, and never appears in tool results, errors, or
 * logs.
 */

import type { AgentToolOutcome } from "./agent-core/types";

export type GoogleTokenAccessor = (signal?: AbortSignal) => Promise<string>;

export const DRIVE_FILES_URL = "https://www.googleapis.com/drive/v3/files";
export const SHEETS_BASE_URL = "https://sheets.googleapis.com/v4/spreadsheets";
export const DOCS_BASE_URL = "https://docs.googleapis.com/v1/documents";
export const SLIDES_BASE_URL = "https://slides.googleapis.com/v1/presentations";
export const CALENDAR_BASE_URL = "https://www.googleapis.com/calendar/v3";

export const TITLE_MAX_LENGTH = 512;
export const TEXT_MAX_LENGTH = 100_000;
export const RANGE_MAX_LENGTH = 256;
export const MAX_VALUE_ROWS = 1_000;
export const MAX_VALUE_CELLS = 10_000;
export const CELL_MAX_LENGTH = 4_000;
export const FILE_ID_PATTERN = /^[A-Za-z0-9_-]{10,256}$/;
export const DEFAULT_READ_RANGE = "A1:Z1000";

export class ArgumentError extends Error {}

export function ok(payload: unknown): AgentToolOutcome {
  return { content: JSON.stringify(payload) };
}

export function fail(content: string): AgentToolOutcome {
  return { content, isError: true };
}

export function invalid(message: string): never {
  throw new ArgumentError(message);
}

export function isOutcome<T>(value: T | AgentToolOutcome): value is AgentToolOutcome {
  return Boolean(value) && typeof value === "object" && "content" in (value as Record<string, unknown>);
}

export function requireTitle(args: Record<string, unknown>): string {
  const title = typeof args.title === "string" ? args.title.trim() : "";
  if (!title) invalid("title must be a non-empty string.");
  if (title.length > TITLE_MAX_LENGTH) invalid(`title exceeds the ${TITLE_MAX_LENGTH}-character limit.`);
  return title;
}

export function requireFileId(args: Record<string, unknown>, field: string): string {
  const value = typeof args[field] === "string" ? (args[field] as string).trim() : "";
  if (!FILE_ID_PATTERN.test(value)) invalid(`${field} must be a valid Google file ID.`);
  return value;
}

export function optionalText(args: Record<string, unknown>, field: string): string | undefined {
  const value = args[field];
  if (value === undefined) return undefined;
  if (typeof value !== "string") invalid(`${field} must be a string.`);
  if ((value as string).length > TEXT_MAX_LENGTH) invalid(`${field} exceeds the ${TEXT_MAX_LENGTH.toLocaleString()}-character limit.`);
  return value as string;
}

export function requireText(args: Record<string, unknown>, field: string): string {
  const value = optionalText(args, field);
  if (!value?.length) invalid(`${field} must be a non-empty string.`);
  return value;
}

export function requireRange(args: Record<string, unknown>, fallback?: string): string {
  const value = args.range === undefined && fallback !== undefined ? fallback : args.range;
  if (typeof value !== "string" || !value.trim()) invalid("range must be a non-empty A1-notation string.");
  const range = (value as string).trim();
  if (range.length > RANGE_MAX_LENGTH || /[\u0000-\u001f\u007f]/.test(range)) invalid("range is not a valid A1-notation string.");
  return range;
}

export function requireValues(args: Record<string, unknown>, field: string, options: { optional?: boolean } = {}): string[][] | undefined {
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

const DEFAULT_NOT_FOUND = "That Google file or resource was not found, or WasmHatch does not have access to it.";

export async function httpFailure(response: Response, notFoundMessage: string = DEFAULT_NOT_FOUND): Promise<AgentToolOutcome> {
  if (response.status === 401) return fail("Google authorization expired or is missing. Reconnect Google and retry.");
  if (response.status === 403) {
    return fail(`Google denied this request (insufficient scope or permission)${await readApiErrorDetail(response)}`);
  }
  if (response.status === 404) return fail(notFoundMessage);
  if (response.status === 429) return fail("Google rate limit reached. Wait briefly and retry.");
  if (response.status >= 500) return fail(`Google is temporarily unavailable (${response.status}). Retry shortly.`);
  return fail(`Google request failed (${response.status})${await readApiErrorDetail(response)}`);
}

export interface GoogleRequestContext {
  getToken: GoogleTokenAccessor;
  fetchImpl: typeof fetch;
  signal?: AbortSignal;
}

/**
 * Resolves the fetch implementation for an executor. The default MUST be bound
 * to globalThis: a bare `fetch` reference called through a context object gets
 * that object as `this`, and Chrome rejects it with "Illegal invocation".
 */
export function resolveFetch(fetchImpl?: typeof fetch): typeof fetch {
  return fetchImpl ?? globalThis.fetch.bind(globalThis);
}

export async function googleFetch(
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

/**
 * Wraps an executor body so argument-validation, abort, and auth-session errors
 * become the same safe, user-facing outcomes both connector families expect.
 */
export function toToolFailure(error: unknown): AgentToolOutcome {
  if (error instanceof ArgumentError) return fail(error.message);
  if (error instanceof DOMException && error.name === "AbortError") throw error;
  // Auth-session errors (e.g. expired grant) carry safe, user-facing messages;
  // surface them so the model can ask the user to reconnect.
  if (error instanceof Error && error.name === "GoogleOAuthReauthorizationRequiredError") {
    return fail(error.message);
  }
  // Workspace-reference parse errors carry a plain-language message.
  if (error instanceof Error && error.name === "GoogleWorkspaceReferenceError") {
    return fail(error.message);
  }
  // Credential-broker contract errors are written to be user-facing too.
  if (error instanceof Error && error.name === "ConnectorContractError") {
    return fail(error.message);
  }
  // Anything else is unexpected (a CSP block, a dropped connection, invalid
  // JSON). Keep the advice but preserve the cause: these messages come from the
  // platform, never contain the token, and turn a dead-end reply into a
  // diagnosis. Bound the length so a hostile response can't flood the model.
  const cause = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return fail(`Google request failed before completion (${cause.slice(0, 160)}). Check the connection and retry.`);
}
