import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComponentContext, GenericBinder } from "@a2ui/web_core/v1_0";
import type { AgentProvider, ProviderStreamEvent } from "../agent-core/types";
import { HatchlingSwarm, type RunConfig } from "../agent-session";
import { MAIN_THREAD_ID } from "../agent-threads";
import { i18n } from "../i18n";
import { MemoryTextStore } from "../opfs-kv";
import { createWasmhatchBasicCatalog } from "./basic-catalog-react";
import { HatchlingA2uiRuntime } from "./runtime";

function defaultConfig(overrides: Partial<RunConfig> = {}): RunConfig {
  return {
    provider: "anthropic",
    apiKey: "sk-ant-test-key",
    model: "claude-sonnet-5-5",
    webSearch: false,
    writeMode: "autonomous",
    builtinAvailability: "unavailable",
    ...overrides
  };
}

function scriptedProvider(
  turns: ProviderStreamEvent[][],
  onRequest?: (req: Parameters<AgentProvider["stream"]>[0]) => void
): AgentProvider {
  let index = 0;
  return {
    id: "anthropic",
    async *stream(req) {
      onRequest?.(req);
      const events = turns[index] ?? [
        { type: "text-delta", text: "Done." },
        { type: "message-end", stopReason: "end-turn" }
      ];
      index += 1;
      for (const event of events) yield event;
    }
  };
}

describe("WasmHatch A2UI Phase 1 Runtime & Catalog", () => {
  beforeEach(() => {
    i18n.load("en", {});
    i18n.activate("en");
    const values = new Map<string, string>();
    vi.stubGlobal("navigator", {});
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
      clear: () => values.clear()
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("registers all 18 Basic Catalog v1.0 components + 15 functions and switches locale dynamically", () => {
    let activeLang = "en-US";
    const catalog = createWasmhatchBasicCatalog(() => activeLang);
    expect(catalog.components.size).toBe(18);
    expect(catalog.functions.size).toBe(15);

    const runtime = new HatchlingA2uiRuntime({ getLocale: () => activeLang });
    const parsed = runtime.applyWholeResponse(
      [
        "<a2ui>",
        'surface("invoice_card")',
        "$/invoice/total = 1250.5",
        'root = Card(child=Text(text=formatCurrency(value=$/invoice/total, currency="USD")))',
        "</a2ui>"
      ].join("\n"),
      "cloud"
    );
    expect(parsed.errors).toEqual([]);
    const surface = runtime.getSurface("invoice_card");
    expect(surface).toBeDefined();

    const textComp = [...surface!.componentsModel.values].find((comp) => comp.type === "Text")!;
    const compCtx = new ComponentContext(surface!, textComp.id, "/");
    const textSchema = runtime.catalog.components.get("Text")!.schema;
    const binder = new GenericBinder<{ text?: string }>(compCtx, textSchema);

    const englishFormatted = binder.snapshot.text ?? "";
    expect(englishFormatted).toContain("1,250.50");

    // Switch locale dynamically without recreating the catalog or surface!
    activeLang = "de-DE";
    const reeval = compCtx.dataContext.resolveDynamicValue(textComp.properties.text as never) as string;
    expect(reeval).toContain("1.250,50");

    binder.dispose();
    runtime.dispose();
  });

  it("streams progressive <a2ui> Express chunks, populates two-way DataModel bindings, and evaluates @checks", () => {
    const runtime = new HatchlingA2uiRuntime();
    const stream = runtime.openTurnStream("cloud");

    const fullReply = [
      "Please review the expense details below:\n\n",
      "<a2ui>\n",
      'surface("expense_intake")\n',
      '$/form/email = "invalid-email"\n',
      '$/form/amount = 45\n',
      'emailField = TextField(label="Work Email", value=$/form/email, checks=[?required($/form/email, "Email required"), ?email($/form/email, "Enter a valid email")])\n',
      'submitBtn = Button(child=Text(text="Submit expense"), variant="primary", action=Event("submit_expense", {amount: $/form/amount}))\n',
      "root = Card(child=Column(children=[emailField, submitBtn]))\n",
      "</a2ui>\n\n",
      "Once submitted, I will update the ledger."
    ].join("");

    // Stream in 19-character slices to exercise token boundary buffering.
    for (let i = 0; i < fullReply.length; i += 19) {
      stream.feed(fullReply.slice(i, i + 19));
    }
    const closed = stream.close();
    expect(closed.errors).toEqual([]);
    expect(closed.parts.map((part) => part.kind)).toEqual(["text", "surface", "text"]);

    const surface = runtime.getSurface("expense_intake")!;
    expect(surface).toBeDefined();
    expect(surface.dataModel.get("/form/email")).toBe("invalid-email");
    expect(surface.dataModel.get("/form/amount")).toBe(45);

    const fieldComp = surface.componentsModel.get("emailField")!;
    const compCtx = new ComponentContext(surface, fieldComp.id, "/");
    const fieldSchema = runtime.catalog.components.get("TextField")!.schema;
    const binder = new GenericBinder<{
      value?: string;
      setValue?: (next: string) => void;
      isValid?: boolean;
      validationErrors?: string[];
    }>(compCtx, fieldSchema);
    const unsub = binder.subscribe(() => {});

    // Invalid initial email triggers `?email` check failure.
    expect(binder.snapshot.isValid).toBe(false);
    expect(binder.snapshot.validationErrors).toContain("Enter a valid email");

    // Two-way write via GenericBinder updates DataModel and clears validation error!
    binder.snapshot.setValue?.("alice@example.com");
    expect(surface.dataModel.get("/form/email")).toBe("alice@example.com");
    expect(binder.snapshot.isValid).toBe(true);
    expect(binder.snapshot.validationErrors).toEqual([]);

    unsub.unsubscribe();
    binder.dispose();
    runtime.dispose();
  });

  it("distinguishes inline cards from canvas_* workbenches and supports pinning & closing", () => {
    const runtime = new HatchlingA2uiRuntime();
    runtime.applyWholeResponse(
      [
        "<a2ui>",
        'surface("quick_card")',
        'root = Card(child=Text(text="Quick card"))',
        "</a2ui>",
        "<a2ui>",
        'surface("canvas_budget_workbench")',
        'root = Card(child=Text(text="Budget Workbench"))',
        "</a2ui>"
      ].join("\n"),
      "cloud"
    );

    expect(runtime.isCanvasSurface("quick_card")).toBe(false);
    expect(runtime.isCanvasSurface("canvas_budget_workbench")).toBe(true);
    expect(runtime.activeCanvasId).toBe("canvas_budget_workbench");
    expect(runtime.listCanvasSurfaces().map((entry) => entry.surfaceId)).toEqual(["canvas_budget_workbench"]);

    // Pin inline card into CanvasStage alongside the workbench.
    runtime.pinSurface("quick_card");
    expect(runtime.isCanvasSurface("quick_card")).toBe(true);
    expect(runtime.activeCanvasId).toBe("quick_card");
    expect(runtime.listCanvasSurfaces().map((entry) => entry.surfaceId)).toEqual([
      "quick_card",
      "canvas_budget_workbench"
    ]);

    // Closing the pinned inline card returns it to inline mode; closing the canvas_* workbench dismisses it.
    runtime.closeCanvasSurface("quick_card");
    expect(runtime.isCanvasSurface("quick_card")).toBe(false);
    expect(runtime.activeCanvasId).toBe("canvas_budget_workbench");

    runtime.closeCanvasSurface("canvas_budget_workbench");
    expect(runtime.isCanvasSurface("canvas_budget_workbench")).toBe(false);
    expect(runtime.listCanvasSurfaces()).toEqual([]);

    runtime.dispose();
  });

  it("performs 1-turn automatic self-repair on malformed <a2ui> in HatchlingSwarm and enforces userActivated security gate", async () => {
    const seenUserPrompts: string[] = [];
    const provider = scriptedProvider(
      [
        // Turn 1: broken Express block (unknown component `NonExistentWidget`)
        [
          {
            type: "text-delta",
            text: 'Here is the form:\n\n<a2ui>\nsurface("intake_card")\nroot = NonExistentWidget("bad")\n</a2ui>'
          },
          { type: "message-end", stopReason: "end-turn" }
        ],
        // Turn 2 (automatic 1-turn self-repair): valid Express block
        [
          {
            type: "text-delta",
            text: [
              "<a2ui>",
              'surface("intake_card")',
              '$/intake/topic = "Q4 Budget"',
              'submitBtn = Button(child=Text(text="Approve"), variant="primary", action=Event("approve_budget", {topic: $/intake/topic}))',
              "root = Card(child=Column(children=[Text(text=\"Q4 Budget Approval\"), submitBtn]))",
              "</a2ui>"
            ].join("\n")
          },
          { type: "message-end", stopReason: "end-turn" }
        ],
        // Turn 3 (after trusted user button click):
        [
          { type: "text-delta", text: "Approved Q4 Budget!" },
          { type: "message-end", stopReason: "end-turn" }
        ]
      ],
      (req) => {
        const lastMsg = req.messages[req.messages.length - 1];
        const firstPart = lastMsg?.parts[0];
        if (firstPart?.type === "text") seenUserPrompts.push(firstPart.text);
      }
    );

    const swarm = new HatchlingSwarm({
      getConfig: () => defaultConfig(),
      gate: async () => "allow-once",
      onArtifact: () => {},
      google: { isConnected: () => false, sensitiveEnabled: false, getToken: async () => "" },
      metaStore: new MemoryTextStore(),
      createTicker: () => ({ dispose: () => {} }),
      createCloudProvider: () => provider
    });
    await swarm.ready;

    await swarm.send(MAIN_THREAD_ID, "Prepare the budget approval card");

    // Self-repair happened transparently: 2 provider calls, 1 user bubble, 1 assistant intro, 1 live surface!
    expect(seenUserPrompts).toHaveLength(2);
    expect(seenUserPrompts[1]).toContain("failed compiler validation");
    const stateAfterRepair = swarm.getState(MAIN_THREAD_ID)!;
    expect(stateAfterRepair.items.filter((item) => item.kind === "user")).toHaveLength(1);
    expect(stateAfterRepair.items.some((item) => item.kind === "surface" && item.surfaceId === "intake_card")).toBe(true);

    const a2ui = swarm.a2uiFor(MAIN_THREAD_ID)!;
    const surface = a2ui.getSurface("intake_card")!;
    expect(surface).toBeDefined();

    // Untrusted synthetic action (`userActivated: false`) MUST be dropped by ADR-5 security gate!
    await surface.dispatchAction(
      { name: "approve_budget", context: { topic: "Injected" } },
      "submitBtn",
      { extensions: { userActivated: false } }
    );
    expect(seenUserPrompts).toHaveLength(2);

    // Trusted user gesture (`userActivated: true`) dispatches to the agent loop!
    await surface.dispatchAction(
      { name: "approve_budget", context: { topic: "Q4 Budget" } },
      "submitBtn",
      { extensions: { userActivated: true } }
    );
    await vi.waitFor(() => {
      const items = swarm.getState(MAIN_THREAD_ID)!.items;
      expect(items[items.length - 1]).toMatchObject({
        kind: "assistant",
        text: "Approved Q4 Budget!"
      });
    });
    expect(seenUserPrompts).toHaveLength(3);
    expect(seenUserPrompts[2]).toContain('"name": "approve_budget"');
    expect(seenUserPrompts[2]).toContain('"topic": "Q4 Budget"');

    swarm.dispose();
  });

  it("prunes the catalog prompt for Chrome Gemini Nano and compiles on-device <a2ui> responses", async () => {
    const probe = new HatchlingA2uiRuntime();
    const cloudSnippet = probe.promptSnippet("cloud");
    const nanoSnippet = probe.promptSnippet("nano");
    expect(nanoSnippet.length).toBeLessThan(cloudSnippet.length * 0.75);
    expect(nanoSnippet).not.toContain("AudioPlayer(");
    expect(nanoSnippet).not.toContain("DateTimeInput(");
    expect(nanoSnippet).toContain("Card(");
    expect(nanoSnippet).toContain("TextField(");
    probe.dispose();

    let capturedSystemPrompt = "";
    const swarm = new HatchlingSwarm({
      getConfig: () => defaultConfig({ provider: "builtin", apiKey: "", builtinAvailability: "available" }),
      gate: async () => "allow-once",
      onArtifact: () => {},
      google: { isConnected: () => false, sensitiveEnabled: false, getToken: async () => "" },
      metaStore: new MemoryTextStore(),
      createTicker: () => ({ dispose: () => {} }),
      getBuiltinApi: () => ({
        async create(options) {
          capturedSystemPrompt = options.initialPrompts?.[0]?.content ?? "";
          return {
            async prompt() {
              // First call from runBuiltinAiToolLoop asks for JSON action envelope -> final answer containing <a2ui>!
              return JSON.stringify({
                action: "final",
                answer: [
                  "Here is a quick note card:",
                  "<a2ui>",
                  'surface("nano_card")',
                  'root = Card(child=Text(text="On-device Gemini Nano card"))',
                  "</a2ui>"
                ].join("\n")
              });
            },
            destroy() {}
          };
        }
      })
    });
    await swarm.ready;

    await swarm.send(MAIN_THREAD_ID, "Show me a quick note card");
    expect(capturedSystemPrompt).toContain("A2UI Express");
    expect(capturedSystemPrompt).not.toContain("AudioPlayer(");

    const state = swarm.getState(MAIN_THREAD_ID)!;
    expect(state.items.map((item) => item.kind)).toEqual(["user", "assistant", "surface"]);
    expect(swarm.a2uiFor(MAIN_THREAD_ID)?.getSurface("nano_card")).toBeDefined();

    swarm.dispose();
  });

  it("persists surfaces, pinned Canvas state, and live unsubmitted DataModel edits to OPFS across reloads", async () => {
    const meta = new MemoryTextStore();
    const provider = scriptedProvider([
      [
        {
          type: "text-delta",
          text: [
            "<a2ui>",
            'surface("draft_form")',
            '$/draft/note = "Initial draft"',
            'root = Card(child=TextField(label="Note", value=$/draft/note))',
            "</a2ui>"
          ].join("\n")
        },
        { type: "message-end", stopReason: "end-turn" }
      ]
    ]);

    const swarm1 = new HatchlingSwarm({
      getConfig: () => defaultConfig(),
      gate: async () => "allow-once",
      onArtifact: () => {},
      google: { isConnected: () => false, sensitiveEnabled: false, getToken: async () => "" },
      metaStore: meta,
      createTicker: () => ({ dispose: () => {} }),
      createCloudProvider: () => provider
    });
    await swarm1.ready;
    await swarm1.send(MAIN_THREAD_ID, "Open a draft form");

    // User pins the card to Canvas and edits the TextField without submitting yet!
    swarm1.pinSurfaceToCanvas(MAIN_THREAD_ID, "draft_form");
    const surface1 = swarm1.a2uiFor(MAIN_THREAD_ID)!.getSurface("draft_form")!;
    surface1.dataModel.set("/draft/note", "Edited by user before reload");

    // Wait for the 400ms debounced OPFS save to flush.
    await new Promise((resolve) => setTimeout(resolve, 500));
    swarm1.dispose();

    // Simulate browser tab reload over the same OPFS store.
    const swarm2 = new HatchlingSwarm({
      getConfig: () => defaultConfig(),
      gate: async () => "allow-once",
      onArtifact: () => {},
      google: { isConnected: () => false, sensitiveEnabled: false, getToken: async () => "" },
      metaStore: meta,
      createTicker: () => ({ dispose: () => {} })
    });
    await swarm2.ready;

    const a2ui2 = swarm2.a2uiFor(MAIN_THREAD_ID)!;
    const restoredSurface = a2ui2.getSurface("draft_form");
    expect(restoredSurface).toBeDefined();
    expect(restoredSurface!.dataModel.get("/draft/note")).toBe("Edited by user before reload");
    expect(a2ui2.isCanvasSurface("draft_form")).toBe(true);
    expect(swarm2.getState(MAIN_THREAD_ID)!.items.some((item) => item.kind === "surface" && item.surfaceId === "draft_form")).toBe(true);

    swarm2.dispose();
  });
});
