import { describe, expect, it, vi, afterEach } from "vitest";
import worker from "../../workers/slack-proxy/worker.js";

describe("slack-proxy worker", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("enforces ALLOWED_ORIGIN on POST and OPTIONS when configured", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true, channels: [] }), { status: 200 })
    );
    const env = { ALLOWED_ORIGIN: "https://wasmhatch.example" };
    const formBody = new URLSearchParams({ token: "xoxb-valid-token" }).toString();

    const missingOrigin = await worker.fetch(
      new Request("https://proxy.example/api/conversations.list", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: formBody
      }),
      env
    );
    expect(missingOrigin.status).toBe(403);
    expect(await missingOrigin.json()).toEqual({ ok: false, error: "forbidden_origin" });

    const wrongOrigin = await worker.fetch(
      new Request("https://proxy.example/api/conversations.list", {
        method: "POST",
        headers: { origin: "https://evil.example", "content-type": "application/x-www-form-urlencoded" },
        body: formBody
      }),
      env
    );
    expect(wrongOrigin.status).toBe(403);
    expect(fetchSpy).not.toHaveBeenCalled();

    const allowed = await worker.fetch(
      new Request("https://proxy.example/api/conversations.list", {
        method: "POST",
        headers: { origin: "https://wasmhatch.example", "content-type": "application/x-www-form-urlencoded" },
        body: formBody
      }),
      env
    );
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("access-control-allow-origin")).toBe("https://wasmhatch.example");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("rejects control-character tokens, oversized bodies, and upstream network failures cleanly", async () => {
    const badToken = await worker.fetch(
      new Request("https://proxy.example/api/chat.postMessage", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: "xoxb-bad\r\ntoken", channel: "C1", text: "hi" }).toString()
      }),
      {}
    );
    expect(badToken.status).toBe(401);
    expect(await badToken.json()).toEqual({ ok: false, error: "invalid_auth" });

    const hugeBody = new URLSearchParams({ token: "xoxb-valid", pad: "x".repeat(300 * 1024) }).toString();
    const tooLarge = await worker.fetch(
      new Request("https://proxy.example/api/chat.postMessage", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: hugeBody
      }),
      {}
    );
    expect(tooLarge.status).toBe(413);
    expect(await tooLarge.json()).toEqual({ ok: false, error: "payload_too_large" });

    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("socket hang up"));
    const upstreamDown = await worker.fetch(
      new Request("https://proxy.example/api/conversations.list", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: "xoxb-valid" }).toString()
      }),
      {}
    );
    expect(upstreamDown.status).toBe(502);
    expect(await upstreamDown.json()).toEqual({ ok: false, error: "upstream_unavailable" });
  });
});
