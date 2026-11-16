import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HatchlingSwarm, type RunConfig } from "../agent-session";
import { MAIN_THREAD_ID } from "../agent-threads";
import { SessionPermissionStore } from "../chat-permissions";
import { i18n } from "../i18n";
import { MemoryTextStore } from "../opfs-kv";
import { createWorkspaceStore } from "../workspace";
import {
  HatchlingA2uiRuntime,
  VEGACHART_V1_CATALOG_ID,
  WASMHATCH_TABULAR_CATALOG_ID,
  WASMHATCH_WORKSPACE_CATALOG_ID
} from "./runtime";
import { type LoadedWorkspaceTable, type QuickJsTransformOutput } from "./rpc-functions";
import {
  detectFormulaInjection,
  normalizeTabularDataset,
  profileTabularDataset,
  serializeSafeCsv
} from "./tabular-utils";
import { normalizeVegaLiteSpec } from "./vega-chart-catalog";

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

describe("WasmHatch A2UI Phase 2 Domain Catalogs & Local QuickJS RPC", () => {
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

  it("parses RFC 4180 CSV, preserves ZIP codes & negative numbers, flags formula injection, and exports neutralized CSV", () => {
    expect(detectFormulaInjection("=CMD|' /C calc'!A0")).toBe(true);
    expect(detectFormulaInjection("+SUM(A1:A2)")).toBe(true);
    expect(detectFormulaInjection("@import(evil)")).toBe(true);
    expect(detectFormulaInjection("-2+3")).toBe(true);
    expect(detectFormulaInjection("\t=1+1")).toBe(true);
    expect(detectFormulaInjection("-42.5")).toBe(false);
    expect(detectFormulaInjection("Normal note")).toBe(false);

    const csv = [
      "\uFEFFregion,postal_code,delta,formula_note",
      '"APAC, North",00742,-125.5,"=CMD|\' /C calc\'!A0"',
      '"EMEA ""West""",90210,300,"+SUM(B1:B2)"',
      "AMER,,74.5,Safe text"
    ].join("\r\n");

    const dataset = normalizeTabularDataset(csv);
    expect(dataset.columns.map((c) => ({ key: c.key, type: c.type }))).toEqual([
      { key: "region", type: "text" },
      { key: "postal_code", type: "text" },
      { key: "delta", type: "number" },
      { key: "formula_note", type: "text" }
    ]);
    expect(dataset.rows[0]?.cells.postal_code).toBe("00742");
    expect(dataset.rows[0]?.cells.delta).toBe(-125.5);
    expect(dataset.formulaWarnings).toHaveLength(2);

    const profile = profileTabularDataset(dataset);
    const deltaProfile = profile.find((p) => p.key === "delta");
    expect(deltaProfile?.min).toBe(-125.5);
    expect(deltaProfile?.max).toBe(300);
    expect(deltaProfile?.sum).toBe(249);
    const postalProfile = profile.find((p) => p.key === "postal_code");
    expect(postalProfile?.missingCount).toBe(1);

    const exported = serializeSafeCsv(dataset.columns, dataset.rows);
    expect(exported).toContain("'=CMD|' /C calc'!A0");
    expect(exported).toContain("'+SUM(B1:B2)");
    expect(exported).toContain("-125.5");
  });

  it("normalizes Vega-Lite bar, line, area, point, and donut specs with aggregations and multi-series", () => {
    const barSpec = normalizeVegaLiteSpec({
      title: "Regional Revenue",
      mark: "bar",
      data: {
        values: [
          { quarter: "Q1", channel: "Direct", revenue: 120 },
          { quarter: "Q1", channel: "Direct", revenue: 80 },
          { quarter: "Q1", channel: "Partner", revenue: 60 },
          { quarter: "Q2", channel: "Direct", revenue: 250 }
        ]
      },
      encoding: {
        x: { field: "quarter", title: "Quarter" },
        y: { field: "revenue", aggregate: "sum", title: "Revenue ($k)" },
        color: { field: "channel", title: "Channel" }
      }
    });

    expect(barSpec).not.toBeNull();
    expect(barSpec?.mark).toBe("bar");
    expect(barSpec?.categories).toEqual(["Q1", "Q2"]);
    expect(barSpec?.seriesNames).toEqual(["Direct", "Partner"]);
    const q1Direct = barSpec?.points.find((p) => p.xLabel === "Q1" && p.series === "Direct");
    expect(q1Direct?.yValue).toBe(200);

    const donutSpec = normalizeVegaLiteSpec({
      mark: { type: "arc", innerRadius: 52 },
      data: { values: [{ segment: "Enterprise", share: 65 }, { segment: "SMB", share: 35 }] },
      encoding: { color: { field: "segment" }, theta: { field: "share" } }
    });
    expect(donutSpec?.mark).toBe("arc");
    expect(donutSpec?.donutInnerRatio).toBeGreaterThan(0.3);
    expect(donutSpec?.points).toHaveLength(2);
  });

  it("compiles multi-catalog Express surfaces (Basic + VegaChart + Tabular + Workspace) and round-trips snapshots", () => {
    const runtime = new HatchlingA2uiRuntime();
    const response = [
      "Interactive projection workbench ready:",
      "<a2ui>",
      'surface("canvas_revenue_lab", sendDataModel=true)',
      "$/params/growth = 15",
      '$/sim/rows = [{"month": "Jan", "mrr": 100}, {"month": "Feb", "mrr": 115}]',
      '$/sim/chart = {"title": "MRR Forecast", "mark": "line", "data": {"values": [{"month": "Jan", "mrr": 100}, {"month": "Feb", "mrr": 115}]}, "encoding": {"x": {"field": "month"}, "y": {"field": "mrr"}}}',
      'slider = Slider("Monthly growth (%)", 0, 50, $/params/growth)',
      'engine = QuickJsWorkbench("({ rows: [1, 2].map(m => ({ month: \'M\' + m, mrr: Math.round(100 * Math.pow(1 + args.growth / 100, m)) })) })", $/params, "/sim", "MRR Sandbox")',
      "chart = VegaChart($/sim/chart, 260)",
      'grid = DataGrid($/sim/rows, "Monthly projection")',
      'profiler = ColumnProfiler($/sim/rows, "Forecast stats")',
      'diff = WorkspaceDiffCard("forecast.json", "{\\"growth\\": 15}\\n", "Save config")',
      "root = Column([slider, engine, chart, grid, profiler, diff])",
      "</a2ui>"
    ].join("\n");

    const result = runtime.applyWholeResponse(response, "cloud");
    expect(result.errors).toEqual([]);
    expect(runtime.activeCanvasId).toBe("canvas_revenue_lab");

    const surface = runtime.getSurface("canvas_revenue_lab");
    expect(surface).toBeDefined();
    expect(surface?.componentsModel.get("chart")?.catalog.id).toBe(VEGACHART_V1_CATALOG_ID);
    expect(surface?.componentsModel.get("grid")?.catalog.id).toBe(WASMHATCH_TABULAR_CATALOG_ID);
    expect(surface?.componentsModel.get("engine")?.catalog.id).toBe(WASMHATCH_WORKSPACE_CATALOG_ID);
    expect(surface?.componentsModel.get("diff")?.catalog.id).toBe(WASMHATCH_WORKSPACE_CATALOG_ID);

    const snapshots = runtime.serializeSurfaces();
    const restoredRuntime = new HatchlingA2uiRuntime();
    restoredRuntime.restoreSurfaces(snapshots);

    const restoredSurface = restoredRuntime.getSurface("canvas_revenue_lab");
    expect(restoredSurface).toBeDefined();
    expect(restoredSurface?.componentsModel.get("chart")?.catalog.id).toBe(VEGACHART_V1_CATALOG_ID);
    expect(restoredSurface?.componentsModel.get("grid")?.catalog.id).toBe(WASMHATCH_TABULAR_CATALOG_ID);
    expect(restoredSurface?.componentsModel.get("engine")?.catalog.id).toBe(WASMHATCH_WORKSPACE_CATALOG_ID);
    expect(restoredSurface?.dataModel.get("/params/growth")).toBe(15);

    runtime.dispose();
    restoredRuntime.dispose();
  });

  it("executes QuickJS transforms over callAgentFunction RPC in milliseconds and updates SurfaceModel.dataModel", async () => {
    const workspace = createWorkspaceStore({
      working: "test-a2ui-qjs-work",
      baseline: "test-a2ui-qjs-base"
    });
    await workspace.writeFile("rates.json", JSON.stringify({ taxRate: 0.1 }));
    await workspace.writeFile(
      "calc.js",
      "function main(input) { const tax = JSON.parse(input.files[0].content).taxRate; const subtotal = input.args.price * input.args.qty; return { subtotal, total: Number((subtotal * (1 + tax)).toFixed(2)) }; }"
    );

    const runtime = new HatchlingA2uiRuntime({ workspace });
    runtime.applyWholeResponse(
      [
        "<a2ui>",
        'surface("quote_calc")',
        't = Text("Quote")',
        "root = Column([t])",
        "</a2ui>"
      ].join("\n"),
      "cloud"
    );

    const inlineOut = await runtime.callLocalRpc<QuickJsTransformOutput>(
      "quote_calc",
      "runQuickJsTransform",
      {
        script: "({ doubled: args.base * 2, series: [1, 2, 3].map(i => i * args.base) })",
        args: { base: 14 },
        targetPath: "/computed/inline"
      }
    );
    expect(inlineOut.stale).toBe(false);
    expect(inlineOut.result).toEqual({ doubled: 28, series: [14, 28, 42] });
    expect(runtime.getSurface("quote_calc")?.dataModel.get("/computed/inline")).toEqual({
      doubled: 28,
      series: [14, 28, 42]
    });

    const fileOut = await runtime.callLocalRpc<QuickJsTransformOutput>(
      "quote_calc",
      "runQuickJsTransform",
      {
        scriptPath: "calc.js",
        inputPaths: ["rates.json"],
        args: { price: 25, qty: 4 },
        targetPath: "/computed/quote"
      }
    );
    expect(fileOut.result).toEqual({ subtotal: 100, total: 110 });
    expect(runtime.getSurface("quote_calc")?.dataModel.get("/computed/quote")).toEqual({
      subtotal: 100,
      total: 110
    });

    runtime.dispose();
  });

  it("drops stale out-of-order QuickJS RPC completions using monotonic sequence tracking", async () => {
    const runtime = new HatchlingA2uiRuntime({
      runScript: async (_script, input) => {
        const payload = input.args as { label: string; delayMs: number };
        await new Promise((resolve) => setTimeout(resolve, payload.delayMs));
        return {
          output: { label: payload.label },
          durationMs: payload.delayMs,
          inputBytes: 10,
          outputBytes: 10
        };
      }
    });

    runtime.applyWholeResponse(
      ['<a2ui>', 'surface("race_surface")', 't = Text("Race")', 'root = Column([t])', '</a2ui>'].join("\n"),
      "cloud"
    );

    const slowFirst = runtime.callLocalRpc<QuickJsTransformOutput>(
      "race_surface",
      "runQuickJsTransform",
      {
        script: "args",
        args: { label: "stale-slider-drag", delayMs: 45 },
        targetPath: "/sim/state"
      }
    );
    const fastSecond = runtime.callLocalRpc<QuickJsTransformOutput>(
      "race_surface",
      "runQuickJsTransform",
      {
        script: "args",
        args: { label: "latest-slider-drag", delayMs: 5 },
        targetPath: "/sim/state"
      }
    );

    const [firstRes, secondRes] = await Promise.all([slowFirst, fastSecond]);
    expect(secondRes.stale).toBe(false);
    expect(firstRes.stale).toBe(true);
    expect(runtime.getSurface("race_surface")?.dataModel.get("/sim/state")).toEqual({
      label: "latest-slider-drag"
    });

    runtime.dispose();
  });

  it("enforces hatchling capability allowlists fail-closed and blocks protected workspace paths", async () => {
    const workspace = createWorkspaceStore({
      working: "test-a2ui-caps-work",
      baseline: "test-a2ui-caps-base"
    });
    await workspace.writeFile("metrics.csv", "team,score\nCore,98\nInfra,=1+1\n");
    await workspace.writeFile(".env", "API_SECRET=never-expose");

    let activeCaps: readonly string[] | null = ["workspace.read"];
    const runtime = new HatchlingA2uiRuntime({
      workspace,
      getCapabilities: () => activeCaps
    });

    runtime.applyWholeResponse(
      ['<a2ui>', 'surface("cap_surface")', 't = Text("Caps")', 'root = Column([t])', '</a2ui>'].join("\n"),
      "cloud"
    );

    // Cloud prompt prunes QuickJsWorkbench and commitWorkspaceWrite when only workspace.read is granted
    const readOnlyPrompt = runtime.promptSnippet("cloud");
    expect(readOnlyPrompt).toContain("WorkspaceDiffCard");
    expect(readOnlyPrompt).toContain("loadWorkspaceTable");
    expect(readOnlyPrompt).not.toContain("QuickJsWorkbench");
    expect(readOnlyPrompt).not.toContain("commitWorkspaceWrite");

    // workspace.read succeeds on normal CSV
    const table = await runtime.callLocalRpc<LoadedWorkspaceTable>(
      "cap_surface",
      "loadWorkspaceTable",
      { path: "metrics.csv", targetPath: "/loaded" }
    );
    expect(table.totalRows).toBe(2);
    expect(table.formulaWarningCount).toBe(1);
    expect(runtime.getSurface("cap_surface")?.dataModel.get("/loaded/totalRows")).toBe(2);

    // Protected path is always rejected even with workspace.read
    await expect(
      runtime.callLocalRpc("cap_surface", "readWorkspaceFile", { path: ".env" })
    ).rejects.toThrow(/Protected workspace path/);

    // workspace.script fails closed
    await expect(
      runtime.callLocalRpc("cap_surface", "runQuickJsTransform", {
        script: "1 + 1"
      })
    ).rejects.toThrow(/workspace\.script/);

    // workspace.write fails closed even when userActivated is true
    await expect(
      runtime.callLocalRpc(
        "cap_surface",
        "commitWorkspaceWrite",
        { path: "metrics.csv", content: "team,score\nCore,99\n" },
        { userActivated: true }
      )
    ).rejects.toThrow(/workspace\.write/);

    // Granting null (ordinary unrestricted hatchling) unlocks QuickJsWorkbench in prompt
    activeCaps = null;
    expect(runtime.promptSnippet("cloud")).toContain("QuickJsWorkbench");

    runtime.dispose();
  });

  it("requires userActivated for exports/writes, honors Careful-mode PermissionGate, and supports 1-click Undo in HatchlingSwarm", async () => {
    const downloads: { fileName: string; content: string }[] = [];
    const standaloneWorkspace = createWorkspaceStore({
      working: "test-a2ui-export-work",
      baseline: "test-a2ui-export-base"
    });
    const standalone = new HatchlingA2uiRuntime({
      workspace: standaloneWorkspace,
      permissions: new SessionPermissionStore(),
      onDownload: (fileName, content) => downloads.push({ fileName, content })
    });
    standalone.applyWholeResponse(
      ['<a2ui>', 'surface("exp")', 't = Text("Export")', 'root = Column([t])', '</a2ui>'].join("\n"),
      "cloud"
    );

    // Untrusted export is rejected
    await expect(
      standalone.callLocalRpc(
        "exp",
        "exportSafeCsv",
        { rows: [{ col: "=EVIL()" }], fileName: "out.csv" },
        { userActivated: false }
      )
    ).rejects.toThrow(/explicit user gesture/);

    // Trusted export succeeds and neutralizes formula injection
    await standalone.callLocalRpc(
      "exp",
      "exportSafeCsv",
      { rows: [{ col: "=EVIL()" }], fileName: "out.csv" },
      { userActivated: true }
    );
    expect(downloads).toHaveLength(1);
    expect(downloads[0]?.content).toContain("'=EVIL()");
    standalone.dispose();

    // Full HatchlingSwarm Careful-mode gate + 1-click revert integration
    const gateCalls: string[] = [];
    let gateDecision: "allow-once" | "reject" = "reject";
    const swarm = new HatchlingSwarm({
      getConfig: () => defaultConfig({ writeMode: "careful" }),
      gate: async (req) => {
        gateCalls.push(req.path);
        return gateDecision;
      },
      onArtifact: () => {},
      google: { isConnected: () => false, sensitiveEnabled: false, getToken: async () => "" },
      metaStore: new MemoryTextStore(),
      createTicker: () => ({ dispose: () => {} })
    });
    await swarm.ready;

    const ws = swarm.workspaceFor(MAIN_THREAD_ID);
    await ws.writeFile("plan.md", "# Draft v1\n");

    const a2ui = swarm.a2uiFor(MAIN_THREAD_ID)!;
    a2ui.applyWholeResponse(
      [
        "<a2ui>",
        'surface("review_card")',
        'diff = WorkspaceDiffCard("plan.md", "# Draft v2\\nApproved.\\n", "Review plan")',
        "root = Column([diff])",
        "</a2ui>"
      ].join("\n"),
      "cloud"
    );

    // Without user activation: blocked before hitting gate
    await expect(
      a2ui.callLocalRpc(
        "review_card",
        "commitWorkspaceWrite",
        { path: "plan.md", content: "# Draft v2\nApproved.\n" },
        { userActivated: false }
      )
    ).rejects.toThrow(/explicit user gesture/);
    expect(gateCalls).toHaveLength(0);

    // Careful-mode reject: file stays untouched
    await expect(
      a2ui.callLocalRpc(
        "review_card",
        "commitWorkspaceWrite",
        { path: "plan.md", content: "# Draft v2\nApproved.\n" },
        { userActivated: true }
      )
    ).rejects.toThrow(/rejected/);
    expect(gateCalls).toEqual(["plan.md"]);
    expect(await ws.readFile("plan.md")).toBe("# Draft v1\n");

    // Careful-mode allow-once: writes file, emits revertible write item, and 1-click Undo reverts it!
    gateDecision = "allow-once";
    await a2ui.callLocalRpc(
      "review_card",
      "commitWorkspaceWrite",
      { path: "plan.md", content: "# Draft v2\nApproved.\n" },
      { userActivated: true }
    );
    expect(await ws.readFile("plan.md")).toBe("# Draft v2\nApproved.\n");

    const stateAfterWrite = swarm.getState(MAIN_THREAD_ID)!;
    const writeItem = stateAfterWrite.items.find((item) => item.kind === "write");
    expect(writeItem).toBeDefined();
    expect(writeItem?.write?.path).toBe("plan.md");
    expect(writeItem?.write?.reverted).toBe(false);

    const reverted = await swarm.revertWrite(MAIN_THREAD_ID, writeItem!.id);
    expect(reverted).toBe(true);
    expect(await ws.readFile("plan.md")).toBe("# Draft v1\n");

    swarm.dispose();
  });
});
