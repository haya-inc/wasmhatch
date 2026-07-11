import { describe, expect, it, vi } from "vitest";
import { OpenAIPlanner } from "./business-planner";

function plannerResponse(overrides: Record<string, unknown> = {}) {
  return new Response(JSON.stringify({
    id: "resp_test_123",
    output: [{
      type: "function_call",
      name: "propose_spreadsheet_transform",
      arguments: JSON.stringify({
        summary: "Normalize the region column.",
        expected_effect: "Region values become uppercase; headers and other cells remain unchanged.",
        script: "(rows) => rows.map((row, index) => index === 0 ? row : [row[0], String(row[1]).toUpperCase(), ...row.slice(2)])",
        assumptions: ["The first row is a header."],
        warnings: []
      })
    }],
    ...overrides
  }), { status: 200, headers: { "content-type": "application/json" } });
}

describe("OpenAIPlanner", () => {
  it("requests one strict staged plan without leaking the API key", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => plannerResponse());
    const planner = new OpenAIPlanner("sk-secret-value", fetcher as typeof fetch);
    const plan = await planner.planSpreadsheetTransform({
      task: "Uppercase the region column.",
      rows: [["Owner", "Region"], ["Aya", "west"]]
    });

    expect(plan.summary).toBe("Normalize the region column.");
    expect(plan.inputRows).toBe(2);
    expect(plan.inputCells).toBe(4);
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/responses");
    const body = JSON.parse(String(init?.body));
    expect(body.store).toBe(false);
    expect(body.parallel_tool_calls).toBe(false);
    expect(body.tool_choice).toEqual({ type: "function", name: "propose_spreadsheet_transform" });
    expect(body.tools[0].strict).toBe(true);
    expect(body.tools[0].parameters.additionalProperties).toBe(false);
    expect(body.input[1].content[0].text).toContain("Uppercase the region column");
    expect(body.input[1].content[0].text).toContain("Aya");
    expect(JSON.stringify(body)).not.toContain("sk-secret-value");
    expect(String(url)).not.toContain("sk-secret-value");
    expect((init?.headers as Record<string, string>).authorization).toBe("Bearer sk-secret-value");
  });

  it("rejects oversized model context before making a request", async () => {
    const fetcher = vi.fn();
    const planner = new OpenAIPlanner("sk-test", fetcher as typeof fetch);
    await expect(planner.planSpreadsheetTransform({
      task: "Normalize rows.",
      rows: Array.from({ length: 201 }, () => ["value"])
    })).rejects.toThrow("limited to 200 rows");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects malformed or missing function calls", async () => {
    const fetcher = vi.fn(async () => plannerResponse({ output: [{ type: "message" }] }));
    const planner = new OpenAIPlanner("sk-test", fetcher as typeof fetch);
    await expect(planner.planSpreadsheetTransform({ task: "Normalize rows.", rows: [["A"]] }))
      .rejects.toThrow("did not return a spreadsheet transformation plan");
  });

  it("returns redacted actionable API errors", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ error: { message: "secret detail" } }), { status: 401 }));
    const planner = new OpenAIPlanner("sk-test", fetcher as typeof fetch);
    await expect(planner.planSpreadsheetTransform({ task: "Normalize rows.", rows: [["A"]] }))
      .rejects.toThrow("API key is invalid or expired");
  });
});
