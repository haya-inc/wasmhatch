import { expect, test } from "@playwright/test";

test("presents a friendly consumer landing without technical jargon", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");

  await expect(page.getByRole("heading", { name: /actually does the work/ })).toBeVisible();
  await expect(page.getByText("No install, no account")).toBeVisible();
  await expect(page.getByRole("link", { name: /Try it now/ })).toHaveAttribute("href", "/?view=chat");
  await expect(page.getByRole("heading", { name: "There is no setup." })).toBeVisible();
  await expect(page.getByText("Open the link.", { exact: true })).toBeVisible();
  await expect(page.getByText(/because no server registers you/)).toBeVisible();
  await expect(page.getByRole("heading", { name: "One assistant for the busywork." })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Fix messy spreadsheets" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Draft docs and decks" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Keep it or undo it" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Private by design" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Yours to keep" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Hatch a tiny team in one tab." })).toBeVisible();
  await expect(page.getByText(/connect Ollama on your own machine/)).toBeVisible();

  // Interactive hatchlings showcase switches the inspected desk card cleanly on mobile too.
  await page.getByRole("button", { name: "Mame", exact: true }).click();
  await expect(page.getByText("Data wrangler · isolated workspace")).toBeVisible();

  // The first screen a stranger sees must stay free of internal jargon.
  // The brand name itself contains "wasm", so it is excluded first.
  const body = (await page.locator("body").innerText()).toLowerCase().replaceAll("wasmhatch", "");
  for (const banned of ["wasm", "quickjs", "sandbox", "manifest", "opfs", "csp"]) {
    expect(body, `landing page should not say "${banned}"`).not.toContain(banned);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
});
