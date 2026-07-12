import { describe, expect, it } from "vitest";
import {
  createGoogleSheetsWorkspaceSnapshot,
  googleSheetsWorkspaceSnapshotArtifact,
  parseGoogleSheetsWorkspaceSnapshot,
  serializeGoogleSheetsWorkspaceSnapshot
} from "./google-sheets-workspace-snapshot";

const SOURCE = {
  spreadsheetId: "sheet-secret-resource-id",
  range: "Pipeline!A1:B3",
  values: [["Owner", "Amount"], ["Aya", 1200], ["Ken", 900]]
};

describe("Google Sheets workspace snapshots", () => {
  it("stores a target hash and bounded values without the provider resource ID", async () => {
    const snapshot = await createGoogleSheetsWorkspaceSnapshot(SOURCE);
    const content = serializeGoogleSheetsWorkspaceSnapshot(snapshot);
    expect(snapshot).toMatchObject({
      schema: "wasmhatch.google-sheets-snapshot.v1",
      connector: { id: "google-sheets" },
      target: { range: SOURCE.range },
      rows: SOURCE.values
    });
    expect(snapshot.target.spreadsheetIdSha256).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(content).not.toContain(SOURCE.spreadsheetId);
    expect(parseGoogleSheetsWorkspaceSnapshot(content)).toEqual(snapshot);
    expect(Object.isFrozen(snapshot)).toBe(true);
  });

  it("creates a deterministic content-addressed portable artifact", async () => {
    const first = await googleSheetsWorkspaceSnapshotArtifact(SOURCE);
    const second = await googleSheetsWorkspaceSnapshotArtifact({ ...SOURCE, values: SOURCE.values.map((row) => [...row]) });
    expect(first).toEqual(second);
    expect(first.path).toMatch(/^inputs\/google-sheets-[a-f0-9]{12}\.json$/);
    expect(first.sha256).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(first.bytes).toBe(new TextEncoder().encode(first.content).byteLength);
  });

  it("rejects edited schema, connector, target hash, dimensions, and extra fields", async () => {
    const valid = await createGoogleSheetsWorkspaceSnapshot(SOURCE);
    expect(() => parseGoogleSheetsWorkspaceSnapshot({ ...valid, schema: "other" })).toThrow("schema is unsupported");
    expect(() => parseGoogleSheetsWorkspaceSnapshot({ ...valid, connector: { ...valid.connector, version: "0.0.0" } })).toThrow("connector is unsupported");
    expect(() => parseGoogleSheetsWorkspaceSnapshot({ ...valid, target: { ...valid.target, spreadsheetIdSha256: "bad" } })).toThrow("target hash is invalid");
    expect(() => parseGoogleSheetsWorkspaceSnapshot({ ...valid, rows: [[Number.NaN]] })).toThrow("Spreadsheet values");
    expect(() => parseGoogleSheetsWorkspaceSnapshot({ ...valid, credential: "token" })).toThrow("missing or unsupported fields");
  });

  it("rejects an oversized snapshot before it can be persisted", async () => {
    await expect(googleSheetsWorkspaceSnapshotArtifact({
      spreadsheetId: SOURCE.spreadsheetId,
      range: SOURCE.range,
      values: [["x".repeat(512 * 1024)]]
    })).rejects.toThrow("exceeds the 512 KB artifact limit");
  });
});
