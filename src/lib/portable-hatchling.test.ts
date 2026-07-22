import { describe, expect, it, vi } from "vitest";
import { PORTABLE_AGENT_MEDIA_TYPE, readPortableAgentPackage } from "./agent-package";
import {
  capabilityForTool,
  filterToolsByCapabilities,
  summarizeRequestedCapabilities
} from "./hatchling-capabilities";
import {
  buildPortableHatchling,
  hatchProfileFromPackage,
  isRegistryPackageUrl,
  portableAgentId,
  publishToRegistry,
  registryPackageUrl,
  unpublishFromRegistry
} from "./portable-hatchling";
import { mainHatchling, type HatchlingThread } from "./agent-threads";

function thread(overrides: Partial<HatchlingThread> = {}): HatchlingThread {
  return { ...mainHatchling(new Date("2026-07-23T00:00:00Z")), ...overrides };
}

const TOOLS = [
  { name: "read_file", description: "", inputSchema: {} },
  { name: "write_file", description: "", inputSchema: {} },
  { name: "create_artifact", description: "", inputSchema: {} },
  { name: "post_slack_message", description: "", inputSchema: {} },
  { name: "mcp_local_search", description: "", inputSchema: {} },
  { name: "some_future_tool", description: "", inputSchema: {} }
];

describe("hatchling capabilities", () => {
  it("maps tools to the shared vocabulary, mcp by prefix, unknown to null", () => {
    expect(capabilityForTool("read_file")).toBe("workspace.read");
    expect(capabilityForTool("post_slack_message")).toBe("slack");
    expect(capabilityForTool("mcp_local_search")).toBe("mcp");
    expect(capabilityForTool("some_future_tool")).toBeNull();
  });

  it("filters by allowlist and fails closed on unmapped tools", () => {
    const filtered = filterToolsByCapabilities(TOOLS, ["workspace.read", "slack"]);
    expect(filtered.map((tool) => tool.name)).toEqual(["read_file", "post_slack_message"]);
    expect(filterToolsByCapabilities(TOOLS, null)).toHaveLength(TOOLS.length);
    expect(filterToolsByCapabilities(TOOLS, [])).toHaveLength(0);
  });

  it("splits declared names into known capabilities and unknown requests", () => {
    const summary = summarizeRequestedCapabilities(["workspace.read", "warp-drive", "workspace.read", "mcp"]);
    expect(summary.known).toEqual(["workspace.read", "mcp"]);
    expect(summary.unknown).toEqual(["warp-drive"]);
  });
});

describe("portable hatchling export/import", () => {
  it("slugs hatchling names into valid portable ids", () => {
    expect(portableAgentId("Pip")).toBe("pip");
    expect(portableAgentId("Weekly Brief 2")).toBe("weekly-brief-2");
    expect(portableAgentId("ピップ")).toBe("hatchling");
  });

  it("round-trips a hatchling through the package format", async () => {
    const source = thread({
      name: "Report Chick",
      instructions: "Turn notes into a weekly brief.",
      capabilities: ["workspace.read", "workspace.write", "artifacts"]
    });
    const pkg = await buildPortableHatchling(source, [
      { path: "templates/brief.md", content: "# Brief\n" },
      { path: "config/openai.key", content: "sk-secret\n" }
    ], { summary: "Weekly brief writer." });

    expect(pkg.manifest.id).toBe("report-chick");
    expect(pkg.manifest.permissions.tools).toEqual(["workspace.read", "workspace.write", "artifacts"]);
    expect(pkg.manifest.files.map((file) => file.path)).toEqual(["AGENTS.md", "templates/brief.md"]);
    expect(JSON.stringify(pkg.manifest)).not.toContain("sk-secret");

    const restored = await readPortableAgentPackage(pkg.bytes);
    const profile = hatchProfileFromPackage(restored);
    expect(profile.name).toBe("Report Chick");
    expect(profile.instructions).toBe("Turn notes into a weekly brief.");
    expect(profile.capabilities).toEqual(["workspace.read", "workspace.write", "artifacts"]);
    expect(profile.seedFiles.map((file) => file.path)).toEqual(["AGENTS.md", "templates/brief.md"]);
  });

  it("exports every capability for an unrestricted hatchling", async () => {
    const pkg = await buildPortableHatchling(thread({ name: "Pip" }), []);
    expect(pkg.manifest.permissions.tools).toContain("workspace.read");
    expect(pkg.manifest.permissions.tools).toContain("mcp");
    expect(pkg.manifest.entrypoint).toBe("AGENTS.md");
  });
});

describe("registry client", () => {
  it("publishes the package bytes with the bearer token and media type", async () => {
    const pkg = await buildPortableHatchling(thread({ name: "Pip" }), []);
    const fetchImpl = vi.fn(async () => Response.json(
      { publisherId: "haya", agentId: "pip", latestSha256: pkg.sha256 },
      { status: 201 }
    ));

    const result = await publishToRegistry("https://registry.example", "publish-token", pkg, { fetchImpl: fetchImpl as typeof fetch });

    expect(result).toEqual({ publisherId: "haya", agentId: "pip", latestSha256: pkg.sha256 });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://registry.example/v1/agents");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer publish-token");
    expect((init.headers as Record<string, string>)["content-type"]).toBe(PORTABLE_AGENT_MEDIA_TYPE);
    expect(registryPackageUrl("https://registry.example/", result))
      .toBe(`https://registry.example/v1/agents/haya/pip/revisions/${pkg.sha256}/package`);
  });

  it("surfaces the registry's decline message without the token", async () => {
    const pkg = await buildPortableHatchling(thread({ name: "Pip" }), []);
    const fetchImpl = vi.fn(async () => Response.json({ error: "unauthorized", message: "Publisher authentication is required." }, { status: 401 }));

    await expect(publishToRegistry("https://registry.example", "secret-token", pkg, { fetchImpl: fetchImpl as typeof fetch }))
      .rejects.toThrow("Publisher authentication is required.");
  });

  it("unpublishes with the bearer token and surfaces declines", async () => {
    const ok = vi.fn(async () => Response.json({ ok: true }, { status: 200 }));
    await unpublishFromRegistry("https://registry.example/", "publish-token", "haya", "pip", { fetchImpl: ok as typeof fetch });
    const [url, init] = ok.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://registry.example/v1/agents/haya/pip");
    expect(init.method).toBe("DELETE");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer publish-token");

    const denied = vi.fn(async () => Response.json({ error: "forbidden", message: "Publishers may only unpublish their own agents." }, { status: 403 }));
    await expect(unpublishFromRegistry("https://registry.example", "publish-token", "haya", "pip", { fetchImpl: denied as typeof fetch }))
      .rejects.toThrow("their own agents");
  });

  it("recognizes package URLs on the configured registry origin only", () => {
    expect(isRegistryPackageUrl("https://registry.example/v1/agents/a/b/revisions/x/package", "https://registry.example")).toBe(true);
    expect(isRegistryPackageUrl("https://evil.example/v1/agents/a/b/revisions/x/package", "https://registry.example")).toBe(false);
    expect(isRegistryPackageUrl("https://registry.example/x", undefined)).toBe(false);
  });
});
