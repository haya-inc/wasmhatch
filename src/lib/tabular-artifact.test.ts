import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import {
  exportTabularArtifact,
  importTabularArtifact
} from "./tabular-artifact";
import {
  normalizedArtifactJson,
  normalizedArtifactPath,
  normalizedWorkingArtifactPath,
  parseNormalizedArtifactJson
} from "./tabular-artifact-persistence";

function csv(value: string) {
  return importTabularArtifact({ name: "sample.csv", mediaType: "text/csv", bytes: strToU8(value) });
}

describe("tabular artifact boundary", () => {
  it("parses RFC 4180-style UTF-8 CSV as inert strings with provenance", async () => {
    const snapshot = await csv('\ufeffName,Note,Value\r\n"Aya, Inc.","line 1\nline 2",=2+2\r\n');

    expect(snapshot.rows).toEqual([
      ["Name", "Note", "Value"],
      ["Aya, Inc.", "line 1\nline 2", "=2+2"]
    ]);
    expect(snapshot.provenance).toMatchObject({
      format: "csv",
      sheetName: "CSV",
      rows: 2,
      columns: 3,
      cells: 6,
      formulaCells: 1,
      externalLinks: 0
    });
    expect(snapshot.provenance.sourceSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.isFrozen(snapshot.rows)).toBe(true);
  });

  it("rejects malformed CSV instead of guessing", async () => {
    await expect(csv('a,"unterminated\n')).rejects.toThrow("quoted field");
    await expect(csv('a,"closed"junk\n')).rejects.toThrow("closing quote");
    await expect(importTabularArtifact({ name: "sample.csv", bytes: Uint8Array.of(0xff) }))
      .rejects.toThrow("valid UTF-8");
  });

  it("neutralizes spreadsheet formula prefixes in CSV exports", () => {
    const exported = exportTabularArtifact([
      ["=HYPERLINK(\"https://example.test\")", "+1", "-2", "@SUM(A1:A2)", "safe"]
    ], "csv", "review");

    expect(exported.neutralizedFormulaCells).toBe(4);
    expect(strFromU8(exported.bytes)).toContain("'=HYPERLINK");
    expect(exported.fileName).toBe("review.csv");
  });

  it("round-trips typed values through a minimal value-only XLSX", async () => {
    const rows = [
      ["Name", "Amount", "Active", "Formula-looking text"],
      ["山田", 1250.5, true, "=1+1"],
      ["empty", null, false, ""]
    ] as const;
    const exported = exportTabularArtifact(rows.map((row) => [...row]), "xlsx", "safe-values");
    const snapshot = await importTabularArtifact({
      name: exported.fileName,
      mediaType: exported.mediaType,
      bytes: exported.bytes
    });

    expect(snapshot.rows).toEqual(rows);
    expect(snapshot.provenance).toMatchObject({
      format: "xlsx",
      sheetName: "Sheet1",
      formulaCells: 0,
      rows: 3,
      columns: 4
    });
    expect(strFromU8(unzipSync(exported.bytes)["xl/worksheets/sheet1.xml"]))
      .toContain('<c r="D2" t="inlineStr"><is><t xml:space="preserve">=1+1</t>');
  });

  it("imports only the cached value of a formula and records the loss boundary", async () => {
    const exported = exportTabularArtifact([["placeholder"]], "xlsx");
    const entries = unzipSync(exported.bytes);
    const worksheet = strFromU8(entries["xl/worksheets/sheet1.xml"])
      .replace('<c r="A1" t="inlineStr"><is><t xml:space="preserve">placeholder</t></is></c>', '<c r="A1" t="n"><f>1+1</f><v>2</v></c>');
    entries["xl/worksheets/sheet1.xml"] = strToU8(worksheet);

    const snapshot = await importTabularArtifact({ name: "formula.xlsx", bytes: zipSync(entries) });

    expect(snapshot.rows).toEqual([[2]]);
    expect(snapshot.provenance.formulaCells).toBe(1);
    expect(snapshot.provenance.warnings.join(" ")).toMatch(/cached values.*stale/i);
  });

  it("rejects macro content and unsafe ZIP paths", async () => {
    const exported = exportTabularArtifact([["safe"]], "xlsx");
    const macroEntries = unzipSync(exported.bytes);
    macroEntries["xl/vbaProject.bin"] = Uint8Array.of(1, 2, 3);
    await expect(importTabularArtifact({ name: "macro.xlsx", bytes: zipSync(macroEntries) }))
      .rejects.toThrow("Macro-enabled");

    const disguisedMacroEntries = unzipSync(exported.bytes);
    disguisedMacroEntries["[Content_Types].xml"] = strToU8(strFromU8(disguisedMacroEntries["[Content_Types].xml"])
      .replace("</Types>", '<Override PartName="/xl/custom.bin" ContentType="application/vnd.ms-office.vbaProject"/></Types>'));
    await expect(importTabularArtifact({ name: "disguised.xlsx", bytes: zipSync(disguisedMacroEntries) }))
      .rejects.toThrow("Macro-enabled");

    const unsafeEntries = unzipSync(exported.bytes);
    unsafeEntries["../escape.xml"] = strToU8("<escape/>");
    await expect(importTabularArtifact({ name: "unsafe.xlsx", bytes: zipSync(unsafeEntries) }))
      .rejects.toThrow("unsafe ZIP path");
  });

  it("ignores external workbook parts and reports them", async () => {
    const exported = exportTabularArtifact([["safe"]], "xlsx");
    const entries = unzipSync(exported.bytes);
    entries["xl/externalLinks/externalLink1.xml"] = strToU8("<externalLink/>");
    const snapshot = await importTabularArtifact({ name: "external.xlsx", bytes: zipSync(entries) });

    expect(snapshot.rows).toEqual([["safe"]]);
    expect(snapshot.provenance.externalLinks).toBe(1);
    expect(snapshot.provenance.warnings.join(" ")).toMatch(/external workbook links were ignored/i);
  });

  it("excludes values in hidden rows and columns from the normalized snapshot", async () => {
    const exported = exportTabularArtifact([
      ["A", "B", "secret-column"],
      ["secret-row-a", "secret-row-b", "secret-row-c"],
      ["u", "v", "secret-column-2"]
    ], "xlsx");
    const entries = unzipSync(exported.bytes);
    const worksheet = strFromU8(entries["xl/worksheets/sheet1.xml"])
      .replace("<sheetData>", '<cols><col min="3" max="3" hidden="1"/></cols><sheetData>')
      .replace('<row r="2">', '<row r="2" hidden="1">');
    entries["xl/worksheets/sheet1.xml"] = strToU8(worksheet);

    const snapshot = await importTabularArtifact({ name: "hidden.xlsx", bytes: zipSync(entries) });

    expect(snapshot.rows).toEqual([["A", "B"], [], ["u", "v"]]);
    expect(JSON.stringify(snapshot.rows)).not.toContain("secret");
    expect(snapshot.provenance.warnings.join(" ")).toMatch(/5 cells were excluded from hidden rows or columns/i);
  });

  it("lists visible worksheets and imports the explicitly selected sheet", async () => {
    const exported = exportTabularArtifact([["First"]], "xlsx");
    const entries = unzipSync(exported.bytes);
    entries["xl/workbook.xml"] = strToU8(strFromU8(entries["xl/workbook.xml"])
      .replace("</sheets>", '<sheet name="Second" sheetId="2" r:id="rId2"/></sheets>'));
    entries["xl/_rels/workbook.xml.rels"] = strToU8(strFromU8(entries["xl/_rels/workbook.xml.rels"])
      .replace("</Relationships>", '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/></Relationships>'));
    entries["xl/worksheets/sheet2.xml"] = strToU8(strFromU8(entries["xl/worksheets/sheet1.xml"]).replace("First", "Second value"));
    const workbook = zipSync(entries);

    const first = await importTabularArtifact({ name: "multi.xlsx", bytes: workbook });
    const second = await importTabularArtifact({ name: "multi.xlsx", bytes: workbook, sheetName: "Second" });

    expect(first.rows).toEqual([["First"]]);
    expect(first.provenance.sheets).toEqual([
      { name: "Sheet1", visibility: "visible" },
      { name: "Second", visibility: "visible" }
    ]);
    expect(first.provenance.warnings.join(" ")).toContain("2 visible worksheets");
    expect(second.rows).toEqual([["Second value"]]);
    expect(second.provenance.sheetName).toBe("Second");
  });

  it("counts hidden worksheets without persisting their names", async () => {
    const exported = exportTabularArtifact([["Visible"]], "xlsx");
    const entries = unzipSync(exported.bytes);
    entries["xl/workbook.xml"] = strToU8(strFromU8(entries["xl/workbook.xml"])
      .replace("</sheets>", '<sheet name="SECRET-CUSTOMERS" sheetId="2" state="hidden" r:id="rId2"/></sheets>'));

    const snapshot = await importTabularArtifact({ name: "hidden-sheet.xlsx", bytes: zipSync(entries) });
    const persisted = normalizedArtifactJson(snapshot);

    expect(snapshot.provenance.hiddenSheets).toBe(1);
    expect(snapshot.provenance.sheets).toEqual([{ name: "Sheet1", visibility: "visible" }]);
    expect(persisted).not.toContain("SECRET-CUSTOMERS");
  });

  it("serializes an inspectable workspace snapshot without executable workbook state", async () => {
    const snapshot = await csv("name,amount\nAya,10\n");
    const serialized = normalizedArtifactJson(snapshot);
    const persisted = JSON.parse(serialized) as Record<string, unknown>;

    expect(persisted).toMatchObject({ schema: "wasmhatch.tabular-snapshot.v1", rows: [["name", "amount"], ["Aya", "10"]] });
    expect(normalizedArtifactPath(snapshot)).toMatch(/^inputs\/sample--CSV--[a-f0-9]{12}\.json$/);
    expect(normalizedWorkingArtifactPath(snapshot, `sha256:${"a".repeat(64)}`))
      .toBe(`work/sample--CSV--${"a".repeat(64)}.json`);
    expect(() => normalizedWorkingArtifactPath(snapshot, "sha256:short")).toThrow("content hash is invalid");
    expect(parseNormalizedArtifactJson(serialized)).toEqual(snapshot);
    expect(Object.isFrozen(parseNormalizedArtifactJson(serialized).rows)).toBe(true);
  });

  it("rejects restored snapshots with edited provenance, dimensions, or executable-shaped fields", async () => {
    const snapshot = await csv("name,amount\nAya,10\n");
    const base = JSON.parse(normalizedArtifactJson(snapshot)) as Record<string, unknown>;
    const provenance = base.provenance as Record<string, unknown>;
    expect(() => parseNormalizedArtifactJson(JSON.stringify({ ...base, provenance: { ...provenance, rows: 99 } })))
      .toThrow("dimensions do not match");
    expect(() => parseNormalizedArtifactJson(JSON.stringify({ ...base, provenance: { ...provenance, sourceSha256: "not-a-hash" } })))
      .toThrow("source hash is invalid");
    expect(() => parseNormalizedArtifactJson(JSON.stringify({ ...base, network: true })))
      .toThrow("missing or unsupported fields");
  });
});
