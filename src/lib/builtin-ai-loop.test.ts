import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_MAX_STEPS,
  TOOL_RESULT_EXCERPT_CHAR_CAP,
  TRANSCRIPT_CHAR_CAP,
  detectBuiltinAiToolLoopSupport,
  runBuiltinAiToolLoop,
  type BuiltinAiLoopEvent,
  type BuiltinAiSessionLike,
  type BuiltinTool
} from "./builtin-ai-loop";
import { i18n } from "./i18n";

// Language declarations follow the active UI locale; pin it so assertions do
// not depend on the OS language of the machine running the tests.
beforeAll(() => {
  i18n.load("en", {});
  i18n.activate("en");
});

type PromptOptions = Parameters<BuiltinAiSessionLike["prompt"]>[1];

interface PromptCall {
  input: string;
  options: PromptOptions;
}

function scriptedSessionFactory(responses: readonly string[]) {
  const calls: PromptCall[] = [];
  const destroy = vi.fn();
  let index = 0;
  const session: BuiltinAiSessionLike = {
    async prompt(input, options) {
      calls.push({ input, options });
      if (index >= responses.length) throw new Error("Scripted session ran out of responses.");
      const response = responses[index];
      index += 1;
      return response;
    },
    destroy
  };
  const createSession = vi.fn(async () => session);
  return { calls, destroy, createSession };
}

function toolCall(tool: string, args: Record<string, unknown>) {
  return JSON.stringify({ action: "tool_call", tool, arguments: args });
}

function finalAnswer(answer: string) {
  return JSON.stringify({ action: "final", answer });
}

const TOOLS: BuiltinTool[] = [
  {
    name: "list_files",
    description: "List every file in the workspace.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "read_file",
    description: "Read one UTF-8 text file.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false
    }
  }
];

describe("detectBuiltinAiToolLoopSupport", () => {
  it("reports unavailable without a LanguageModel global", async () => {
    await expect(detectBuiltinAiToolLoopSupport({})).resolves.toBe("unavailable");
  });

  it("passes through recognised availability states and probes with language options", async () => {
    const availability = vi.fn(async () => "downloadable");
    await expect(detectBuiltinAiToolLoopSupport({
      LanguageModel: { availability, create: vi.fn() }
    })).resolves.toBe("downloadable");
    expect(availability).toHaveBeenCalledWith(expect.objectContaining({
      expectedInputs: [{ type: "text", languages: ["en"] }],
      expectedOutputs: [{ type: "text", languages: ["en"] }]
    }));
  });

  it("declares the UI language alongside English when the Prompt API supports it", async () => {
    i18n.load("ja", {});
    i18n.activate("ja");
    try {
      const availability = vi.fn(async () => "available");
      await detectBuiltinAiToolLoopSupport({ LanguageModel: { availability, create: vi.fn() } });
      expect(availability).toHaveBeenCalledWith(expect.objectContaining({
        expectedInputs: [{ type: "text", languages: ["en", "ja"] }],
        expectedOutputs: [{ type: "text", languages: ["en", "ja"] }]
      }));
    } finally {
      i18n.activate("en");
    }
  });

  it("normalises unknown states and probe failures to unavailable", async () => {
    await expect(detectBuiltinAiToolLoopSupport({
      LanguageModel: { availability: vi.fn(async () => "quantum"), create: vi.fn() }
    })).resolves.toBe("unavailable");
    await expect(detectBuiltinAiToolLoopSupport({
      LanguageModel: {
        availability: vi.fn(async () => { throw new Error("probe failed"); }),
        create: vi.fn()
      }
    })).resolves.toBe("unavailable");
  });
});

describe("runBuiltinAiToolLoop", () => {
  it("runs two tool calls then finishes with a constrained final answer", async () => {
    const { calls, destroy, createSession } = scriptedSessionFactory([
      toolCall("list_files", {}),
      toolCall("read_file", { path: "notes.txt" }),
      finalAnswer("The workspace has 2 files; notes.txt says hello.")
    ]);
    const execute = vi.fn(async (name: string) =>
      name === "list_files" ? "notes.txt\nreadme.md" : "hello from notes"
    );

    const result = await runBuiltinAiToolLoop({
      task: "Summarize the workspace.",
      tools: TOOLS,
      execute,
      createSession
    });

    expect(result).toEqual({
      status: "completed",
      answer: "The workspace has 2 files; notes.txt says hello.",
      steps: [
        { step: 1, tool: "list_files", arguments: {}, result: "notes.txt\nreadme.md" },
        { step: 2, tool: "read_file", arguments: { path: "notes.txt" }, result: "hello from notes" }
      ]
    });
    expect(createSession).toHaveBeenCalledOnce();
    expect(destroy).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenNthCalledWith(1, "list_files", {});
    expect(execute).toHaveBeenNthCalledWith(2, "read_file", { path: "notes.txt" });
    expect(calls).toHaveLength(3);
    expect(calls[0].input).toContain("untrusted data");
    expect(calls[0].input).toContain("Summarize the workspace.");
    expect(calls[0].input).toContain("read_file");
    expect(calls[0].input).toContain('"path"');
    expect(calls[0].input).toContain("(none yet)");
    const constraint = JSON.stringify(calls[0].options?.responseConstraint);
    expect(constraint).toContain("tool_call");
    expect(constraint).toContain("final");
    expect(constraint).toContain("list_files");
    expect(calls[2].input).toContain("hello from notes");
  });

  it("clips a long tool result at the excerpt cap in the next prompt", async () => {
    const longResult = "x".repeat(TOOL_RESULT_EXCERPT_CHAR_CAP * 3);
    const { calls, createSession } = scriptedSessionFactory([
      toolCall("read_file", { path: "big.log" }),
      finalAnswer("done")
    ]);
    const events: BuiltinAiLoopEvent[] = [];

    const result = await runBuiltinAiToolLoop({
      task: "Inspect the log.",
      tools: TOOLS,
      execute: async () => longResult,
      createSession,
      onEvent: (event) => events.push(event)
    });

    expect(result.status).toBe("completed");
    expect(calls[1].input).toContain("[truncated]");
    expect(calls[1].input).not.toContain("x".repeat(TOOL_RESULT_EXCERPT_CHAR_CAP));
    const toolResultEvent = events.find(
      (event): event is Extract<BuiltinAiLoopEvent, { type: "tool-result" }> => event.type === "tool-result"
    );
    expect(toolResultEvent).toBeDefined();
    expect(toolResultEvent?.truncated).toBe(true);
    expect(toolResultEvent?.excerpt).toHaveLength(TOOL_RESULT_EXCERPT_CHAR_CAP);
    expect(result.steps[0].result).toHaveLength(TOOL_RESULT_EXCERPT_CHAR_CAP * 3);
  });

  it("drops the oldest transcript entries once the transcript cap is reached", async () => {
    const filler = "a".repeat(Math.floor(TRANSCRIPT_CHAR_CAP / 4));
    const responses = [1, 2, 3, 4, 5, 6].map((step) => toolCall("read_file", { path: `f${step}` }));
    responses.push(finalAnswer("done"));
    const { calls, createSession } = scriptedSessionFactory(responses);

    const result = await runBuiltinAiToolLoop({
      task: "Read every file.",
      tools: TOOLS,
      execute: async (_name, args) => `content-${String(args.path)}-${filler}`,
      createSession
    });

    expect(result.status).toBe("completed");
    expect(calls).toHaveLength(7);
    const lastPrompt = calls[6].input;
    expect(lastPrompt).toContain("earlier steps omitted");
    expect(lastPrompt).toContain("content-f6-");
    expect(lastPrompt).not.toContain("content-f1-");
  });

  it("retries an invalid JSON turn once with a correction, then fails the run", async () => {
    const { calls, destroy, createSession } = scriptedSessionFactory(["not json at all", "{ still broken"]);
    const execute = vi.fn(async () => "unused");

    await expect(runBuiltinAiToolLoop({
      task: "Summarize.",
      tools: TOOLS,
      execute,
      createSession
    })).rejects.toThrow(/step 1 after one retry.*not valid JSON/);

    expect(calls).toHaveLength(2);
    expect(calls[1].input).toContain("Correction:");
    expect(calls[1].input).toContain("not valid JSON");
    expect(execute).not.toHaveBeenCalled();
    expect(destroy).toHaveBeenCalledOnce();
  });

  it("recovers when the retry after invalid JSON is valid", async () => {
    const { calls, createSession } = scriptedSessionFactory(["garbage", finalAnswer("ok")]);

    const result = await runBuiltinAiToolLoop({
      task: "Summarize.",
      tools: TOOLS,
      execute: async () => "unused",
      createSession
    });

    expect(result).toMatchObject({ status: "completed", answer: "ok" });
    expect(calls).toHaveLength(2);
  });

  it("retries an unknown tool once with the valid tool names, then fails", async () => {
    const { calls, destroy, createSession } = scriptedSessionFactory([
      toolCall("format_disk", {}),
      toolCall("format_disk", {})
    ]);
    const execute = vi.fn(async () => "unused");

    await expect(runBuiltinAiToolLoop({
      task: "Clean up.",
      tools: TOOLS,
      execute,
      createSession
    })).rejects.toThrow(/format_disk/);

    expect(calls).toHaveLength(2);
    expect(calls[1].input).toContain("Correction:");
    expect(calls[1].input).toContain("list_files, read_file");
    expect(execute).not.toHaveBeenCalled();
    expect(destroy).toHaveBeenCalledOnce();
  });

  it("stops with AbortError when cancelled between a tool execution and the next model turn", async () => {
    const controller = new AbortController();
    const { calls, destroy, createSession } = scriptedSessionFactory([
      toolCall("list_files", {}),
      finalAnswer("never reached")
    ]);
    const execute = vi.fn(async () => {
      controller.abort();
      return "files";
    });

    await expect(runBuiltinAiToolLoop({
      task: "Summarize.",
      tools: TOOLS,
      execute,
      createSession,
      signal: controller.signal
    })).rejects.toSatisfy((error: unknown) =>
      error instanceof DOMException && error.name === "AbortError"
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].options?.signal).toBe(controller.signal);
    expect(execute).toHaveBeenCalledOnce();
    expect(destroy).toHaveBeenCalledOnce();
  });

  it("checks the signal again before executing a tool", async () => {
    const controller = new AbortController();
    const destroy = vi.fn();
    const session: BuiltinAiSessionLike = {
      async prompt() {
        controller.abort();
        return toolCall("list_files", {});
      },
      destroy
    };
    const execute = vi.fn(async () => "unused");

    await expect(runBuiltinAiToolLoop({
      task: "Summarize.",
      tools: TOOLS,
      execute,
      createSession: async () => session,
      signal: controller.signal
    })).rejects.toSatisfy((error: unknown) =>
      error instanceof DOMException && error.name === "AbortError"
    );

    expect(execute).not.toHaveBeenCalled();
    expect(destroy).toHaveBeenCalledOnce();
  });

  it("does not create a session when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const createSession = vi.fn(async () => ({ prompt: async () => finalAnswer("x") }));

    await expect(runBuiltinAiToolLoop({
      task: "Summarize.",
      tools: TOOLS,
      execute: async () => "unused",
      createSession,
      signal: controller.signal
    })).rejects.toSatisfy((error: unknown) =>
      error instanceof DOMException && error.name === "AbortError"
    );

    expect(createSession).not.toHaveBeenCalled();
  });

  it("returns a distinguishable max-steps result instead of throwing", async () => {
    expect(DEFAULT_MAX_STEPS).toBe(24);
    const { calls, destroy, createSession } = scriptedSessionFactory([
      toolCall("list_files", {}),
      toolCall("list_files", {})
    ]);

    const result = await runBuiltinAiToolLoop({
      task: "Summarize.",
      tools: TOOLS,
      execute: async () => "files",
      createSession,
      maxSteps: 2
    });

    expect(result.status).toBe("max-steps-exhausted");
    expect(result.steps).toHaveLength(2);
    expect(calls).toHaveLength(2);
    expect(destroy).toHaveBeenCalledOnce();
  });

  it("emits model-turn, tool-call, tool-result, and final events in order", async () => {
    const { createSession } = scriptedSessionFactory([
      toolCall("list_files", {}),
      finalAnswer("done")
    ]);
    const events: BuiltinAiLoopEvent[] = [];

    await runBuiltinAiToolLoop({
      task: "Summarize.",
      tools: TOOLS,
      execute: async () => "files",
      createSession,
      onEvent: (event) => events.push(event)
    });

    expect(events.map((event) => event.type)).toEqual([
      "model-turn",
      "tool-call",
      "tool-result",
      "model-turn",
      "final"
    ]);
    expect(events[0]).toMatchObject({ step: 1, attempt: 1 });
    expect(events[1]).toMatchObject({ step: 1, tool: "list_files", arguments: {} });
    expect(events[2]).toMatchObject({ step: 1, tool: "list_files", excerpt: "files", truncated: false });
    expect(events[3]).toMatchObject({ step: 2, attempt: 1 });
    expect(events[4]).toMatchObject({ step: 2, answer: "done" });
  });

  it("tolerates sessions without destroy and an empty tool catalog", async () => {
    const session: BuiltinAiSessionLike = {
      prompt: async () => finalAnswer("done")
    };

    const result = await runBuiltinAiToolLoop({
      task: "Say done.",
      tools: [],
      execute: async () => "unused",
      createSession: async () => session
    });

    expect(result).toMatchObject({ status: "completed", answer: "done" });
  });

  it("rejects blank tasks, bad step budgets, and duplicate tool names before creating a session", async () => {
    const createSession = vi.fn(async () => ({ prompt: async () => finalAnswer("x") }));
    const execute = async () => "unused";

    await expect(runBuiltinAiToolLoop({ task: "   ", tools: TOOLS, execute, createSession }))
      .rejects.toThrow("Task must not be empty.");
    await expect(runBuiltinAiToolLoop({ task: "Go.", tools: TOOLS, execute, createSession, maxSteps: 0 }))
      .rejects.toThrow("maxSteps must be a positive integer.");
    await expect(runBuiltinAiToolLoop({ task: "Go.", tools: [TOOLS[0], { ...TOOLS[0] }], execute, createSession }))
      .rejects.toThrow("Duplicate tool name");
    expect(createSession).not.toHaveBeenCalled();
  });
});
