import { afterEach, describe, expect, it, vi } from "vitest";
import { runAnthropicAgent, type AgentBudgetSnapshot, type ModelEgressEvent } from "./agent";
import type { WorkspaceStore } from "./workspace";

function apiResponse(
  content: unknown[],
  usage?: { input_tokens: number; output_tokens: number },
  stopReason?: string
) {
  return new Response(JSON.stringify({ content, usage, stop_reason: stopReason }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

function createWorkspace(overrides: Partial<WorkspaceStore> = {}): WorkspaceStore {
  return {
    backend: "opfs",
    listFiles: vi.fn().mockResolvedValue(["src/a.ts"]),
    listBaselineFiles: vi.fn().mockResolvedValue(["src/a.ts"]),
    readFile: vi.fn().mockResolvedValue("export const a = 1;\n"),
    readBaselineFile: vi.fn().mockResolvedValue("export const a = 1;\n"),
    writeFile: vi.fn(),
    replaceBaseline: vi.fn(),
    replaceAll: vi.fn(),
    clear: vi.fn(),
    ...overrides
  };
}

function agentOptions(workspace: WorkspaceStore, onProposal = vi.fn()) {
  return {
    apiKey: "test-key",
    model: "test-model",
    task: "Fix a",
    workspace,
    onStatus: vi.fn(),
    onProposal
  };
}

function lastRequestResults(fetchMock: ReturnType<typeof vi.fn>, callIndex: number) {
  const body = JSON.parse(String((fetchMock.mock.calls[callIndex][1] as RequestInit).body));
  const messages = body.messages as Array<{ content: unknown }>;
  return messages[messages.length - 1].content;
}

describe("runAnthropicAgent", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("executes bounded reads and stages one write without applying it", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(apiResponse([{ type: "tool_use", id: "tool-1", name: "list_files", input: {} }]))
      .mockResolvedValueOnce(apiResponse([{ type: "tool_use", id: "tool-2", name: "read_file", input: { path: "src/a.ts" } }]))
      .mockResolvedValueOnce(apiResponse([
        { type: "text", text: "A change is ready for review." },
        {
          type: "tool_use",
          id: "tool-3",
          name: "propose_file",
          input: { path: "src/a.ts", content: "export const a = 2;\n", rationale: "Fix the value." }
        }
      ]));
    vi.stubGlobal("fetch", fetchMock);

    const workspace = createWorkspace();
    const onProposal = vi.fn();
    const answer = await runAnthropicAgent(agentOptions(workspace, onProposal));

    expect(answer).toBe("A change is ready for review.");
    expect(onProposal).toHaveBeenCalledOnce();
    expect(onProposal).toHaveBeenCalledWith({
      path: "src/a.ts",
      content: "export const a = 2;\n",
      rationale: "Fix the value."
    });
    expect(workspace.writeFile).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("returns tool failures to the model and allows recovery", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(apiResponse([{
        type: "tool_use",
        id: "read-1",
        name: "read_file",
        input: { path: "missing.ts" }
      }]))
      .mockResolvedValueOnce(apiResponse([{ type: "text", text: "The requested file is unavailable." }]));
    vi.stubGlobal("fetch", fetchMock);
    const workspace = createWorkspace({
      readFile: vi.fn().mockRejectedValue(new Error("File not found: missing.ts"))
    });

    await expect(runAnthropicAgent(agentOptions(workspace)))
      .resolves.toBe("The requested file is unavailable.");
    expect(lastRequestResults(fetchMock, 1)).toEqual([{
      type: "tool_result",
      tool_use_id: "read-1",
      is_error: true,
      content: "File not found: missing.ts"
    }]);
  });

  it("hides protected paths from file listings", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(apiResponse([{ type: "tool_use", id: "list-1", name: "list_files", input: {} }]))
      .mockResolvedValueOnce(apiResponse([{ type: "text", text: "Only source files are available." }]));
    vi.stubGlobal("fetch", fetchMock);
    const workspace = createWorkspace({
      listFiles: vi.fn().mockResolvedValue(["src/a.ts", ".env", ".ssh/id_rsa"])
    });

    await runAnthropicAgent(agentOptions(workspace));

    expect(lastRequestResults(fetchMock, 1)).toEqual([{
      type: "tool_result",
      tool_use_id: "list-1",
      content: JSON.stringify(["src/a.ts"])
    }]);
  });

  it("rejects protected file reads before accessing storage", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(apiResponse([{
        type: "tool_use",
        id: "read-secret",
        name: "read_file",
        input: { path: ".env.local" }
      }]))
      .mockResolvedValueOnce(apiResponse([{ type: "text", text: "The protected file is unavailable." }]));
    vi.stubGlobal("fetch", fetchMock);
    const workspace = createWorkspace();

    await runAnthropicAgent(agentOptions(workspace));

    expect(workspace.readFile).not.toHaveBeenCalled();
    expect(lastRequestResults(fetchMock, 1)).toEqual([{
      type: "tool_result",
      tool_use_id: "read-secret",
      is_error: true,
      content: "Protected file is unavailable to the agent: .env.local"
    }]);
  });

  it("rejects protected file proposals", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(apiResponse([{
        type: "tool_use",
        id: "propose-secret",
        name: "propose_file",
        input: { path: ".npmrc", content: "token=changed", rationale: "Update auth" }
      }]))
      .mockResolvedValueOnce(apiResponse([{ type: "text", text: "I cannot change that protected file." }]));
    vi.stubGlobal("fetch", fetchMock);
    const onProposal = vi.fn();

    await runAnthropicAgent(agentOptions(createWorkspace(), onProposal));

    expect(onProposal).not.toHaveBeenCalled();
    expect(lastRequestResults(fetchMock, 1)).toEqual([
      expect.objectContaining({
        tool_use_id: "propose-secret",
        is_error: true,
        content: "Protected file cannot be proposed by the agent: .npmrc"
      })
    ]);
  });

  it("reports only user data attached to outgoing model requests", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(apiResponse([{ type: "tool_use", id: "list-1", name: "list_files", input: {} }]))
      .mockResolvedValueOnce(apiResponse([{ type: "tool_use", id: "read-1", name: "read_file", input: { path: "src/a.ts" } }]))
      .mockResolvedValueOnce(apiResponse([{ type: "text", text: "Done." }]));
    vi.stubGlobal("fetch", fetchMock);
    const events: ModelEgressEvent[] = [];
    const workspace = createWorkspace({
      listFiles: vi.fn().mockResolvedValue(["src/a.ts", ".env"])
    });

    await runAnthropicAgent({
      ...agentOptions(workspace),
      onEgress: (event) => events.push(event)
    });

    expect(events).toEqual([
      { kind: "task", bytes: 5 },
      { kind: "file-list", bytes: 12, paths: ["src/a.ts"], protectedPaths: 1 },
      {
        kind: "file-read",
        bytes: 115,
        path: "src/a.ts",
        startLine: 1,
        endLine: 2,
        totalLines: 2,
        truncated: false
      }
    ]);
  });

  it("returns explicit line ranges with continuation metadata", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(apiResponse([{
        type: "tool_use",
        id: "read-range",
        name: "read_file",
        input: { path: "src/a.ts", start_line: 2, end_line: 3 }
      }]))
      .mockResolvedValueOnce(apiResponse([{ type: "text", text: "Range read." }]));
    vi.stubGlobal("fetch", fetchMock);
    const workspace = createWorkspace({
      readFile: vi.fn().mockResolvedValue("one\ntwo\nthree\nfour")
    });

    await runAnthropicAgent(agentOptions(workspace));

    const results = lastRequestResults(fetchMock, 1) as Array<{ content: string }>;
    expect(JSON.parse(results[0].content)).toEqual({
      path: "src/a.ts",
      start_line: 2,
      end_line: 3,
      total_lines: 4,
      content: "two\nthree",
      truncated: true
    });
  });

  it("bounds a multibyte line by UTF-8 bytes", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(apiResponse([{
        type: "tool_use",
        id: "read-wide-line",
        name: "read_file",
        input: { path: "src/a.ts" }
      }]))
      .mockResolvedValueOnce(apiResponse([{ type: "text", text: "Enough context." }]));
    vi.stubGlobal("fetch", fetchMock);
    const workspace = createWorkspace({
      readFile: vi.fn().mockResolvedValue("😀".repeat(20_000))
    });

    await runAnthropicAgent(agentOptions(workspace));

    const results = lastRequestResults(fetchMock, 1) as Array<{ content: string }>;
    const payload = JSON.parse(results[0].content) as { content: string; truncated: boolean };
    expect(new TextEncoder().encode(payload.content).byteLength).toBeLessThanOrEqual(50_000);
    expect(payload.content.charCodeAt(payload.content.length - 1)).toBeGreaterThanOrEqual(0xdc00);
    expect(payload.content.charCodeAt(payload.content.length - 1)).toBeLessThanOrEqual(0xdfff);
    expect(payload.truncated).toBe(true);
  });

  it("rejects invalid or oversized line ranges before reading storage", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(apiResponse([{
        type: "tool_use",
        id: "read-too-much",
        name: "read_file",
        input: { path: "src/a.ts", start_line: 1, end_line: 201 }
      }]))
      .mockResolvedValueOnce(apiResponse([{ type: "text", text: "Range rejected." }]));
    vi.stubGlobal("fetch", fetchMock);
    const workspace = createWorkspace();

    await runAnthropicAgent(agentOptions(workspace));

    expect(workspace.readFile).not.toHaveBeenCalled();
    expect(lastRequestResults(fetchMock, 1)).toEqual([
      expect.objectContaining({ is_error: true, content: "read_file is limited to 200 lines per call." })
    ]);
  });

  it("compacts completed tool exchanges while preserving recent pairs", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(apiResponse([{ type: "tool_use", id: "list-1", name: "list_files", input: {} }]))
      .mockResolvedValueOnce(apiResponse([{ type: "tool_use", id: "list-2", name: "list_files", input: {} }]))
      .mockResolvedValueOnce(apiResponse([{ type: "tool_use", id: "list-3", name: "list_files", input: {} }]))
      .mockResolvedValueOnce(apiResponse([{ type: "text", text: "Compacted." }]));
    vi.stubGlobal("fetch", fetchMock);
    const events: ModelEgressEvent[] = [];

    await runAnthropicAgent({
      ...agentOptions(createWorkspace()),
      onEgress: (event) => events.push(event)
    });

    const fourthBody = JSON.parse(String((fetchMock.mock.calls[3][1] as RequestInit).body));
    expect(fourthBody.messages).toHaveLength(5);
    expect(fourthBody.messages[0].content).toContain("[Compacted context]");
    expect(fourthBody.messages[0].content).not.toContain('["src/a.ts"]');
    expect(events).toContainEqual(expect.objectContaining({ kind: "compaction", toolCalls: 1 }));
  });

  it("stops before cumulative request bodies exceed 500 KB", async () => {
    let toolCall = 0;
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(apiResponse([{
      type: "tool_use",
      id: `read-${toolCall += 1}`,
      name: "read_file",
      input: { path: "src/a.ts" }
    }])));
    vi.stubGlobal("fetch", fetchMock);
    const workspace = createWorkspace({
      readFile: vi.fn().mockResolvedValue("x".repeat(50_000))
    });

    await expect(runAnthropicAgent(agentOptions(workspace)))
      .rejects.toThrow("Agent stopped before exceeding the 500,000-byte request budget.");
    expect(fetchMock.mock.calls.length).toBeGreaterThan(2);
    expect(fetchMock.mock.calls.length).toBeLessThan(8);
  });

  it("stops tool execution at the provider output-token budget", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(apiResponse([{
      type: "tool_use",
      id: "over-budget-read",
      name: "read_file",
      input: { path: "src/a.ts" }
    }], { input_tokens: 100, output_tokens: 8_000 }));
    vi.stubGlobal("fetch", fetchMock);
    const workspace = createWorkspace();

    await expect(runAnthropicAgent(agentOptions(workspace)))
      .rejects.toThrow("Agent stopped after reaching the 8,000 output-token budget.");
    expect(workspace.readFile).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("stops tool execution at the provider input-token budget", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(apiResponse([{
      type: "tool_use",
      id: "over-budget-list",
      name: "list_files",
      input: {}
    }], { input_tokens: 120_000, output_tokens: 10 }));
    vi.stubGlobal("fetch", fetchMock);
    const workspace = createWorkspace();

    await expect(runAnthropicAgent(agentOptions(workspace)))
      .rejects.toThrow("Agent stopped after reaching the 120,000 input-token budget.");
    expect(workspace.listFiles).not.toHaveBeenCalled();
  });

  it("reports request payload and provider usage budgets", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(apiResponse(
      [{ type: "text", text: "Done." }],
      { input_tokens: 321, output_tokens: 45 }
    ));
    vi.stubGlobal("fetch", fetchMock);
    const budgets: AgentBudgetSnapshot[] = [];

    await runAnthropicAgent({
      ...agentOptions(createWorkspace()),
      onBudget: (budget) => budgets.push(budget)
    });

    expect(budgets.at(-1)).toEqual(expect.objectContaining({
      requests: 1,
      requestLimit: 8,
      requestByteLimit: 500_000,
      inputTokens: 321,
      inputTokenLimit: 120_000,
      outputTokens: 45,
      outputTokenLimit: 8_000
    }));
    const requestBody = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));
    expect(requestBody.max_tokens).toBe(2_048);
  });

  it("does not report tool results that are never sent in a later request", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(apiResponse([
      { type: "tool_use", id: "read-1", name: "read_file", input: { path: "src/a.ts" } },
      {
        type: "tool_use",
        id: "proposal-1",
        name: "propose_file",
        input: { path: "src/a.ts", content: "changed", rationale: "A direct proposal" }
      }
    ]));
    vi.stubGlobal("fetch", fetchMock);
    const events: ModelEgressEvent[] = [];

    await runAnthropicAgent({
      ...agentOptions(createWorkspace()),
      onEgress: (event) => events.push(event)
    });

    expect(events).toEqual([{ kind: "task", bytes: 5 }]);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("rejects a batch of proposals and stages only a later single proposal", async () => {
    const first = {
      type: "tool_use",
      id: "proposal-1",
      name: "propose_file",
      input: { path: "src/a.ts", content: "one", rationale: "First" }
    };
    const second = {
      type: "tool_use",
      id: "proposal-2",
      name: "propose_file",
      input: { path: "src/b.ts", content: "two", rationale: "Second" }
    };
    const accepted = {
      type: "tool_use",
      id: "proposal-3",
      name: "propose_file",
      input: { path: "src/a.ts", content: "accepted", rationale: "One focused change" }
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(apiResponse([first, second]))
      .mockResolvedValueOnce(apiResponse([{ type: "text", text: "One change." }, accepted]));
    vi.stubGlobal("fetch", fetchMock);
    const onProposal = vi.fn();

    await expect(runAnthropicAgent(agentOptions(createWorkspace(), onProposal)))
      .resolves.toBe("One change.");
    expect(onProposal).toHaveBeenCalledOnce();
    expect(onProposal).toHaveBeenCalledWith({
      path: "src/a.ts",
      content: "accepted",
      rationale: "One focused change"
    });
    expect(lastRequestResults(fetchMock, 1)).toEqual([
      expect.objectContaining({ tool_use_id: "proposal-1", is_error: true }),
      expect.objectContaining({ tool_use_id: "proposal-2", is_error: true })
    ]);
  });

  it("rejects missing proposal fields instead of staging undefined strings", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(apiResponse([{
        type: "tool_use",
        id: "invalid-proposal",
        name: "propose_file",
        input: { path: "src/a.ts", rationale: "Missing content" }
      }]))
      .mockResolvedValueOnce(apiResponse([
        { type: "text", text: "Corrected proposal." },
        {
          type: "tool_use",
          id: "valid-proposal",
          name: "propose_file",
          input: { path: "src/a.ts", content: "", rationale: "Clear the file intentionally" }
        }
      ]));
    vi.stubGlobal("fetch", fetchMock);
    const onProposal = vi.fn();

    await runAnthropicAgent(agentOptions(createWorkspace(), onProposal));
    expect(onProposal).toHaveBeenCalledOnce();
    expect(onProposal).toHaveBeenCalledWith(expect.objectContaining({ content: "" }));
    expect(lastRequestResults(fetchMock, 1)).toEqual([
      expect.objectContaining({
        tool_use_id: "invalid-proposal",
        is_error: true,
        content: "content must be a string."
      })
    ]);
  });

  it("rejects a response truncated at the per-request output limit", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(apiResponse(
      [{ type: "text", text: "Partial answer that stopped mid-" }],
      { input_tokens: 100, output_tokens: 2_048 },
      "max_tokens"
    ));
    vi.stubGlobal("fetch", fetchMock);

    await expect(runAnthropicAgent(agentOptions(createWorkspace())))
      .rejects.toThrow("Anthropic truncated the response at the per-request output limit");
  });

  it("retries transient rate limits before succeeding", async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(new Response("", { status: 429 }))
        .mockResolvedValueOnce(new Response("", { status: 503 }))
        .mockResolvedValueOnce(apiResponse([{ type: "text", text: "Recovered." }]));
      vi.stubGlobal("fetch", fetchMock);

      const run = runAnthropicAgent(agentOptions(createWorkspace()));
      await vi.runAllTimersAsync();

      await expect(run).resolves.toBe("Recovered.");
      expect(fetchMock).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports a persistent rate limit after retries are exhausted", async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn().mockResolvedValue(new Response("", { status: 429 }));
      vi.stubGlobal("fetch", fetchMock);

      const run = runAnthropicAgent(agentOptions(createWorkspace()));
      run.catch(() => { /* Asserted below after the timers run. */ });
      await vi.runAllTimersAsync();

      await expect(run).rejects.toThrow("Anthropic rate limit reached (429). Wait briefly and try again.");
      expect(fetchMock).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels while waiting on a retry delay", async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn().mockResolvedValue(new Response("", { status: 429 }));
      vi.stubGlobal("fetch", fetchMock);
      const controller = new AbortController();

      const run = runAnthropicAgent({
        ...agentOptions(createWorkspace()),
        signal: controller.signal
      });
      run.catch(() => { /* Asserted below after the abort. */ });
      await vi.advanceTimersByTimeAsync(100);
      controller.abort();

      await expect(run).rejects.toThrow("Agent run cancelled.");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns an actionable authentication error without exposing the response body", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ error: { message: "sensitive provider detail" } }),
      { status: 401, headers: { "content-type": "application/json" } }
    )));

    await expect(runAnthropicAgent(agentOptions(createWorkspace())))
      .rejects.toThrow("Anthropic rejected the API key (401). Check the key and try again.");
  });

  it("stops a tool loop after eight turns", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(apiResponse([{
      type: "tool_use",
      id: "list-files",
      name: "list_files",
      input: {}
    }])));
    vi.stubGlobal("fetch", fetchMock);

    await expect(runAnthropicAgent(agentOptions(createWorkspace())))
      .rejects.toThrow("Agent stopped after reaching the 8-turn safety limit.");
    expect(fetchMock).toHaveBeenCalledTimes(8);
  });

  it("rejects malformed API message content", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ content: null }),
      { status: 200, headers: { "content-type": "application/json" } }
    )));

    await expect(runAnthropicAgent(agentOptions(createWorkspace())))
      .rejects.toThrow("Anthropic returned an invalid message response.");
  });

  it("cancels an in-flight request without changing the workspace", async () => {
    const fetchMock = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener(
        "abort",
        () => reject(new DOMException("Aborted", "AbortError")),
        { once: true }
      );
    }));
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    const workspace = createWorkspace();
    const run = runAnthropicAgent({
      ...agentOptions(workspace),
      signal: controller.signal
    });
    await Promise.resolve();
    controller.abort();

    await expect(run).rejects.toThrow("Agent run cancelled.");
    expect(workspace.writeFile).not.toHaveBeenCalled();
  });
});
