import { expect, test } from "@playwright/test";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { exportTabularArtifact } from "../src/lib/tabular-artifact";

test("imports a CSV as a persisted value snapshot, transforms it, and exports a safe artifact", async ({ page }) => {
  await page.goto("/?view=operator");

  await page.getByLabel("Import CSV or XLSX").setInputFiles({
    name: "pipeline.csv",
    mimeType: "text/csv",
    buffer: Buffer.from("Owner,Amount,Note\r\n aya ,10,=2+2\r\n", "utf8")
  });

  await expect(page.getByText("Local tabular artifact imported", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /pipeline\.csv/ })).toContainText("CSV");
  await expect(page.getByRole("cell", { name: "=2+2" })).toBeVisible();
  await expect(page.locator(".artifact-provenance")).toContainText("inputs/pipeline--");
  await expect(page.locator(".artifact-provenance")).toContainText("formulas 1");

  const persisted = await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const workspace = await root.getDirectoryHandle("wasmhatch-workspace");
    const inputs = await workspace.getDirectoryHandle("inputs");
    const names: string[] = [];
    for await (const [name] of (inputs as FileSystemDirectoryHandle & {
      entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
    }).entries()) names.push(name);
    const file = await inputs.getFileHandle(names[0]);
    return JSON.parse(await (await file.getFile()).text()) as { schema: string; rows: unknown[][] };
  });
  expect(persisted.schema).toBe("wasmhatch.tabular-snapshot.v1");
  expect(persisted.rows[1]).toEqual([" aya ", "10", "=2+2"]);

  await page.getByRole("textbox", { name: "Sandbox transformation script" }).fill(
    "(rows) => rows.map((row, index) => index === 0 ? row : [String(row[0]).trim(), Number(row[1]), row[2]])"
  );
  await page.getByRole("button", { name: "Run in Wasm sandbox" }).click();
  await expect(page.getByText("Explicit approval required")).toBeVisible();
  await expect(page.getByText("the imported working snapshot")).toBeVisible();
  await page.getByRole("button", { name: "Approve and apply locally" }).click();
  await expect(page.getByRole("cell", { name: "aya", exact: true })).toBeVisible();
  await expect(page.getByText("Local effect committed", { exact: true })).toBeVisible();

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export safe CSV" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("pipeline.csv");
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  expect(Buffer.concat(chunks).toString("utf8")).toContain("'=2+2");
  await expect(page.getByText("Value-only artifact exported", { exact: true })).toBeVisible();
  await expect(page.getByText(/1 CSV formula prefixes neutralized/)).toBeVisible();
});

test("blocks a disguised XLSX before it reaches working data", async ({ page }) => {
  await page.goto("/?view=operator");
  await page.getByLabel("Import CSV or XLSX").setInputFiles({
    name: "fake.xlsx",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: Buffer.from("not a zip", "utf8")
  });

  await expect(page.getByRole("alert")).toContainText("not a valid ZIP-based workbook");
  await expect(page.getByLabel("Review and audit").getByText("Local artifact import blocked", { exact: true })).toBeVisible();
  await expect(page.getByRole("cell", { name: "aya tanaka" })).toBeVisible();
});

test("imports a value-only XLSX in the browser worker without executing formula-looking text", async ({ page }) => {
  const workbook = exportTabularArtifact([
    ["Account", "Balance", "Literal"],
    ["North", 4200, "=SUM(A1:A2)"]
  ], "xlsx", "accounts");
  await page.goto("/?view=operator");
  await page.getByLabel("Import CSV or XLSX").setInputFiles({
    name: workbook.fileName,
    mimeType: workbook.mediaType,
    buffer: Buffer.from(workbook.bytes)
  });

  await expect(page.getByText("Local tabular artifact imported", { exact: true })).toBeVisible();
  await expect(page.getByRole("cell", { name: "4200" })).toBeVisible();
  await expect(page.getByRole("cell", { name: "=SUM(A1:A2)" })).toBeVisible();
  await expect(page.locator(".artifact-provenance")).toContainText("formulas 0");
});

test("lets the user choose a different visible XLSX worksheet", async ({ page }) => {
  const exported = exportTabularArtifact([["First sheet"]], "xlsx", "multi");
  const entries = unzipSync(exported.bytes);
  entries["xl/workbook.xml"] = strToU8(strFromU8(entries["xl/workbook.xml"])
    .replace("</sheets>", '<sheet name="Second" sheetId="2" r:id="rId2"/></sheets>'));
  entries["xl/_rels/workbook.xml.rels"] = strToU8(strFromU8(entries["xl/_rels/workbook.xml.rels"])
    .replace("</Relationships>", '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/></Relationships>'));
  entries["xl/worksheets/sheet2.xml"] = strToU8(strFromU8(entries["xl/worksheets/sheet1.xml"]).replace("First sheet", "Second sheet"));

  await page.goto("/?view=operator");
  await page.getByLabel("Import CSV or XLSX").setInputFiles({
    name: "multi.xlsx",
    mimeType: exported.mediaType,
    buffer: Buffer.from(zipSync(entries))
  });
  await expect(page.getByRole("cell", { name: "First sheet" })).toBeVisible();
  await page.getByLabel("Visible worksheet").selectOption("Second");
  await page.getByRole("button", { name: "Load sheet" }).click();

  await expect(page.getByRole("cell", { name: "Second sheet" })).toBeVisible();
  await expect(page.locator(".artifact-provenance")).toContainText("multi--Second--");
});
