import { strToU8, unzipSync, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import type { WorkspaceFile, WorkspaceStore } from "./workspace";
import {
  createOperatorWorkspaceBundle,
  executeOperatorWorkspaceClear,
  executeOperatorWorkspaceRestore,
  OperatorWorkspaceRestoreUncertainError,
  prepareOperatorWorkspaceClear,
  prepareOperatorWorkspaceRestore,
  readOperatorWorkspaceBundle
} from "./operator-workspace-bundle";

function memoryStore(initial: WorkspaceFile[], replace?: (files: WorkspaceFile[], attempt: number) => void | Promise<void>) {
  let files = new Map(initial.map((file) => [file.path, file.content]));
  let attempts = 0;
  const store: WorkspaceStore = {
    backend: "local-storage",
    listFiles: async () => [...files.keys()].sort(),
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
      attempts += 1;
      if (replace) await replace(next, attempts);
      files = new Map(next.map((file) => [file.path, file.content]));
    },
    clear: async () => files.clear()
  };
  return { store, current: () => Object.fromEntries(files) };
}

const TABULAR_SNAPSHOT = `${JSON.stringify({
  schema: "wasmhatch.tabular-snapshot.v1",
  provenance: {
    sourceName: "pipeline.csv",
    mediaType: "text/csv",
    sourceBytes: 16,
    sourceSha256: "b".repeat(64),
    format: "csv",
    sheetName: "CSV",
    sheets: [{ name: "CSV", visibility: "visible" }],
    hiddenSheets: 0,
    rows: 2,
    columns: 1,
    cells: 2,
    formulaCells: 0,
    externalLinks: 0,
    warnings: []
  },
  rows: [["Owner"], ["Aya"]]
}, null, 2)}\n`;

const FILES = [
  { path: "inputs/pipeline.json", content: TABULAR_SNAPSHOT },
  { path: "work/pipeline-approved.json", content: TABULAR_SNAPSHOT.replace('"Aya"', '"AYA"') },
  { path: "scripts/pipeline.js", content: "() => null\n" },
  { path: "workflows/pipeline.json", content: "{\"schemaVersion\":1}\n" },
  { path: "outputs/report.md", content: "# Pipeline\n" }
];
const POLICY_DECISION_ID = `policy_decision_${"a".repeat(32)}`;

describe("operator workspace bundle", () => {
  it("round-trips exact portable artifacts with hashes and active context", async () => {
    const source = memoryStore(FILES);
    const exported = await createOperatorWorkspaceBundle(source.store, {
      activeArtifactPath: "inputs/pipeline.json",
      exportedAt: "2026-07-12T00:00:00.000Z"
    });
    const parsed = await readOperatorWorkspaceBundle(exported.bytes);
    expect(exported.fileName).toBe("wasmhatch-operator-workspace-2026-07-12.zip");
    expect(parsed.files).toEqual([...FILES].sort((left, right) => left.path.localeCompare(right.path)));
    expect(parsed.manifest.activeArtifactPath).toBe("inputs/pipeline.json");
    expect(parsed.manifest.files.every((file) => /^sha256:[a-f0-9]{64}$/.test(file.sha256))).toBe(true);
    expect(Object.isFrozen(parsed.manifest)).toBe(true);
  });

  it("round-trips an approved work snapshot as the active tabular artifact", async () => {
    const source = memoryStore(FILES);
    const exported = await createOperatorWorkspaceBundle(source.store, {
      activeArtifactPath: "work/pipeline-approved.json",
      exportedAt: "2026-07-12T00:00:00.000Z"
    });
    const parsed = await readOperatorWorkspaceBundle(exported.bytes);
    expect(parsed.manifest.activeArtifactPath).toBe("work/pipeline-approved.json");
    expect(parsed.files.find((file) => file.path === parsed.manifest.activeArtifactPath)?.content).toContain("AYA");
  });

  it("rejects protected, unsupported, and outside-root files before export", async () => {
    await expect(createOperatorWorkspaceBundle(memoryStore([{ path: "inputs/.env", content: "secret" }]).store))
      .rejects.toThrow("protected credential material");
    await expect(createOperatorWorkspaceBundle(memoryStore([{ path: "README.md", content: "legacy" }]).store))
      .rejects.toThrow("outside the portable roots");
    await expect(createOperatorWorkspaceBundle(memoryStore([{ path: "inputs/data.xlsx", content: "binary" }]).store))
      .rejects.toThrow("type is unsupported");
    await expect(createOperatorWorkspaceBundle(
      memoryStore([{ path: "inputs/data.json", content: "{}\n" }]).store,
      { activeArtifactPath: "inputs/data.json" }
    )).rejects.toThrow("missing or unsupported fields");
  });

  it("rejects archive traversal, extra entries, and content that does not match the manifest", async () => {
    const exported = await createOperatorWorkspaceBundle(memoryStore(FILES).store, { exportedAt: "2026-07-12T00:00:00.000Z" });
    await expect(readOperatorWorkspaceBundle(zipSync({ "../manifest.json": strToU8("{}") })))
      .rejects.toThrow("unsafe path");
    const extra = unzipSync(exported.bytes);
    extra["wasmhatch-operator-workspace/extra.txt"] = strToU8("extra");
    await expect(readOperatorWorkspaceBundle(zipSync(extra))).rejects.toThrow("unexpected entry");
    const tampered = unzipSync(exported.bytes);
    tampered["wasmhatch-operator-workspace/files/inputs/pipeline.json"] = strToU8("tampered\n");
    await expect(readOperatorWorkspaceBundle(zipSync(tampered))).rejects.toThrow("identity does not match");
  });

  it("validates the complete bundle before replacing any current file", async () => {
    const target = memoryStore([{ path: "outputs/existing.md", content: "keep\n" }]);
    await expect(prepareOperatorWorkspaceRestore(target.store, strToU8("not a zip"), POLICY_DECISION_ID)).rejects.toThrow("not a valid archive");
    expect(target.current()).toEqual({ "outputs/existing.md": "keep\n" });
  });

  it("replaces stale files exactly and verifies the restored workspace", async () => {
    const exported = await createOperatorWorkspaceBundle(memoryStore(FILES).store, { exportedAt: "2026-07-12T00:00:00.000Z" });
    const target = memoryStore([{ path: "outputs/stale.md", content: "stale\n" }]);
    const proposal = await prepareOperatorWorkspaceRestore(target.store, exported.bytes, POLICY_DECISION_ID);
    const restored = await executeOperatorWorkspaceRestore(target.store, exported.bytes, proposal);
    expect(target.current()).toEqual(Object.fromEntries(FILES.map((file) => [file.path, file.content])));
    expect(restored).toMatchObject({ status: "committed", receipt: { files: FILES.length } });
  });

  it("rolls back and verifies the prior workspace after a failed replacement", async () => {
    const exported = await createOperatorWorkspaceBundle(memoryStore(FILES).store, { exportedAt: "2026-07-12T00:00:00.000Z" });
    const target = memoryStore([{ path: "outputs/existing.md", content: "keep\n" }], async (_files, attempt) => {
      if (attempt === 1) throw new Error("simulated replacement failure");
    });
    const proposal = await prepareOperatorWorkspaceRestore(target.store, exported.bytes, POLICY_DECISION_ID);
    await expect(executeOperatorWorkspaceRestore(target.store, exported.bytes, proposal)).rejects.toThrow("previous workspace was restored and verified");
    expect(target.current()).toEqual({ "outputs/existing.md": "keep\n" });
  });

  it("reports an uncertain restore when rollback cannot be verified", async () => {
    const exported = await createOperatorWorkspaceBundle(memoryStore(FILES).store, { exportedAt: "2026-07-12T00:00:00.000Z" });
    const target = memoryStore([{ path: "outputs/existing.md", content: "keep\n" }], async () => {
      throw new Error("all replacements fail");
    });
    const proposal = await prepareOperatorWorkspaceRestore(target.store, exported.bytes, POLICY_DECISION_ID);
    await expect(executeOperatorWorkspaceRestore(target.store, exported.bytes, proposal)).rejects.toBeInstanceOf(OperatorWorkspaceRestoreUncertainError);
  });

  it("binds a restore review to both archive and current workspace identities", async () => {
    const exported = await createOperatorWorkspaceBundle(memoryStore(FILES).store, { exportedAt: "2026-07-12T00:00:00.000Z" });
    const target = memoryStore([{ path: "outputs/existing.md", content: "keep\n" }]);
    const proposal = await prepareOperatorWorkspaceRestore(target.store, exported.bytes, POLICY_DECISION_ID);
    expect(proposal.proposalId).toMatch(/^workspace_restore_[a-f0-9]{64}$/);
    expect(proposal.archiveSha256).toMatch(/^sha256:[a-f0-9]{64}$/);

    await target.store.writeFile("outputs/newer.md", "newer\n");
    await expect(executeOperatorWorkspaceRestore(target.store, exported.bytes, proposal)).resolves.toMatchObject({
      status: "conflict",
      expectedBaseSha256: proposal.base.sha256
    });
    expect(target.current()).toMatchObject({ "outputs/existing.md": "keep\n", "outputs/newer.md": "newer\n" });
  });

  it("commits an exact reviewed restore and returns a deterministic receipt", async () => {
    const exported = await createOperatorWorkspaceBundle(memoryStore(FILES).store, { exportedAt: "2026-07-12T00:00:00.000Z" });
    const target = memoryStore([{ path: "outputs/existing.md", content: "keep\n" }]);
    const proposal = await prepareOperatorWorkspaceRestore(target.store, exported.bytes, POLICY_DECISION_ID);
    const outcome = await executeOperatorWorkspaceRestore(target.store, exported.bytes, proposal);
    expect(outcome).toMatchObject({
      status: "committed",
      proposalId: proposal.proposalId,
      receipt: { operation: "restore-operator-workspace", files: FILES.length, activeArtifactPath: null }
    });
    if (outcome.status === "committed") expect(outcome.receipt.receiptId).toMatch(/^workspace_receipt_[a-f0-9]{64}$/);
  });

  it("stages clear as an exact reviewed file set and rejects stale approval", async () => {
    const target = memoryStore(FILES);
    const proposal = await prepareOperatorWorkspaceClear(target.store, POLICY_DECISION_ID);
    expect(proposal.proposalId).toMatch(/^workspace_clear_[a-f0-9]{64}$/);
    await target.store.writeFile("outputs/newer.md", "newer\n");
    await expect(executeOperatorWorkspaceClear(target.store, proposal)).resolves.toMatchObject({ status: "conflict" });
    expect(target.current()).toHaveProperty("outputs/newer.md");
  });

  it("clears only the exact reviewed workspace and verifies the empty result", async () => {
    const target = memoryStore(FILES);
    const proposal = await prepareOperatorWorkspaceClear(target.store, POLICY_DECISION_ID);
    const outcome = await executeOperatorWorkspaceClear(target.store, proposal);
    expect(outcome).toMatchObject({
      status: "committed",
      receipt: { operation: "clear-operator-workspace", files: FILES.length }
    });
    expect(target.current()).toEqual({});
  });
});
