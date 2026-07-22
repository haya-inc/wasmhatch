import { expect, test } from "@playwright/test";

test("hatches a second worker with its own chat, shared tickets, and swarm-aware instructions", async ({ page }) => {
  let instructions = "";
  let toolNames: string[] = [];
  await page.route("https://api.openai.com/v1/responses", async (route) => {
    const body = route.request().postDataJSON() as { instructions?: string; tools?: Array<{ name?: string }> };
    instructions = String(body.instructions ?? "");
    toolNames = (body.tools ?? []).map((tool) => String(tool.name ?? ""));
    const events = [
      { type: "response.output_text.delta", output_index: 0, delta: "On it — checking the board." },
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
  await page.getByLabel("API key", { exact: true }).fill("sk-e2e-hatchlings");

  // Hatch a second worker: it gets its own name, the composer follows the
  // selection, and the selection gets its own URL.
  await page.getByRole("button", { name: "Hatch a new one" }).click();
  const rows = page.locator(".hatchling-row");
  await expect(rows).toHaveCount(2);
  await expect(page.getByLabel("Message the agent")).toHaveAttribute("placeholder", /Ask Momo/);
  await expect(page).toHaveURL(/hatch=h-[a-z0-9]{6}/);

  // The pixel office mirrors the swarm and never hides facts from assistive tech.
  await expect(page.locator(".hatchling-office")).toHaveAttribute("aria-label", /Pip is .*; Momo is /);

  // One shared ticket board serves the user and every hatchling.
  await page.getByLabel("New ticket title").fill("Tidy the Q3 export");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.locator(".ticket-title")).toHaveText("Tidy the Q3 export");

  // A message to the second hatchling carries its identity and the ticket tools.
  await page.getByLabel("Message the agent").fill("Check the board.");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.locator(".chat-assistant")).toContainText("On it — checking the board.");
  expect(instructions).toContain("You are Momo");
  expect(instructions).toContain("working alongside Pip");
  expect(instructions).toMatch(/Today is \w+, \d{4}-\d{2}-\d{2}/);
  expect(toolNames).toEqual(expect.arrayContaining([
    "list_tickets",
    "create_ticket",
    "update_ticket",
    "write_file",
    "run_script",
    "create_artifact"
  ]));

  // Conversations stay isolated per hatchling: Pip's thread is untouched,
  // and the first hatchling keeps the clean parameter-free URL.
  await rows.first().click();
  await expect(page.getByLabel("Message the agent")).toHaveAttribute("placeholder", /Ask Pip/);
  await expect(page.locator(".chat-assistant")).toHaveCount(0);
  await expect(page).not.toHaveURL(/hatch=/);

  // The swarm survives a reload: both hatchlings and the shared ticket return.
  await page.reload();
  await expect(page.locator(".hatchling-row")).toHaveCount(2);
  await expect(page.locator(".ticket-title")).toHaveText("Tidy the Q3 export");

  // Back walks the selection history to Momo's URL…
  await page.goBack();
  await expect(page).toHaveURL(/hatch=h-[a-z0-9]{6}/);
  await expect(page.getByLabel("Message the agent")).toHaveAttribute("placeholder", /Ask Momo/);

  // …and reloading a deep link lands on that hatchling directly.
  await page.reload();
  await expect(page.getByLabel("Message the agent")).toHaveAttribute("placeholder", /Ask Momo/);
});
