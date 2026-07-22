import { expect, test } from "@playwright/test";

function sse(events: { type: string; [key: string]: unknown }[]) {
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

function functionCallTurn(callId: string, name: string, args: Record<string, unknown>) {
  const item = { id: `fc_${callId}`, type: "function_call", call_id: callId, name, arguments: JSON.stringify(args), status: "completed" };
  return sse([
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { status: "completed", output: [item], usage: { input_tokens: 10, output_tokens: 5 } } }
  ]);
}

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

test("connects a bot token, lists channels, and posts through the body-token Web API route", async ({ page }) => {
  const apiBodies: Record<string, string[]> = {};
  await page.route("https://slack.com/api/**", async (route) => {
    const method = new URL(route.request().url()).pathname.replace("/api/", "");
    (apiBodies[method] ??= []).push(route.request().postData() ?? "");
    const bodies: Record<string, unknown> = {
      "auth.test": { ok: true, team: "E2E Rocket", user_id: "U0BOT" },
      "conversations.list": { ok: true, channels: [{ id: "C0GENERAL", name: "general", is_member: true }] },
      "chat.postMessage": { ok: true, channel: "C0GENERAL", ts: "1.2" }
    };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(bodies[method] ?? { ok: false, error: "unknown_method" }) });
  });

  let modelRequest = 0;
  await page.route("https://api.openai.com/v1/responses", async (route) => {
    modelRequest += 1;
    const body = modelRequest === 1
      ? functionCallTurn("call_list", "list_slack_channels", {})
      : modelRequest === 2
        ? functionCallTurn("call_post", "send_slack_channel_message", { channel: "C0GENERAL", text: "Standup summary posted." })
        : sse([
            { type: "response.output_text.delta", output_index: 0, delta: "Posted to #general." },
            { type: "response.completed", response: { status: "completed", output: [{ id: "msg_1", type: "message" }], usage: { input_tokens: 4, output_tokens: 4 } } }
          ]);
    await route.fulfill({ status: 200, contentType: "text/event-stream", body });
  });

  await page.goto("/?view=chat");

  await page.getByLabel("Bot token (channel tools)").fill("xoxb-e2e-secret");
  await page.getByRole("button", { name: "Connect bot token" }).click();
  await expect(page.getByText("Connected to “E2E Rocket”", { exact: false })).toBeVisible();
  // The secret token never lingers in the input.
  await expect(page.getByLabel("Bot token (channel tools)")).toHaveCount(0);

  await page.getByLabel("Provider").selectOption("openai");
  await page.getByLabel("API key", { exact: true }).fill("sk-e2e-slack-api");
  await page.getByLabel("Message the agent").fill("Post the standup summary to the general channel.");
  await page.getByRole("button", { name: "Send" }).click();

  await expect(page.getByText("Checking Slack channels")).toBeVisible();
  await expect(page.getByText("Posting to Slack — C0GENERAL")).toBeVisible();
  await expect(page.locator(".chat-assistant").last()).toContainText("Posted to #general.");

  const authParams = new URLSearchParams(apiBodies["auth.test"][0]);
  expect(authParams.get("token")).toBe("xoxb-e2e-secret");
  const listParams = new URLSearchParams(apiBodies["conversations.list"][0]);
  expect(listParams.get("token")).toBe("xoxb-e2e-secret");
  expect(listParams.get("types")).toBe("public_channel");
  const postParams = new URLSearchParams(apiBodies["chat.postMessage"][0]);
  expect(postParams.get("channel")).toBe("C0GENERAL");
  expect(postParams.get("text")).toBe("Standup summary posted.");
});
