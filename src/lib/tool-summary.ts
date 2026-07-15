/**
 * Human-readable summaries for chat transcript tool chips.
 *
 * Called by ChatPage to turn raw tool names into sentences like
 * "Creating a Google Sheet — Q3 budget" instead of just "create_google_sheet".
 */

export interface ToolSummaryRule {
  name: string;
  /** Which arg key to pull a title/path from, if any */
  argKey?: string;
  /** Factory that produces the summary string given the extracted value */
  format: (value: string) => string;
}

/**
 * Map of tool names to their display rules. New tools should be added here.
 */
const RULES: ToolSummaryRule[] = [
  { name: "read_file", argKey: "path", format: (path) => `Reading ${path}` },
  { name: "write_file", argKey: "path", format: (path) => `Writing ${path}` },
  { name: "list_files", format: () => "Listing workspace files" },
  { name: "create_artifact", argKey: "title", format: (title) => `Creating an HTML artifact — ${title}` },
  { name: "create_google_doc", argKey: "title", format: (title) => `Creating a Google Doc — ${title}` },
  { name: "create_google_sheet", argKey: "title", format: (title) => `Creating a Google Sheet — ${title}` },
  { name: "create_google_slides", argKey: "title", format: (title) => `Creating a Google Slides deck — ${title}` },
  { name: "read_google_sheet_values", format: () => "Reading a Google Sheet" },
  { name: "update_google_sheet_values", format: () => "Updating a Google Sheet" },
  { name: "append_google_doc_text", format: () => "Appending text to a Google Doc" },
];

/** Produce a human-readable summary for a tool call. Falls back to the raw name. */
export function summarizeToolCall(name: string, args: Record<string, unknown>): string {
  const path = typeof args.path === "string" ? args.path : "";
  const rule = RULES.find((r) => r.name === name);
  if (!rule) return path ? `${name} ${path}` : name;

  if (rule.argKey) {
    // Rules with required args only fire when the arg is present and non-empty.
    // If the arg is missing, fall through to the raw-name fallback.
    const value = args[rule.argKey];
    const valueStr = typeof value === "string" ? value : "";
    if (valueStr) return rule.format(valueStr);
    // No value — skip to raw name fallback below
    return path ? `${name} ${path}` : name;
  }

  // Rules without required args (e.g., list_files) always match.
  return rule.format("");
}
