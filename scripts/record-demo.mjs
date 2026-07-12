// Records an uncut WasmHatch demo take as a .webm video.
//
// It drives the real app with a real model — nothing is mocked — so the
// recording is honest launch material (ROADMAP phase 1: "one uncut take").
//
//   WASMHATCH_DEMO_KEY=sk-ant-... node scripts/record-demo.mjs [appUrl]
//
//   WASMHATCH_DEMO_KEY       required; your Anthropic or OpenAI API key.
//                            Read once, typed into the page, never printed.
//   WASMHATCH_DEMO_PROVIDER  "anthropic" (default) or "openai".
//   WASMHATCH_DEMO_TASK      the request to type; the default asks for a
//                            file cleanup plus an in-chat HTML report.
//   appUrl                   default http://localhost:5173 — pass
//                            https://wasmhatch.com for the production take.
//
// Output: demo-recordings/wasmhatch-demo-<timestamp>.webm (git-ignored).
// The Google Sheets beat still needs a human take: OAuth consent is a real
// account interaction this script must not automate.

import { mkdirSync, renameSync } from "node:fs";
import { chromium } from "@playwright/test";

const appUrl = process.argv[2] ?? "http://localhost:5173";
const provider = process.env.WASMHATCH_DEMO_PROVIDER === "openai" ? "openai" : "anthropic";
const key = process.env.WASMHATCH_DEMO_KEY ?? "";
const task = process.env.WASMHATCH_DEMO_TASK ??
  "Tidy up src/greet.ts (clearer names, add a doc comment), then create a one-page HTML report titled \"Tiny Hatch health check\" summarizing the files in this workspace.";

if (!key) {
  console.error("Set WASMHATCH_DEMO_KEY first (your Anthropic or OpenAI key). It is typed into the page and never logged.");
  process.exit(1);
}

const outDir = "demo-recordings";
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1280, height: 800 },
  recordVideo: { dir: outDir, size: { width: 1280, height: 800 } }
});
const page = await context.newPage();
const pause = (ms) => page.waitForTimeout(ms);
let outcome = "completed";

try {
  // Beat 1 — the whole setup: open the link.
  await page.goto(appUrl);
  await page.getByRole("heading", { name: /actually does the work/ }).waitFor();
  await pause(1500);
  await page.getByRole("link", { name: "Open WasmHatch" }).first().click();
  await page.getByRole("heading", { name: "What do you want to get done?" }).waitFor();
  await pause(800);

  // Beat 2 — the one optional step: choose a provider and paste a key.
  // exact: true — the Provider label's text includes its option strings
  // ("Claude (your API key)"), so a substring match would hit the select.
  await page.getByLabel("Provider").selectOption(provider);
  const keyField = page.getByLabel("API key", { exact: true });
  await keyField.click();
  await keyField.pressSequentially(key, { delay: 8 });
  await pause(600);

  // Beat 3 — give it something real to work on.
  await page.getByRole("button", { name: "Add sample files" }).click();
  await page.getByRole("button", { name: "src/greet.ts" }).waitFor();
  const composer = page.getByLabel("Message the agent");
  await composer.click();
  await composer.pressSequentially(task, { delay: 18 });
  await pause(400);
  await composer.press("Enter");

  // Beat 4 — watch the work land: a visible diff and, ideally, an artifact.
  // Bail fast on a visible error (bad key, network) instead of waiting out
  // the full budget — any error on screen means a retake anyway.
  await page.locator(".chat-write, .chat-notice-error").first().waitFor({ timeout: 180_000 });
  if (await page.locator(".chat-notice-error").count()) {
    throw new Error(`the run showed an error: ${await page.locator(".chat-notice-error").first().innerText()}`);
  }
  await page.locator(".artifact-frame").waitFor({ timeout: 180_000 }).catch(() => {
    outcome = "completed (no artifact appeared; diff beat only)";
  });
  await pause(2500);

  // Beat 5 — everything is undoable: open the diff for the camera.
  const firstWrite = page.locator(".chat-write summary").first();
  await firstWrite.click();
  await pause(2500);
} catch (error) {
  outcome = `incomplete: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`;
} finally {
  await context.close(); // flushes the video
  await browser.close();
}

const video = page.video();
const recordedPath = video ? await video.path() : null;
if (recordedPath) {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
  const finalPath = `${outDir}/wasmhatch-demo-${stamp}.webm`;
  renameSync(recordedPath, finalPath);
  console.log(`Take ${outcome === "completed" ? "complete" : "saved"}: ${finalPath}`);
} else {
  console.error("No video was produced.");
  process.exitCode = 1;
}
if (outcome !== "completed") {
  console.error(`Note: ${outcome}`);
  process.exitCode = outcome.startsWith("incomplete") ? 1 : 0;
}
