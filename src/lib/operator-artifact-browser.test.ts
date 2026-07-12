import { describe, expect, it } from "vitest";
import {
  listOperatorArtifacts,
  OPERATOR_ARTIFACT_BROWSER_LIMITS,
  prepareOperatorArtifactAttachment,
  readOperatorArtifactPreview,
  verifyOperatorArtifactAttachment
} from "./operator-artifact-browser";
import { normalizedArtifactJson } from "./tabular-artifact-persistence";
import type { WorkspaceStore } from "./workspace";

function createStore(initial: Record<string, string>) {
  const files = new Map(Object.entries(initial));
  const store: WorkspaceStore = {
    backend: "local-storage",
    listFiles: async () => [...files.keys()],
    listBaselineFiles: async () => [],
    readFile: async (path) => {
      const content = files.get(path);
      if (content === undefined) throw new Error(`File not found: ${path}`);
      return content;
    },
    readBaselineFile: async () => { throw new Error("No baseline"); },
    writeFile: async (path, content) => { files.set(path, content); },
    replaceBaseline: async () => undefined,
    replaceAll: async (next) => {
      files.clear();
      next.forEach((file) => files.set(file.path, file.content));
    },
    clear: async () => files.clear()
  };
  return { store, files };
}

function tabularSnapshot() {
  return normalizedArtifactJson({
    provenance: {
      sourceName: "pipeline.csv",
      mediaType: "text/csv",
      sourceBytes: 20,
      sourceSha256: "a".repeat(64),
      format: "csv",
      sheetName: "CSV",
      sheets: [{ name: "CSV", visibility: "visible" }],
      hiddenSheets: 0,
      rows: 2,
      columns: 2,
      cells: 4,
      formulaCells: 0,
      externalLinks: 0,
      warnings: []
    },
    rows: [["Name", "Amount"], ["Aya", 1200]]
  });
}

describe("operator artifact browser", () => {
  it("indexes canonical portable artifacts with exact metadata and tabular identity", async () => {
    const snapshot = tabularSnapshot();
    const { store } = createStore({
      "outputs/report.md": "# Report\n\nReady.\n",
      "inputs/pipeline.json": snapshot,
      "scripts/normalize.js": "export default () => 1;\n"
    });

    const index = await listOperatorArtifacts(store);
    expect(index.files.map((file) => file.path)).toEqual([
      "inputs/pipeline.json",
      "outputs/report.md",
      "scripts/normalize.js"
    ]);
    expect(index.files[0]).toMatchObject({
      root: "inputs",
      name: "pipeline.json",
      kind: "json",
      mediaType: "application/json",
      bytes: new TextEncoder().encode(snapshot).byteLength,
      tabularSnapshot: true
    });
    expect(index.files[0].sha256).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(index.totalBytes).toBe(index.files.reduce((total, file) => total + file.bytes, 0));
    expect(Object.isFrozen(index)).toBe(true);
  });

  it("previews no more than 24 KB and 200 lines on complete UTF-8 boundaries", async () => {
    const content = Array.from({ length: 240 }, (_, index) => `${index + 1} あ${"x".repeat(180)}`).join("\n");
    const { store } = createStore({ "outputs/report.md": content });

    const preview = await readOperatorArtifactPreview(store, "outputs/report.md");
    expect(preview.previewBytes).toBeLessThanOrEqual(OPERATOR_ARTIFACT_BROWSER_LIMITS.previewBytes);
    expect(preview.previewLines).toBeLessThanOrEqual(OPERATOR_ARTIFACT_BROWSER_LIMITS.previewLines);
    expect(preview.content).not.toContain("�");
    expect(preview.truncated).toBe(true);
    expect(preview.artifact.bytes).toBeGreaterThan(preview.previewBytes);
  });

  it("binds an AI attachment to the reviewed file identity and rejects a later edit", async () => {
    const { store, files } = createStore({ "outputs/report.md": "# Reviewed\n" });
    const attachment = await prepareOperatorArtifactAttachment(store, "outputs/report.md");
    expect(await verifyOperatorArtifactAttachment(store, attachment)).toEqual(attachment);

    files.set("outputs/report.md", "# Changed\n");
    await expect(verifyOperatorArtifactAttachment(store, attachment)).rejects.toThrow("changed after AI attachment review");
  });

  it("rejects unsupported paths, protected material, NUL data, and oversized AI attachments", async () => {
    await expect(listOperatorArtifacts(createStore({ "other/report.md": "x" }).store)).rejects.toThrow("outside the portable roots");
    await expect(listOperatorArtifacts(createStore({ "inputs/.env": "SECRET=x" }).store)).rejects.toThrow("protected credential material");
    await expect(listOperatorArtifacts(createStore({ "outputs/report.txt": "bad\0data" }).store)).rejects.toThrow("NUL byte");
    await expect(listOperatorArtifacts(createStore({ "outputs/Report.md": "A", "outputs/report.md": "B" }).store)).rejects.toThrow("case-ambiguous");
    await expect(prepareOperatorArtifactAttachment(
      createStore({ "outputs/large.txt": "x".repeat(OPERATOR_ARTIFACT_BROWSER_LIMITS.attachmentBytes + 1) }).store,
      "outputs/large.txt"
    )).rejects.toThrow("512 KB AI attachment limit");
  });
});
