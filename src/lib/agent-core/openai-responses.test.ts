import { describe, expect, it, vi } from "vitest";
import { createOpenAiResponsesProvider } from "./openai-responses";
import type { ProviderRequest, ProviderStreamEvent } from "./types";

const encoder = new TextEncoder();

function chunkLine(payload: Record<string, unknown>) {
  return `event: ${String(payload.type)}\ndata: ${JSON.stringify(payload)}\n\n`;
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
  model: "gpt-5.6-luna",
  system: "You are a test agent.",
  messages: [{ role: "user", parts: [{ type: "text", text: "hi" }] }],
  tools: [{ name: "lookup", description: "Look something up.", inputSchema: { type: "object" } }],
  maxOutputTokens: 512
};

function provider(fetchImpl: typeof fetch) {
  return createOpenAiResponsesProvider({
    apiKey: "sk-test",
    baseUrl: "https://api.openai.com/v1",
    id: "openai",
    fetchImpl
  });
}

async function collect(instance: ReturnType<typeof provider>, req = request) {
  const events: ProviderStreamEvent[] = [];
  for await (const event of instance.stream(req)) events.push(event);
  return events;
}

const reasoningItem = { id: "rs_1", type: "reasoning", summary: [] };
const functionCallItem = { id: "fc_1", type: "function_call", call_id: "call_a", name: "lookup", arguments: "{\"q\":\"x\"}" };

const happyStream = [
  chunkLine({ type: "response.created", response: {} }),
  chunkLine({ type: "response.output_item.added", output_index: 0, item: reasoningItem }),
  chunkLine({ type: "response.output_item.done", output_index: 0, item: reasoningItem }),
  chunkLine({ type: "response.output_item.added", output_index: 1, item: { id: "msg_1", type: "message", role: "assistant", content: [] } }),
  chunkLine({ type: "response.output_text.delta", output_index: 1, delta: "Th" }),
  chunkLine({ type: "response.output_text.delta", output_index: 1, delta: "inking" }),
  chunkLine({ type: "response.output_item.done", output_index: 1, item: { id: "msg_1", type: "message", role: "assistant", content: [{ type: "output_text", text: "Thinking" }] } }),
  chunkLine({ type: "response.output_item.added", output_index: 2, item: { ...functionCallItem, arguments: "" } }),
  chunkLine({ type: "response.function_call_arguments.delta", output_index: 2, delta: "{\"q\"" }),
  chunkLine({ type: "response.function_call_arguments.delta", output_index: 2, delta: ":\"x\"}" }),
  chunkLine({ type: "response.output_item.done", output_index: 2, item: functionCallItem }),
  chunkLine({
    type: "response.completed",
    response: {
      status: "completed",
      output: [reasoningItem, { id: "msg_1", type: "message" }, functionCallItem],
      usage: { input_tokens: 30, output_tokens: 11 }
    }
  })
].join("");

describe("createOpenAiResponsesProvider", () => {
  it("maps streaming events onto the unified schema in wire order", async () => {
    const fetchImpl = vi.fn(async () => streamResponse(happyStream));
    const events = await collect(provider(fetchImpl));
    expect(events).toEqual([
      { type: "provider-raw", block: reasoningItem },
      { type: "text-delta", text: "Th" },
      { type: "text-delta", text: "inking" },
      { type: "tool-call-start", index: 2, callId: "call_a", name: "lookup" },
      { type: "tool-call-args-delta", index: 2, argsJsonDelta: "{\"q\"" },
      { type: "tool-call-args-delta", index: 2, argsJsonDelta: ":\"x\"}" },
      { type: "provider-raw", block: functionCallItem },
      { type: "tool-call-end", index: 2 },
      { type: "message-end", stopReason: "tool-use", usage: { inputTokens: 30, outputTokens: 11 } }
    ]);
  });

  it("sends a stateless Responses request with flat non-strict function tools", async () => {
    const fetchImpl = vi.fn(async () => streamResponse(happyStream));
    await collect(provider(fetchImpl));
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/responses");
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer sk-test");
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.stream).toBe(true);
    expect(body.store).toBe(false);
    expect(body.max_output_tokens).toBe(512);
    expect(body.instructions).toBe("You are a test agent.");
    expect(body.tools).toEqual([
      { type: "function", name: "lookup", description: "Look something up.", parameters: { type: "object" }, strict: false }
    ]);
    expect(body.input).toEqual([{ role: "user", content: [{ type: "input_text", text: "hi" }] }]);
  });

  it("replays raw items verbatim without duplicating their tool calls", async () => {
    const fetchImpl = vi.fn(async () => streamResponse(happyStream));
    await collect(provider(fetchImpl), {
      ...request,
      messages: [
        { role: "user", parts: [{ type: "text", text: "hi" }] },
        {
          role: "assistant",
          parts: [
            { type: "provider_raw", providerId: "openai", block: reasoningItem },
            { type: "text", text: "Thinking" },
            { type: "provider_raw", providerId: "openai", block: functionCallItem },
            { type: "provider_raw", providerId: "anthropic", block: { type: "server_tool_use", id: "srv_1" } },
            { type: "tool_call", callId: "call_a", name: "lookup", args: { q: "x" } }
          ]
        },
        { role: "tool", parts: [{ type: "tool_result", callId: "call_a", name: "lookup", content: "result", isError: false }] }
      ]
    });
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { input: Array<Record<string, unknown>> };
    // The foreign anthropic block is dropped; call_a appears once, as the raw item.
    expect(body.input).toEqual([
      { role: "user", content: [{ type: "input_text", text: "hi" }] },
      reasoningItem,
      { role: "assistant", content: [{ type: "output_text", text: "Thinking" }] },
      functionCallItem,
      { type: "function_call_output", call_id: "call_a", output: "result" }
    ]);
  });

  it("synthesizes function calls for history from other providers and marks failed results", async () => {
    const fetchImpl = vi.fn(async () => streamResponse(happyStream));
    await collect(provider(fetchImpl), {
      ...request,
      messages: [
        { role: "user", parts: [{ type: "text", text: "hi" }] },
        { role: "assistant", parts: [{ type: "tool_call", callId: "call_b", name: "lookup", args: { q: "y" } }] },
        { role: "tool", parts: [{ type: "tool_result", callId: "call_b", name: "lookup", content: "boom", isError: true }] }
      ]
    });
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { input: Array<Record<string, unknown>> };
    expect(body.input.slice(1)).toEqual([
      { type: "function_call", call_id: "call_b", name: "lookup", arguments: "{\"q\":\"y\"}" },
      { type: "function_call_output", call_id: "call_b", output: "Error: boom" }
    ]);
  });

  it("surfaces a whole tool call from output_item.done when the added event was skipped", async () => {
    const bare = [
      chunkLine({ type: "response.output_item.done", output_index: 0, item: functionCallItem }),
      chunkLine({ type: "response.completed", response: { status: "completed", output: [functionCallItem], usage: { input_tokens: 3, output_tokens: 1 } } })
    ].join("");
    const fetchImpl = vi.fn(async () => streamResponse(bare));
    const events = await collect(provider(fetchImpl));
    expect(events).toEqual([
      { type: "provider-raw", block: functionCallItem },
      { type: "tool-call-start", index: 0, callId: "call_a", name: "lookup" },
      { type: "tool-call-args-delta", index: 0, argsJsonDelta: "{\"q\":\"x\"}" },
      { type: "tool-call-end", index: 0 },
      { type: "message-end", stopReason: "tool-use", usage: { inputTokens: 3, outputTokens: 1 } }
    ]);
  });

  it("maps an incomplete response onto the max-output-tokens stop reason", async () => {
    const truncated = [
      chunkLine({ type: "response.output_text.delta", delta: "partial" }),
      chunkLine({
        type: "response.incomplete",
        response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [], usage: { input_tokens: 5, output_tokens: 512 } }
      })
    ].join("");
    const fetchImpl = vi.fn(async () => streamResponse(truncated));
    const events = await collect(provider(fetchImpl));
    expect(events.at(-1)).toEqual({ type: "message-end", stopReason: "max-output-tokens", usage: { inputTokens: 5, outputTokens: 512 } });
  });

  it("maps url_citation annotations onto citation events", async () => {
    const annotated = [
      chunkLine({ type: "response.output_text.delta", delta: "Cited." }),
      chunkLine({ type: "response.output_text.annotation.added", annotation: { type: "url_citation", url: "https://example.com/a", title: "A" } }),
      chunkLine({ type: "response.output_text.annotation.added", annotation: { type: "url_citation", url: "https://example.com/b" } }),
      chunkLine({ type: "response.completed", response: { status: "completed", output: [], usage: { input_tokens: 2, output_tokens: 1 } } })
    ].join("");
    const fetchImpl = vi.fn(async () => streamResponse(annotated));
    const events = await collect(provider(fetchImpl));
    expect(events).toContainEqual({ type: "citation", url: "https://example.com/a", title: "A" });
    expect(events).toContainEqual({ type: "citation", url: "https://example.com/b", title: "https://example.com/b" });
  });

  it("retries transient failures before streaming", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response("busy", { status: 500 }))
      .mockResolvedValueOnce(streamResponse(happyStream));
    const events = await collect(provider(fetchImpl as unknown as typeof fetch));
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(events.at(-1)?.type).toBe("message-end");
  });

  it("maps a 401 to a key error without echoing the key", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 401 }));
    await expect(collect(provider(fetchImpl))).rejects.toThrow(/rejected the API key/);
  });

  it("throws when the stream ends before a terminal response event", async () => {
    const fetchImpl = vi.fn(async () => streamResponse(chunkLine({ type: "response.output_text.delta", delta: "hi" })));
    await expect(collect(provider(fetchImpl))).rejects.toThrow(/stream ended before the message completed/);
  });

  it("surfaces failed responses and stream errors without leaking the body verbatim", async () => {
    const failed = chunkLine({ type: "response.failed", response: { error: { message: "model  says\nno" } } });
    const fetchImpl = vi.fn(async () => streamResponse(failed));
    await expect(collect(provider(fetchImpl))).rejects.toThrow("openai reported a failed response: model says no");

    const errored = chunkLine({ type: "error", code: "server_error", message: "boom" });
    const fetchImpl2 = vi.fn(async () => streamResponse(errored));
    await expect(collect(provider(fetchImpl2))).rejects.toThrow("openai reported a stream error: boom");
  });
});
