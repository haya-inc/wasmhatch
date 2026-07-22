import { expect, test } from "@playwright/test";
import { createHash } from "node:crypto";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { exportTabularArtifact } from "../src/lib/tabular-artifact";
import { forceCloudPlanner } from "./force-cloud-planner";

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
    const workspace = await root.getDirectoryHandle("wasmhatch-operator-workspace-v1");
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
  await expect(page.locator(".artifact-provenance")).toContainText("work/pipeline--CSV--");

  const durableSnapshots = await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const workspace = await root.getDirectoryHandle("wasmhatch-operator-workspace-v1");
    const readOnlyJson = async (rootName: "inputs" | "work") => {
      const directory = await workspace.getDirectoryHandle(rootName);
      const names: string[] = [];
      for await (const [name] of (directory as FileSystemDirectoryHandle & {
        entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
      }).entries()) if (name.endsWith(".json")) names.push(name);
      const file = await directory.getFileHandle(names[0]);
      return { name: names[0], value: JSON.parse(await (await file.getFile()).text()) as { rows: unknown[][] } };
    };
    return { input: await readOnlyJson("inputs"), work: await readOnlyJson("work") };
  });
  expect(durableSnapshots.input.value.rows[1]).toEqual([" aya ", "10", "=2+2"]);
  expect(durableSnapshots.work.value.rows[1]).toEqual(["aya", 10, "=2+2"]);
  expect(durableSnapshots.work.name).toMatch(/^pipeline--CSV--[a-f0-9]{64}\.json$/);

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

  await page.getByRole("button", { name: "Review undo" }).click();
  await expect(page.getByText("Undo approval required", { exact: true })).toBeVisible();
  await expect(page.getByText("Local undo proposal prepared", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Approve and apply undo locally" }).click();
  await expect(page.getByText("Local undo committed", { exact: true })).toBeVisible();
  await expect(page.getByText("Approved undo persisted to a verified work/ snapshot", { exact: true })).toBeVisible();
  await expect(page.locator(".operator-table tr").nth(1).locator("td").nth(0)).toHaveText(" aya ");
  await expect(page.locator(".operator-table tr").nth(1).locator("td").nth(1)).toHaveText("10");
  await expect(page.getByRole("button", { name: "Review redo" })).toBeVisible();

  const reversedSnapshots = await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const workspace = await root.getDirectoryHandle("wasmhatch-operator-workspace-v1");
    const work = await workspace.getDirectoryHandle("work");
    const snapshots: { name: string; rows: unknown[][] }[] = [];
    for await (const [name, handle] of (work as FileSystemDirectoryHandle & {
      entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
    }).entries()) {
      if (handle.kind !== "file" || !name.endsWith(".json")) continue;
      const file = await (handle as FileSystemFileHandle).getFile();
      const value = JSON.parse(await file.text()) as { rows: unknown[][] };
      snapshots.push({ name, rows: value.rows });
    }
    return snapshots;
  });
  expect(reversedSnapshots).toHaveLength(2);
  expect(reversedSnapshots.map((snapshot) => snapshot.rows[1])).toEqual(expect.arrayContaining([
    ["aya", 10, "=2+2"],
    [" aya ", "10", "=2+2"]
  ]));
  reversedSnapshots.forEach((snapshot) => expect(snapshot.name).toMatch(/^pipeline--CSV--[a-f0-9]{64}\.json$/));

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("button", { name: "Review redo" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
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

test("blocks local undo when the durable committed snapshot drifts", async ({ page }) => {
  await page.goto("/?view=operator");
  await page.getByLabel("Import CSV or XLSX").setInputFiles({
    name: "reversal.csv",
    mimeType: "text/csv",
    buffer: Buffer.from("Owner,Amount\r\n aya ,10\r\n", "utf8")
  });
  await page.getByRole("textbox", { name: "Sandbox transformation script" }).fill(
    "(rows) => rows.map((row, index) => index === 0 ? row : [String(row[0]).trim(), Number(row[1])])"
  );
  await page.getByRole("button", { name: "Run in Wasm sandbox" }).click();
  await page.getByRole("button", { name: "Approve and apply locally" }).click();
  await expect(page.getByRole("button", { name: "Review undo" })).toBeVisible();

  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const workspace = await root.getDirectoryHandle("wasmhatch-operator-workspace-v1");
    const work = await workspace.getDirectoryHandle("work");
    for await (const [name, handle] of (work as FileSystemDirectoryHandle & {
      entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
    }).entries()) {
      if (handle.kind !== "file" || !name.endsWith(".json")) continue;
      const fileHandle = handle as FileSystemFileHandle;
      const value = JSON.parse(await (await fileHandle.getFile()).text()) as { rows: unknown[][] };
      value.rows[1][0] = "tampered after commit";
      const writable = await fileHandle.createWritable();
      await writable.write(`${JSON.stringify(value, null, 2)}\n`);
      await writable.close();
      return;
    }
    throw new Error("Committed work snapshot was not found.");
  });

  await page.getByRole("button", { name: "Review undo" }).click();
  // Scoped by text: the artifact indexer owns a second alert surface, and a rare
  // transient index error must not turn this assertion into a strict-mode clash.
  await expect(page.getByRole("alert").filter({ hasText: "durable working snapshot changed" })).toBeVisible();
  await expect(page.getByLabel("Review and audit").getByText("Local undo blocked", { exact: true })).toBeVisible();
  await expect(page.getByText("Undo approval required", { exact: true })).toHaveCount(0);
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

test("lets AI inspect one exact workspace snapshot through checkpointed bounded tools", async ({ page }) => {
  await forceCloudPlanner(page);
  const csv = Buffer.from("Owner,Region\r\nAya,west\r\nKen,east\r\n", "utf8");
  const sourceHash = createHash("sha256").update(csv).digest("hex");
  const workspacePath = `inputs/agent-pipeline--CSV--${sourceHash.slice(0, 12)}.json`;
  const requestBodies: Record<string, unknown>[] = [];
  let modelRequest = 0;
  await page.route("https://api.openai.com/v1/responses", async (route) => {
    requestBodies.push(route.request().postDataJSON() as Record<string, unknown>);
    modelRequest += 1;
    const calls = [
      { id: "resp_list", callId: "call_list", name: "list_workspace_files", args: {} },
      { id: "resp_rows", callId: "call_rows", name: "read_tabular_rows", args: { path: workspacePath, start_row: 1, row_count: 3 } },
      {
        id: "resp_plan",
        callId: "call_plan",
        name: "propose_spreadsheet_transform",
        args: {
          summary: "Normalize region labels from the granted snapshot.",
          expected_effect: "Data rows receive uppercase regions; the header and owner column remain unchanged.",
          script: "(rows) => rows.map((row, index) => index === 0 ? row : [row[0], String(row[1]).toUpperCase()])",
          assumptions: ["Row 1 is the header."],
          warnings: []
        }
      }
    ];
    const call = calls[modelRequest - 1];
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        id: call.id,
        output: [
          { id: `rs_${call.id}`, type: "reasoning", summary: [] },
          {
            id: `fc_${call.id}`,
            type: "function_call",
            call_id: call.callId,
            name: call.name,
            arguments: JSON.stringify(call.args),
            status: "completed"
          }
        ],
        usage: { input_tokens: 100, output_tokens: 25 }
      })
    });
  });

  await page.goto("/?view=operator");
  await page.getByLabel("Import CSV or XLSX").setInputFiles({
    name: "agent-pipeline.csv",
    mimeType: "text/csv",
    buffer: csv
  });
  await page.getByLabel("OpenAI session API key").fill("sk-workspace-e2e");
  await page.getByRole("button", { name: "Inspect workspace with AI" }).click();

  await expect(page.getByRole("heading", { name: "Normalize region labels from the granted snapshot." })).toBeVisible();
  await expect(page.getByText("AI tool: list_workspace_files", { exact: true })).toBeVisible();
  await expect(page.getByText("AI tool: read_tabular_rows", { exact: true })).toBeVisible();
  await expect(page.getByText("Checkpointed workspace plan staged", { exact: true })).toBeVisible();
  await expect(page.getByLabel("AI transformation plan")).toContainText("3 model requests · 3 checkpointed tools");
  await expect(page.getByLabel("Workspace file diff")).toHaveCount(0);

  expect(requestBodies).toHaveLength(3);
  expect(requestBodies[0]).toMatchObject({ store: false, parallel_tool_calls: true, tool_choice: "required" });
  expect(JSON.stringify(requestBodies[0])).not.toContain("sk-workspace-e2e");
  expect(JSON.stringify(requestBodies[1].input)).toContain("wasmhatch.workspace-list.v1");
  expect(JSON.stringify(requestBodies[2].input)).toContain("wasmhatch.tabular-window.v1");
  expect(JSON.stringify(requestBodies[2].input)).toContain("west");

  const durableFiles = await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const workspace = await root.getDirectoryHandle("wasmhatch-operator-workspace-v1");
    const names: string[] = [];
    const walk = async (directory: FileSystemDirectoryHandle, prefix = "") => {
      for await (const [name, handle] of (directory as FileSystemDirectoryHandle & {
        entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
      }).entries()) {
        const path = prefix ? `${prefix}/${name}` : name;
        if (handle.kind === "file") names.push(path);
        else await walk(handle as FileSystemDirectoryHandle, path);
      }
    };
    await walk(workspace);
    return names.sort();
  });
  expect(durableFiles).toEqual([workspacePath]);
});

test("previews a workspace artifact locally and sends it only through an explicit identity-bound AI attachment", async ({ page }) => {
  await forceCloudPlanner(page);
  const requestBodies: Record<string, unknown>[] = [];
  let modelRequest = 0;
  const briefPath = "work/weekly-brief.md";
  const briefContent = "# Weekly brief\n\nWEST needs manual review before publication.\n";
  await page.route("https://api.openai.com/v1/responses", async (route) => {
    requestBodies.push(route.request().postDataJSON() as Record<string, unknown>);
    modelRequest += 1;
    const calls = [
      { id: "resp_list", callId: "call_list", name: "list_workspace_files", args: {} },
      { id: "resp_brief", callId: "call_brief", name: "read_workspace_file", args: { path: briefPath, start_line: 1, max_lines: 20 } },
      {
        id: "resp_plan",
        callId: "call_plan",
        name: "propose_spreadsheet_transform",
        args: {
          summary: "Normalize the active table using the reviewed weekly brief.",
          expected_effect: "Region labels are uppercased while headers and unrelated cells remain unchanged.",
          script: "(rows) => rows.map((row, index) => index === 0 ? row : [row[0], String(row[1]).toUpperCase()])",
          assumptions: ["Row 1 is the header."],
          warnings: ["Review WEST rows before publication."]
        }
      }
    ];
    const call = calls[modelRequest - 1];
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        id: call.id,
        output: [
          { id: `rs_${call.id}`, type: "reasoning", summary: [] },
          { id: `fc_${call.id}`, type: "function_call", call_id: call.callId, name: call.name, arguments: JSON.stringify(call.args), status: "completed" }
        ],
        usage: { input_tokens: 100, output_tokens: 25 }
      })
    });
  });

  await page.goto("/?view=operator");
  await page.getByLabel("Import CSV or XLSX").setInputFiles({
    name: "attachment-table.csv",
    mimeType: "text/csv",
    buffer: Buffer.from("Owner,Region\r\nAya,west\r\n", "utf8")
  });
  await page.evaluate(async ({ path, content }) => {
    const origin = await navigator.storage.getDirectory();
    let directory = await origin.getDirectoryHandle("wasmhatch-operator-workspace-v1", { create: true });
    const parts = path.split("/");
    const name = parts.pop()!;
    for (const part of parts) directory = await directory.getDirectoryHandle(part, { create: true });
    const file = await directory.getFileHandle(name, { create: true });
    const writer = await file.createWritable();
    await writer.write(content);
    await writer.close();
  }, { path: briefPath, content: briefContent });

  await page.getByLabel("Refresh workspace artifacts").click();
  const brief = page.getByRole("option", { name: /weekly-brief\.md/ });
  await expect(brief).toBeVisible();
  await brief.click();
  const preview = page.getByLabel("Workspace artifact preview", { exact: true });
  await expect(preview).toContainText("WEST needs manual review before publication.");
  await expect(preview).toContainText("Complete local preview.");
  await preview.getByRole("button", { name: "Attach exact file to AI plan" }).click();
  await expect(page.getByLabel("AI workspace attachment")).toContainText(briefPath);
  await expect(page.getByText("Workspace artifact attached for AI review", { exact: true })).toBeVisible();

  await page.getByLabel("OpenAI session API key").fill("sk-artifact-e2e");
  await page.getByRole("button", { name: "Inspect workspace with AI" }).click();
  await expect(page.getByRole("heading", { name: "Normalize the active table using the reviewed weekly brief." })).toBeVisible();
  await expect(page.getByText("AI tool: read_workspace_file", { exact: true })).toBeVisible();

  expect(requestBodies).toHaveLength(3);
  expect(JSON.stringify(requestBodies[0])).not.toContain("WEST needs manual review");
  expect(JSON.stringify(requestBodies[1])).not.toContain("WEST needs manual review");
  expect(JSON.stringify(requestBodies[2])).toContain("WEST needs manual review");
  expect(JSON.stringify(requestBodies)).not.toContain("sk-artifact-e2e");
});

test("plans, sandboxes, reviews, and commits one typed Markdown artifact workflow", async ({ page }) => {
  await forceCloudPlanner(page);
  const inputPath = "work/weekly-brief.md";
  const inputContent = "# Weekly brief\n\nWEST needs manual review.\n";
  const outputPath = "outputs/weekly-review.md";
  let modelRequest = 0;
  const requestBodies: Record<string, unknown>[] = [];
  await page.route("https://api.openai.com/v1/responses", async (route) => {
    requestBodies.push(route.request().postDataJSON() as Record<string, unknown>);
    modelRequest += 1;
    const calls = [
      { id: "resp_list", callId: "call_list", name: "list_workspace_files", args: {} },
      { id: "resp_read", callId: "call_read", name: "read_workspace_file", args: { path: inputPath, start_line: 1, max_lines: 20 } },
      {
        id: "resp_artifact",
        callId: "call_artifact",
        name: "propose_workspace_artifact",
        args: {
          summary: "Create a weekly review report.",
          expected_effect: "Write one Markdown report while leaving the weekly brief unchanged.",
          output_path: outputPath,
          media_type: "text/markdown",
          script: `({ fs }) => {
  const brief = fs.readText("/inputs/workspace/work/weekly-brief.md");
  fs.writeText("/outputs/result.md", "# Weekly review\\n\\n" + brief);
  return { written: 1 };
}`,
          assumptions: ["The attached brief is the approved source."],
          warnings: ["Review WEST before publication."]
        }
      }
    ];
    const call = calls[modelRequest - 1];
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        id: call.id,
        output: [
          { id: `rs_${call.id}`, type: "reasoning", summary: [] },
          { id: `fc_${call.id}`, type: "function_call", call_id: call.callId, name: call.name, arguments: JSON.stringify(call.args), status: "completed" }
        ],
        usage: { input_tokens: 100, output_tokens: 25 }
      })
    });
  });

  await page.goto("/?view=operator");
  await page.evaluate(async ({ path, content }) => {
    const origin = await navigator.storage.getDirectory();
    let directory = await origin.getDirectoryHandle("wasmhatch-operator-workspace-v1", { create: true });
    const parts = path.split("/");
    const name = parts.pop()!;
    for (const part of parts) directory = await directory.getDirectoryHandle(part, { create: true });
    const file = await directory.getFileHandle(name, { create: true });
    const writer = await file.createWritable();
    await writer.write(content);
    await writer.close();
  }, { path: inputPath, content: inputContent });
  await page.getByLabel("Refresh workspace artifacts").click();
  await page.getByRole("option", { name: /weekly-brief\.md/ }).click();
  await page.getByLabel("Workspace artifact preview", { exact: true }).getByRole("button", { name: "Attach exact file to AI plan" }).click();
  await page.getByRole("button", { name: "Artifact output" }).click();
  await page.getByLabel("Business task").fill("Turn the attached weekly brief into a concise reviewed Markdown report.");
  await page.getByLabel("OpenAI session API key").fill("sk-workflow-e2e");
  await page.getByRole("button", { name: "Draft artifact with AI" }).click();

  const stagedPlan = page.getByLabel("AI artifact workflow plan");
  await expect(stagedPlan).toContainText("Create a weekly review report.");
  await expect(stagedPlan).toContainText(outputPath);
  await expect(stagedPlan).toContainText("text/markdown");
  await expect(page.getByText("AI artifact workflow staged", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Run & stage artifact diff" }).click();

  await expect(page.getByText("Artifact workflow definition saved", { exact: true })).toBeVisible();
  await expect(page.getByText("Artifact workflow script completed", { exact: true })).toBeVisible();
  await expect(page.getByText("Workspace file proposal prepared", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Workspace file diff")).toContainText("# Weekly review");
  const beforeApproval = await page.evaluate(async ({ path }) => {
    try {
      const origin = await navigator.storage.getDirectory();
      const root = await origin.getDirectoryHandle("wasmhatch-operator-workspace-v1");
      const parts = path.split("/");
      const name = parts.pop()!;
      let directory = root;
      for (const part of parts) directory = await directory.getDirectoryHandle(part);
      await directory.getFileHandle(name);
      return true;
    } catch { return false; }
  }, { path: outputPath });
  expect(beforeApproval).toBe(false);

  await page.getByRole("button", { name: "Approve and write workspace file" }).click();
  await expect(page.getByText("Workspace file effect committed", { exact: true })).toBeVisible();
  const output = await page.evaluate(async ({ path }) => {
    const origin = await navigator.storage.getDirectory();
    const root = await origin.getDirectoryHandle("wasmhatch-operator-workspace-v1");
    const parts = path.split("/");
    const name = parts.pop()!;
    let directory = root;
    for (const part of parts) directory = await directory.getDirectoryHandle(part);
    return (await (await directory.getFileHandle(name)).getFile()).text();
  }, { path: outputPath });
  expect(output).toBe(`# Weekly review\n\n${inputContent}`);
  await expect(page.getByRole("option", { name: /weekly-review\.md/ })).toBeVisible();

  expect(requestBodies).toHaveLength(3);
  expect(JSON.stringify(requestBodies[0])).toContain("propose_workspace_artifact");
  expect(JSON.stringify(requestBodies[0])).not.toContain("propose_spreadsheet_transform");
  expect(JSON.stringify(requestBodies)).not.toContain("sk-workflow-e2e");
});

test("runs a saved manifest against the granted snapshot and writes only after file-diff approval", async ({ page }) => {
  await page.goto("/?view=operator");
  await page.getByLabel("Import CSV or XLSX").setInputFiles({
    name: "workspace-pipeline.csv",
    mimeType: "text/csv",
    buffer: Buffer.from("Owner,Amount\r\naya,10\r\n", "utf8")
  });
  await expect(page.getByText("Local tabular artifact imported", { exact: true })).toBeVisible();
  await page.getByRole("textbox", { name: "Sandbox transformation script" }).fill(
    "(rows) => rows.map((row, index) => index ? [String(row[0]).toUpperCase(), Number(row[1])] : row)"
  );
  await page.getByRole("button", { name: "Run in Wasm sandbox" }).click();
  await page.getByRole("button", { name: "Approve and apply locally" }).click();
  await expect(page.locator(".artifact-provenance")).toContainText("work/workspace-pipeline--CSV--");
  await page.getByRole("button", { name: "Save & stage workspace output" }).click();

  await expect(page.getByText("Workspace script definition saved", { exact: true })).toBeVisible();
  await expect(page.getByText("Workspace file proposal prepared", { exact: true })).toBeVisible();
  await expect(page.getByRole("group", { name: "Immutable workspace proposal identity" })).toContainText("missing");
  await expect(page.getByLabel("Workspace file diff")).toContainText('"AYA"');
  const beforeApproval = await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const workspace = await root.getDirectoryHandle("wasmhatch-operator-workspace-v1");
    const list = async (directoryName: string) => {
      const directory = await workspace.getDirectoryHandle(directoryName);
      const names: string[] = [];
      for await (const [name] of (directory as FileSystemDirectoryHandle & {
        entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
      }).entries()) names.push(name);
      return names.sort();
    };
    let outputs: string[] = [];
    try { outputs = await list("outputs"); } catch { /* Output directory is not created before approval. */ }
    return { scripts: await list("scripts"), workflows: await list("workflows"), outputs };
  });
  expect(beforeApproval.scripts).toHaveLength(1);
  expect(beforeApproval.workflows).toHaveLength(1);
  expect(beforeApproval.outputs).toEqual([]);

  await page.getByRole("button", { name: "Approve and write workspace file" }).click();
  await expect(page.getByText("Workspace file effect committed", { exact: true })).toBeVisible();
  const persisted = await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const workspace = await root.getDirectoryHandle("wasmhatch-operator-workspace-v1");
    const outputs = await workspace.getDirectoryHandle("outputs");
    const names: string[] = [];
    for await (const [name] of (outputs as FileSystemDirectoryHandle & {
      entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
    }).entries()) names.push(name);
    const file = await outputs.getFileHandle(names[0]);
    return JSON.parse(await (await file.getFile()).text()) as { schema: string; rows: unknown[][] };
  });
  expect(persisted).toMatchObject({
    schema: "wasmhatch.tabular-output.v1",
    rows: [["Owner", "Amount"], ["AYA", 10]]
  });
});

test("exports, reviews, clears, restores, and resumes the isolated operator workspace", async ({ page }) => {
  await page.goto("/?view=operator");
  await page.getByLabel("Import CSV or XLSX").setInputFiles({
    name: "recovery.csv",
    mimeType: "text/csv",
    buffer: Buffer.from("Owner,Amount\r\naya,10\r\n", "utf8")
  });
  await expect(page.getByText("Local tabular artifact imported", { exact: true })).toBeVisible();
  await page.getByRole("textbox", { name: "Sandbox transformation script" }).fill(
    "(rows) => rows.map((row, index) => index ? [String(row[0]).toUpperCase(), Number(row[1])] : row)"
  );
  await page.getByRole("button", { name: "Run in Wasm sandbox" }).click();
  await page.getByRole("button", { name: "Approve and apply locally" }).click();
  await expect(page.locator(".artifact-provenance")).toContainText("work/recovery--CSV--");
  await page.getByRole("button", { name: "Save & stage workspace output" }).click();
  await page.getByRole("button", { name: "Approve and write workspace file" }).click();
  await expect(page.getByText("Workspace file effect committed", { exact: true })).toBeVisible();

  await page.evaluate(async () => {
    const origin = await navigator.storage.getDirectory();
    const write = async (rootName: string, path: string, content: string) => {
      const parts = path.split("/");
      const fileName = parts.pop()!;
      let directory = await origin.getDirectoryHandle(rootName, { create: true });
      for (const part of parts) directory = await directory.getDirectoryHandle(part, { create: true });
      const handle = await directory.getFileHandle(fileName, { create: true });
      const writable = await handle.createWritable();
      await writable.write(content);
      await writable.close();
    };
    await write("wasmhatch-operator-workspace-v1", "work/exceptions.csv", "Owner,Reason\naya,review\n");
    await write("wasmhatch-operator-workspace-v1", "outputs/summary.md", "# Recovery report\n");
    await write("wasmhatch-workspace", "legacy/keep.txt", "legacy remains\n");
  });

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export workspace" }).click();
  const download = await downloadPromise;
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  const archive = Buffer.concat(chunks);
  const entries = unzipSync(archive);
  const manifest = JSON.parse(strFromU8(entries["wasmhatch-operator-workspace/manifest.json"])) as {
    activeArtifactPath: string;
    files: Array<{ path: string; sha256: string }>;
  };
  expect(download.suggestedFilename()).toMatch(/^wasmhatch-operator-workspace-\d{4}-\d{2}-\d{2}\.zip$/);
  expect(manifest.activeArtifactPath).toMatch(/^work\/recovery--CSV--[a-f0-9]{64}\.json$/);
  expect(manifest.files.some((file) => file.path === "work/exceptions.csv")).toBe(true);
  expect(manifest.files.some((file) => file.path === "outputs/summary.md")).toBe(true);
  expect(manifest.files.some((file) => file.path.endsWith(".js"))).toBe(true);
  expect(manifest.files.every((file) => /^sha256:[a-f0-9]{64}$/.test(file.sha256))).toBe(true);
  const workflowPath = manifest.files.find((file) => file.path.startsWith("workflows/") && file.path.endsWith(".json"))?.path;
  if (!workflowPath) throw new Error("Portable workspace did not contain the tabular workflow manifest.");
  expect(strFromU8(entries[`wasmhatch-operator-workspace/files/${workflowPath}`])).toContain(manifest.activeArtifactPath);

  await page.getByRole("button", { name: "Review workspace clear" }).click();
  const clearReview = page.getByRole("group", { name: "Operator workspace clear review" });
  await expect(clearReview).toContainText("work/exceptions.csv");
  await expect(clearReview).toContainText("outputs/summary.md");
  await clearReview.getByRole("button", { name: "Approve exact clear" }).click();
  await expect(page.getByText("Operator workspace clear committed", { exact: true })).toBeVisible();
  await expect(page.getByRole("cell", { name: "aya tanaka" })).toBeVisible();

  const afterClear = await page.evaluate(async () => {
    const origin = await navigator.storage.getDirectory();
    let operatorFiles = 0;
    try {
      const operator = await origin.getDirectoryHandle("wasmhatch-operator-workspace-v1");
      for await (const _entry of (operator as FileSystemDirectoryHandle & {
        entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
      }).entries()) operatorFiles += 1;
    } catch { /* Clear may remove the root entirely. */ }
    const legacy = await origin.getDirectoryHandle("wasmhatch-workspace");
    const legacyDirectory = await legacy.getDirectoryHandle("legacy");
    const legacyFile = await legacyDirectory.getFileHandle("keep.txt");
    return { operatorFiles, legacy: await (await legacyFile.getFile()).text() };
  });
  expect(afterClear).toEqual({ operatorFiles: 0, legacy: "legacy remains\n" });

  await page.getByLabel("Restore operator workspace ZIP").setInputFiles({
    name: "recovery.zip",
    mimeType: "application/zip",
    buffer: archive
  });
  const restoreReview = page.getByRole("group", { name: "Operator workspace restore review" });
  await expect(restoreReview).toContainText("work/exceptions.csv");
  await expect(restoreReview).toContainText("outputs/summary.md");
  await restoreReview.getByRole("button", { name: "Approve exact restore" }).click();

  await expect(page.getByText("Operator workspace restore committed", { exact: true })).toBeVisible();
  await expect(page.getByRole("cell", { name: "AYA", exact: true })).toBeVisible();
  await expect(page.locator(".artifact-provenance")).toContainText("work/recovery--CSV--");
  const restored = await page.evaluate(async () => {
    const origin = await navigator.storage.getDirectory();
    const operator = await origin.getDirectoryHandle("wasmhatch-operator-workspace-v1");
    const work = await operator.getDirectoryHandle("work");
    const outputs = await operator.getDirectoryHandle("outputs");
    const csv = await work.getFileHandle("exceptions.csv");
    const markdown = await outputs.getFileHandle("summary.md");
    const legacy = await origin.getDirectoryHandle("wasmhatch-workspace");
    const legacyFile = await (await legacy.getDirectoryHandle("legacy")).getFileHandle("keep.txt");
    return {
      csv: await (await csv.getFile()).text(),
      markdown: await (await markdown.getFile()).text(),
      legacy: await (await legacyFile.getFile()).text()
    };
  });
  expect(restored).toEqual({
    csv: "Owner,Reason\naya,review\n",
    markdown: "# Recovery report\n",
    legacy: "legacy remains\n"
  });
});

test("blocks a stale workspace output after an external OPFS edit", async ({ page }) => {
  await page.goto("/?view=operator");
  await page.getByLabel("Import CSV or XLSX").setInputFiles({
    name: "stale.csv",
    mimeType: "text/csv",
    buffer: Buffer.from("Owner\r\naya\r\n", "utf8")
  });
  await page.getByRole("textbox", { name: "Sandbox transformation script" }).fill(
    "(rows) => rows.map((row) => row.map((cell) => String(cell).toUpperCase()))"
  );
  await page.getByRole("button", { name: "Save & stage workspace output" }).click();
  await expect(page.getByText("Workspace file proposal prepared", { exact: true })).toBeVisible();
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const workspace = await root.getDirectoryHandle("wasmhatch-operator-workspace-v1");
    const outputs = await workspace.getDirectoryHandle("outputs", { create: true });
    const handle = await outputs.getFileHandle("tabular-placeholder", { create: true });
    await (await handle.createWritable()).close();
    await outputs.removeEntry("tabular-placeholder");
    const proposalText = document.querySelector(".change-summary p")?.textContent ?? "";
    const match = proposalText.match(/outputs\/(tabular-[^\s.]+\.json)/);
    if (!match) throw new Error("Could not resolve proposed output path.");
    const output = await outputs.getFileHandle(match[1], { create: true });
    const writer = await output.createWritable();
    await writer.write("newer external output\n");
    await writer.close();
  });
  await page.getByRole("button", { name: "Approve and write workspace file" }).click();

  await expect(page.getByRole("alert")).toContainText("changed after this proposal was prepared");
  await expect(page.getByText("Workspace write blocked: conflict", { exact: true })).toBeVisible();
});
