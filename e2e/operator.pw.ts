import { expect, test } from "@playwright/test";

test("runs a spreadsheet transform in Wasm and requires write approval", async ({ page }) => {
  await page.goto("/?view=operator");

  await expect(page.getByText("Spreadsheet transformation")).toBeVisible();
  await expect(page.getByRole("cell", { name: "aya tanaka" })).toBeVisible();
  await expect(page.getByText("No pending write")).toBeVisible();

  await page.getByRole("button", { name: "Run in Wasm sandbox" }).click();

  await expect(page.getByText("Explicit approval required")).toBeVisible();
  await expect(page.getByText("Immutable write proposal prepared")).toBeVisible();
  await expect(page.getByRole("group", { name: "Immutable proposal identity" })).toContainText("recheck");
  await expect(page.getByText("Aya Tanaka", { exact: true })).toBeVisible();
  await expect(page.getByText("WEST", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Approve and apply locally" }).click();

  await expect(page.getByText("No pending write")).toBeVisible();
  await expect(page.getByRole("cell", { name: "Aya Tanaka" })).toBeVisible();
  await expect(page.getByText("Local effect committed")).toBeVisible();
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
  await page.getByLabel("Development access token").fill("test-token");
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
  await page.getByLabel("Development access token").fill("test-token");
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
  await page.getByLabel("Development access token").fill("test-token");
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
