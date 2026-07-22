/**
 * Hatchling capability vocabulary.
 *
 * One stable, coarse vocabulary serves two purposes: a portable agent
 * manifest declares the capabilities it wants (`permissions.tools`), and a
 * hatchling stores the capabilities it is allowed to use. The names are
 * requests, never grants — the runtime intersects them with what the
 * deployment ships and what the user has actually connected.
 *
 * Filtering fails closed: when a hatchling carries a capability list, a
 * tool that maps to no known capability is withheld. A future tool added
 * without a vocabulary entry is therefore invisible to packaged hatchlings
 * until someone decides where it belongs; ordinary hatchlings (capability
 * list null) keep everything.
 */

import type { AgentToolDefinition } from "./agent-core/types";

export const HATCHLING_CAPABILITY_IDS = Object.freeze([
  "workspace.read",
  "workspace.write",
  "workspace.script",
  "artifacts",
  "tickets",
  "google",
  "google.sensitive",
  "slack",
  "mcp"
] as const);

export type HatchlingCapability = (typeof HATCHLING_CAPABILITY_IDS)[number];

const TOOL_CAPABILITY: Readonly<Record<string, HatchlingCapability>> = Object.freeze({
  list_files: "workspace.read",
  read_file: "workspace.read",
  write_file: "workspace.write",
  run_script: "workspace.script",
  create_artifact: "artifacts",
  list_tickets: "tickets",
  create_ticket: "tickets",
  update_ticket: "tickets",
  create_google_doc: "google",
  create_google_sheet: "google",
  create_google_slides: "google",
  read_google_sheet_values: "google",
  update_google_sheet_values: "google",
  append_google_doc_text: "google",
  open_google_file_picker: "google",
  read_google_sheet: "google.sensitive",
  write_google_sheet: "google.sensitive",
  read_google_doc: "google.sensitive",
  append_google_doc: "google.sensitive",
  read_google_slides: "google.sensitive",
  add_google_slide: "google.sensitive",
  list_calendar_events: "google.sensitive",
  create_calendar_event: "google.sensitive",
  post_slack_message: "slack",
  list_slack_channels: "slack",
  send_slack_channel_message: "slack"
});

/** Maps a concrete tool name to its capability; null for unmapped tools. */
export function capabilityForTool(toolName: string): HatchlingCapability | null {
  const mapped = TOOL_CAPABILITY[toolName];
  if (mapped) return mapped;
  if (/^mcp_[a-z0-9-]+_/.test(toolName)) return "mcp";
  return null;
}

export function isKnownCapability(value: string): value is HatchlingCapability {
  return (HATCHLING_CAPABILITY_IDS as readonly string[]).includes(value);
}

/**
 * Applies a hatchling's capability allowlist to an assembled tool list.
 * A null list means "everything" (the ordinary hatchling default).
 */
export function filterToolsByCapabilities(
  tools: readonly AgentToolDefinition[],
  capabilities: readonly string[] | null
): AgentToolDefinition[] {
  if (capabilities === null) return [...tools];
  const allowed = new Set(capabilities);
  return tools.filter((tool) => {
    const capability = capabilityForTool(tool.name);
    return capability !== null && allowed.has(capability);
  });
}

/**
 * Splits a manifest's declared tool names into the known capabilities they
 * request and the names this build does not recognize (shown in the
 * preview, granted nothing).
 */
export function summarizeRequestedCapabilities(declared: readonly string[]): {
  known: HatchlingCapability[];
  unknown: string[];
} {
  const known: HatchlingCapability[] = [];
  const unknown: string[] = [];
  for (const name of declared) {
    if (isKnownCapability(name)) {
      if (!known.includes(name)) known.push(name);
    } else if (!unknown.includes(name)) {
      unknown.push(name);
    }
  }
  return { known, unknown };
}
