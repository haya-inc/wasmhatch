import { expect, test } from "@playwright/test";

test("runs a spreadsheet transform in Wasm and requires write approval", async ({ page }) => {
  await page.goto("/?view=operator");

  await expect(page.getByText("Spreadsheet transformation")).toBeVisible();
  await expect(page.getByRole("cell", { name: "aya tanaka" })).toBeVisible();
  await expect(page.getByText("No pending write")).toBeVisible();

  await page.getByRole("button", { name: "Run in Wasm sandbox" }).click();

  await expect(page.getByText("Explicit approval required")).toBeVisible();
  await expect(page.getByText("Sandbox transform completed")).toBeVisible();
  await expect(page.getByText("Aya Tanaka", { exact: true })).toBeVisible();
  await expect(page.getByText("WEST", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Approve and apply locally" }).click();

  await expect(page.getByText("No pending write")).toBeVisible();
  await expect(page.getByRole("cell", { name: "Aya Tanaka" })).toBeVisible();
  await expect(page.getByText("Local write approved")).toBeVisible();
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
