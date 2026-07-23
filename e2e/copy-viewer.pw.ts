import { expect, test } from "@playwright/test";
import { FIRST_RUN_CSV_SAMPLE } from "../src/lib/first-run-csv-sample";

test("copies the viewed file's exact contents from the file viewer", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);

  await page.goto("/?view=chat");
  await page.getByRole("button", { name: "Add a sample spreadsheet" }).click();
  await page.getByRole("button", { name: FIRST_RUN_CSV_SAMPLE.fileName }).click();

  const viewerPanel = page.locator(".chat-panel", { has: page.locator(".chat-viewer") });
  await expect(viewerPanel.locator(".chat-viewer")).toContainText("aya tanaka");

  const copyButton = viewerPanel.getByRole("button", { name: "Copy", exact: true });
  await expect(copyButton).toBeEnabled();
  await copyButton.click();

  // Feedback flips to "Copied" for about two seconds, then returns.
  await expect(viewerPanel.getByRole("button", { name: "Copied", exact: true })).toBeVisible();
  const clipboard = await page.evaluate(() => navigator.clipboard.readText());
  // The OS clipboard may normalize newlines (CRLF on Windows); the copied
  // text is otherwise byte-exact.
  expect(clipboard.replace(/\r\n/g, "\n")).toBe(FIRST_RUN_CSV_SAMPLE.content);
  await expect(copyButton).toHaveText("Copy", { timeout: 5000 });

  // Opening another view of the file starts back at the default label.
  await viewerPanel.getByRole("button", { name: "Close" }).click();
  await page.getByRole("button", { name: FIRST_RUN_CSV_SAMPLE.fileName }).click();
  await expect(viewerPanel.getByRole("button", { name: "Copy", exact: true })).toBeVisible();
});
