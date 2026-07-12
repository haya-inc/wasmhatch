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
  await page.route("https://api.openai.com/v1/chat/completions", async (route) => {
    const chunks = [
      JSON.stringify({ choices: [{ delta: { content: reply } }] }),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } })
    ];
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: chunks.map((chunk) => `data: ${chunk}\n\n`).join("") + "data: [DONE]\n\n"
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
});
