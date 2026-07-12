import { describe, expect, it, vi } from "vitest";
import type { WorkspaceStore } from "./workspace";
import { OpenAIWorkspaceAgent, WORKSPACE_AGENT_LIMITS } from "./workspace-agent";

const ARTIFACT_PATH = "inputs/pipeline.json";
const ARTIFACT = `${JSON.stringify({
  schema: "wasmhatch.tabular-snapshot.v1",
  provenance: { sourceName: "pipeline.csv", sheetName: "CSV" },
  rows: [["Owner", "Region"], ["Aya", "west"], ["Ken", "east"]]
}, null, 2)}\n`;

function createWorkspace(files: Record<string, string> = { [ARTIFACT_PATH]: ARTIFACT }) {
  const readFile = vi.fn(async (path: string) => {
    const content = files[path];
    if (content === undefined) throw new Error(`File not found: ${path}`);
    return content;
  });
  const workspace: WorkspaceStore = {
    backend: "local-storage",
    listFiles: vi.fn(async () => Object.keys(files).sort()),
    listBaselineFiles: vi.fn(async () => []),
    readFile,
    readBaselineFile: vi.fn(async () => { throw new Error("No baseline"); }),
    writeFile: vi.fn(async () => undefined),
    replaceBaseline: vi.fn(async () => undefined),
    replaceAll: vi.fn(async () => undefined),
    clear: vi.fn(async () => undefined)
  };
  return { workspace, readFile };
}

function toolResponse(
  id: string,
  callId: string,
  name: string,
  args: Record<string, unknown>,
  usage: { input_tokens: number; output_tokens: number } | null = { input_tokens: 120, output_tokens: 30 }
) {
  return new Response(JSON.stringify({
    id,
    output: [
      { id: `rs_${id}`, type: "reasoning", summary: [] },
      {
        id: `fc_${id}`,
        type: "function_call",
        call_id: callId,
        name,
        arguments: JSON.stringify(args),
        status: "completed"
      }
    ],
    ...(usage ? { usage } : {})
  }), { status: 200, headers: { "content-type": "application/json" } });
}

const PLAN = {
  summary: "Normalize region labels.",
  expected_effect: "Data rows receive uppercase regions; the header and owner values remain unchanged.",
  script: "(rows) => rows.map((row, index) => index === 0 ? row : [row[0], String(row[1]).toUpperCase()])",
  assumptions: ["Row 1 is the header."],
  warnings: []
};

function request(overrides: Record<string, unknown> = {}) {
  return {
    task: "Normalize the region column.",
    model: "gpt-5.6-luna",
    grant: { readablePaths: [ARTIFACT_PATH], tabularPaths: [ARTIFACT_PATH] },
    inputRows: 3,
    inputCells: 6,
    ...overrides
  };
}

describe("OpenAIWorkspaceAgent", () => {
  it("continues a store:false reasoning tool loop and stages a plan without writing", async () => {
    const { workspace } = createWorkspace();
    const responses = [
      toolResponse("resp_list", "call_list", "list_workspace_files", {}),
      toolResponse("resp_rows", "call_rows", "read_tabular_rows", {
        path: ARTIFACT_PATH, start_row: 1, row_count: 3
      }),
      toolResponse("resp_plan", "call_plan", "propose_spreadsheet_transform", PLAN)
    ];
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => responses.shift()!);
    const events: string[] = [];
    const agent = new OpenAIWorkspaceAgent("sk-secret", workspace, fetcher as typeof fetch);
    const result = await agent.plan(request({
      onTrace: (event: { tool: string }) => events.push(event.tool)
    }));

    expect(result.plan).toMatchObject({
      summary: "Normalize region labels.",
      responseId: "resp_plan",
      inputRows: 3,
      inputCells: 6
    });
    expect(events).toEqual(["list_workspace_files", "read_tabular_rows", "propose_spreadsheet_transform"]);
    expect(result.trace[1]).toMatchObject({ path: ARTIFACT_PATH, status: "completed" });
    expect(result.budget).toMatchObject({ modelRequests: 3, toolCalls: 3, inputTokens: 360, outputTokens: 90 });
    expect(result.budget.egressBytes).toBeGreaterThan(0);
    expect(workspace.writeFile).not.toHaveBeenCalled();

    const bodies = fetcher.mock.calls.map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>);
    expect(bodies).toHaveLength(3);
    expect(bodies[0]).toMatchObject({ store: false, parallel_tool_calls: false, tool_choice: "required" });
    expect((bodies[0].tools as { strict: boolean }[]).every((tool) => tool.strict)).toBe(true);
    expect(JSON.stringify(bodies[0])).not.toContain("sk-secret");
    expect((fetcher.mock.calls[0][1]?.headers as Record<string, string>).authorization).toBe("Bearer sk-secret");
    expect(JSON.stringify(bodies[1].input)).toContain("rs_resp_list");
    expect(JSON.stringify(bodies[1].input)).toContain("function_call_output");
    expect(JSON.stringify(bodies[2].input)).toContain("wasmhatch.tabular-window.v1");
  });

  it("supports bounded literal search and line reads with visible egress accounting", async () => {
    const { workspace } = createWorkspace({
      "work/notes.md": "# Pipeline\n\nWEST needs review\nEast is complete\n"
    });
    const responses = [
      toolResponse("resp_search", "call_search", "search_workspace_text", {
        path: "work/notes.md", query: "west", max_results: 5
      }),
      toolResponse("resp_read", "call_read", "read_workspace_file", {
        path: "work/notes.md", start_line: 1, max_lines: 4
      }),
      toolResponse("resp_plan", "call_plan", "propose_spreadsheet_transform", PLAN)
    ];
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => responses.shift()!);
    const result = await new OpenAIWorkspaceAgent("sk-test", workspace, fetcher as typeof fetch).plan(request({
      grant: { readablePaths: ["work/notes.md"] }
    }));

    expect(result.trace[0]).toMatchObject({ tool: "search_workspace_text", summary: "1 matches in work/notes.md" });
    expect(result.trace[1]).toMatchObject({ tool: "read_workspace_file", path: "work/notes.md" });
    const finalBody = JSON.parse(String(fetcher.mock.calls[2][1]?.body));
    expect(JSON.stringify(finalBody.input)).toContain("WEST needs review");
    expect(result.budget.egressBytes).toBeLessThanOrEqual(WORKSPACE_AGENT_LIMITS.maxEgressBytes);
  });

  it("denies an ungranted path before reading or returning data to the model", async () => {
    const { workspace, readFile } = createWorkspace();
    const fetcher = vi.fn(async () => toolResponse("resp_bad", "call_bad", "read_workspace_file", {
      path: "inputs/secrets.json", start_line: 1, max_lines: 20
    }));
    const events: { status: string; summary: string }[] = [];
    const agent = new OpenAIWorkspaceAgent("sk-test", workspace, fetcher as typeof fetch);

    await expect(agent.plan(request({ onTrace: (event: { status: string; summary: string }) => events.push(event) })))
      .rejects.toThrow("outside the exact grant");
    expect(readFile).not.toHaveBeenCalled();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ status: "denied" });
  });

  it("requires actual content inspection before accepting a staged plan", async () => {
    const { workspace } = createWorkspace();
    const fetcher = vi.fn(async () => toolResponse("resp_plan", "call_plan", "propose_spreadsheet_transform", PLAN));
    const agent = new OpenAIWorkspaceAgent("sk-test", workspace, fetcher as typeof fetch);

    await expect(agent.plan(request())).rejects.toThrow("must inspect granted file content");
    expect(workspace.readFile).not.toHaveBeenCalled();
  });

  it("stops repeated calls and missing usage before additional workspace egress", async () => {
    const duplicateWorkspace = createWorkspace();
    const duplicateResponses = [
      toolResponse("resp_list_1", "call_list_1", "list_workspace_files", {}),
      toolResponse("resp_list_2", "call_list_2", "list_workspace_files", {})
    ];
    const duplicateFetcher = vi.fn(async () => duplicateResponses.shift()!);
    await expect(new OpenAIWorkspaceAgent("sk-test", duplicateWorkspace.workspace, duplicateFetcher as typeof fetch).plan(request()))
      .rejects.toThrow("repeated the same workspace tool call");
    expect(duplicateWorkspace.workspace.listFiles).toHaveBeenCalledTimes(1);

    const missingUsageWorkspace = createWorkspace();
    const missingUsageFetcher = vi.fn(async () => toolResponse(
      "resp_no_usage", "call_rows", "read_tabular_rows", { path: ARTIFACT_PATH, start_row: 1, row_count: 3 }, null
    ));
    await expect(new OpenAIWorkspaceAgent("sk-test", missingUsageWorkspace.workspace, missingUsageFetcher as typeof fetch).plan(request()))
      .rejects.toThrow("OpenAI workspace usage must be an object");
    expect(missingUsageWorkspace.readFile).not.toHaveBeenCalled();
  });

  it("enforces provider token budgets before executing a requested read", async () => {
    const { workspace, readFile } = createWorkspace();
    const fetcher = vi.fn(async () => toolResponse(
      "resp_over_budget",
      "call_rows",
      "read_tabular_rows",
      { path: ARTIFACT_PATH, start_row: 1, row_count: 3 },
      { input_tokens: WORKSPACE_AGENT_LIMITS.maxInputTokens + 1, output_tokens: 1 }
    ));

    await expect(new OpenAIWorkspaceAgent("sk-test", workspace, fetcher as typeof fetch).plan(request()))
      .rejects.toThrow("120,000 input-token budget");
    expect(readFile).not.toHaveBeenCalled();
  });

  it("honors cancellation before any model or workspace request", async () => {
    const { workspace } = createWorkspace();
    const fetcher = vi.fn();
    const controller = new AbortController();
    controller.abort();

    await expect(new OpenAIWorkspaceAgent("sk-test", workspace, fetcher as typeof fetch).plan(request({ signal: controller.signal })))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(fetcher).not.toHaveBeenCalled();
    expect(workspace.listFiles).not.toHaveBeenCalled();
  });
});
