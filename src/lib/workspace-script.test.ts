import { describe, expect, it } from "vitest";
import type { WorkspaceStore } from "./workspace";
import {
  WORKSPACE_SCRIPT_DEFAULT_LIMITS,
  serializeWorkspaceScriptManifest,
  validateWorkspaceScriptManifest,
  type WorkspaceScriptManifest
} from "./workspace-script-contract";
import { prepareWorkspaceScriptRun } from "./workspace-script";
import { executeWorkspaceScript } from "./workspace-script-runtime";
import {
  decideWorkspaceFileEffect,
  executeWorkspaceFileEffect,
  prepareWorkspaceFileEffects,
  workspaceFileEffectDiff
} from "./workspace-file-effect";
import { createTabularWorkspaceScriptDefinition } from "./tabular-workspace-script";
import type { TabularArtifactProvenance } from "./tabular-artifact-contract";

const SOURCE = `({ fs, args }) => {
  const input = JSON.parse(fs.readText("/inputs/data.json"));
  fs.writeText("/outputs/report.md", "# " + args.title + "\\n\\nRows: " + input.rows.length + "\\n");
  return { rows: input.rows.length, files: fs.list("/inputs/") };
}`;

function manifest(overrides: Partial<WorkspaceScriptManifest> = {}): WorkspaceScriptManifest {
  return {
    schemaVersion: 1,
    id: "pipeline-report",
    version: "1.0.0",
    sourcePath: "scripts/pipeline-report.js",
    inputs: [{
      workspacePath: "inputs/data.json",
      mountPath: "/inputs/data.json",
      mediaType: "application/json",
      maxBytes: 128 * 1024
    }],
    outputs: [{
      workspacePath: "outputs/report.md",
      mountPath: "/outputs/report.md",
      mediaType: "text/markdown",
      maxBytes: 64 * 1024,
      required: true
    }],
    limits: {
      ...WORKSPACE_SCRIPT_DEFAULT_LIMITS,
      maxTotalInputBytes: 128 * 1024,
      maxTotalOutputBytes: 64 * 1024
    },
    ...overrides
  };
}

function createStore(initial: Record<string, string>, write?: (path: string, content: string, files: Map<string, string>) => void | Promise<void>) {
  const files = new Map(Object.entries(initial));
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
    writeFile: async (path, content) => {
      if (write) await write(path, content, files);
      else files.set(path, content);
    },
    replaceBaseline: async () => undefined,
    replaceAll: async () => undefined,
    clear: async () => files.clear()
  };
  return { store, files };
}

function initialFiles(
  extra: Record<string, string> = {},
  scriptManifest: WorkspaceScriptManifest = manifest()
) {
  return {
    "workflows/pipeline-report.json": serializeWorkspaceScriptManifest(scriptManifest),
    "scripts/pipeline-report.js": SOURCE,
    "inputs/data.json": JSON.stringify({ rows: [["name"], ["Aya"], ["Ken"]] }),
    ...extra
  };
}

describe("workspace script manifests", () => {
  it("validates and freezes exact source, input, output, media, and resource grants", () => {
    const validated = validateWorkspaceScriptManifest(manifest());

    expect(validated.sourcePath).toBe("scripts/pipeline-report.js");
    expect(validated.inputs[0].mountPath).toBe("/inputs/data.json");
    expect(validated.outputs[0].workspacePath).toBe("outputs/report.md");
    expect(Object.isFrozen(validated)).toBe(true);
    expect(Object.isFrozen(validated.inputs[0])).toBe(true);
    expect(JSON.parse(serializeWorkspaceScriptManifest(validated))).toEqual(validated);
  });

  it("rejects unknown fields, traversal, credential paths, duplicate mounts, and excessive aggregate grants", () => {
    const unknown = { ...manifest(), network: true };
    expect(() => validateWorkspaceScriptManifest(unknown)).toThrow("missing or unsupported fields");
    expect(() => validateWorkspaceScriptManifest(manifest({ sourcePath: "../escape.js" }))).toThrow("Path traversal");
    expect(() => validateWorkspaceScriptManifest(manifest({
      inputs: [{ workspacePath: "inputs/.env", mountPath: "/inputs/env", mediaType: "text/plain", maxBytes: 1 }]
    }))).toThrow("protected credential path");
    expect(() => validateWorkspaceScriptManifest(manifest({
      inputs: [
        { workspacePath: "inputs/a.json", mountPath: "/inputs/same", mediaType: "application/json", maxBytes: 64 * 1024 },
        { workspacePath: "inputs/b.json", mountPath: "/inputs/same", mediaType: "application/json", maxBytes: 64 * 1024 }
      ]
    }))).toThrow("input mounts contains duplicates");
    expect(() => validateWorkspaceScriptManifest(manifest({
      limits: { ...WORKSPACE_SCRIPT_DEFAULT_LIMITS, maxTotalInputBytes: 256 * 1024 }
    }))).toThrow("cannot exceed the sum");
  });
});

describe("workspace script snapshot and virtual mount", () => {
  it("snapshots granted inputs and output bases, then exposes only the ephemeral mount", async () => {
    const { store } = createStore(initialFiles());
    const snapshot = await prepareWorkspaceScriptRun(store, manifest(), { title: "Pipeline" });
    const result = await executeWorkspaceScript(snapshot);

    expect(snapshot.runId).toMatch(/^run_[a-f0-9]{64}$/);
    expect(snapshot.sourceSha256).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(snapshot.inputs[0]).toMatchObject({
      workspacePath: "inputs/data.json",
      mountPath: "/inputs/data.json"
    });
    expect(snapshot.outputBases[0]).toMatchObject({ before: null, baseSha256: "missing" });
    expect(result.value).toEqual({ rows: 3, files: ["/inputs/data.json"] });
    expect(result.outputs).toEqual([{
      workspacePath: "outputs/report.md",
      mountPath: "/outputs/report.md",
      mediaType: "text/markdown",
      content: "# Pipeline\n\nRows: 3\n",
      bytes: 20
    }]);
    expect(result.inputBytes).toBeGreaterThan(0);
  });

  it("blocks undeclared reads, writes, missing required outputs, async scripts, and ambient network access", async () => {
    const cases = [
      { source: `({ fs }) => fs.readText("/inputs/not-granted.txt")`, message: "not granted" },
      { source: `({ fs }) => fs.writeText("/outputs/not-granted.txt", "x")`, message: "not granted" },
      { source: `() => "no output"`, message: "Required virtual output" },
      { source: `async () => "later"`, message: "Async workspace scripts" },
      { source: `({ fs }) => { fs.writeText("/outputs/report.md", typeof fetch); return null; }`, message: null }
    ];
    for (const item of cases) {
      const { store } = createStore({ ...initialFiles(), "scripts/pipeline-report.js": item.source });
      const snapshot = await prepareWorkspaceScriptRun(store, manifest());
      if (item.message) await expect(executeWorkspaceScript(snapshot)).rejects.toThrow(item.message);
      else expect((await executeWorkspaceScript(snapshot)).outputs[0].content).toBe("undefined");
    }
  });

  it("rejects changed or oversized granted files at snapshot time", async () => {
    const oversizedManifest = manifest({
      inputs: [{ workspacePath: "inputs/large.txt", mountPath: "/inputs/large.txt", mediaType: "text/plain", maxBytes: 10 }],
      limits: { ...WORKSPACE_SCRIPT_DEFAULT_LIMITS, maxTotalInputBytes: 10, maxTotalOutputBytes: 64 * 1024 }
    });
    const { store } = createStore(initialFiles({ "inputs/large.txt": "x".repeat(20) }, oversizedManifest));
    await expect(prepareWorkspaceScriptRun(store, oversizedManifest)).rejects.toThrow("exceeds its 10-byte limit");
  });
});

describe("tabular workspace script definition", () => {
  it("saves an inspectable wrapper that transforms only the granted snapshot and stages one declared output", async () => {
    const provenance: TabularArtifactProvenance = {
      sourceName: "pipeline.csv",
      mediaType: "text/csv",
      sourceBytes: 32,
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
    };
    const definition = createTabularWorkspaceScriptDefinition({
      provenance,
      inputPath: "inputs/pipeline--CSV--aaaaaaaaaaaa.json",
      transformSource: "(rows) => rows.map((row, index) => index ? [String(row[0]).toUpperCase(), Number(row[1])] : row)"
    });
    const input = `${JSON.stringify({
      schema: "wasmhatch.tabular-snapshot.v1",
      provenance,
      rows: [["name", "amount"], ["aya", "10"]]
    })}\n`;
    const { store, files } = createStore({
      [definition.manifestPath]: serializeWorkspaceScriptManifest(definition.manifest),
      [definition.manifest.sourcePath]: definition.source,
      [definition.manifest.inputs[0].workspacePath]: input
    });
    const snapshot = await prepareWorkspaceScriptRun(store, definition.manifest);
    const result = await executeWorkspaceScript(snapshot);
    const output = JSON.parse(result.outputs[0].content) as { schema: string; rows: unknown[][] };

    expect(definition.manifestPath).toBe("workflows/tabular-aaaaaaaaaaaa.json");
    expect(definition.outputPath).toBe("outputs/tabular-aaaaaaaaaaaa-CSV.json");
    expect(output).toMatchObject({
      schema: "wasmhatch.tabular-output.v1",
      rows: [["name", "amount"], ["AYA", 10]]
    });
    expect(files.has(definition.outputPath)).toBe(false);
  });
});

describe("workspace file effects", () => {
  async function prepared(extra: Record<string, string> = {}) {
    const state = createStore(initialFiles(extra));
    const snapshot = await prepareWorkspaceScriptRun(state.store, manifest(), { title: "Pipeline" });
    const execution = await executeWorkspaceScript(snapshot);
    const proposals = await prepareWorkspaceFileEffects(snapshot, execution, "foreground-explicit-approval-v1");
    return { ...state, snapshot, execution, proposal: proposals[0] };
  }

  it("binds source, input hashes, base content, output bytes, and policy into one reviewable proposal", async () => {
    const { proposal } = await prepared();

    expect(proposal.proposalId).toMatch(/^file_effect_[a-f0-9]{64}$/);
    expect(proposal.run.manifestPath).toBe("workflows/pipeline-report.json");
    expect(proposal.run.manifestSha256).toMatch(/^sha256:/);
    expect(proposal.run.inputs[0].sha256).toMatch(/^sha256:/);
    expect(proposal.base).toEqual({ existed: false, content: null, sha256: "missing" });
    expect(proposal.output.content).toBe("# Pipeline\n\nRows: 3\n");
    expect(workspaceFileEffectDiff(proposal)).toContain("+++ b/outputs/report.md");
    expect(Object.isFrozen(proposal)).toBe(true);
  });

  it("commits only the exactly approved proposal and returns a verifiable receipt", async () => {
    const { proposal, store, files } = await prepared();
    const outcome = await executeWorkspaceFileEffect(
      proposal,
      decideWorkspaceFileEffect(proposal, "approve", "foreground-user"),
      store
    );

    expect(outcome.status).toBe("committed");
    expect(files.get("outputs/report.md")).toBe("# Pipeline\n\nRows: 3\n");
    if (outcome.status === "committed") {
      expect(outcome.receipt.receiptId).toMatch(/^file_receipt_[a-f0-9]{64}$/);
      expect(outcome.receipt.preconditionStrength).toBe("recheck");
    }
  });

  it("rejects without writing and blocks stale or edited proposals", async () => {
    const rejected = await prepared();
    expect((await executeWorkspaceFileEffect(
      rejected.proposal,
      decideWorkspaceFileEffect(rejected.proposal, "reject", "foreground-user"),
      rejected.store
    )).status).toBe("rejected");
    expect(rejected.files.has("outputs/report.md")).toBe(false);

    const stale = await prepared();
    stale.files.set("outputs/report.md", "newer user edit\n");
    const conflict = await executeWorkspaceFileEffect(
      stale.proposal,
      decideWorkspaceFileEffect(stale.proposal, "approve", "foreground-user"),
      stale.store
    );
    expect(conflict.status).toBe("conflict");
    expect(stale.files.get("outputs/report.md")).toBe("newer user edit\n");

    const edited = await prepared();
    const tampered = JSON.parse(JSON.stringify(edited.proposal));
    tampered.output.content = "tampered";
    const failed = await executeWorkspaceFileEffect(
      tampered,
      decideWorkspaceFileEffect(edited.proposal, "approve", "foreground-user"),
      edited.store
    );
    expect(failed).toMatchObject({ status: "failed", retryable: false });
  });

  it.each([
    ["manifest", "workflows/pipeline-report.json"],
    ["source", "scripts/pipeline-report.js"],
    ["input", "inputs/data.json"]
  ])("blocks a stale %s dependency before writing", async (_label, resourcePath) => {
    const state = await prepared();
    state.files.set(resourcePath, "changed after review\n");

    const outcome = await executeWorkspaceFileEffect(
      state.proposal,
      decideWorkspaceFileEffect(state.proposal, "approve", "foreground-user"),
      state.store
    );

    expect(outcome).toMatchObject({ status: "conflict", resourcePath });
    expect(state.files.has("outputs/report.md")).toBe(false);
  });

  it("classifies an unverified partial local write as uncertain", async () => {
    const base = await prepared({ "outputs/report.md": "old\n" });
    const uncertainStore = createStore(initialFiles({ "outputs/report.md": "old\n" }), async (path, _content, files) => {
      files.set(path, "partial\n");
      throw new Error("disk interrupted");
    }).store;
    const outcome = await executeWorkspaceFileEffect(
      base.proposal,
      decideWorkspaceFileEffect(base.proposal, "approve", "foreground-user"),
      uncertainStore
    );

    expect(outcome).toMatchObject({ status: "uncertain", reconciliationRequired: true });
  });
});
