import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";

test("renders assistant markdown as structure without ever injecting HTML", async ({ page }) => {
  const reply = [
    "## Plan",
    "",
    "Here is **bold**, *soft*, and `code` — 2 * 3 * 4 stays math.",
    "",
    "- first",
    "- second",
    "",
    "```js",
    "const x = 1; // **not bold in here**",
    "```",
    "",
    "Read [the guide](https://example.com/guide) but not [this](javascript:alert(1)).",
    "",
    "<img src=x onerror=alert(1)>"
  ].join("\n");
  let instructions = "";
  await page.route("https://api.openai.com/v1/responses", async (route) => {
    const body = route.request().postDataJSON() as { instructions?: string };
    instructions = String(body.instructions ?? "");
    const events = [
      { type: "response.output_text.delta", output_index: 0, delta: reply },
      {
        type: "response.completed",
        response: { status: "completed", output: [{ id: "msg_1", type: "message" }], usage: { input_tokens: 1, output_tokens: 1 } }
      }
    ];
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("")
    });
  });

  await page.goto("/?view=chat");
  await page.getByLabel("Provider").selectOption("openai");
  // exact: true — the Provider label's own text contains "API key" via its options.
  await page.getByLabel("API key", { exact: true }).fill("sk-e2e-markdown");
  await page.getByLabel("Message the agent").fill("Show me markdown.");
  await page.getByRole("button", { name: "Send" }).click();

  const bubble = page.locator(".chat-assistant");
  await expect(bubble.getByRole("heading", { name: "Plan" })).toBeVisible();
  await expect(bubble.locator("strong")).toHaveText("bold");
  await expect(bubble.locator("em")).toHaveText("soft");
  await expect(bubble.locator("ul li")).toHaveCount(2);
  await expect(bubble.locator("pre code")).toContainText("const x = 1;");
  await expect(bubble.locator("pre strong")).toHaveCount(0);
  await expect(bubble).toContainText("2 * 3 * 4 stays math");

  const link = bubble.getByRole("link", { name: "the guide" });
  await expect(link).toHaveAttribute("href", "https://example.com/guide");
  await expect(link).toHaveAttribute("rel", /noopener/);
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(bubble.locator('a:not([href^="https://example.com"])')).toHaveCount(0);

  // Raw markers must not leak, and markup in model output stays inert text.
  await expect(bubble).not.toContainText("**bold**");
  await expect(bubble).toContainText("<img src=x onerror=alert(1)>");
  await expect(bubble.locator("img")).toHaveCount(0);

  // The system prompt carries today's date so models can resolve "this Friday"
  // without asking the user.
  expect(instructions).toMatch(/Today is \w+, \d{4}-\d{2}-\d{2}/);
});

test("records the run in the journal and exports it as credential-redacted JSON", async ({ page }) => {
  await page.route("https://api.openai.com/v1/responses", async (route) => {
    const events = [
      { type: "response.output_text.delta", output_index: 0, delta: "All done." },
      {
        type: "response.completed",
        response: { status: "completed", output: [{ id: "msg_1", type: "message" }], usage: { input_tokens: 2, output_tokens: 2 } }
      }
    ];
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("")
    });
  });

  await page.goto("/?view=chat");
  const journalPanel = page.locator(".chat-panel", { hasText: "Run journal" });
  await expect(journalPanel).toContainText("stays in this tab");

  await page.getByLabel("Provider").selectOption("openai");
  await page.getByLabel("API key", { exact: true }).fill("sk-e2e-journal-secret");
  await page.getByLabel("Message the agent").fill("Say you are done.");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.locator(".chat-assistant").last()).toContainText("All done.");

  await expect(journalPanel).toContainText("2 events · 0 tool calls · 0 writes");
  await expect(journalPanel).toContainText("Manual run started");
  await expect(journalPanel).toContainText("Run finished");

  const downloadPromise = page.waitForEvent("download");
  await journalPanel.getByRole("button", { name: "Export JSON" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^wasmhatch-run-[a-f0-9]{12}\.json$/);
  const exported = JSON.parse(await readFile(await download.path(), "utf8")) as {
    schemaVersion: number;
    events: { summary: string }[];
    context: { task: string };
    privacy: { credentialFieldsIncluded: boolean };
  };
  expect(exported.schemaVersion).toBe(1);
  expect(exported.events.map((event) => event.summary)).toEqual(["Manual run started", "Run finished"]);
  expect(exported.context.task).toBe("Say you are done.");
  expect(exported.privacy.credentialFieldsIncluded).toBe(false);
  expect(JSON.stringify(exported)).not.toContain("sk-e2e-journal-secret");
});
