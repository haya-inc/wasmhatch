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

describe("web search server tool", () => {
  const searchStream = sse([
    { event: "message_start", data: { type: "message_start", message: { usage: { input_tokens: 30 } } } },
    { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "server_tool_use", id: "srvtoolu_1", name: "web_search" } } },
    { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"query\":" } } },
    { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "\"wasm news\"}" } } },
    { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
    { event: "content_block_start", data: { type: "content_block_start", index: 1, content_block: { type: "web_search_tool_result", tool_use_id: "srvtoolu_1", content: [{ type: "web_search_result", url: "https://example.com/a", title: "A" }] } } },
    { event: "content_block_stop", data: { type: "content_block_stop", index: 1 } },
    { event: "content_block_start", data: { type: "content_block_start", index: 2, content_block: { type: "text" } } },
    { event: "content_block_delta", data: { type: "content_block_delta", index: 2, delta: { type: "citations_delta", citation: { type: "web_search_result_location", url: "https://example.com/a", title: "A" } } } },
    { event: "content_block_delta", data: { type: "content_block_delta", index: 2, delta: { type: "text_delta", text: "Answer." } } },
    { event: "content_block_stop", data: { type: "content_block_stop", index: 2 } },
    { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "pause_turn" }, usage: { output_tokens: 9 } } },
    { event: "message_stop", data: { type: "message_stop" } }
  ]);

  it("declares the server tool only when web search is on", async () => {
    const fetchImpl = vi.fn(async () => streamResponse(happyStream));
    await collect(createAnthropicProvider({ apiKey: "sk-test", fetchImpl, webSearch: true }));
    let body = JSON.parse((fetchImpl.mock.calls[0] as unknown[])[1] ? String(((fetchImpl.mock.calls[0] as unknown[])[1] as RequestInit).body) : "{}") as { tools: Array<Record<string, unknown>> };
    expect(body.tools).toContainEqual({ type: "web_search_20250305", name: "web_search", max_uses: 5 });

    fetchImpl.mockClear();
    await collect(createAnthropicProvider({ apiKey: "sk-test", fetchImpl }));
    body = JSON.parse(String(((fetchImpl.mock.calls[0] as unknown[])[1] as RequestInit).body)) as { tools: Array<Record<string, unknown>> };
    expect(body.tools.some((tool) => tool.type === "web_search_20250305")).toBe(false);
  });

  it("streams server tool blocks, citations, and pause_turn onto the unified schema", async () => {
    const fetchImpl = vi.fn(async () => streamResponse(searchStream));
    const provider = createAnthropicProvider({ apiKey: "sk-test", fetchImpl, webSearch: true });
    const events = await collect(provider);
    expect(events).toEqual([
      {
        type: "server-tool-call",
        callId: "srvtoolu_1",
        name: "web_search",
        args: { query: "wasm news" },
        block: { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: { query: "wasm news" } }
      },
      {
        type: "server-tool-result",
        callId: "srvtoolu_1",
        name: "web_search",
        isError: false,
        block: { type: "web_search_tool_result", tool_use_id: "srvtoolu_1", content: [{ type: "web_search_result", url: "https://example.com/a", title: "A" }] }
      },
      { type: "citation", url: "https://example.com/a", title: "A" },
      { type: "text-delta", text: "Answer." },
      { type: "message-end", stopReason: "pause-turn", usage: { inputTokens: 30, outputTokens: 9 } }
    ]);
  });

  it("marks an object-shaped web_search_tool_result content as an error", async () => {
    const errorStream = sse([
      { event: "message_start", data: { type: "message_start", message: { usage: { input_tokens: 1 } } } },
      { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "web_search_tool_result", tool_use_id: "srvtoolu_9", content: { type: "web_search_tool_result_error", error_code: "max_uses_exceeded" } } } },
      { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
      { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } } },
      { event: "message_stop", data: { type: "message_stop" } }
    ]);
    const fetchImpl = vi.fn(async () => streamResponse(errorStream));
    const events = await collect(createAnthropicProvider({ apiKey: "sk-test", fetchImpl, webSearch: true }));
    expect(events[0]).toMatchObject({ type: "server-tool-result", callId: "srvtoolu_9", isError: true });
  });

  it("replays anthropic provider_raw parts verbatim and drops foreign ones", async () => {
    const fetchImpl = vi.fn(async () => streamResponse(happyStream));
    const provider = createAnthropicProvider({ apiKey: "sk-test", fetchImpl, webSearch: true });
    const rawBlock = { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: { query: "x" } };
    await collect(provider, {
      ...request,
      messages: [
        { role: "user", parts: [{ type: "text", text: "hi" }] },
        {
          role: "assistant",
          parts: [
            { type: "provider_raw", providerId: "anthropic", block: rawBlock },
            { type: "provider_raw", providerId: "openrouter", block: { type: "alien" } },
            { type: "text", text: "Answer." }
          ]
        }
      ]
    });
    const body = JSON.parse(String(((fetchImpl.mock.calls[0] as unknown[])[1] as RequestInit).body)) as {
      messages: Array<{ role: string; content: Array<Record<string, unknown>> }>;
    };
    expect(body.messages[1].content).toEqual([rawBlock, { type: "text", text: "Answer." }]);
  });
});
