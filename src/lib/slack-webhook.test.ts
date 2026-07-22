import { describe, expect, it, vi } from "vitest";
import {
  SLACK_WEBHOOK_TOOLS,
  createSlackWebhookExecutor,
  isSlackWebhookUrl
} from "./slack-webhook";

const WEBHOOK_URL = "https://hooks.slack.com/services/T0001/B0002/secretsecretsecretsecret";

function recordingExecutor(response: Response | Error, url: string = WEBHOOK_URL) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    if (response instanceof Error) throw response;
    return response;
  });
  const execute = createSlackWebhookExecutor(() => url, { fetchImpl: fetchImpl as typeof fetch });
  return { execute, calls };
}

describe("isSlackWebhookUrl", () => {
  it("accepts only https hooks.slack.com service URLs without query or fragment", () => {
    expect(isSlackWebhookUrl(WEBHOOK_URL)).toBe(true);
    expect(isSlackWebhookUrl("")).toBe(false);
    expect(isSlackWebhookUrl("http://hooks.slack.com/services/T/B/x")).toBe(false);
    expect(isSlackWebhookUrl("https://hooks.slack.com/other/T/B/x")).toBe(false);
    expect(isSlackWebhookUrl("https://evil.example/services/T/B/x")).toBe(false);
    expect(isSlackWebhookUrl(`${WEBHOOK_URL}?x=1`)).toBe(false);
    expect(isSlackWebhookUrl(`${WEBHOOK_URL}#x`)).toBe(false);
  });
});

describe("createSlackWebhookExecutor", () => {
  it("exposes exactly one posting tool", () => {
    expect(SLACK_WEBHOOK_TOOLS.map((tool) => tool.name)).toEqual(["post_slack_message"]);
  });

  it("delivers text as a preflight-free form-encoded payload and confirms on ok", async () => {
    const { execute, calls } = recordingExecutor(new Response("ok", { status: 200 }));
    const outcome = await execute("post_slack_message", { text: "Report is *ready* — 12 rows fixed." }, {});

    expect(outcome.isError).toBeFalsy();
    expect(outcome.content).toContain("delivered");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(WEBHOOK_URL);
    expect(calls[0].init?.method).toBe("POST");
    expect((calls[0].init?.headers as Record<string, string>)["content-type"]).toBe("application/x-www-form-urlencoded");
    const body = String(calls[0].init?.body);
    expect(body.startsWith("payload=")).toBe(true);
    const payload = JSON.parse(decodeURIComponent(body.slice("payload=".length))) as { text: string };
    expect(payload).toEqual({ text: "Report is *ready* — 12 rows fixed." });
  });

  it("explains a revoked webhook without leaking the URL", async () => {
    const { execute } = recordingExecutor(new Response("no_service", { status: 404 }));
    const outcome = await execute("post_slack_message", { text: "hello" }, {});

    expect(outcome.isError).toBe(true);
    expect(outcome.content).toContain("revoked");
    expect(outcome.content).not.toContain("hooks.slack.com");
    expect(outcome.content).not.toContain("secretsecret");
  });

  it("maps archived-channel and rate-limit errors to actionable sentences", async () => {
    const archived = recordingExecutor(new Response("channel_is_archived", { status: 410 }));
    expect((await archived.execute("post_slack_message", { text: "x" }, {})).content).toContain("archived");

    const limited = recordingExecutor(new Response("rate_limited", { status: 429 }));
    expect((await limited.execute("post_slack_message", { text: "x" }, {})).content).toContain("rate-limiting");
  });

  it("reports an unreachable network without claiming delivery", async () => {
    const { execute } = recordingExecutor(new TypeError("Failed to fetch"));
    const outcome = await execute("post_slack_message", { text: "hello" }, {});

    expect(outcome.isError).toBe(true);
    expect(outcome.content).toContain("not delivered");
    expect(outcome.content).not.toContain(WEBHOOK_URL);
  });

  it("rejects empty, non-string, and oversized text without a network call", async () => {
    const { execute, calls } = recordingExecutor(new Response("ok", { status: 200 }));
    expect((await execute("post_slack_message", { text: "   " }, {})).isError).toBe(true);
    expect((await execute("post_slack_message", { text: 7 }, {})).isError).toBe(true);
    expect((await execute("post_slack_message", { text: "x".repeat(40_001) }, {})).isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("refuses to run while Slack is not connected", async () => {
    const { execute, calls } = recordingExecutor(new Response("ok", { status: 200 }), "");
    const outcome = await execute("post_slack_message", { text: "hello" }, {});

    expect(outcome.isError).toBe(true);
    expect(outcome.content).toContain("not connected");
    expect(calls).toHaveLength(0);
  });

  it("rethrows aborts so cancellation stays a cancellation", async () => {
    const { execute } = recordingExecutor(new DOMException("Aborted", "AbortError"));
    await expect(execute("post_slack_message", { text: "hello" }, {})).rejects.toMatchObject({ name: "AbortError" });
  });
});
