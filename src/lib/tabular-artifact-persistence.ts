import type { TabularArtifactSnapshot } from "./tabular-artifact-contract";

function safePathPart(value: string) {
  const stem = value.replace(/\.(csv|xlsx)$/i, "").trim().replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "");
  return (stem || "wasmhatch-artifact").slice(0, 120);
}

export function normalizedArtifactJson(snapshot: TabularArtifactSnapshot) {
  return `${JSON.stringify({
    schema: "wasmhatch.tabular-snapshot.v1",
    provenance: snapshot.provenance,
    rows: snapshot.rows
  }, null, 2)}\n`;
}

export function normalizedArtifactPath(snapshot: TabularArtifactSnapshot) {
  const stem = safePathPart(snapshot.provenance.sourceName);
  const sheet = safePathPart(snapshot.provenance.sheetName);
  return `inputs/${stem}--${sheet}--${snapshot.provenance.sourceSha256.slice(0, 12)}.json`;
}
