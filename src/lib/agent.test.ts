import { afterEach, describe, expect, it, vi } from "vitest";
import { runAnthropicAgent } from "./agent";
import type { WorkspaceStore } from "./workspace";

function apiResponse(content: unknown[]) {
  return new Response(JSON.stringify({ content }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

function createWorkspace(overrides: Partial<WorkspaceStore> = {}): WorkspaceStore {
  return {
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
