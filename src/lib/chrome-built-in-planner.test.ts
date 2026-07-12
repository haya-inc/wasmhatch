import { describe, expect, it, vi } from "vitest";
import {
  ChromeBuiltInPlanner,
  chromeBuiltInPlannerAvailability
} from "./chrome-built-in-planner";

function validPlan() {
  return JSON.stringify({
    summary: "Normalize the region column.",
    expected_effect: "Region values become uppercase; other cells remain unchanged.",
    script: "(rows) => rows.map((row, index) => index === 0 ? row : [row[0], String(row[1]).toUpperCase()])",
    assumptions: ["Row 1 is the header."],
    warnings: []
  });
}

describe("ChromeBuiltInPlanner", () => {
  it("detects absence without loading a model", async () => {
    await expect(chromeBuiltInPlannerAvailability(null)).resolves.toBe("unavailable");
  });

  it("creates one constrained local session and destroys it after planning", async () => {
    const prompt = vi.fn().mockResolvedValue(validPlan());
    const destroy = vi.fn();
    const create = vi.fn(async (options: {
      initialPrompts: readonly { role: string; content: string }[];
      monitor?: (monitor: EventTarget) => void;
    }) => {
      const monitor = new EventTarget();
      options.monitor?.(monitor);
      const progressEvent = new Event("downloadprogress");
      Object.defineProperty(progressEvent, "loaded", { value: 0.42 });
      monitor.dispatchEvent(progressEvent);
      return { prompt, destroy };
    });
    const api = { availability: vi.fn().mockResolvedValue("available"), create };
    const onDownloadProgress = vi.fn();
    const planner = new ChromeBuiltInPlanner(api, onDownloadProgress);

    const result = await planner.planSpreadsheetTransform({
      task: "Uppercase regions.",
      rows: [["Owner", "Region"], ["Aya", "west"]]
    });

    expect(result.model).toBe("chrome-built-in");
    expect(result.inputRows).toBe(2);
    expect(result.inputCells).toBe(4);
    expect(create).toHaveBeenCalledOnce();
    expect(create.mock.calls[0][0]).toMatchObject({
      expectedInputs: [{ type: "text", languages: ["en", "ja"] }],
      expectedOutputs: [{ type: "text", languages: ["en"] }]
    });
    expect(create.mock.calls[0][0].initialPrompts[0].content).toContain("untrusted data");
    expect(prompt).toHaveBeenCalledOnce();
    expect(prompt.mock.calls[0][0]).toContain("Uppercase regions");
    expect(prompt.mock.calls[0][0]).toContain("west");
    expect(prompt.mock.calls[0][1]).toMatchObject({
      omitResponseConstraintInput: false,
      responseConstraint: { additionalProperties: false }
    });
    expect(onDownloadProgress).toHaveBeenCalledWith(0.42);
    expect(destroy).toHaveBeenCalledOnce();
  });

  it("destroys the session and fails closed on malformed output", async () => {
    const destroy = vi.fn();
    const api = {
      availability: vi.fn().mockResolvedValue("available"),
      create: vi.fn().mockResolvedValue({ prompt: vi.fn().mockResolvedValue("not json"), destroy })
    };
    await expect(new ChromeBuiltInPlanner(api).planSpreadsheetTransform({
      task: "Normalize.",
      rows: [["A"]]
    })).rejects.toThrow("invalid plan JSON");
    expect(destroy).toHaveBeenCalledOnce();
  });
});
