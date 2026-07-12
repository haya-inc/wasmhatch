import { expect, test, type Page } from "@playwright/test";

const GOOGLE_CLIENT_ID = "1234567890-wasmhatch.apps.googleusercontent.com";

async function authorizeGoogleSheets(page: Page) {
  await page.route("https://accounts.google.com/gsi/client", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/javascript",
      body: `globalThis.google = { accounts: { oauth2: {
        initTokenClient(config) {
          return { requestAccessToken() { config.callback({
            access_token: "test-token",
            expires_in: 3600,
            scope: "https://www.googleapis.com/auth/spreadsheets",
            token_type: "Bearer"
          }); } };
        },
        hasGrantedAllScopes() { return true; },
        revoke(token, callback) { globalThis.__wasmhatchRevokedToken = token; callback({ successful: true }); }
      } } };`
    });
  });
  await page.getByLabel("Google OAuth Web client ID").fill(GOOGLE_CLIENT_ID);
  await page.getByRole("button", { name: "Connect Google Sheets" }).click();
  await expect(page.getByText("Google Sheets authorized")).toBeVisible();
}

test("runs a spreadsheet transform in Wasm and requires write approval", async ({ page }) => {
  await page.goto("/?view=operator");

  await expect(page.getByText("Business artifact operation")).toBeVisible();
  await expect(page.getByRole("cell", { name: "aya tanaka" })).toBeVisible();
  await expect(page.getByText("No pending write")).toBeVisible();

  await page.getByRole("button", { name: "Run in Wasm sandbox" }).click();

  await expect(page.getByText("Explicit approval required")).toBeVisible();
  await expect(page.getByText("Typed mutation proposal prepared")).toBeVisible();
  await expect(page.getByRole("group", { name: "Immutable proposal identity" })).toContainText("recheck");
  await expect(page.getByRole("group", { name: "Immutable proposal identity" })).toContainText("12 typed cells");
  await expect(page.getByText("Aya Tanaka", { exact: true })).toBeVisible();
  await expect(page.getByText("WEST", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Approve and apply locally" }).click();

  await expect(page.getByText("No pending write")).toBeVisible();
  await expect(page.getByRole("cell", { name: "Aya Tanaka" })).toBeVisible();
  await expect(page.getByText("Local effect committed")).toBeVisible();
});

test("completes the 60-second local demo without an account or API key", async ({ page }) => {
  await page.goto("/?view=operator&demo=local");

  const guide = page.getByRole("region", { name: "60-second local demo" });
  await expect(guide).toContainText("No account or API key");
  await guide.getByRole("button", { name: "Run bounded transform" }).click();

  await expect(page.getByText("Explicit approval required")).toBeVisible();
  await expect(guide).toContainText("12 typed changes staged");
  await guide.getByRole("button", { name: "Review changes" }).click();
  await page.getByRole("button", { name: "Approve and apply locally" }).click();

  await expect(page.getByText("Local effect committed", { exact: true })).toBeVisible();
  await expect(guide).toContainText("Local loop complete");
  await guide.getByRole("button", { name: "Done" }).click();
  await expect(guide).toBeHidden();
  expect(await page.getByLabel("OpenAI session API key").inputValue()).toBe("");
});

test("keeps the guided local demo usable at 390 pixels", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?view=operator&demo=local");

  const guide = page.getByRole("region", { name: "60-second local demo" });
  await expect(guide).toBeVisible();
  const action = guide.getByRole("button", { name: "Run bounded transform" });
  await expect(action).toBeVisible();
  expect((await action.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
});

test("exports a credential-field-free structured run journal with pilot timing evidence", async ({ page }) => {
  await page.goto("/?view=operator");
  await page.getByLabel("OpenAI session API key").fill("sk-e2e-secret-never-record");
  await page.getByRole("button", { name: "Run in Wasm sandbox" }).click();
  await expect(page.getByText("Explicit approval required")).toBeVisible();
  await page.getByRole("button", { name: "Approve and apply locally" }).click();
  await expect(page.getByText("Local effect committed")).toBeVisible();

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export JSON" }).click();
  const download = await downloadPromise;
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  const serialized = Buffer.concat(chunks).toString("utf8");
  const journal = JSON.parse(serialized) as {
    schemaVersion: number;
    state: string;
    metrics: Record<string, number | null>;
    privacy: Record<string, boolean | string>;
    events: Array<{ category: string; outcome: string; evidence: Record<string, unknown> }>;
  };

  expect(download.suggestedFilename()).toMatch(/^wasmhatch-run-[a-f0-9]{8}\.json$/);
  expect(journal.schemaVersion).toBe(1);
  expect(journal.state).toBe("committed");
  expect(journal.metrics.scriptRuns).toBe(1);
  expect(journal.metrics.proposalsPrepared).toBe(1);
  expect(journal.metrics.approvals).toBe(1);
  expect(journal.metrics.commits).toBe(1);
  expect(journal.metrics.timeToFirstProposalMs).not.toBeNull();
  expect(journal.metrics.timeToFirstCommitMs).not.toBeNull();
  expect(journal.privacy.credentialFieldsIncluded).toBe(false);
  expect(journal.privacy.sourceContentsIncluded).toBe(false);
  expect(journal.privacy.defensiveRedactionApplied).toBe(true);
  expect(journal.events.some((event) => event.category === "policy" && event.outcome === "allowed")).toBe(true);
  expect(journal.events.some((event) => event.category === "effect" && event.outcome === "committed")).toBe(true);
  expect(serialized).not.toContain("sk-e2e-secret-never-record");
  expect(serialized).not.toContain("aya tanaka");
});

test("rejects structural script output before creating a write proposal", async ({ page }) => {
  await page.goto("/?view=operator");
  await page.getByRole("textbox", { name: "Sandbox transformation script" }).fill("(rows) => rows.slice(0, 1)");
  await page.getByRole("button", { name: "Run in Wasm sandbox" }).click();

  await expect(page.getByRole("alert")).toContainText("row insertion or deletion is not supported");
  await expect(page.getByText("No pending write")).toBeVisible();
  await expect(page.getByText("Sandbox transform blocked")).toBeVisible();
});

test("stages an AI plan before the Wasm transform and write review", async ({ page }) => {
  let requestBody: Record<string, unknown> | undefined;
  let authorization = "";
  await page.route("https://api.openai.com/v1/responses", async (route) => {
    requestBody = route.request().postDataJSON() as Record<string, unknown>;
    authorization = route.request().headers().authorization;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        id: "resp_e2e_plan",
        output: [{
          type: "function_call",
          name: "propose_spreadsheet_transform",
          arguments: JSON.stringify({
            summary: "Normalize region labels only.",
            expected_effect: "Rows 2 through 4 receive uppercase region values; all other cells remain unchanged.",
            script: "(rows) => rows.map((row, index) => index === 0 ? row : [row[0], String(row[1]).trim().toUpperCase(), ...row.slice(2)])",
            assumptions: ["Column B contains regions."],
            warnings: []
          })
        }]
      })
    });
  });

  await page.goto("/?view=operator");
  await page.getByLabel("OpenAI session API key").fill("sk-e2e-secret");
  await page.getByRole("button", { name: "Draft with AI" }).click();

  await expect(page.getByRole("heading", { name: "Normalize region labels only." })).toBeVisible();
  await expect(page.getByText("AI plan staged", { exact: true })).toBeVisible();
  expect(authorization).toBe("Bearer sk-e2e-secret");
  expect(requestBody?.store).toBe(false);
  expect(JSON.stringify(requestBody)).not.toContain("sk-e2e-secret");

  await page.getByRole("button", { name: "Run in Wasm sandbox" }).click();
  await expect(page.getByText("Explicit approval required")).toBeVisible();
  await expect(page.getByText("WEST", { exact: true })).toBeVisible();
  await expect(page.getByText("EAST", { exact: true })).toBeVisible();
  await expect(page.getByText("NORTH", { exact: true })).toBeVisible();
});

test("keeps the GIS token out of the UI and revokes it on disconnect", async ({ page }) => {
  await page.goto("/?view=operator");
  await authorizeGoogleSheets(page);

  await expect(page.getByText(/Connected until/)).toBeVisible();
  expect(await page.locator("body").innerText()).not.toContain("test-token");
  await page.getByRole("button", { name: "Revoke Google access" }).click();

  await expect(page.getByText("Google access revoked", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Connect Google Sheets" })).toBeVisible();
  expect(await page.evaluate(() => (globalThis as typeof globalThis & { __wasmhatchRevokedToken?: string }).__wasmhatchRevokedToken)).toBe("test-token");
});

test("materializes an exact Google Sheets grant and commits a reviewed artifact", async ({ page }) => {
  const spreadsheetId = "sheet-ai-provider-resource";
  const range = "Ops!A1:B3";
  const sourceRows = [["Owner", "Amount"], ["Aya", 1200], ["Ken", 900]];
  const requestBodies: Record<string, unknown>[] = [];
  let sheetReads = 0;
  await page.route("https://sheets.googleapis.com/v4/spreadsheets/**", async (route) => {
    sheetReads += 1;
    expect(route.request().method()).toBe("GET");
    expect(route.request().headers().authorization).toBe("Bearer test-token");
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ range, values: sourceRows })
    });
  });
  await page.route("https://api.openai.com/v1/responses", async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    requestBodies.push(body);
    const requestNumber = requestBodies.length;
    let name = "read_google_sheets_range";
    let args: Record<string, unknown> = {};
    if (requestNumber === 2) {
      const serialized = JSON.stringify(body);
      const inputPath = serialized.match(/inputs\/google-sheets-[a-f0-9]{12}\.json/)?.[0];
      if (!inputPath) throw new Error("Materialized Google Sheets path was not returned to the model.");
      name = "propose_workspace_artifact";
      args = {
        summary: "Create a Google Sheets pipeline report.",
        expected_effect: "Write one Markdown total report from the immutable Sheets snapshot.",
        output_path: "outputs/google-pipeline.md",
        media_type: "text/markdown",
        script: `({ fs }) => { const source = JSON.parse(fs.readText("/inputs/workspace/${inputPath}")); const total = source.rows.slice(1).reduce((sum, row) => sum + Number(row[1]), 0); fs.writeText("/outputs/result.md", "# Pipeline total\\n\\n" + total); return { written: 1 }; }`,
        assumptions: ["Row 1 is the header."],
        warnings: []
      };
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        id: `resp_google_${requestNumber}`,
        output: [
          { id: `rs_google_${requestNumber}`, type: "reasoning", summary: [] },
          { id: `fc_google_${requestNumber}`, type: "function_call", call_id: `call_google_${requestNumber}`, name, arguments: JSON.stringify(args), status: "completed" }
        ],
        usage: { input_tokens: 100, output_tokens: 25 }
      })
    });
  });

  await page.goto("/?view=operator");
  await authorizeGoogleSheets(page);
  await page.getByLabel("Spreadsheet ID").fill(spreadsheetId);
  await page.getByLabel("Range").fill(range);
  await page.getByRole("button", { name: "Read range" }).click();
  await expect(page.getByText("AI read grant ready", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Artifact output" }).click();
  await page.getByLabel("Business task").fill("Create a Markdown report with the total amount.");
  await page.getByLabel("OpenAI session API key").fill("sk-google-artifact-e2e");
  await page.getByRole("button", { name: "Draft artifact with AI" }).click();

  await expect(page.getByLabel("AI artifact workflow plan")).toContainText("Create a Google Sheets pipeline report.");
  await expect(page.getByText("Google Sheets AI read snapshot materialized", { exact: true })).toBeVisible();
  expect(sheetReads).toBe(2);
  expect(requestBodies).toHaveLength(2);
  expect(JSON.stringify(requestBodies[0])).toContain("read_google_sheets_range");
  expect(JSON.stringify(requestBodies[1])).toContain("wasmhatch.google-sheets-window.v1");
  expect(JSON.stringify(requestBodies[1])).toContain("Aya");
  expect(JSON.stringify(requestBodies)).not.toContain(spreadsheetId);
  expect(JSON.stringify(requestBodies)).not.toContain("test-token");
  expect(JSON.stringify(requestBodies)).not.toContain("sk-google-artifact-e2e");

  const persisted = await page.evaluate(async () => {
    const origin = await navigator.storage.getDirectory();
    const workspace = await origin.getDirectoryHandle("wasmhatch-operator-workspace-v1");
    const inputs = await workspace.getDirectoryHandle("inputs");
    const names: string[] = [];
    for await (const [name] of (inputs as FileSystemDirectoryHandle & {
      entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
    }).entries()) if (name.startsWith("google-sheets-")) names.push(name);
    const file = await inputs.getFileHandle(names[0]);
    return { name: names[0], content: await (await file.getFile()).text() };
  });
  expect(persisted.name).toMatch(/^google-sheets-[a-f0-9]{12}\.json$/);
  expect(persisted.content).toContain("wasmhatch.google-sheets-snapshot.v1");
  expect(persisted.content).toContain("Aya");
  expect(persisted.content).not.toContain(spreadsheetId);

  await page.getByRole("button", { name: "Run & stage artifact diff" }).click();
  await expect(page.getByLabel("Workspace file diff")).toContainText("2100");
  await page.getByRole("button", { name: "Approve and write workspace file" }).click();
  await expect(page.getByText("Workspace file effect committed", { exact: true })).toBeVisible();
  await expect(page.getByRole("option", { name: /google-pipeline\.md/ })).toBeVisible();

  const journalDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export JSON" }).click();
  const journalStream = await (await journalDownload).createReadStream();
  const journalChunks: Buffer[] = [];
  for await (const chunk of journalStream) journalChunks.push(Buffer.from(chunk));
  const journalText = Buffer.concat(journalChunks).toString("utf8");
  expect(journalText).toContain("google-sheets");
  expect(journalText).toMatch(/sha256:[a-f0-9]{64}/);
  expect(journalText).not.toContain(spreadsheetId);
  expect(journalText).not.toContain("test-token");
});

test("invalidates a pending proposal before switching Google authority", async ({ page }) => {
  await page.route("https://sheets.googleapis.com/v4/spreadsheets/**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        range: "Ops!A1:D2",
        values: [
          ["Owner", "Region", "Amount", "Stage"],
          [" aya tanaka ", " west ", "12,400", "won"]
        ]
      })
    });
  });
  await page.goto("/?view=operator");
  await authorizeGoogleSheets(page);
  await page.getByLabel("Spreadsheet ID").fill("sheet-1");
  await page.getByLabel("Range").fill("Ops!A1:D2");
  await page.getByRole("button", { name: "Read range" }).click();
  await page.getByRole("button", { name: "Run in Wasm sandbox" }).click();
  await expect(page.getByText("Explicit approval required")).toBeVisible();

  await page.getByRole("button", { name: "Switch Google account" }).click();

  await expect(page.getByText("No pending write")).toBeVisible();
  await expect(page.getByText("Write proposal invalidated")).toBeVisible();
  await expect(page.getByRole("button", { name: "Run in Wasm sandbox" })).toBeDisabled();
});

test("rechecks Google Sheets and blocks a stale approved proposal before PUT", async ({ page }) => {
  let reads = 0;
  let writes = 0;
  const authorizationHeaders: string[] = [];
  const originalRows = [
    ["Owner", "Region", "Amount", "Stage"],
    ["  aya tanaka", " west ", "12,400", "won"],
    ["KEN ITO  ", "East", "8300", "OPEN"],
    [" mei sato ", " north", "6,250", " Won "]
  ];
  await page.route("https://sheets.googleapis.com/v4/spreadsheets/**", async (route) => {
    authorizationHeaders.push(route.request().headers().authorization ?? "");
    if (route.request().method() === "GET") {
      reads += 1;
      const values = reads === 1
        ? originalRows
        : originalRows.map((row, index) => index === 1 ? ["External edit", ...row.slice(1)] : row);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ range: "Ops!A1:D4", values })
      });
      return;
    }
    writes += 1;
    await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });

  await page.goto("/?view=operator");
  await authorizeGoogleSheets(page);
  await page.getByLabel("Spreadsheet ID").fill("sheet-1");
  await page.getByLabel("Range").fill("Ops!A1:D4");
  await page.getByRole("button", { name: "Read range" }).click();
  await expect(page.getByText("Google Sheets range read")).toBeVisible();

  await page.getByRole("button", { name: "Run in Wasm sandbox" }).click();
  await expect(page.getByRole("group", { name: "Immutable proposal identity" })).toContainText("recheck");
  await page.getByRole("button", { name: "Approve and write range" }).click();

  await expect(page.getByRole("alert")).toContainText("source changed after this proposal was prepared");
  await expect(page.getByText("Write blocked: source conflict")).toBeVisible();
  await expect(page.getByRole("cell", { name: "External edit" })).toBeVisible();
  expect(reads).toBe(2);
  expect(writes).toBe(0);
  expect(authorizationHeaders).toEqual(["Bearer test-token", "Bearer test-token"]);
});

test("does not retry when a Google Sheets write outcome is uncertain", async ({ page }) => {
  let writes = 0;
  const values = [
    ["Owner", "Region", "Amount", "Stage"],
    ["  aya tanaka", " west ", "12,400", "won"]
  ];
  await page.route("https://sheets.googleapis.com/v4/spreadsheets/**", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ range: "Ops!A1:D2", values })
      });
      return;
    }
    writes += 1;
    await route.abort("timedout");
  });

  await page.goto("/?view=operator");
  await authorizeGoogleSheets(page);
  await page.getByLabel("Spreadsheet ID").fill("sheet-1");
  await page.getByLabel("Range").fill("Ops!A1:D2");
  await page.getByRole("button", { name: "Read range" }).click();
  await page.getByRole("button", { name: "Run in Wasm sandbox" }).click();
  await page.getByRole("button", { name: "Approve and write range" }).click();

  await expect(page.getByRole("alert")).toContainText("may have reached the provider");
  await expect(page.getByText("No pending write")).toBeVisible();
  await expect(page.getByText("Write outcome uncertain", { exact: true })).toBeVisible();
  expect(writes).toBe(1);
});

test("invalidates a pending Google proposal when its target is edited", async ({ page }) => {
  let writes = 0;
  await page.route("https://sheets.googleapis.com/v4/spreadsheets/**", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          range: "Ops!A1:D2",
          values: [
            ["Owner", "Region", "Amount", "Stage"],
            ["  aya tanaka", " west ", "12,400", "won"]
          ]
        })
      });
      return;
    }
    writes += 1;
    await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });

  await page.goto("/?view=operator");
  await authorizeGoogleSheets(page);
  await page.getByLabel("Spreadsheet ID").fill("sheet-1");
  await page.getByLabel("Range").fill("Ops!A1:D2");
  await page.getByRole("button", { name: "Read range" }).click();
  await page.getByRole("button", { name: "Run in Wasm sandbox" }).click();
  await expect(page.getByText("Explicit approval required")).toBeVisible();

  await page.getByLabel("Range").fill("Other!A1:D2");

  await expect(page.getByText("No pending write")).toBeVisible();
  await expect(page.getByText("Write proposal invalidated")).toBeVisible();
  await expect(page.getByRole("button", { name: "Run in Wasm sandbox" })).toBeDisabled();
  expect(writes).toBe(0);
});
