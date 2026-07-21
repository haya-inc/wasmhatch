import { strToU8, unzipSync, zipSync } from "fflate";
import { describe, expect, it, vi } from "vitest";
import packageJson from "../../package.json";
import {
  createPortableAgentPackage,
  fetchPortableAgentPackage,
  PORTABLE_AGENT_CORE_VERSION,
  PORTABLE_AGENT_KIND,
  PORTABLE_AGENT_MEDIA_TYPE,
  readPortableAgentPackage,
  validatePortableAgentManifest
} from "./agent-package";

const draft = {
  id: "weekly-brief",
  name: "Weekly brief",
  summary: "Turns weekly notes into a concise operational brief.",
  version: "1.0.0",
  license: "Apache-2.0",
  entrypoint: "AGENTS.md",
  permissions: { tools: ["workspace.read", "workspace.write"], networkOrigins: [] },
  examples: [{ title: "Summarize notes", prompt: "Create this week's brief from notes.md." }]
} as const;

const files = [
  { path: "AGENTS.md", content: "# Weekly brief\n\nRead the notes and write `brief.md`.\n" },
  { path: "templates/brief.md", content: "# Weekly brief\n\n## Highlights\n" }
];

describe("portable agent packages", () => {
  it("keeps the default compatibility floor in step with the released core", () => {
    expect(PORTABLE_AGENT_CORE_VERSION).toBe(packageJson.version);
  });

  it("creates and reads a content-verified package", async () => {
    const created = await createPortableAgentPackage(draft, files);
    const restored = await readPortableAgentPackage(created.bytes);

    expect(restored.sha256).toBe(created.sha256);
    expect(restored.manifest.kind).toBe(PORTABLE_AGENT_KIND);
    expect(restored.manifest.entrypoint).toBe("AGENTS.md");
    expect(restored.manifest.files.map((file) => file.path)).toEqual(["AGENTS.md", "templates/brief.md"]);
    expect(restored.files).toEqual(files);
  });

  it("rejects protected credential paths before export", async () => {
    await expect(createPortableAgentPackage(draft, [
      ...files,
      { path: ".env.production", content: "API_KEY=secret\n" }
    ])).rejects.toThrow("protected credential material");
  });

  it("rejects a changed file whose manifest hash was not updated", async () => {
    const created = await createPortableAgentPackage(draft, files);
    const entries = unzipSync(created.bytes);
    entries["wasmhatch-agent/files/AGENTS.md"] = strToU8("# Replaced\n");

    await expect(readPortableAgentPackage(zipSync(entries))).rejects.toThrow("byte count does not match");
  });

  it("rejects undeclared archive files", async () => {
    const created = await createPortableAgentPackage(draft, files);
    const entries = unzipSync(created.bytes);
    entries["wasmhatch-agent/files/extra.txt"] = strToU8("extra\n");

    await expect(readPortableAgentPackage(zipSync(entries))).rejects.toThrow("undeclared file");
  });

  it("fails closed on unknown manifest fields", async () => {
    const created = await createPortableAgentPackage(draft, files);
    expect(() => validatePortableAgentManifest({ ...created.manifest, billing: "platform" }))
      .toThrow("missing or unsupported fields");
  });

  it("loads a package from a generic HTTPS source", async () => {
    const created = await createPortableAgentPackage(draft, files);
    const fetcher = vi.fn().mockResolvedValue(new Response(Uint8Array.from(created.bytes).buffer, {
      status: 200,
      headers: { "content-type": PORTABLE_AGENT_MEDIA_TYPE },
    }));

    const restored = await fetchPortableAgentPackage("https://agents.example/weekly-brief.zip", { fetch: fetcher });

    expect(restored.manifest.id).toBe("weekly-brief");
    expect(fetcher).toHaveBeenCalledWith(
      new URL("https://agents.example/weekly-brief.zip"),
      expect.objectContaining({ headers: { Accept: PORTABLE_AGENT_MEDIA_TYPE } })
    );
  });

  it("rejects insecure remote and credential-bearing URLs", async () => {
    await expect(fetchPortableAgentPackage("http://agents.example/agent.zip", { fetch: vi.fn() }))
      .rejects.toThrow("must use HTTPS");
    await expect(fetchPortableAgentPackage("https://token@agents.example/agent.zip", { fetch: vi.fn() }))
      .rejects.toThrow("must use HTTPS");
  });
});
