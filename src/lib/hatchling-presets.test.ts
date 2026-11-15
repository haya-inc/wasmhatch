import { describe, expect, it } from "vitest";
import { i18n } from "@lingui/core";
import { createHatchling, mainHatchling } from "./agent-threads";
import { filterToolsByCapabilities, isKnownCapability } from "./hatchling-capabilities";
import { HATCHLING_PRESETS, profileFromPreset } from "./hatchling-presets";
import { buildPortableHatchling } from "./portable-hatchling";
import type { AgentToolDefinition } from "./agent-core/types";

i18n.load("en", {});
i18n.activate("en");

const SAMPLE_TOOLS: readonly AgentToolDefinition[] = [
  { name: "read_file", description: "read", inputSchema: { type: "object", properties: {} } },
  { name: "write_file", description: "write", inputSchema: { type: "object", properties: {} } },
  { name: "run_script", description: "script", inputSchema: { type: "object", properties: {} } },
  { name: "create_artifact", description: "artifact", inputSchema: { type: "object", properties: {} } },
  { name: "list_tickets", description: "tickets", inputSchema: { type: "object", properties: {} } },
  { name: "post_slack_message", description: "slack", inputSchema: { type: "object", properties: {} } }
];

describe("hatchling specialist presets", () => {
  it("uses only known fail-closed capabilities and non-empty instructions", () => {
    for (const preset of HATCHLING_PRESETS) {
      expect(preset.defaultName.length).toBeGreaterThan(0);
      expect(preset.instructions.length).toBeGreaterThan(40);
      expect(preset.label().length).toBeGreaterThan(0);
      expect(preset.summary().length).toBeGreaterThan(0);
      expect(preset.capabilities.length).toBeGreaterThan(0);
      for (const cap of preset.capabilities) {
        expect(isKnownCapability(cap)).toBe(true);
      }
    }
  });

  it("fences each specialist to its declared tool surface and exports cleanly as a .agent package", async () => {
    const existing = [mainHatchling()];
    const wrangler = createHatchling(existing, new Date("2026-07-26T00:00:00Z"), profileFromPreset("wrangler"));
    expect(wrangler.name).toBe("Mame");
    const wranglerTools = filterToolsByCapabilities(SAMPLE_TOOLS, wrangler.capabilities).map((tool) => tool.name);
    expect(wranglerTools).toEqual(["read_file", "write_file", "run_script", "list_tickets"]);
    expect(wranglerTools).not.toContain("post_slack_message");
    expect(wranglerTools).not.toContain("create_artifact");

    const pkg = await buildPortableHatchling(wrangler, []);
    expect(pkg.manifest.name).toBe("Mame");
    expect(pkg.manifest.permissions.tools).toEqual(["workspace.read", "workspace.write", "workspace.script", "tickets"]);
    expect(pkg.files.find((file) => file.path === "AGENTS.md")?.content).toContain("Data Wrangler");
  });
});
