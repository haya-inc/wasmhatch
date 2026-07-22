import { expect, test } from "@playwright/test";
import { createPortableAgentPackage, PORTABLE_AGENT_MEDIA_TYPE } from "../src/lib/agent-package";

test("imports a portable agent behind a preview, hatches it, and confines its tools", async ({ page }) => {
  const pkg = await createPortableAgentPackage({
    id: "report-chick",
    name: "Report Chick",
    summary: "Turns notes into a weekly brief.",
    version: "1.0.0",
    license: "Apache-2.0",
    entrypoint: "AGENTS.md",
    permissions: { tools: ["workspace.read", "artifacts"], networkOrigins: [] },
    examples: []
  }, [
    { path: "AGENTS.md", content: "Always follow the REPORT-CHICK-PLAYBOOK-MARKER method.\n" },
    { path: "templates/brief.md", content: "# Brief\n" }
  ]);

  let requestBody: { instructions?: string; tools?: { name?: string }[] } = {};
  await page.route("https://api.openai.com/v1/responses", async (route) => {
    requestBody = route.request().postDataJSON() as typeof requestBody;
    const events = [
      { type: "response.output_text.delta", output_index: 0, delta: "Chirp — brief writer ready." },
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
  await page.getByLabel("Import portable agent file").setInputFiles({
    name: "report-chick-1.0.0.agent",
    mimeType: PORTABLE_AGENT_MEDIA_TYPE,
    buffer: Buffer.from(pkg.bytes)
  });

  // Nothing hatches without consent: the preview names the files and capabilities.
  await expect(page.getByText("Hatch “Report Chick”?")).toBeVisible();
  await expect(page.getByText("report-chick@1.0.0", { exact: false })).toBeVisible();
  await expect(page.getByText("Requested capabilities: workspace.read, artifacts")).toBeVisible();
  await page.getByRole("button", { name: "Hatch it" }).click();
  await expect(page.getByText("Hatched “Report Chick”", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: /Report Chick/ })).toBeVisible();

  await page.getByLabel("Provider").selectOption("openai");
  await page.getByLabel("API key", { exact: true }).fill("sk-e2e-portable");
  await page.getByLabel("Message the agent").fill("Introduce yourself.");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.locator(".chat-assistant").last()).toContainText("Chirp — brief writer ready.");

  // The packaged playbook rides the system prompt, framed as untrusted content.
  expect(requestBody.instructions).toContain("REPORT-CHICK-PLAYBOOK-MARKER");
  expect(requestBody.instructions).toContain("BEGIN PACKAGED PLAYBOOK");
  // The capability allowlist fails closed: reads and artifacts only.
  const toolNames = (requestBody.tools ?? []).map((tool) => tool.name).filter(Boolean);
  expect(toolNames).toContain("read_file");
  expect(toolNames).toContain("list_files");
  expect(toolNames).toContain("create_artifact");
  expect(toolNames).not.toContain("write_file");
  expect(toolNames).not.toContain("run_script");
  expect(toolNames).not.toContain("list_tickets");
});
