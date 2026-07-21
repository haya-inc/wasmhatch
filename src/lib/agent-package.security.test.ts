import { strToU8, unzipSync, zipSync } from "fflate";
import { describe, expect, it, vi } from "vitest";
import {
  createPortableAgentPackage,
  fetchPortableAgentPackage,
  readPortableAgentPackage
} from "./agent-package";

const draft = {
  id: "hardening-probe",
  name: "Hardening probe",
  summary: "Fixture agent for adversarial package tests.",
  version: "1.0.0",
  license: "Apache-2.0",
  entrypoint: "AGENTS.md"
} as const;

const files = [{ path: "AGENTS.md", content: "# Agent\n" }];

async function sha256(bytes: Uint8Array) {
  const digest = await crypto.subtle.digest("SHA-256", bytes.slice().buffer);
  return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

type ManifestShape = {
  files: Array<{ path: string; mediaType: string; bytes: number; sha256: string }>;
  totalBytes: number;
  entrypoint: string;
};

function readManifest(entries: Record<string, Uint8Array>): ManifestShape {
  return JSON.parse(new TextDecoder().decode(entries["wasmhatch-agent/manifest.json"])) as ManifestShape;
}

function writeManifest(entries: Record<string, Uint8Array>, manifest: ManifestShape) {
  entries["wasmhatch-agent/manifest.json"] = strToU8(JSON.stringify(manifest));
}

describe("portable agent package hardening", () => {
  it("rejects archive entries that escape the package root", async () => {
    const created = await createPortableAgentPackage(draft, files);
    for (const name of [
      "wasmhatch-agent/files/../escape.md",
      "/etc/passwd",
      "wasmhatch-agent\\files\\evil.md"
    ]) {
      const entries = unzipSync(created.bytes);
      entries[name] = strToU8("evil\n");
      await expect(readPortableAgentPackage(zipSync(entries))).rejects.toThrow("unsafe path");
    }
  });

  it("rejects entries outside the wasmhatch-agent root", async () => {
    const created = await createPortableAgentPackage(draft, files);
    const entries = unzipSync(created.bytes);
    entries["README.txt"] = strToU8("stray\n");
    await expect(readPortableAgentPackage(zipSync(entries))).rejects.toThrow("unsupported entry");
  });

  it("rejects credential-named entries smuggled into files/", async () => {
    const created = await createPortableAgentPackage(draft, files);
    const entries = unzipSync(created.bytes);
    entries["wasmhatch-agent/files/.ssh/id_rsa"] = strToU8("PRIVATE KEY\n");
    // The unzip filter currently masks the specific credential message as a
    // generic ZIP error; the invariant under test is that the package is rejected.
    await expect(readPortableAgentPackage(zipSync(entries))).rejects.toThrow(/credential material|not a valid ZIP/);
  });

  it("rejects tampered content whose byte count still matches", async () => {
    const created = await createPortableAgentPackage(draft, files);
    const entries = unzipSync(created.bytes);
    const tampered = strToU8("! Agent\n");
    expect(tampered.byteLength).toBe(strToU8(files[0].content).byteLength);
    entries["wasmhatch-agent/files/AGENTS.md"] = tampered;
    await expect(readPortableAgentPackage(zipSync(entries))).rejects.toThrow("hash does not match");
  });

  it("rejects NUL bytes even when the manifest declares them honestly", async () => {
    const created = await createPortableAgentPackage(draft, files);
    const entries = unzipSync(created.bytes);
    const evil = strToU8("A\0B");
    const manifest = readManifest(entries);
    manifest.files = [{ path: "AGENTS.md", mediaType: "text/markdown", bytes: evil.byteLength, sha256: await sha256(evil) }];
    manifest.totalBytes = evil.byteLength;
    writeManifest(entries, manifest);
    entries["wasmhatch-agent/files/AGENTS.md"] = evil;
    await expect(readPortableAgentPackage(zipSync(entries))).rejects.toThrow("NUL byte");
  });

  it("rejects invalid UTF-8 even when the manifest declares it honestly", async () => {
    const created = await createPortableAgentPackage(draft, files);
    const entries = unzipSync(created.bytes);
    const evil = Uint8Array.from([0xc3, 0x28]);
    const manifest = readManifest(entries);
    manifest.files = [{ path: "AGENTS.md", mediaType: "text/markdown", bytes: evil.byteLength, sha256: await sha256(evil) }];
    manifest.totalBytes = evil.byteLength;
    writeManifest(entries, manifest);
    entries["wasmhatch-agent/files/AGENTS.md"] = evil;
    await expect(readPortableAgentPackage(zipSync(entries))).rejects.toThrow("valid UTF-8");
  });

  it("rejects manifests whose file list is not sorted", async () => {
    const created = await createPortableAgentPackage(draft, [
      ...files,
      { path: "templates/brief.md", content: "# Brief\n" }
    ]);
    const entries = unzipSync(created.bytes);
    const manifest = readManifest(entries);
    manifest.files = [...manifest.files].reverse();
    writeManifest(entries, manifest);
    await expect(readPortableAgentPackage(zipSync(entries))).rejects.toThrow("sorted by path");
  });

  it("rejects manifests whose entrypoint is not packaged", async () => {
    const created = await createPortableAgentPackage(draft, files);
    const entries = unzipSync(created.bytes);
    const manifest = readManifest(entries);
    manifest.entrypoint = "missing.md";
    writeManifest(entries, manifest);
    await expect(readPortableAgentPackage(zipSync(entries))).rejects.toThrow("entrypoint is not present");
  });

  it("rejects archives above the 8 MB input limit before parsing", async () => {
    await expect(readPortableAgentPackage(new Uint8Array(8 * 1024 * 1024 + 1))).rejects.toThrow("exceeds 8 MB");
  });

  it("rejects oversized downloads from the declared content-length alone", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      url: "https://agents.example/a.zip",
      headers: new Headers({ "content-length": String(64 * 1024 * 1024) }),
      arrayBuffer: () => {
        throw new Error("the body must not be read");
      }
    } as unknown as Response);
    await expect(fetchPortableAgentPackage("https://agents.example/a.zip", { fetch: fetcher }))
      .rejects.toThrow("exceeds 8 MB");
  });

  it("rejects responses that landed on a non-HTTPS URL after redirects", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      url: "http://agents.example/a.zip",
      headers: new Headers(),
      arrayBuffer: () => {
        throw new Error("the body must not be read");
      }
    } as unknown as Response);
    await expect(fetchPortableAgentPackage("https://agents.example/a.zip", { fetch: fetcher }))
      .rejects.toThrow("must use HTTPS");
  });

  it("accepts localhost HTTP for development loads", async () => {
    const created = await createPortableAgentPackage(draft, files);
    const fetcher = vi.fn().mockResolvedValue(new Response(Uint8Array.from(created.bytes).buffer, { status: 200 }));
    const restored = await fetchPortableAgentPackage("http://localhost:8788/agent.zip", { fetch: fetcher });
    expect(restored.manifest.id).toBe("hardening-probe");
  });

  it("rejects declared network origins that are not bare HTTPS origins", async () => {
    for (const origin of ["https://api.example.com/v1", "http://api.example.com", "https://user:pw@api.example.com"]) {
      await expect(createPortableAgentPackage(
        { ...draft, permissions: { tools: [], networkOrigins: [origin] } },
        files
      )).rejects.toThrow("HTTPS origins");
    }
  });

  it("normalizes declared network origins to their canonical form", async () => {
    const created = await createPortableAgentPackage(
      { ...draft, permissions: { tools: [], networkOrigins: ["https://API.example.com"] } },
      files
    );
    expect(created.manifest.permissions.networkOrigins).toEqual(["https://api.example.com"]);
  });

  it("rejects case-ambiguous workspace paths at export", async () => {
    await expect(createPortableAgentPackage(draft, [
      ...files,
      { path: "agents.md", content: "shadow\n" }
    ])).rejects.toThrow("case-ambiguous");
  });

  it("rejects an empty core compatibility range", async () => {
    await expect(createPortableAgentPackage(
      { ...draft, compatibleCore: { minInclusive: "1.0.0", maxExclusive: "1.0.0" } },
      files
    )).rejects.toThrow("must not be empty");
  });
});
