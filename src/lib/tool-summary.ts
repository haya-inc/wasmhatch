/**
 * Human-readable summaries for chat transcript tool chips.
 *
 * Called by ChatPage to turn raw tool names into sentences like
 * "Creating a Google Sheet — Q3 budget" instead of just "create_google_sheet".
 * Summaries are Lingui messages, so they follow the active UI locale.
 */

import { t } from "@lingui/core/macro";

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
  { name: "read_file", argKey: "path", format: (path) => t`Reading ${path}` },
  { name: "write_file", argKey: "path", format: (path) => t`Writing ${path}` },
  { name: "list_files", format: () => t`Listing workspace files` },
  { name: "run_script", format: () => t`Running a sandboxed script` },
  { name: "web_search", argKey: "query", format: (query) => t`Searching the web — ${query}` },
  { name: "create_artifact", argKey: "title", format: (title) => t`Creating an HTML artifact — ${title}` },
  { name: "create_google_doc", argKey: "title", format: (title) => t`Creating a Google Doc — ${title}` },
  { name: "create_google_sheet", argKey: "title", format: (title) => t`Creating a Google Sheet — ${title}` },
  { name: "create_google_slides", argKey: "title", format: (title) => t`Creating a Google Slides deck — ${title}` },
  { name: "read_google_sheet_values", format: () => t`Reading a Google Sheet` },
  { name: "update_google_sheet_values", format: () => t`Updating a Google Sheet` },
  { name: "append_google_doc_text", format: () => t`Appending text to a Google Doc` },
  { name: "open_google_file_picker", format: () => t`Asking for Google files` },
  { name: "post_slack_message", format: () => t`Posting to Slack` },
  { name: "list_slack_channels", format: () => t`Checking Slack channels` },
  { name: "send_slack_channel_message", argKey: "channel", format: (channel) => t`Posting to Slack — ${channel}` },
  { name: "list_tickets", format: () => t`Checking the ticket board` },
  { name: "create_ticket", argKey: "title", format: (title) => t`Adding a ticket — ${title}` },
  { name: "update_ticket", argKey: "id", format: (id) => t`Updating ticket ${id}` },
];

/** Produce a human-readable summary for a tool call. Falls back to the raw name. */
export function summarizeToolCall(name: string, args: Record<string, unknown>): string {
  const path = typeof args.path === "string" ? args.path : "";
  const rule = RULES.find((r) => r.name === name);
  if (!rule) {
    // MCP tools arrive namespaced as mcp_<server>_<tool>.
    const mcpMatch = /^mcp_([a-z0-9-]+)_(.+)$/.exec(name);
    if (mcpMatch) {
      const server = mcpMatch[1];
      const tool = mcpMatch[2].replace(/_/g, " ");
      return t`Using ${server} — ${tool}`;
    }
    return path ? `${name} ${path}` : name;
  }

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
