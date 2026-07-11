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
