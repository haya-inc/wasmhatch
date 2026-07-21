import { describe, expect, it, vi } from "vitest";
import { createOpenAiCompatibleProvider } from "./openai-compatible";
import type { ProviderRequest, ProviderStreamEvent } from "./types";

const encoder = new TextEncoder();

function chunkLine(payload: Record<string, unknown>) {
  return `data: ${JSON.stringify(payload)}\n\n`;
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
  model: "gpt-5.2",
  system: "You are a test agent.",
  messages: [{ role: "user", parts: [{ type: "text", text: "hi" }] }],
  tools: [{ name: "lookup", description: "Look something up.", inputSchema: { type: "object" } }],
  maxOutputTokens: 512
};

function provider(fetchImpl: typeof fetch, options?: { maxTokensParam?: "max_tokens" | "max_completion_tokens" }) {
  return createOpenAiCompatibleProvider({
    apiKey: "sk-test",
    baseUrl: "https://api.openai.com/v1",
    id: "openai",
    fetchImpl,
    ...options
  });
}

async function collect(instance: ReturnType<typeof provider>, req = request) {
  const events: ProviderStreamEvent[] = [];
  for await (const event of instance.stream(req)) events.push(event);
  return events;
}

const happyStream = [
  chunkLine({ choices: [{ index: 0, delta: { role: "assistant", content: "Th" } }] }),
  chunkLine({ choices: [{ index: 0, delta: { content: "inking" } }] }),
  chunkLine({
    choices: [{
      index: 0,
      delta: {
        tool_calls: [{ index: 0, id: "call_a", type: "function", function: { name: "lookup", arguments: "{\"q\"" } }]
      }
    }]
  }),
  chunkLine({
    choices: [{
      index: 0,
      delta: { tool_calls: [{ index: 0, function: { arguments: ":\"x\"}" } }] }
    }]
  }),
  chunkLine({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }),
  chunkLine({ choices: [], usage: { prompt_tokens: 30, completion_tokens: 11 } }),
  "data: [DONE]\n\n"
].join("");

describe("createOpenAiCompatibleProvider", () => {
  it("maps streaming chunks onto the unified schema in wire order", async () => {
    const fetchImpl = vi.fn(async () => streamResponse(happyStream));
    const events = await collect(provider(fetchImpl));
    expect(events).toEqual([
      { type: "text-delta", text: "Th" },
      { type: "text-delta", text: "inking" },
      { type: "tool-call-start", index: 0, callId: "call_a", name: "lookup" },
      { type: "tool-call-args-delta", index: 0, argsJsonDelta: "{\"q\"" },
      { type: "tool-call-args-delta", index: 0, argsJsonDelta: ":\"x\"}" },
      { type: "tool-call-end", index: 0 },
      { type: "message-end", stopReason: "tool-use", usage: { inputTokens: 30, outputTokens: 11 } }
    ]);
  });

  it("sends a Chat Completions request with tools and usage reporting", async () => {
    const fetchImpl = vi.fn(async () => streamResponse(happyStream));
    await collect(provider(fetchImpl, { maxTokensParam: "max_completion_tokens" }));
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer sk-test");
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(body.max_completion_tokens).toBe(512);
    expect(body.tools).toEqual([
      { type: "function", function: { name: "lookup", description: "Look something up.", parameters: { type: "object" } } }
    ]);
    const messages = body.messages as Array<Record<string, unknown>>;
    expect(messages[0]).toEqual({ role: "system", content: "You are a test agent." });
  });

  it("converts assistant tool calls and tool results into the wire transcript", async () => {
    const fetchImpl = vi.fn(async () => streamResponse(happyStream));
    await collect(provider(fetchImpl), {
      ...request,
      messages: [
        { role: "user", parts: [{ type: "text", text: "hi" }] },
        {
          role: "assistant",
          parts: [
            { type: "text", text: "Checking." },
            { type: "tool_call", callId: "call_a", name: "lookup", args: { q: "x" } }
          ]
        },
        { role: "tool", parts: [{ type: "tool_result", callId: "call_a", name: "lookup", content: "result", isError: false }] }
      ]
    });
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { messages: Array<Record<string, unknown>> };
    expect(body.messages.slice(1)).toEqual([
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: "Checking.",
        tool_calls: [{ id: "call_a", type: "function", function: { name: "lookup", arguments: "{\"q\":\"x\"}" } }]
      },
      { role: "tool", tool_call_id: "call_a", content: "result" }
    ]);
  });

  it("marks failed tool results in the transcript", async () => {
    const fetchImpl = vi.fn(async () => streamResponse(happyStream));
    await collect(provider(fetchImpl), {
      ...request,
      messages: [
        { role: "tool", parts: [{ type: "tool_result", callId: "call_a", name: "lookup", content: "boom", isError: true }] }
      ]
    });
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { messages: Array<Record<string, unknown>> };
    expect(body.messages[1]).toEqual({ role: "tool", tool_call_id: "call_a", content: "Error: boom" });
  });

  it("retries transient failures before streaming", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response("busy", { status: 500 }))
      .mockResolvedValueOnce(streamResponse(happyStream));
    const events = await collect(provider(fetchImpl as unknown as typeof fetch));
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(events.at(-1)?.type).toBe("message-end");
  });

  it("omits the Authorization header entirely when there is no key (keyless local server)", async () => {
    const fetchImpl = vi.fn(async () => streamResponse(happyStream));
    const keyless = createOpenAiCompatibleProvider({ apiKey: "", baseUrl: "http://localhost:11434/v1", id: "ollama", fetchImpl });
    await collect(keyless);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://localhost:11434/v1/chat/completions");
    const headers = init.headers as Record<string, string>;
    expect("authorization" in headers).toBe(false);
  });

  it("maps a 401 to a key error without echoing the key", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 401 }));
    await expect(collect(provider(fetchImpl))).rejects.toThrow(/rejected the API key/);
  });

  it("completes even when the server omits usage and [DONE]", async () => {
    const bare = [
      chunkLine({ choices: [{ index: 0, delta: { content: "ok" } }] }),
      chunkLine({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })
    ].join("");
    const fetchImpl = vi.fn(async () => streamResponse(bare));
    const events = await collect(provider(fetchImpl));
    expect(events).toEqual([
      { type: "text-delta", text: "ok" },
      { type: "message-end", stopReason: "end-turn", usage: undefined }
    ]);
  });
});

describe("openrouter web plugin", () => {
  it("adds the plugins array only when the web plugin is on", async () => {
    const doneStream = chunkLine({ choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] }) + "data: [DONE]\n\n";
    const fetchImpl = vi.fn(async () => streamResponse(doneStream));
    const withPlugin = createOpenAiCompatibleProvider({
      apiKey: "sk-or-test",
      baseUrl: "https://openrouter.ai/api/v1",
      id: "openrouter",
      webPlugin: true,
      fetchImpl
    });
    await collect(withPlugin as ReturnType<typeof provider>);
    let body = JSON.parse(String(((fetchImpl.mock.calls[0] as unknown[])[1] as RequestInit).body)) as Record<string, unknown>;
    expect(body.plugins).toEqual([{ id: "web" }]);

    fetchImpl.mockClear();
    await collect(provider(fetchImpl));
    body = JSON.parse(String(((fetchImpl.mock.calls[0] as unknown[])[1] as RequestInit).body)) as Record<string, unknown>;
    expect("plugins" in body).toBe(false);
  });

  it("maps url_citation annotations onto citation events", async () => {
    const annotatedStream =
      chunkLine({
        choices: [{
          index: 0,
          delta: {
            content: "Cited.",
            annotations: [
              { type: "url_citation", url_citation: { url: "https://example.com/a", title: "A" } },
              { type: "url_citation", url_citation: { url: "https://example.com/b" } }
            ]
          },
          finish_reason: "stop"
        }]
      }) + "data: [DONE]\n\n";
    const fetchImpl = vi.fn(async () => streamResponse(annotatedStream));
    const events = await collect(provider(fetchImpl));
    expect(events).toContainEqual({ type: "citation", url: "https://example.com/a", title: "A" });
    expect(events).toContainEqual({ type: "citation", url: "https://example.com/b", title: "https://example.com/b" });
  });
});
