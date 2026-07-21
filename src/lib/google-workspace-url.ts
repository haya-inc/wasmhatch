/**
 * Parses a Google Workspace file reference — a share URL or a bare file ID —
 * into its file ID, so the agent can open a Sheet, Doc, or Slides deck the user
 * names in chat. Opening a file the user references (rather than one WasmHatch
 * created) is exactly the capability `drive.file` cannot serve; it needs the
 * matching Sensitive scope, which is why these tools live behind the flag.
 */

export type GoogleWorkspaceKind = "spreadsheet" | "document" | "presentation";

// Google file IDs are URL-safe base64-ish tokens; keep the same bound the
// drive.file connector already enforces so IDs round-trip identically.
const FILE_ID_PATTERN = /^[A-Za-z0-9_-]{10,256}$/;

// The path segment Google uses in a share URL for each file kind. Used both to
// find the ID and to reject a mismatched reference (a Sheet URL handed to the
// Doc tool) before a request is ever made.
const KIND_SEGMENTS: Record<GoogleWorkspaceKind, string> = {
  spreadsheet: "spreadsheets",
  document: "document",
  presentation: "presentation"
};

const KIND_LABELS: Record<GoogleWorkspaceKind, string> = {
  spreadsheet: "Google Sheets",
  document: "Google Docs",
  presentation: "Google Slides"
};

export class GoogleWorkspaceReferenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoogleWorkspaceReferenceError";
  }
}

/**
 * Extracts the file ID from `reference` for the given file `kind`. Accepts a
 * bare ID or a docs.google.com / drive.google.com URL. Throws a plain-language
 * GoogleWorkspaceReferenceError the model can relay to the user.
 */
export function parseWorkspaceReference(reference: unknown, kind: GoogleWorkspaceKind): string {
  const value = typeof reference === "string" ? reference.trim() : "";
  if (!value) {
    throw new GoogleWorkspaceReferenceError(`A ${KIND_LABELS[kind]} URL or file ID is required.`);
  }
  // Bare file ID (no scheme, no slash).
  if (!value.includes("/") && !value.includes(":")) {
    if (FILE_ID_PATTERN.test(value)) return value;
    throw new GoogleWorkspaceReferenceError(`That is not a valid ${KIND_LABELS[kind]} file ID.`);
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new GoogleWorkspaceReferenceError(`That is not a valid ${KIND_LABELS[kind]} URL.`);
  }
  if (url.protocol !== "https:") {
    throw new GoogleWorkspaceReferenceError("Google file URLs must use https.");
  }
  const host = url.hostname.toLowerCase();
  if (host !== "docs.google.com" && host !== "drive.google.com") {
    throw new GoogleWorkspaceReferenceError("Only docs.google.com and drive.google.com URLs are supported.");
  }

  // drive.google.com/open?id=<id> form.
  const queryId = url.searchParams.get("id");
  if (queryId) {
    if (FILE_ID_PATTERN.test(queryId)) return queryId;
    throw new GoogleWorkspaceReferenceError(`That URL does not contain a valid ${KIND_LABELS[kind]} file ID.`);
  }

  // docs.google.com/<segment>/d/<id>/... form.
  const segments = url.pathname.split("/").filter(Boolean);
  const leadingSegment = segments[0]?.toLowerCase();
  if (
    host === "docs.google.com" &&
    leadingSegment &&
    leadingSegment !== KIND_SEGMENTS[kind] &&
    (leadingSegment === "spreadsheets" || leadingSegment === "document" || leadingSegment === "presentation")
  ) {
    throw new GoogleWorkspaceReferenceError(
      `That looks like a ${leadingSegment} URL, but this tool expects a ${KIND_LABELS[kind]} file.`
    );
  }
  const idIndex = segments.indexOf("d") + 1;
  const candidate = idIndex > 0 ? segments[idIndex] : undefined;
  if (candidate && FILE_ID_PATTERN.test(candidate)) return candidate;
  throw new GoogleWorkspaceReferenceError(`Could not find a ${KIND_LABELS[kind]} file ID in that URL.`);
}
