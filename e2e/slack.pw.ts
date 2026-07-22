import { expect, test } from "@playwright/test";

test("connects a Slack webhook and delivers an agent post as a form-encoded payload", async ({ page }) => {
  const webhookUrl = "https://hooks.slack.com/services/T0E2E/B0E2E/e2esecrete2esecrete2esec";
  const slackBodies: string[] = [];
  await page.route("https://hooks.slack.com/services/**", async (route) => {
    slackBodies.push(route.request().postData() ?? "");
    await route.fulfill({ status: 200, contentType: "text/plain", body: "ok" });
  });

  let modelRequest = 0;
  await page.route("https://api.openai.com/v1/responses", async (route) => {
    modelRequest += 1;
    const events = modelRequest === 1
      ? [
          {
            type: "response.output_item.done",
            output_index: 0,
            item: {
              id: "fc_slack",
              type: "function_call",
              call_id: "call_slack",
              name: "post_slack_message",
              arguments: JSON.stringify({ text: "Weekly report is ready — 3 tickets closed." }),
              status: "completed"
            }
          },
          {
            type: "response.completed",
            response: {
              status: "completed",
              output: [{
                id: "fc_slack",
                type: "function_call",
                call_id: "call_slack",
                name: "post_slack_message",
                arguments: JSON.stringify({ text: "Weekly report is ready — 3 tickets closed." })
              }],
              usage: { input_tokens: 10, output_tokens: 5 }
            }
          }
        ]
      : [
          { type: "response.output_text.delta", output_index: 0, delta: "Posted the update to Slack." },
          {
            type: "response.completed",
            response: { status: "completed", output: [{ id: "msg_1", type: "message" }], usage: { input_tokens: 4, output_tokens: 4 } }
          }
        ];
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("")
    });
  });

  await page.goto("/?view=chat");

  await page.getByLabel("Incoming Webhook URL").fill(webhookUrl);
  await page.getByRole("button", { name: "Connect Slack" }).click();
  await expect(page.getByText("Slack connected.", { exact: false })).toBeVisible();
  // The secret capability URL never lingers in the input.
  await expect(page.getByLabel("Incoming Webhook URL")).toHaveCount(0);

  await page.getByLabel("Provider").selectOption("openai");
  await page.getByLabel("API key", { exact: true }).fill("sk-e2e-slack");
  await page.getByLabel("Message the agent").fill("Post the weekly report summary to Slack.");
  await page.getByRole("button", { name: "Send" }).click();

  await expect(page.getByText("Posting to Slack")).toBeVisible();
  await expect(page.locator(".chat-assistant").last()).toContainText("Posted the update to Slack.");

  expect(slackBodies).toHaveLength(1);
  expect(slackBodies[0].startsWith("payload=")).toBe(true);
  const payload = JSON.parse(decodeURIComponent(slackBodies[0].slice("payload=".length))) as { text: string };
  expect(payload).toEqual({ text: "Weekly report is ready — 3 tickets closed." });
});
