import { afterEach, describe, expect, it, vi } from "vitest";
import { runAnthropicAgent, type FileProposal } from "./agent";
import type { WorkspaceStore } from "./workspace";

function apiResponse(content: unknown[]) {
  return new Response(JSON.stringify({ content }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

describe("runAnthropicAgent", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("executes bounded reads and stages writes without applying them", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(apiResponse([{ type: "tool_use", id: "tool-1", name: "list_files", input: {} }]))
      .mockResolvedValueOnce(apiResponse([{ type: "tool_use", id: "tool-2", name: "read_file", input: { path: "src/a.ts" } }]))
      .mockResolvedValueOnce(apiResponse([{
        type: "tool_use",
        id: "tool-3",
        name: "propose_file",
        input: { path: "src/a.ts", content: "export const a = 2;\n", rationale: "Fix the value." }
      }]))
      .mockResolvedValueOnce(apiResponse([{ type: "text", text: "A change is ready for review." }]));
    vi.stubGlobal("fetch", fetchMock);

    const workspace: WorkspaceStore = {
      listFiles: vi.fn().mockResolvedValue(["src/a.ts"]),
      listBaselineFiles: vi.fn().mockResolvedValue(["src/a.ts"]),
      readFile: vi.fn().mockResolvedValue("export const a = 1;\n"),
      readBaselineFile: vi.fn().mockResolvedValue("export const a = 1;\n"),
      writeFile: vi.fn(),
      replaceBaseline: vi.fn(),
      replaceAll: vi.fn()
    };
    let proposal: FileProposal | undefined;

    const answer = await runAnthropicAgent({
      apiKey: "test-key",
      model: "test-model",
      task: "Fix a",
      workspace,
      onStatus: vi.fn(),
      onProposal: (next) => { proposal = next; }
    });

    expect(answer).toBe("A change is ready for review.");
    expect(proposal).toEqual({
      path: "src/a.ts",
      content: "export const a = 2;\n",
      rationale: "Fix the value."
    });
    expect(workspace.writeFile).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});
