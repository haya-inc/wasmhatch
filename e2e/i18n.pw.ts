import { expect, test } from "@playwright/test";

test("switches the UI to Japanese in place and remembers the choice", async ({ page }) => {
  await page.goto("/?view=chat");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("What do you want to get done?");

  await page.getByLabel("Language").selectOption("ja");
  // In-place switch: same page, no reload, document language follows.
  await expect(page.locator("html")).toHaveAttribute("lang", "ja");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(/何を片付け/);
  await expect(page.getByRole("button", { name: "送信" })).toBeVisible();

  // The choice persists across reloads.
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("lang", "ja");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(/何を片付け/);
});

test("auto-detects the browser language on first visit", async ({ browser }) => {
  const context = await browser.newContext({ locale: "ja-JP" });
  const page = await context.newPage();
  await page.goto("/?view=chat");
  await expect(page.locator("html")).toHaveAttribute("lang", "ja");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(/何を片付け/);
  await context.close();
});

test("switches the landing page to Japanese in place without mobile overflow", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");

  await page.getByLabel("Language").selectOption("ja");
  await expect(page.locator("html")).toHaveAttribute("lang", "ja");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("本当に手を動かしてくれる");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
});
