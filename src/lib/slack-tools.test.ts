import { describe, expect, it, vi } from "vitest";
import { SLACK_API_TOOLS, createSlackApiExecutor } from "./slack-tools";

const TOKEN = "xoxb-secret-secret-secret";

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

function recordingExecutor(responses: (Response | Error)[], token: string = TOKEN, baseUrl?: string) {
  const calls: { url: string; body: string }[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), body: String(init?.body ?? "") });
    const next = responses.shift();
    if (!next) throw new Error("No scripted response left.");
    if (next instanceof Error) throw next;
    return next;
  });
  const execute = createSlackApiExecutor(() => token, { fetchImpl: fetchImpl as typeof fetch, baseUrl });
  return { execute, calls };
}

describe("createSlackApiExecutor", () => {
  it("exposes the channel-list and channel-post tools", () => {
    expect(SLACK_API_TOOLS.map((tool) => tool.name)).toEqual(["list_slack_channels", "send_slack_channel_message"]);
  });

  it("lists public channels over the body-token form route without leaking the token", async () => {
    const { execute, calls } = recordingExecutor([jsonResponse({
      ok: true,
      channels: [
        { id: "C001", name: "general", is_member: true },
        { id: "C002", name: "random", is_member: false },
        { bogus: true }
      ]
    })]);
    const outcome = await execute("list_slack_channels", {}, {});

    expect(outcome.isError).toBeFalsy();
    expect(outcome.content).toContain("2 public channel(s)");
    expect(outcome.content).toContain("C001  #general  (bot is a member)");
    expect(outcome.content).toContain("C002  #random");
    expect(outcome.content).not.toContain(TOKEN);
    expect(calls[0].url).toBe("https://slack.com/api/conversations.list");
    const params = new URLSearchParams(calls[0].body);
    expect(params.get("token")).toBe(TOKEN);
    expect(params.get("types")).toBe("public_channel");
    expect(params.get("exclude_archived")).toBe("true");
  });

  it("posts to a channel and reports the delivered channel id", async () => {
    const { execute, calls } = recordingExecutor([jsonResponse({ ok: true, channel: "C001", ts: "1.2" })]);
    const outcome = await execute("send_slack_channel_message", { channel: "C001", text: "Report *ready*." }, {});

    expect(outcome.isError).toBeFalsy();
    expect(outcome.content).toBe("Message delivered to C001.");
    expect(calls[0].url).toBe("https://slack.com/api/chat.postMessage");
    const params = new URLSearchParams(calls[0].body);
    expect(params.get("channel")).toBe("C001");
    expect(params.get("text")).toBe("Report *ready*.");
    expect(params.get("token")).toBe(TOKEN);
  });

  it("routes through a configured relay base URL", async () => {
    const { execute, calls } = recordingExecutor(
      [jsonResponse({ ok: true, channels: [] })],
      TOKEN,
      "https://relay.example.workers.dev/api"
    );
    await execute("list_slack_channels", {}, {});
    expect(calls[0].url).toBe("https://relay.example.workers.dev/api/conversations.list");
  });

  it("maps Slack error codes to actionable sentences", async () => {
    const cases: [string, string][] = [
      ["invalid_auth", "rejected the bot token"],
      ["missing_scope", "docs/slack.md"],
      ["channel_not_found", "list_slack_channels"],
      ["not_in_channel", "Invite it in Slack"],
      ["is_archived", "archived"],
      ["ratelimited", "rate-limiting"]
    ];
    for (const [code, fragment] of cases) {
      const { execute } = recordingExecutor([jsonResponse({ ok: false, error: code })]);
      const outcome = await execute("send_slack_channel_message", { channel: "C001", text: "x" }, {});
      expect(outcome.isError).toBe(true);
      expect(outcome.content).toContain(fragment);
      expect(outcome.content).not.toContain(TOKEN);
    }
  });

  it("surfaces the plain-language relay guidance when the browser route is blocked", async () => {
    const { execute } = recordingExecutor([new TypeError("Failed to fetch")]);
    const outcome = await execute("list_slack_channels", {}, {});

    expect(outcome.isError).toBe(true);
    expect(outcome.content).toContain("workers/slack-proxy");
    expect(outcome.content).not.toContain(TOKEN);
  });

  it("validates arguments before any network call", async () => {
    const { execute, calls } = recordingExecutor([]);
    expect((await execute("send_slack_channel_message", { channel: " ", text: "x" }, {})).isError).toBe(true);
    expect((await execute("send_slack_channel_message", { channel: "C1", text: "" }, {})).isError).toBe(true);
    expect((await execute("send_slack_channel_message", { channel: "C1", text: "x".repeat(40_001) }, {})).isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("refuses to run while no bot token is connected", async () => {
    const { execute, calls } = recordingExecutor([], "  ");
    const outcome = await execute("list_slack_channels", {}, {});

    expect(outcome.isError).toBe(true);
    expect(outcome.content).toContain("not connected");
    expect(calls).toHaveLength(0);
  });

  it("rethrows aborts so cancellation stays a cancellation", async () => {
    const { execute } = recordingExecutor([new DOMException("Aborted", "AbortError")]);
    await expect(execute("list_slack_channels", {}, {})).rejects.toMatchObject({ name: "AbortError" });
  });
});
