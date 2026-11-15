/**
 * Starter specialist profiles for hatching role-focused hatchlings in one click.
 *
 * Each preset uses the same HatchlingProfile contract as imported `.agent`
 * packages: plain-language instructions injected as authored data plus a
 * fail-closed capability allowlist from `hatchling-capabilities.ts`. Exporting
 * a preset hatchling produces a self-contained `.agent` package automatically.
 */

import { t } from "@lingui/core/macro";
import type { HatchlingProfile } from "./agent-threads";
import type { HatchlingCapability } from "./hatchling-capabilities";

export type HatchlingPresetId = "wrangler" | "reporter" | "runner";

export interface HatchlingPreset {
  readonly id: HatchlingPresetId;
  readonly defaultName: string;
  readonly capabilities: readonly HatchlingCapability[];
  readonly instructions: string;
  label(): string;
  summary(): string;
}

export const HATCHLING_PRESETS: readonly HatchlingPreset[] = Object.freeze([
  {
    id: "wrangler",
    defaultName: "Mame",
    capabilities: Object.freeze(["workspace.read", "workspace.write", "workspace.script", "tickets"] as const),
    instructions: [
      "Role: Data Wrangler.",
      "You clean, reconcile, and audit CSV, TSV, JSON, and spreadsheet files in your workspace.",
      "Always run a script via run_script to count rows, check totals, deduplicate, and transform records — never estimate counts or math by eye.",
      "Write tidy output files and summarize exact row and cell changes clearly."
    ].join("\n"),
    label: () => t`Data wrangler`,
    summary: () => t`Cleans and checks CSV / JSON files with local code.`
  },
  {
    id: "reporter",
    defaultName: "Yuzu",
    capabilities: Object.freeze(["workspace.read", "workspace.write", "artifacts", "tickets"] as const),
    instructions: [
      "Role: Report Builder.",
      "You turn workspace tables, notes, and findings into clear, self-contained single-file HTML reports and dashboards using create_artifact.",
      "Keep layouts scannable, accessible, and printable, with zero external assets or CDN links.",
      "Cite exact numbers from the workspace files you read."
    ].join("\n"),
    label: () => t`Report builder`,
    summary: () => t`Builds one-file HTML reports and dashboards.`
  },
  {
    id: "runner",
    defaultName: "Nori",
    capabilities: Object.freeze(["workspace.read", "workspace.write", "tickets", "google", "slack", "web", "mcp"] as const),
    instructions: [
      "Role: Desk Runner.",
      "You check the shared ticket board, draft or update handed-over Google Docs and Sheets, look up facts when web or MCP tools are connected, and post concise status updates to Slack.",
      "Keep ticket notes brief and concrete so teammates and other hatchlings can see what changed."
    ].join("\n"),
    label: () => t`Desk runner`,
    summary: () => t`Works the ticket board, Google files, Slack, and MCP.`
  }
]);

export function findHatchlingPreset(id: HatchlingPresetId): HatchlingPreset {
  const preset = HATCHLING_PRESETS.find((entry) => entry.id === id);
  if (!preset) throw new Error(`Unknown hatchling preset: ${id}`);
  return preset;
}

export function profileFromPreset(id: HatchlingPresetId): HatchlingProfile {
  const preset = findHatchlingPreset(id);
  return {
    name: preset.defaultName,
    instructions: preset.instructions,
    capabilities: preset.capabilities
  };
}
