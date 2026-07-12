import { describe, expect, it } from "vitest";
import {
  SLACK_API_BASE_URL,
  probeSlackConnectivity,
  slackApiCall,
  type SlackProbeResult
} from "./slack-connect";

// Deliberately NOT in the real xox?-… token shape so GitHub push protection
// never mistakes the fixture for a leaked credential.
const TOKEN = "test-slack-token-fixture-SuperSecretProbeToken";

interface RecordedCall {
  url: string;
  init: RequestInit;
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json;charset=utf-8" }
  });
}

function stubFetch(respond: (call: RecordedCall) => Response | Promise<Response>): {
  fetchImpl: typeof fetch;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: RecordedCall = { url: String(input), init: init ?? {} };
    calls.push(call);
    return respond(call);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function throwingFetch(error: unknown): typeof fetch {
  return (async () => {
    throw error;
  }) as typeof fetch;
}

describe("probeSlackConnectivity", () => {
  it("reports connected with team and user when auth.test succeeds", async () => {
    const { fetchImpl, calls } = stubFetch(() => jsonResponse({ ok: true, team: "Haya Inc", user_id: "U0AGENT" }));

    const result = await probeSlackConnectivity(TOKEN, { fetchImpl });

    expect(result).toMatchObject({ ok: true, status: "connected", team: "Haya Inc", userId: "U0AGENT" });
    expect(result.diagnostic).toContain("Haya Inc");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${SLACK_API_BASE_URL}/auth.test`);
  });

  it.each(["invalid_auth", "token_revoked", "account_inactive", "token_expired"])(
    "reports invalid-token when Slack answers %s",
    async (error) => {
      const { fetchImpl } = stubFetch(() => jsonResponse({ ok: false, error }));

      const result = await probeSlackConnectivity(TOKEN, { fetchImpl });

      expect(result.ok).toBe(false);
      expect(result.status).toBe("invalid-token");
      expect(result.diagnostic).toContain(error);
    }
  );

  it("reports cors-blocked and points at the bundled Worker proxy when fetch throws a TypeError", async () => {
    const result = await probeSlackConnectivity(TOKEN, { fetchImpl: throwingFetch(new TypeError("Failed to fetch")) });

    expect(result.ok).toBe(false);
    expect(result.status).toBe("cors-blocked");
    expect(result.diagnostic).toContain("blocked");
    expect(result.diagnostic).toContain("workers/slack-proxy");
  });

  it("reports network-error for non-CORS fetch failures", async () => {
    const result = await probeSlackConnectivity(TOKEN, { fetchImpl: throwingFetch(new Error("socket hang up")) });

    expect(result.ok).toBe(false);
    expect(result.status).toBe("network-error");
    expect(result.diagnostic).toContain("socket hang up");
  });

  it("reports network-error for HTTP failures", async () => {
    const { fetchImpl } = stubFetch(() => jsonResponse({ ok: false, error: "ratelimited" }, 429));

    const result = await probeSlackConnectivity(TOKEN, { fetchImpl });

    expect(result.ok).toBe(false);
    expect(result.status).toBe("network-error");
    expect(result.diagnostic).toContain("429");
  });

  it("reports network-error with the Slack error code for non-token failures", async () => {
    const { fetchImpl } = stubFetch(() => jsonResponse({ ok: false, error: "fatal_error" }));

    const result = await probeSlackConnectivity(TOKEN, { fetchImpl });

    expect(result.status).toBe("network-error");
    expect(result.diagnostic).toContain("fatal_error");
  });

  it("treats not_authed as a broken body-token route and points at the Worker proxy", async () => {
    const { fetchImpl } = stubFetch(() => jsonResponse({ ok: false, error: "not_authed" }));

    const result = await probeSlackConnectivity(TOKEN, { fetchImpl });

    expect(result.ok).toBe(false);
    expect(result.status).toBe("cors-blocked");
    expect(result.diagnostic).toContain("workers/slack-proxy");
  });

  it("reports a route-change hint when the response body is not JSON", async () => {
    const { fetchImpl } = stubFetch(
      () => new Response("<html>not json</html>", { status: 200, headers: { "Content-Type": "text/html" } })
    );

    const result = await probeSlackConnectivity(TOKEN, { fetchImpl });

    expect(result.status).toBe("network-error");
    expect(result.diagnostic).toContain("workers/slack-proxy");
  });

  it("treats an empty token as invalid without touching the network", async () => {
    const { fetchImpl, calls } = stubFetch(() => jsonResponse({ ok: true }));

    const result = await probeSlackConnectivity("   ", { fetchImpl });

    expect(result.status).toBe("invalid-token");
    expect(calls).toHaveLength(0);
  });

  it("sends the token in a form-encoded body without an Authorization header", async () => {
    const { fetchImpl, calls } = stubFetch(() => jsonResponse({ ok: true }));

    await probeSlackConnectivity(TOKEN, { fetchImpl });

    const { init } = calls[0];
    expect(init.method).toBe("POST");
    const headers = new Headers(init.headers);
    expect(headers.get("content-type")).toContain("application/x-www-form-urlencoded");
    expect(headers.get("authorization")).toBeNull();
    const body = new URLSearchParams(String(init.body));
    expect(body.get("token")).toBe(TOKEN);
  });

  it("honors a custom baseUrl, including one with a trailing slash", async () => {
    const { fetchImpl, calls } = stubFetch(() => jsonResponse({ ok: true }));

    await probeSlackConnectivity(TOKEN, { fetchImpl, baseUrl: "https://slack-proxy.example.workers.dev/api/" });

    expect(calls[0].url).toBe("https://slack-proxy.example.workers.dev/api/auth.test");
  });

  it("never places the token in any diagnostic, even when underlying errors contain it", async () => {
    const results: SlackProbeResult[] = await Promise.all([
      probeSlackConnectivity(TOKEN, { fetchImpl: stubFetch(() => jsonResponse({ ok: true, team: "T", user_id: "U" })).fetchImpl }),
      probeSlackConnectivity(TOKEN, { fetchImpl: stubFetch(() => jsonResponse({ ok: false, error: "invalid_auth" })).fetchImpl }),
      probeSlackConnectivity(TOKEN, { fetchImpl: stubFetch(() => jsonResponse({ ok: false, error: "not_authed" })).fetchImpl }),
      probeSlackConnectivity(TOKEN, { fetchImpl: stubFetch(() => jsonResponse({}, 500)).fetchImpl }),
      probeSlackConnectivity(TOKEN, { fetchImpl: throwingFetch(new TypeError(`refused for ${TOKEN}`)) }),
      probeSlackConnectivity(TOKEN, { fetchImpl: throwingFetch(new Error(`ECONNRESET while sending ${TOKEN}`)) }),
      probeSlackConnectivity(TOKEN, { fetchImpl: throwingFetch(`string failure carrying ${TOKEN}`) })
    ]);

    for (const result of results) {
      expect(result.diagnostic).not.toContain(TOKEN);
      expect(JSON.stringify(result)).not.toContain(TOKEN);
    }
  });
});

describe("slackApiCall", () => {
  it("posts URL-encoded params with the token in the body and no Authorization header", async () => {
    const { fetchImpl, calls } = stubFetch(() => jsonResponse({ ok: true, channels: [] }));

    const payload = await slackApiCall<{ ok: boolean; channels: unknown[] }>(
      "conversations.list",
      TOKEN,
      { limit: 200, exclude_archived: true, types: "public_channel,private_channel" },
      { fetchImpl }
    );

    expect(payload.ok).toBe(true);
    expect(payload.channels).toEqual([]);
    expect(calls[0].url).toBe(`${SLACK_API_BASE_URL}/conversations.list`);
    expect(calls[0].init.method).toBe("POST");
    const headers = new Headers(calls[0].init.headers);
    expect(headers.get("content-type")).toContain("application/x-www-form-urlencoded");
    expect(headers.get("authorization")).toBeNull();
    const body = new URLSearchParams(String(calls[0].init.body));
    expect(body.get("token")).toBe(TOKEN);
    expect(body.get("limit")).toBe("200");
    expect(body.get("exclude_archived")).toBe("true");
    expect(body.get("types")).toBe("public_channel,private_channel");
  });

  it("URL-encodes reserved characters in param values", async () => {
    const { fetchImpl, calls } = stubFetch(() => jsonResponse({ ok: true }));

    await slackApiCall("chat.postMessage", TOKEN, { channel: "C123", text: "hi there & <everyone> = 100%" }, { fetchImpl });

    const rawBody = String(calls[0].init.body);
    expect(rawBody).not.toContain("hi there &");
    expect(new URLSearchParams(rawBody).get("text")).toBe("hi there & <everyone> = 100%");
  });

  it("targets a custom baseUrl for the Worker proxy", async () => {
    const { fetchImpl, calls } = stubFetch(() => jsonResponse({ ok: true }));

    await slackApiCall("auth.test", TOKEN, {}, { fetchImpl, baseUrl: "https://slack-proxy.example.workers.dev/api" });

    expect(calls[0].url).toBe("https://slack-proxy.example.workers.dev/api/auth.test");
  });

  it.each(["auth.test", "chat.postMessage", "admin.users.session.reset"])(
    "accepts the well-formed method name %s",
    async (method) => {
      const { fetchImpl, calls } = stubFetch(() => jsonResponse({ ok: true }));

      await slackApiCall(method, TOKEN, {}, { fetchImpl });

      expect(calls[0].url).toBe(`${SLACK_API_BASE_URL}/${method}`);
    }
  );

  it.each([
    "",
    "authtest",
    "auth",
    ".auth.test",
    "auth.test.",
    "auth..test",
    "Auth.test",
    "auth.te st",
    "auth.test/../users.list",
    "https://evil.example/auth.test",
    "xoxb-not-a-method"
  ])("rejects the malformed method name %j without calling fetch", async (method) => {
    const { fetchImpl, calls } = stubFetch(() => jsonResponse({ ok: true }));

    await expect(slackApiCall(method, TOKEN, {}, { fetchImpl })).rejects.toThrow(/method name/i);
    expect(calls).toHaveLength(0);
  });

  it("does not echo a rejected method value in the error (swapped-argument safety)", async () => {
    const { fetchImpl } = stubFetch(() => jsonResponse({ ok: true }));

    const failure = await slackApiCall(TOKEN, "auth.test", {}, { fetchImpl }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/method name/i);
    expect((failure as Error).message).not.toContain(TOKEN);
  });

  it("keeps the token out of thrown errors when the underlying fetch fails", async () => {
    const fetchImpl = throwingFetch(new Error(`connect ECONNREFUSED while sending ${TOKEN}`));

    const failure = await slackApiCall("auth.test", TOKEN, {}, { fetchImpl }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).not.toContain(TOKEN);
    expect((failure as Error).message).toContain("[redacted]");
  });

  it("surfaces the proxy fallback guidance when fetch is CORS-blocked", async () => {
    const fetchImpl = throwingFetch(new TypeError("Failed to fetch"));

    await expect(slackApiCall("auth.test", TOKEN, {}, { fetchImpl })).rejects.toThrow(/workers\/slack-proxy/);
  });

  it("throws a safe error on HTTP failure", async () => {
    const { fetchImpl } = stubFetch(() => jsonResponse({ ok: false }, 503));

    const failure = await slackApiCall("auth.test", TOKEN, {}, { fetchImpl }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("HTTP 503");
    expect((failure as Error).message).not.toContain(TOKEN);
  });

  it("throws a route-change hint when the response body is not JSON", async () => {
    const { fetchImpl } = stubFetch(
      () => new Response("upstream text", { status: 200, headers: { "Content-Type": "text/plain" } })
    );

    await expect(slackApiCall("auth.test", TOKEN, {}, { fetchImpl })).rejects.toThrow(/workers\/slack-proxy/);
  });
});
