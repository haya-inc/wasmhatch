import { expect, test } from "@playwright/test";

test("rejects a model's oversized UI and keeps the next conversation usable", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  let calls = 0;
  const oversized = '<a2ui>\nsurface("oversized")\n$/rows = [' + "0,".repeat(10_000) + '0]\nroot = Text(text="Too large")\n</a2ui>';
  await page.route("https://api.openai.com/v1/responses", async (route) => {
    calls += 1;
    // The first answer and the single automatic repair attempt both remain
    // oversized. A fresh user message then receives an ordinary answer.
    const reply = calls <= 2 ? oversized : "The next conversation works.";
    const events = [
      { type: "response.output_text.delta", output_index: 0, delta: reply },
      {
        type: "response.completed",
        response: { status: "completed", output: [{ id: `msg_${calls}`, type: "message" }], usage: { input_tokens: 1, output_tokens: 1 } }
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
  await page.getByLabel("API key", { exact: true }).fill("sk-e2e-input-budget");
  await page.getByLabel("Message the agent").fill("Show the large table.");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByText(/Interactive view could not be rendered:.*10,000 items/)).toBeVisible();
  expect(calls).toBe(2);

  await page.getByLabel("Message the agent").fill("Now say that this conversation works.");
  await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.locator(".chat-assistant").last()).toContainText("The next conversation works.");
  expect(calls).toBe(3);
  expect(pageErrors).toEqual([]);
});
