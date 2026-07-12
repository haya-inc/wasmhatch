import type { TabularArtifactProvenance } from "./tabular-artifact-contract";
import {
  WORKSPACE_SCRIPT_DEFAULT_LIMITS,
  validateWorkspaceScriptManifest,
  type WorkspaceScriptManifest
} from "./workspace-script-contract";
import { workspaceScriptDefinitionPath } from "./workspace-script";

export interface TabularWorkspaceScriptDefinition {
  manifest: WorkspaceScriptManifest;
  manifestPath: string;
  source: string;
  outputPath: string;
}

function safePathPart(value: string) {
  const part = value.trim().replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "");
  return (part || "sheet").slice(0, 64);
}

export function createTabularWorkspaceScriptDefinition(input: {
  provenance: TabularArtifactProvenance;
  inputPath: string;
  transformSource: string;
}): TabularWorkspaceScriptDefinition {
  const transformSource = input.transformSource.trim();
  if (!transformSource) throw new Error("Tabular transform source is required.");
  const identity = input.provenance.sourceSha256.slice(0, 12);
  if (!/^[a-f0-9]{12}$/.test(identity)) throw new Error("Tabular artifact source hash is invalid.");
  const id = `tabular-${identity}`;
  const outputPath = `outputs/${id}-${safePathPart(input.provenance.sheetName)}.json`;
  const source = `({ fs }) => {
  const snapshot = JSON.parse(fs.readText("/inputs/tabular-snapshot.json"));
  if (!snapshot || snapshot.schema !== "wasmhatch.tabular-snapshot.v1" || !Array.isArray(snapshot.rows)) {
    throw new Error("Granted tabular snapshot is invalid.");
  }
  const transform = (${transformSource});
  if (typeof transform !== "function") throw new Error("Tabular transform must evaluate to a function.");
  const rows = transform(snapshot.rows);
  if (rows && typeof rows.then === "function") throw new Error("Async tabular transforms are not supported.");
  if (!Array.isArray(rows) || rows.length > 5000 || rows.some((row) => !Array.isArray(row) || row.length > 200)) {
    throw new Error("Tabular transform must return at most 5,000 rows by 200 columns.");
  }
  for (const row of rows) for (const cell of row) {
    if (!(cell === null || typeof cell === "string" || typeof cell === "boolean" || (typeof cell === "number" && Number.isFinite(cell)))) {
      throw new Error("Tabular transform returned an unsupported cell value.");
    }
  }
  const output = {
    schema: "wasmhatch.tabular-output.v1",
    source: {
      path: ${JSON.stringify(input.inputPath)},
      sha256: ${JSON.stringify(input.provenance.sourceSha256)},
      sheet: ${JSON.stringify(input.provenance.sheetName)}
    },
    rows
  };
  fs.writeText("/outputs/transformed.json", JSON.stringify(output, null, 2) + "\\n");
  return {
    rows: rows.length,
    columns: rows.reduce((maximum, row) => Math.max(maximum, row.length), 0)
  };
}`;
  const manifest = validateWorkspaceScriptManifest({
    schemaVersion: 1,
    id,
    version: "1.0.0",
    sourcePath: `scripts/${id}.js`,
    inputs: [{
      workspacePath: input.inputPath,
      mountPath: "/inputs/tabular-snapshot.json",
      mediaType: "application/json",
      maxBytes: 512 * 1024
    }],
    outputs: [{
      workspacePath: outputPath,
      mountPath: "/outputs/transformed.json",
      mediaType: "application/json",
      maxBytes: 512 * 1024,
      required: true
    }],
    limits: WORKSPACE_SCRIPT_DEFAULT_LIMITS
  });
  return {
    manifest,
    manifestPath: workspaceScriptDefinitionPath(manifest),
    source,
    outputPath
  };
}
