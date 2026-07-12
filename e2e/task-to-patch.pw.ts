import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { strToU8, zipSync } from "fflate";

const issueUrl = "https://github.com/haya-inc/wasmhatch/issues/4";
const task = "Trim the greeting input and keep the change focused.";
const before = "export function greet(name: string): string {\n  return `Hello, ${name}!`;\n}\n";
const after = "export function greet(name: string): string {\n  return `Hello, ${name.trim()}!`;\n}\n";

test("carries a contribution target from task link to patch download", async ({ page }) => {
  await page.addInitScript(() => {
    const originalGetDirectory = navigator.storage.getDirectory.bind(navigator.storage);
    let firstCall = true;
    let releaseFirstCall!: () => void;
    const firstCallGate = new Promise<void>((resolve) => {
      releaseFirstCall = resolve;
    });
    (globalThis as typeof globalThis & { __releaseWorkspaceDirectory?: () => void })
      .__releaseWorkspaceDirectory = releaseFirstCall;
    Object.defineProperty(navigator.storage, "getDirectory", {
      configurable: true,
      value: async () => {
        if (firstCall) {
          firstCall = false;
          await firstCallGate;
        }
        return originalGetDirectory();
      }
    });
  });
  const query = new URLSearchParams({
    view: "workspace",
    repo: "haya-inc/wasmhatch",
    ref: "3b4a3876b1ff47e9d954f570ec6a79913c1a1da8",
    task,
    issue: issueUrl
  });
  await page.goto(`/?${query.toString()}`);

  await expect(page.getByLabel("Task")).toHaveValue(task);
  await expect(page.getByRole("link", { name: "Issue #4" })).toHaveAttribute("href", issueUrl);
  const archiveButton = page.getByRole("button", { name: "Import zip archive" });
  await expect(archiveButton).toBeDisabled();
  await page.evaluate(() => {
    (globalThis as typeof globalThis & { __releaseWorkspaceDirectory?: () => void })
      .__releaseWorkspaceDirectory?.();
  });

  const archive = zipSync({
    "README.md": strToU8("# Fixture\n"),
    "src/greet.ts": strToU8(before)
  });
  await expect(archiveButton).toBeEnabled();
  const fileChooserPromise = page.waitForEvent("filechooser");
  await archiveButton.click();
  const fileChooser = await fileChooserPromise;
  await fileChooser.setFiles({
    name: "fixture.zip",
    mimeType: "application/zip",
    buffer: Buffer.from(archive)
  });
  await expect(page.getByText("Imported 2 text files from fixture.zip.")).toBeVisible();

  await page.getByRole("button", { name: "src/greet.ts" }).click();
  const editor = page.getByLabel("Code editor");
  const save = page.getByRole("button", { name: "Save" });
  await expect(editor).toHaveValue(before);
  await editor.fill(after);
  await expect(save).toBeEnabled();
  await save.click();
  await expect(page.getByText("Saved src/greet.ts locally.")).toBeVisible();

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Patch" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("wasmhatch.patch");
  const downloadPath = await download.path();
  expect(downloadPath).not.toBeNull();
  const patch = await readFile(downloadPath!, "utf8");
  expect(patch).toContain("--- a/src/greet.ts");
  expect(patch).toContain("+++ b/src/greet.ts");
  expect(patch).toContain("+  return `Hello, ${name.trim()}!`;");
  await expect(page.getByText(/Patch downloaded\. Apply it in a local branch/)).toBeVisible();
});
