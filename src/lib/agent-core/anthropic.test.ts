import { describe, expect, it, vi } from "vitest";
import { createAnthropicProvider } from "./anthropic";
import type { ProviderRequest, ProviderStreamEvent } from "./types";

const encoder = new TextEncoder();

function sse(events: Array<{ event: string; data: Record<string, unknown> }>) {
  return events
    .map(({ event, data }) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    .join("");
}

function streamResponse(body: string, init?: ResponseInit) {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(body));
      controller.close();
    }
  });
  return new Response(stream, { status: 200, ...init });
}

const request: ProviderRequest = {
  model: "claude-sonnet-5",
  system: "You are a test agent.",
  messages: [{ role: "user", parts: [{ type: "text", text: "hi" }] }],
  tools: [{ name: "lookup", description: "Look something up.", inputSchema: { type: "object" } }],
  maxOutputTokens: 512
};

async function collect(provider: ReturnType<typeof createAnthropicProvider>, req = request) {
  const events: ProviderStreamEvent[] = [];
  for await (const event of provider.stream(req)) events.push(event);
  return events;
}

const happyStream = sse([
  { event: "message_start", data: { type: "message_start", message: { usage: { input_tokens: 42 } } } },
  { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "text" } } },
  { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } } },
  { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } } },
  { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
  { event: "content_block_start", data: { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "lookup" } } },
  { event: "content_block_delta", data: { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{\"q\":" } } },
  { event: "content_block_delta", data: { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "\"x\"}" } } },
  { event: "content_block_stop", data: { type: "content_block_stop", index: 1 } },
  { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 17 } } },
  { event: "message_stop", data: { type: "message_stop" } }
]);

describe("createAnthropicProvider", () => {
  it("maps streaming events onto the unified schema in wire order", async () => {
    const fetchImpl = vi.fn(async () => streamResponse(happyStream));
    const provider = createAnthropicProvider({ apiKey: "sk-test", fetchImpl });
    const events = await collect(provider);
    expect(events).toEqual([
      { type: "text-delta", text: "Hel" },
      { type: "text-delta", text: "lo" },
      { type: "tool-call-start", index: 1, callId: "toolu_1", name: "lookup" },
      { type: "tool-call-args-delta", index: 1, argsJsonDelta: "{\"q\":" },
      { type: "tool-call-args-delta", index: 1, argsJsonDelta: "\"x\"}" },
      { type: "tool-call-end", index: 1 },
      { type: "message-end", stopReason: "tool-use", usage: { inputTokens: 42, outputTokens: 17 } }
    ]);
  });

  it("sends the wire request with tools, system, and streaming enabled", async () => {
    const fetchImpl = vi.fn(async () => streamResponse(happyStream));
    const provider = createAnthropicProvider({ apiKey: "sk-test", fetchImpl });
    await collect(provider);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    const headers = init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("sk-test");
    expect(headers["anthropic-dangerous-direct-browser-access"]).toBe("true");
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.stream).toBe(true);
    expect(body.system).toBe("You are a test agent.");
    expect(body.tools).toEqual([
      { name: "lookup", description: "Look something up.", input_schema: { type: "object" } }
    ]);
  });

  it("converts tool results into user tool_result blocks", async () => {
    const fetchImpl = vi.fn(async () => streamResponse(happyStream));
    const provider = createAnthropicProvider({ apiKey: "sk-test", fetchImpl });
    await collect(provider, {
      ...request,
      messages: [
        { role: "user", parts: [{ type: "text", text: "hi" }] },
        { role: "assistant", parts: [{ type: "tool_call", callId: "toolu_1", name: "lookup", args: { q: "x" } }] },
        { role: "tool", parts: [{ type: "tool_result", callId: "toolu_1", name: "lookup", content: "result", isError: false }] }
      ]
    });
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { messages: Array<{ role: string; content: unknown[] }> };
    expect(body.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "lookup", input: { q: "x" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "result", is_error: false }] }
    ]);
  });

  it("retries transient failures before streaming", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response("busy", { status: 529 }))
      .mockResolvedValueOnce(streamResponse(happyStream));
    const provider = createAnthropicProvider({ apiKey: "sk-test", fetchImpl });
    const events = await collect(provider);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(events.at(-1)?.type).toBe("message-end");
  });

  it("maps a 401 to a key error without echoing the key", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 401 }));
    const provider = createAnthropicProvider({ apiKey: "sk-secret", fetchImpl });
    await expect(collect(provider)).rejects.toThrow(/rejected the API key/);
    await expect(collect(provider)).rejects.not.toThrow(/sk-secret/);
  });

  it("fails when the stream ends before message_stop", async () => {
    const truncated = sse([
      { event: "message_start", data: { type: "message_start", message: { usage: { input_tokens: 1 } } } }
    ]);
    const fetchImpl = vi.fn(async () => streamResponse(truncated));
    const provider = createAnthropicProvider({ apiKey: "sk-test", fetchImpl });
    await expect(collect(provider)).rejects.toThrow(/ended before the message completed/);
  });

  it("surfaces stream error events", async () => {
    const errored = sse([
      { event: "error", data: { type: "error", error: { message: "overloaded" } } }
    ]);
    const fetchImpl = vi.fn(async () => streamResponse(errored));
    const provider = createAnthropicProvider({ apiKey: "sk-test", fetchImpl });
    await expect(collect(provider)).rejects.toThrow(/overloaded/);
  });
});
