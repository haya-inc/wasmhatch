/**
 * Google OAuth scope sets for WasmHatch.
 *
 * Launch-day discipline: the production build requests ONLY the non-sensitive
 * `drive.file` scope, so users see no unverified-app warning and no 100-user
 * lifetime cap applies. The Sensitive scopes below unlock capabilities that
 * `drive.file` cannot serve — opening a Sheet/Doc/Slides file the user names by
 * URL or ID, and reading or creating Calendar events — and Google will only
 * verify a scope its reviewers can watch the app actually use.
 *
 * These Sensitive scopes are therefore requested ONLY when a deployment opts in
 * through `VITE_GOOGLE_SENSITIVE_SCOPES`, which must stay unset in production
 * until Google's Sensitive-scope verification for this OAuth client clears.
 */

export const GOOGLE_DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file";
export const GOOGLE_SPREADSHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";
export const GOOGLE_DOCUMENTS_SCOPE = "https://www.googleapis.com/auth/documents";
export const GOOGLE_PRESENTATIONS_SCOPE = "https://www.googleapis.com/auth/presentations";
export const GOOGLE_CALENDAR_EVENTS_SCOPE = "https://www.googleapis.com/auth/calendar.events";

/** The non-sensitive baseline — the only scope requested at launch. */
export const GOOGLE_LAUNCH_SCOPES: readonly string[] = Object.freeze([GOOGLE_DRIVE_FILE_SCOPE]);

/** Sensitive scopes, gated behind verification and the deployment opt-in. */
export const GOOGLE_SENSITIVE_SCOPES: readonly string[] = Object.freeze([
  GOOGLE_SPREADSHEETS_SCOPE,
  GOOGLE_DOCUMENTS_SCOPE,
  GOOGLE_PRESENTATIONS_SCOPE,
  GOOGLE_CALENDAR_EVENTS_SCOPE
]);

/** The full set requested once the deployment enables Sensitive scopes. */
export const GOOGLE_ALL_SCOPES: readonly string[] = Object.freeze([
  GOOGLE_DRIVE_FILE_SCOPE,
  ...GOOGLE_SENSITIVE_SCOPES
]);

/**
 * Reads the deployment opt-in for Sensitive scopes. Only the exact strings
 * "true" or "1" enable them; anything else (including undefined, the production
 * default) keeps the app launch-safe on `drive.file` alone.
 */
export function parseSensitiveScopesFlag(raw: unknown): boolean {
  return raw === "true" || raw === "1";
}

/**
 * Resolves which scopes to request. Sensitive scopes are added only when the
 * deployment has opted in (post-verification); the default is launch-safe.
 */
export function resolveGoogleScopes(sensitiveEnabled: boolean): readonly string[] {
  return sensitiveEnabled ? GOOGLE_ALL_SCOPES : GOOGLE_LAUNCH_SCOPES;
}
