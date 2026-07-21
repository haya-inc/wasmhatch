import { describe, expect, it, vi } from "vitest";
import { runAgentLoop } from "./loop";
import type {
  AgentLoopEvent,
  AgentProvider,
  AgentToolOutcome,
  ProviderRequest,
  ProviderStreamEvent
} from "./types";

/** A provider that replays one scripted event list per turn. */
function scriptedProvider(turns: ProviderStreamEvent[][], onRequest?: (request: ProviderRequest) => void): AgentProvider {
  let turn = 0;
  return {
    id: "scripted",
    // eslint-disable-next-line require-yield
    async *stream(request) {
      onRequest?.(request);
      const events = turns[turn] ?? [{ type: "message-end", stopReason: "end-turn" } as const];
      turn += 1;
      for (const event of events) yield event;
    }
  };
}

const finalTurn = (text: string): ProviderStreamEvent[] => [
  { type: "text-delta", text },
  { type: "message-end", stopReason: "end-turn", usage: { inputTokens: 5, outputTokens: 3 } }
];

const toolTurn = (calls: Array<{ callId: string; name: string; argsJson: string }>): ProviderStreamEvent[] => [
  ...calls.flatMap<ProviderStreamEvent>((call, index) => [
    { type: "tool-call-start", index, callId: call.callId, name: call.name },
    { type: "tool-call-args-delta", index, argsJsonDelta: call.argsJson },
    { type: "tool-call-end", index }
  ]),
  { type: "message-end", stopReason: "tool-use", usage: { inputTokens: 10, outputTokens: 4 } }
];

const lookupTool = { name: "lookup", description: "Look something up.", inputSchema: { type: "object" } };

describe("runAgentLoop", () => {
  it("streams a tool turn, executes tools, and finishes on the final turn", async () => {
    const provider = scriptedProvider([
      toolTurn([{ callId: "c1", name: "lookup", argsJson: "{\"q\":\"a\"}" }]),
      finalTurn("Done.")
    ]);
    const execute = vi.fn(async (): Promise<AgentToolOutcome> => ({ content: "found" }));
    const events: AgentLoopEvent[] = [];
    const result = await runAgentLoop({
      provider,
      model: "m",
      system: "s",
      task: "find a",
      tools: [lookupTool],
      execute,
      onEvent: (event) => events.push(event)
    });

    expect(result.status).toBe("completed");
    expect(result.finalText).toBe("Done.");
    expect(execute).toHaveBeenCalledWith("lookup", { q: "a" }, { signal: undefined });
    expect(result.usage).toEqual({ turns: 2, outputTokens: 7, inputTokens: 15, toolCalls: 1 });
    expect(result.messages).toEqual([
      { role: "user", parts: [{ type: "text", text: "find a" }] },
      { role: "assistant", parts: [{ type: "tool_call", callId: "c1", name: "lookup", args: { q: "a" } }] },
      { role: "tool", parts: [{ type: "tool_result", callId: "c1", name: "lookup", content: "found", isError: false }] },
      { role: "assistant", parts: [{ type: "text", text: "Done." }] }
    ]);
    expect(events.map((event) => event.type)).toEqual([
      "turn-start", "usage", "tool-call", "tool-result", "turn-start", "text-delta", "usage", "final"
    ]);
  });

  it("executes multiple tool calls from one turn in parallel", async () => {
    const provider = scriptedProvider([
      toolTurn([
        { callId: "c1", name: "lookup", argsJson: "{\"q\":\"first\"}" },
        { callId: "c2", name: "lookup", argsJson: "{\"q\":\"second\"}" }
      ]),
      finalTurn("Done.")
    ]);
    let concurrent = 0;
    let peakConcurrency = 0;
    const execute = vi.fn(async (): Promise<AgentToolOutcome> => {
      concurrent += 1;
      peakConcurrency = Math.max(peakConcurrency, concurrent);
      await new Promise((resolve) => setTimeout(resolve, 10));
      concurrent -= 1;
      return { content: "ok" };
    });
    const result = await runAgentLoop({
      provider,
      model: "m",
      system: "s",
      task: "both",
      tools: [lookupTool],
      execute
    });
    expect(result.status).toBe("completed");
    expect(peakConcurrency).toBe(2);
    const toolMessage = result.messages.find((message) => message.role === "tool");
    expect(toolMessage?.parts.map((part) => part.type === "tool_result" ? part.callId : "")).toEqual(["c1", "c2"]);
  });

  it("feeds tool failures back as error results instead of crashing", async () => {
    const provider = scriptedProvider([
      toolTurn([{ callId: "c1", name: "lookup", argsJson: "{}" }]),
      finalTurn("Recovered.")
    ]);
    const execute = vi.fn(async (): Promise<AgentToolOutcome> => {
      throw new Error("backend unavailable");
    });
    const result = await runAgentLoop({
      provider, model: "m", system: "s", task: "t", tools: [lookupTool], execute
    });
    expect(result.status).toBe("completed");
    const toolMessage = result.messages.find((message) => message.role === "tool");
    expect(toolMessage?.parts[0]).toEqual({
      type: "tool_result", callId: "c1", name: "lookup", content: "backend unavailable", isError: true
    });
  });

  it("rejects invalid tool-argument JSON without calling the executor", async () => {
    const provider = scriptedProvider([
      toolTurn([{ callId: "c1", name: "lookup", argsJson: "{broken" }]),
      finalTurn("Done.")
    ]);
    const execute = vi.fn(async (): Promise<AgentToolOutcome> => ({ content: "never" }));
    const result = await runAgentLoop({
      provider, model: "m", system: "s", task: "t", tools: [lookupTool], execute
    });
    expect(execute).not.toHaveBeenCalled();
    const toolMessage = result.messages.find((message) => message.role === "tool");
    expect(toolMessage?.parts[0]).toMatchObject({ isError: true, content: "Tool arguments were not valid JSON." });
  });

  it("rejects unknown tools without calling the executor", async () => {
    const provider = scriptedProvider([
      toolTurn([{ callId: "c1", name: "mystery", argsJson: "{}" }]),
      finalTurn("Done.")
    ]);
    const execute = vi.fn(async (): Promise<AgentToolOutcome> => ({ content: "never" }));
    const result = await runAgentLoop({
      provider, model: "m", system: "s", task: "t", tools: [lookupTool], execute
    });
    expect(execute).not.toHaveBeenCalled();
    const toolMessage = result.messages.find((message) => message.role === "tool");
    expect(toolMessage?.parts[0]).toMatchObject({ isError: true, content: "Unknown tool: mystery" });
  });

  it("ends with budget-exhausted instead of throwing when turns run out", async () => {
    const endlessToolTurn = () => toolTurn([{ callId: "c", name: "lookup", argsJson: "{}" }]);
    const provider: AgentProvider = {
      id: "endless",
      async *stream() {
        for (const event of endlessToolTurn()) yield event;
      }
    };
    const result = await runAgentLoop({
      provider,
      model: "m",
      system: "s",
      task: "t",
      tools: [lookupTool],
      execute: async () => ({ content: "ok" }),
      budget: { maxTurns: 3 }
    });
    expect(result.status).toBe("budget-exhausted");
    expect(result.usage.turns).toBe(3);
    expect(result.messages.length).toBeGreaterThan(1);
  });

  it("treats a truncated final answer as budget exhaustion so the caller can continue", async () => {
    const provider = scriptedProvider([[
      { type: "text-delta", text: "partial" },
      { type: "message-end", stopReason: "max-output-tokens", usage: { inputTokens: 1, outputTokens: 1 } }
    ]]);
    const result = await runAgentLoop({
      provider, model: "m", system: "s", task: "t", tools: [], execute: async () => ({ content: "" })
    });
    expect(result.status).toBe("budget-exhausted");
    expect(result.finalText).toBe("partial");
  });

  it("returns cancelled with the partial transcript when aborted mid-run", async () => {
    const controller = new AbortController();
    const provider = scriptedProvider(
      [toolTurn([{ callId: "c1", name: "lookup", argsJson: "{}" }]), finalTurn("never")]
    );
    const result = await runAgentLoop({
      provider,
      model: "m",
      system: "s",
      task: "t",
      tools: [lookupTool],
      execute: async () => {
        controller.abort();
        return { content: "late" };
      },
      signal: controller.signal
    });
    expect(result.status).toBe("cancelled");
    expect(result.messages.some((message) => message.role === "tool")).toBe(true);
  });

  it("continues a supplied transcript without duplicating it", async () => {
    const provider = scriptedProvider([finalTurn("Continued.")], (request) => {
      expect(request.messages).toHaveLength(2);
    });
    const result = await runAgentLoop({
      provider,
      model: "m",
      system: "s",
      messages: [
        { role: "user", parts: [{ type: "text", text: "earlier" }] },
        { role: "assistant", parts: [{ type: "text", text: "noted" }] }
      ],
      task: "",
      tools: [],
      execute: async () => ({ content: "" })
    });
    expect(result.status).toBe("completed");
    expect(result.finalText).toBe("Continued.");
  });

  it("requires a task or transcript", async () => {
    const provider = scriptedProvider([]);
    await expect(runAgentLoop({
      provider, model: "m", system: "s", tools: [], execute: async () => ({ content: "" })
    })).rejects.toThrow(/needs a task or a prior transcript/);
  });
});

describe("server-side web search", () => {
  it("carries server tool blocks in order, forwards citations, and continues through pause_turn", async () => {
    const requests: ProviderRequest[] = [];
    const useBlock = { type: "server_tool_use", id: "srv_1", name: "web_search", input: { query: "x" } };
    const resultBlock = { type: "web_search_tool_result", tool_use_id: "srv_1", content: [] };
    const provider = scriptedProvider([
      [
        { type: "text-delta", text: "Searching. " },
        { type: "server-tool-call", callId: "srv_1", name: "web_search", args: { query: "x" }, block: useBlock },
        { type: "server-tool-result", callId: "srv_1", name: "web_search", isError: false, block: resultBlock },
        { type: "message-end", stopReason: "pause-turn", usage: { inputTokens: 8, outputTokens: 2 } }
      ],
      [
        { type: "text-delta", text: "Answer." },
        { type: "citation", url: "https://example.com/a", title: "A" },
        { type: "message-end", stopReason: "end-turn", usage: { inputTokens: 9, outputTokens: 3 } }
      ]
    ], (request) => requests.push(request));
    const execute = vi.fn(async (): Promise<AgentToolOutcome> => ({ content: "never" }));
    const events: AgentLoopEvent[] = [];
    const result = await runAgentLoop({
      provider,
      model: "m",
      system: "s",
      task: "look this up",
      tools: [lookupTool],
      execute,
      onEvent: (event) => events.push(event)
    });

    expect(result.status).toBe("completed");
    expect(result.finalText).toBe("Answer.");
    // Server tools never execute client-side.
    expect(execute).not.toHaveBeenCalled();
    expect(result.messages).toEqual([
      { role: "user", parts: [{ type: "text", text: "look this up" }] },
      {
        role: "assistant",
        parts: [
          { type: "text", text: "Searching. " },
          { type: "provider_raw", providerId: "scripted", block: useBlock },
          { type: "provider_raw", providerId: "scripted", block: resultBlock }
        ]
      },
      { role: "assistant", parts: [{ type: "text", text: "Answer." }] }
    ]);
    // The pause_turn continuation resends the transcript including the raw blocks.
    expect(requests).toHaveLength(2);
    expect(requests[1].messages[1].parts.filter((part) => part.type === "provider_raw")).toHaveLength(2);
    expect(events).toContainEqual({ type: "tool-call", turn: 1, callId: "srv_1", name: "web_search", args: { query: "x" } });
    expect(events).toContainEqual({
      type: "tool-result", turn: 1, callId: "srv_1", name: "web_search", content: "", isError: false, durationMs: 0
    });
    expect(events).toContainEqual({ type: "citation", turn: 2, url: "https://example.com/a", title: "A" });
  });
});
