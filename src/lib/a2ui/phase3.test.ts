import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { A2uiExpressionError, DataContext, DataModel } from "@a2ui/web_core/v1_0";
import { SessionPermissionStore } from "../chat-permissions";
import { i18n } from "../i18n";
import {
  buildMcpToolset,
  formatMcpCallResultForAssistant,
  McpConnection,
  type McpRawToolResult
} from "../mcp-client";
import type { McpConnectedServer } from "../mcp-registry";
import { MemoryTextStore } from "../opfs-kv";
import { TicketBoard } from "../tickets";
import { createHatchlingToolExecutor } from "../tool-router";
import { createWorkspaceStore } from "../workspace";
import { WASMHATCH_CONNECTORS_CATALOG_ID } from "./connectors-catalog";
import { MCP_APP_HTML_MIME, serializeSafeJsonForHtml } from "./export-mcp-app";
import { compileJmesPath, searchJmesPath } from "./jmespath";
import {
  createProxyOriginGuard,
  MAX_MCP_APP_HEIGHT,
  McpAppHostBridge,
  MIN_MCP_APP_HEIGHT,
  resolveMcpSandboxConfig,
  validateMcpJsonRpcPayload
} from "./mcp-app-bridge";
import { analyzeA2uiRegex } from "./mcp-catalog";
import type {
  GooglePickerRpcResult,
  GoogleSheetCommitResult,
  GoogleSheetRollbackResult,
  SlackPreviewSendResult
} from "./rpc-functions";
import { HatchlingA2uiRuntime } from "./runtime";

describe("WasmHatch A2UI Phase 3: 4-Way MCP Integration, Connectors Catalog & Universal HTML Exporter", () => {
  beforeEach(() => {
    i18n.load("en", {});
    i18n.activate("en");
    const storage = new Map<string, string>();
    vi.stubGlobal("navigator", {});
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
      clear: () => storage.clear()
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("Pattern 1a: evaluates CSP-safe JMESPath expressions, enforces prototype-pollution guards, and throws A2uiExpressionError on invalid syntax", () => {
    const sample = {
      orders: [
        { id: "o-1", region: "APAC", amount: 180, active: true, tags: ["enterprise", "q4"] },
        { id: "o-2", region: "EMEA", amount: 45, active: false, tags: ["smb"] },
        { id: "o-3", region: "APAC", amount: 320, active: true, tags: ["enterprise"] }
      ],
      meta: { currency: "USD" }
    };

    expect(
      searchJmesPath(sample, "orders[?active && amount >= `100`] | sort_by(@, &amount)[].id")
    ).toEqual(["o-1", "o-3"]);

    expect(
      searchJmesPath(
        sample,
        "{total: sum(orders[?active].amount), avgAmount: avg(orders[].amount), tags: orders[].tags[], label: join(', ', orders[].region)}"
      )
    ).toEqual({
      total: 500,
      avgAmount: (180 + 45 + 320) / 3,
      tags: ["enterprise", "q4", "smb", "enterprise"],
      label: "APAC, EMEA, APAC"
    });

    // Cached second compilation returns exact same AST object and identical result.
    expect(compileJmesPath("meta.currency")).toBe(compileJmesPath("meta.currency"));
    expect(searchJmesPath(sample, "meta.currency")).toBe("USD");

    // Prototype pollution properties are rejected at compile/eval time with A2uiExpressionError.
    expect(() => searchJmesPath(sample, "__proto__")).toThrow(A2uiExpressionError);
    expect(() => searchJmesPath(sample, "orders[0].constructor")).toThrow(A2uiExpressionError);
    expect(() => searchJmesPath(sample, "meta.prototype")).toThrow(A2uiExpressionError);

    expect(() => searchJmesPath(sample, "orders[?amount >")).toThrow(A2uiExpressionError);
    expect(() => searchJmesPath(sample, "unknown_fn(orders)")).toThrow(A2uiExpressionError);
  });

  it("Pattern 1b: executes transformData, atomic updateDataModel, astral-safe split, and ReDoS-hardened regexCapture inside A2UI surfaces", () => {
    const runtime = new HatchlingA2uiRuntime();
    const compiled = runtime.applyWholeResponse(
      [
        "<a2ui>",
        'surface("mcp_fns_surface")',
        't = Text("Summary")',
        "root = Card(t)",
        "</a2ui>"
      ].join("\n"),
      "cloud"
    );
    expect(compiled.errors).toEqual([]);
    const surface = runtime.renderer.getSurface("mcp_fns_surface")!;
    expect(surface).toBeDefined();
    const ctx = new DataContext(surface, "/");

    const updateDataModelFn = runtime.mcpCatalog.functions.get("updateDataModel")!;
    const transformDataFn = runtime.mcpCatalog.functions.get("transformData")!;
    const splitFn = runtime.mcpCatalog.functions.get("split")!;
    const regexFn = runtime.mcpCatalog.functions.get("regexCapture")!;

    // Atomic updateDataModel writes multiple paths cleanly.
    const okWrite = updateDataModelFn.execute(
      {
        updates: {
          "/summary": "Ready",
          "/metrics/items": [
            { name: "Alpha", score: 10 },
            { name: "Beta", score: 30 }
          ]
        }
      },
      ctx
    );
    expect(okWrite).toBe(true);
    expect(surface.dataModel.get("/summary")).toBe("Ready");

    // Prototype-pollution key rejects the entire batch atomically without mutating prior paths.
    expect(() =>
      updateDataModelFn.execute(
        {
          updates: {
            "/summary": "ShouldNotCommit",
            "/__proto__/polluted": "evil"
          }
        },
        ctx
      )
    ).toThrow(A2uiExpressionError);
    expect(surface.dataModel.get("/summary")).toBe("Ready");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();

    // transformData via MCP catalog function
    const transformed = transformDataFn.execute(
      {
        jmespath: "sum([].score)",
        data: surface.dataModel.get("/metrics/items")
      },
      ctx
    );
    expect(transformed).toBe(40);

    // split handles empty-string Unicode code-point splitting (emoji surrogate pairs intact)
    expect(splitFn.execute({ value: "🧪🚀A", separator: "" }, ctx)).toEqual(["🧪", "🚀", "A"]);
    expect(splitFn.execute({ value: ["a:b", "c:d"], separator: ":" }, ctx)).toEqual([
      ["a", "b"],
      ["c", "d"]
    ]);

    // regexCapture extracts groups, maps unmatched optional groups to "", and rejects ReDoS / backreferences
    expect(
      regexFn.execute(
        { value: "INV-2026-042", pattern: "^INV-(\\d{4})(?:-(\\d+))?(?:-([A-Z]+))?$" },
        ctx
      )
    ).toEqual(["2026", "042", ""]);

    expect(analyzeA2uiRegex("(a+)+$").ok).toBe(false);
    expect(analyzeA2uiRegex("([a-z]+)\\1").ok).toBe(false);
    expect(analyzeA2uiRegex("(?<=foo)bar").ok).toBe(false);
    expect(() => regexFn.execute({ value: "aaaa!", pattern: "(a+)+$" }, ctx)).toThrow(
      A2uiExpressionError
    );

    runtime.dispose();
  });

  it("Pattern 1c: callMcpTool enforces capability & Careful PermissionGate and guards targetDataPath against out-of-order race conditions", async () => {
    const resolvers = new Map<string, (res: McpRawToolResult) => void>();
    const callToolRaw = vi.fn(
      (toolName: string, args: Record<string, unknown>) =>
        new Promise<McpRawToolResult>((resolve) => {
          const key = `${toolName}:${String(args.query ?? "")}`;
          resolvers.set(key, resolve);
        })
    );

    const tools = [
      {
        name: "search_metrics",
        description: "Read-only search",
        inputSchema: { type: "object" },
        readOnlyHint: true
      },
      {
        name: "mutate_record",
        description: "Mutating write tool",
        inputSchema: { type: "object" },
        readOnlyHint: false
      }
    ];
    const toolset = buildMcpToolset("analytics", "Analytics MCP", tools);
    const connectedServer: McpConnectedServer = {
      server: {
        id: "analytics",
        label: "Analytics MCP",
        url: "https://mcp.example.test/rpc",
        auth: "none",
        loopback: false
      },
      url: "https://mcp.example.test/rpc",
      toolset,
      tools,
      error: null,
      connection: {
        initialize: vi.fn(),
        listTools: vi.fn(async () => tools),
        callTool: vi.fn(),
        callToolRaw,
        close: vi.fn()
      }
    };

    let capabilities: string[] | null = null;
    let writePolicy: "autonomous" | "careful" = "careful";
    const permissions = new SessionPermissionStore();
    const gate = vi.fn(async () => "allow-once" as const);

    const runtime = new HatchlingA2uiRuntime({
      getCapabilities: () => capabilities,
      getWritePolicy: () => writePolicy,
      permissions,
      gate,
      getActiveMcpServers: () => [connectedServer]
    });

    const compiled = runtime.applyWholeResponse(
      ['<a2ui>', 'surface("mcp_race_surface")', 't = Text("Dashboard")', 'root = Card(t)', '</a2ui>'].join("\n"),
      "cloud"
    );
    expect(compiled.errors).toEqual([]);
    const surface = runtime.renderer.getSurface("mcp_race_surface")!;
    const ctx = new DataContext(surface, "/");
    const callMcpToolFn = runtime.mcpCatalog.functions.get("callMcpTool")!;

    // 1. Out-of-order race test on read-only tool (should NOT trigger PermissionGate even in Careful mode)
    const call1 = Promise.resolve(
      callMcpToolFn.execute(
        {
          name: "search_metrics",
          arguments: { query: "slow-first" },
          targetDataPath: "/searchResult"
        },
        ctx
      )
    );
    const call2 = Promise.resolve(
      callMcpToolFn.execute(
        {
          name: "search_metrics",
          arguments: { query: "fast-second" },
          targetDataPath: "/searchResult"
        },
        ctx
      )
    );

    await vi.waitFor(() => {
      expect(resolvers.has("search_metrics:slow-first")).toBe(true);
      expect(resolvers.has("search_metrics:fast-second")).toBe(true);
    });
    expect(gate).not.toHaveBeenCalled();

    // Resolve call #2 FIRST, then stale call #1 SECOND
    resolvers.get("search_metrics:fast-second")!({
      content: [{ type: "text", text: JSON.stringify({ rows: ["fresh"] }) }],
      isError: false
    });
    await call2;
    expect((surface.dataModel.get("/searchResult") as { json: unknown }).json).toEqual({
      rows: ["fresh"]
    });

    resolvers.get("search_metrics:slow-first")!({
      content: [{ type: "text", text: JSON.stringify({ rows: ["stale"] }) }],
      isError: false
    });
    await call1;
    // Stale call #1 MUST NOT overwrite fresh call #2 at `/searchResult`!
    expect((surface.dataModel.get("/searchResult") as { json: unknown }).json).toEqual({
      rows: ["fresh"]
    });

    // 2. Non-readOnly tool triggers Careful-mode PermissionGate
    const mutatePromise = Promise.resolve(
      callMcpToolFn.execute(
        {
          name: "mutate_record",
          arguments: { query: "write-op" },
          targetDataPath: "/writeResult"
        },
        ctx
      )
    );
    await vi.waitFor(() => {
      expect(resolvers.has("mutate_record:write-op")).toBe(true);
    });
    expect(gate).toHaveBeenCalledTimes(1);
    resolvers.get("mutate_record:write-op")!({
      content: [{ type: "text", text: '{"updated":true}' }],
      isError: false
    });
    await mutatePromise;

    // 3. Disabling `mcp` capability fails closed immediately
    capabilities = ["artifacts"];
    await expect(
      Promise.resolve(
        callMcpToolFn.execute({ name: "search_metrics", arguments: { query: "blocked" } }, ctx)
      )
    ).rejects.toThrow(/capability 'mcp' is disabled/);

    writePolicy = "autonomous";
    runtime.dispose();
  });

  it("Pattern 2: advertises capabilities.a2ui, caches resources/read for a2ui:// & ui:// URIs, mounts surfaces, and strips user-only blocks from assistant context", async () => {
    const sentRequests: Array<{ method: string; params?: Record<string, unknown> }> = [];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        id?: number;
        method: string;
        params?: Record<string, unknown>;
      };
      sentRequests.push({ method: body.method, params: body.params });
      if (body.method === "initialize") {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            result: {
              protocolVersion: "2025-06-18",
              serverInfo: { name: "Demo UI MCP", version: "1.0.0" },
              capabilities: { tools: {}, resources: {} }
            }
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (body.method === "notifications/initialized") {
        return new Response(null, { status: 202 });
      }
      if (body.method === "tools/list") {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            result: {
              tools: [
                {
                  name: "render_kpi_panel",
                  description: "Renders interactive KPI UI",
                  inputSchema: { type: "object" },
                  annotations: { readOnlyHint: true },
                  _meta: { ui: { resourceUri: "a2ui://kpi-template" } }
                }
              ]
            }
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (body.method === "resources/read") {
        const uri = body.params?.uri;
        if (uri === "a2ui://kpi-template") {
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: body.id,
              result: {
                contents: [
                  {
                    uri: "a2ui://kpi-template",
                    mimeType: "application/a2ui+json",
                    text: JSON.stringify([
                      {
                        version: "1.0",
                        createSurface: {
                          surfaceId: "mcp_kpi_surface",
                          catalogId: "https://a2ui.org/specification/v1_0/catalogs/basic/catalog.json"
                        }
                      },
                      {
                        version: "1.0",
                        updateComponents: {
                          surfaceId: "mcp_kpi_surface",
                          components: [
                            { id: "root", component: "Card", child: "headline" },
                            { id: "headline", component: "Text", text: "ARR: $4.2M" }
                          ]
                        }
                      }
                    ])
                  }
                ]
              }
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        if (uri === "ui://chart-widget") {
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: body.id,
              result: {
                contents: [
                  {
                    uri: "ui://chart-widget",
                    mimeType: "text/html;profile=mcp-app",
                    text: "<!doctype html><html><body><h1>Embedded MCP Widget</h1></body></html>",
                    _meta: {
                      ui: {
                        csp: { connectDomains: ["https://api.example.test"] },
                        permissions: { clipboardWrite: true }
                      }
                    }
                  }
                ]
              }
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
      }
      if (body.method === "tools/call") {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            result: {
              content: [
                {
                  type: "text",
                  text: "Compact summary for model: ARR=$4.2M (+18% YoY).",
                  annotations: { audience: ["assistant"] }
                },
                {
                  type: "text",
                  text: "LONG_USER_ONLY_MARKDOWN_TABLE_THAT_SHOULD_NOT_CONSUME_LLM_CONTEXT",
                  annotations: { audience: ["user"] }
                },
                {
                  type: "resource_link",
                  uri: "ui://chart-widget",
                  mimeType: "text/html;profile=mcp-app"
                }
              ],
              _meta: {
                ui: { resourceUri: "a2ui://kpi-template" }
              }
            }
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      throw new Error(`Unexpected method: ${body.method}`);
    });

    const conn = new McpConnection({
      url: "https://mcp.example.test/rpc",
      fetchImpl: fetchMock as unknown as typeof fetch
    });
    await conn.initialize();

    const initReq = sentRequests.find((r) => r.method === "initialize");
    expect(initReq?.params?.capabilities).toMatchObject({
      a2ui: {
        version: "1.0",
        acceptsInlineCatalogs: false,
        mimeTypes: ["application/a2ui+json", "text/html;profile=mcp-app"]
      }
    });

    const listedTools = await conn.listTools();
    expect(listedTools[0]?.uiResourceUris).toEqual(["a2ui://kpi-template"]);
    expect(listedTools[0]?.readOnlyHint).toBe(true);

    const toolset = buildMcpToolset("demo", "Demo UI MCP", listedTools);
    const server: McpConnectedServer = {
      server: {
        id: "demo",
        label: "Demo UI MCP",
        url: "https://mcp.example.test/rpc",
        auth: "none",
        loopback: false
      },
      url: "https://mcp.example.test/rpc",
      toolset,
      tools: listedTools,
      error: null,
      connection: conn
    };

    const runtime = new HatchlingA2uiRuntime({
      getActiveMcpServers: () => [server]
    });
    const workspace = createWorkspaceStore({
      working: "mem-phase3-working",
      baseline: "mem-phase3-baseline"
    });
    const executeTool = createHatchlingToolExecutor({
      threadId: "main",
      workspace,
      permissions: new SessionPermissionStore(),
      gate: async () => "allow-once",
      policy: () => "autonomous",
      onAppliedWrite: () => undefined,
      onArtifact: () => undefined,
      tickets: new TicketBoard(new MemoryTextStore()),
      google: { getToken: async () => "unused" },
      mcpServers: [server],
      recordJournal: () => undefined,
      onMcpUiResult: async ({ server: srv, tool, args, raw, signal }) => {
        const ingested = await runtime.ingestMcpToolResult({
          server: srv,
          toolName: tool,
          toolArgs: args,
          rawResult: raw,
          signal
        });
        return ingested.assistantNote;
      }
    });

    // Execute twice to verify `resources/read` LRU cache deduplication
    const toolName = toolset.definitions[0]!.name;
    const firstOutcome = await executeTool(toolName, { period: "2026-Q4" }, {});
    const secondOutcome = await executeTool(toolName, { period: "2026-Q4" }, {});

    expect(firstOutcome.isError).toBeFalsy();
    expect(firstOutcome.content).toContain("Compact summary for model: ARR=$4.2M (+18% YoY).");
    expect(firstOutcome.content).not.toContain(
      "LONG_USER_ONLY_MARKDOWN_TABLE_THAT_SHOULD_NOT_CONSUME_LLM_CONTEXT"
    );
    expect(firstOutcome.content).not.toContain("ui://chart-widget");
    expect(firstOutcome.content).toContain("[Rendered interactive UI for the user:");
    expect(secondOutcome.content).toContain("Compact summary for model");

    // Both the A2UI surface (`mcp_kpi_surface`) and the `McpApp` Canvas surface (`canvas_mcp_render_kpi_panel`) mounted!
    expect(runtime.renderer.getSurface("mcp_kpi_surface")).toBeDefined();
    expect(runtime.renderer.getSurface("canvas_mcp_render_kpi_panel")).toBeDefined();

    // `resources/read` was invoked once for `a2ui://kpi-template` and once for `ui://chart-widget` despite 2 tool calls!
    const resourceReads = sentRequests.filter((r) => r.method === "resources/read");
    expect(resourceReads).toHaveLength(2);

    // Direct check on `formatMcpCallResultForAssistant`
    const formatted = formatMcpCallResultForAssistant(
      {
        content: [
          { type: "text", text: "For both", annotations: { audience: ["user", "assistant"] } },
          { type: "text", text: "User secret UI block", annotations: { audience: ["user"] } }
        ],
        isError: false
      },
      { stripUserOnlyBlocks: true, uiNote: "[UI ready]" }
    );
    expect(formatted.content).toBe("For both\n[UI ready]");

    runtime.dispose();
  });

  it("Pattern 3a: resolves null-origin vs VITE_USERCONTENT_ORIGIN sandbox config, pins Origin.from(event), and rejects unsafe JSON-RPC payloads", () => {
    const zeroConfig = resolveMcpSandboxConfig({
      usercontentOrigin: "",
      hostOrigin: "https://wasmhatch.app",
      baseUrl: "/"
    });
    expect(zeroConfig).toEqual({
      mode: "null-origin",
      proxyUrl: "/a2ui-mcp-sandbox.html?hostOrigin=https%3A%2F%2Fwasmhatch.app",
      targetOrigin: "*",
      outerSandbox: "allow-scripts"
    });

    const isolated = resolveMcpSandboxConfig({
      usercontentOrigin: "https://usercontent.wasmhatch.dev/ignored-path",
      hostOrigin: "https://wasmhatch.app",
      baseUrl: "/"
    });
    expect(isolated).toEqual({
      mode: "isolated-origin",
      proxyUrl:
        "https://usercontent.wasmhatch.dev/a2ui-mcp-sandbox.html?hostOrigin=https%3A%2F%2Fwasmhatch.app",
      targetOrigin: "https://usercontent.wasmhatch.dev",
      outerSandbox: "allow-scripts allow-same-origin"
    });

    // Rejects accidental same-origin usercontent domain -> falls back safely to null-origin!
    const accidentalSameOrigin = resolveMcpSandboxConfig({
      usercontentOrigin: "https://wasmhatch.app",
      hostOrigin: "https://wasmhatch.app",
      baseUrl: "/"
    });
    expect(accidentalSameOrigin.mode).toBe("null-origin");
    expect(accidentalSameOrigin.outerSandbox).toBe("allow-scripts");

    // Test Origin API opaque-origin pinning via `Origin.from(event)` mock
    const proxyWin = { postMessage: vi.fn() };
    const otherWin = { postMessage: vi.fn() };
    const opaqueTokenA = {
      opaque: true,
      isSameOrigin(other: unknown) {
        return other === opaqueTokenA;
      }
    };
    const opaqueTokenB = {
      opaque: true,
      isSameOrigin(other: unknown) {
        return other === opaqueTokenB;
      }
    };
    vi.stubGlobal(
      "Origin",
      Object.assign(function OriginStub() {}, {
        from: (ev: { _token?: unknown }) => {
          if (!ev._token) throw new TypeError("Not a native MessageEvent");
          return ev._token;
        },
        parse: (url: string) => ({
          opaque: false,
          isSameOrigin: (other: { _url?: string }) => other._url === url
        })
      })
    );

    const guard = createProxyOriginGuard(proxyWin, zeroConfig);
    expect(guard({ source: otherWin, origin: "null", data: {} })).toBe(false);
    expect(
      guard({ source: proxyWin, origin: "null", data: {}, _token: opaqueTokenA } as never)
    ).toBe(true);
    // A different opaque origin spoofing the reference is rejected!
    expect(
      guard({ source: proxyWin, origin: "null", data: {}, _token: opaqueTokenB } as never)
    ).toBe(false);

    // Payload validator checks depth <= 10, <= 64KB, and __proto__/constructor/prototype keys
    const poisoned = JSON.parse(
      '{"jsonrpc":"2.0","method":"ui/initialize","params":{"__proto__":{"polluted":true}}}'
    ) as unknown;
    const poisonedRes = validateMcpJsonRpcPayload(poisoned);
    expect(poisonedRes.ok).toBe(false);

    let deep: Record<string, unknown> = { leaf: "x" };
    for (let i = 0; i < 12; i += 1) {
      deep = { child: deep };
    }
    expect(
      validateMcpJsonRpcPayload({ jsonrpc: "2.0", method: "ui/initialize", params: deep }).ok
    ).toBe(false);

    expect(
      validateMcpJsonRpcPayload({
        jsonrpc: "2.0",
        method: "ui/initialize",
        params: { huge: "x".repeat(70_000) }
      }).ok
    ).toBe(false);
  });

  it("Pattern 3b: McpAppHostBridge drives full JSON-RPC 2.0 handshake, two-way data.paths sync, and allowlisted tool/function calls", async () => {
    const outbox: Array<{ message: Record<string, unknown>; targetOrigin: string }> = [];
    const proxyWindow = {
      postMessage: (message: unknown, targetOrigin: string) => {
        outbox.push({ message: message as Record<string, unknown>, targetOrigin });
      }
    };
    const dataModel = new DataModel({
      filters: { region: "APAC", limit: 25 },
      secret: { apiKey: "never-exposed" }
    });
    const heights: number[] = [];
    const openedUrls: string[] = [];
    const followUps: string[] = [];
    const statuses: string[] = [];

    const sandboxConfig = resolveMcpSandboxConfig({
      usercontentOrigin: "https://usercontent.wasmhatch.dev",
      hostOrigin: "https://wasmhatch.app"
    });

    const bridge = new McpAppHostBridge({
      componentId: "chart-app-1",
      resourceUri: "ui://analytics/chart",
      html: "<!doctype html><html><body>App</body></html>",
      sandboxConfig,
      proxyWindow,
      dataModel,
      dataPaths: { filters: "/filters" },
      toolInput: { metric: "revenue" },
      toolResult: { content: [{ type: "text", text: "ok" }] },
      allowedTools: ["refresh_revenue"],
      allowedFunctions: {
        computeTax: {
          type: "object",
          required: ["amount"],
          properties: {
            amount: { type: "number", minimum: 0, maximum: 10_000 }
          },
          additionalProperties: false
        }
      },
      csp: { connectDomains: ["https://api.example.test"] },
      permissions: { clipboardWrite: true },
      onHeightChange: (h) => heights.push(h),
      onOpenLink: (url) => {
        openedUrls.push(url);
        return true;
      },
      onMessage: (text) => {
        followUps.push(text);
      },
      onStatusChange: (st) => statuses.push(st),
      callMcpTool: async (name, args) => ({ echoedTool: name, echoedArgs: args }),
      callCatalogFunction: async (_name, args) => Number(args.amount) * 0.1
    });

    const sendFromProxy = (data: Record<string, unknown>) =>
      bridge.handleWindowMessage({
        source: proxyWindow,
        origin: "https://usercontent.wasmhatch.dev",
        data
      });

    // Spoofed origin is ignored completely
    const spoofed = await bridge.handleWindowMessage({
      source: proxyWindow,
      origin: "https://evil.example.com",
      data: { jsonrpc: "2.0", method: "ui/notifications/sandbox-proxy-ready" }
    });
    expect(spoofed).toBe(false);
    expect(outbox).toHaveLength(0);

    // 1. Proxy ready -> host sends sandbox-resource-ready with HTML, CSP, and permissions
    await sendFromProxy({ jsonrpc: "2.0", method: "ui/notifications/sandbox-proxy-ready" });
    expect(outbox[0]?.targetOrigin).toBe("https://usercontent.wasmhatch.dev");
    expect(outbox[0]?.message).toMatchObject({
      method: "ui/notifications/sandbox-resource-ready",
      params: {
        html: "<!doctype html><html><body>App</body></html>",
        csp: { connectDomains: ["https://api.example.test"] },
        permissions: { clipboardWrite: true }
      }
    });

    // 2. Guest `ui/initialize` -> host capabilities include `a2uiDataModel`
    await sendFromProxy({ jsonrpc: "2.0", id: 1, method: "ui/initialize", params: {} });
    expect(outbox[1]?.message).toMatchObject({
      id: 1,
      result: {
        hostCapabilities: {
          a2uiDataModel: { twoWay: true, paths: ["filters"] }
        }
      }
    });

    // 3. Guest `ui/notifications/initialized` -> pushes initial data snapshot, toolInput, and toolResult
    await sendFromProxy({ jsonrpc: "2.0", method: "ui/notifications/initialized" });
    expect(statuses).toContain("ready");
    const methodsAfterInit = outbox.map((entry) => entry.message.method);
    expect(methodsAfterInit).toContain("ui/notifications/data-model-update");
    expect(methodsAfterInit).toContain("ui/notifications/tool-input");
    expect(methodsAfterInit).toContain("ui/notifications/tool-result");

    // 4. Host DataModel mutation -> pushes `ui/notifications/data-model-update` to guest
    const countBeforeHostUpdate = outbox.length;
    dataModel.set("/filters/region", "EMEA");
    expect(outbox.length).toBeGreaterThan(countBeforeHostUpdate);
    expect(outbox[outbox.length - 1]?.message).toMatchObject({
      method: "ui/notifications/data-model-update",
      params: {
        data: { filters: { region: "EMEA", limit: 25 } },
        changedKeys: ["filters"]
      }
    });

    // 5. Guest `ui/notifications/data-model-change` -> updates bound `/filters/limit` and rejects unbound `/secret/apiKey`
    await sendFromProxy({
      jsonrpc: "2.0",
      method: "ui/notifications/data-model-change",
      params: { key: "filters", subpath: "/limit", value: 100 }
    });
    expect(dataModel.get("/filters/limit")).toBe(100);

    await sendFromProxy({
      jsonrpc: "2.0",
      method: "ui/notifications/data-model-change",
      params: { path: "/secret/apiKey", value: "hijacked" }
    });
    expect(dataModel.get("/secret/apiKey")).toBe("never-exposed");

    // 6. `tools/call` allowlist enforcement
    await sendFromProxy({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "drop_production_db", arguments: {} }
    });
    expect(outbox[outbox.length - 1]?.message).toMatchObject({
      id: 2,
      error: { code: -32601 }
    });

    await sendFromProxy({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "refresh_revenue", arguments: { year: 2026 } }
    });
    expect(outbox[outbox.length - 1]?.message).toMatchObject({
      id: 3,
      result: { echoedTool: "refresh_revenue", echoedArgs: { year: 2026 } }
    });

    // 7. `ui/requests/function-call` allowlist + JSON Schema validation
    await sendFromProxy({
      jsonrpc: "2.0",
      id: 4,
      method: "ui/requests/function-call",
      params: { call: "computeTax", args: { amount: -50 } }
    });
    expect(outbox[outbox.length - 1]?.message).toMatchObject({
      id: 4,
      error: { code: -32602 }
    });

    await sendFromProxy({
      jsonrpc: "2.0",
      id: 5,
      method: "ui/requests/function-call",
      params: { call: "computeTax", args: { amount: 250 } }
    });
    expect(outbox[outbox.length - 1]?.message).toMatchObject({
      id: 5,
      result: { status: "success", result: 25, value: 25 }
    });

    // 8. Size clamping, link scheme validation, and follow-up message
    await sendFromProxy({
      jsonrpc: "2.0",
      method: "ui/notifications/size-changed",
      params: { height: 20 }
    });
    await sendFromProxy({
      jsonrpc: "2.0",
      method: "ui/notifications/size-changed",
      params: { height: 9_999 }
    });
    expect(heights).toEqual([MIN_MCP_APP_HEIGHT, MAX_MCP_APP_HEIGHT]);

    await sendFromProxy({
      jsonrpc: "2.0",
      id: 6,
      method: "ui/open-link",
      params: { url: "javascript:alert(1)" }
    });
    expect(outbox[outbox.length - 1]?.message).toMatchObject({
      id: 6,
      error: { code: -32602 }
    });
    expect(openedUrls).toHaveLength(0);

    await sendFromProxy({
      jsonrpc: "2.0",
      id: 7,
      method: "ui/open-link",
      params: { url: "https://example.com/report" }
    });
    expect(openedUrls).toEqual(["https://example.com/report"]);

    await sendFromProxy({
      jsonrpc: "2.0",
      id: 8,
      method: "ui/message",
      params: { content: { type: "text", text: "Drill into APAC Q4 churn" } }
    });
    expect(followUps).toEqual(["Drill into APAC Q4 churn"]);

    bridge.dispose();
  });

  it("Pattern 4: exports any A2UI surface + live DataModel as a self-contained offline Universal MCP App HTML file with XSS-safe JSON escaping", () => {
    const runtime = new HatchlingA2uiRuntime();
    const compiled = runtime.applyWholeResponse(
      [
        "<a2ui>",
        'surface("rev_calc")',
        'heading = Text("# Revenue Calculator")',
        'seatsSlider = Slider("Seats", 1, 500, $/seats)',
        'companyField = TextField("Company", $/company)',
        "root = Card(Column([heading, seatsSlider, companyField]))",
        "</a2ui>"
      ].join("\n"),
      "cloud"
    );
    expect(compiled.errors).toEqual([]);
    const surface = runtime.renderer.getSurface("rev_calc")!;

    // Inject live DataModel state including a `</script>` breakout attempt!
    surface.dataModel.set("/seats", 42);
    surface.dataModel.set("/company", "Acme </script><script>alert('xss')</script> Corp");

    const exported = runtime.exportSurfaceHtml("rev_calc");
    expect(exported).not.toBeNull();
    expect(exported!.fileName).toBe("revenue-calculator.mcp-app.html");
    expect(exported!.html).toContain("<!doctype html>");
    expect(exported!.html).toContain(`(${MCP_APP_HTML_MIME})`);
    expect(exported!.html).toContain("default-src 'none'");
    expect(exported!.html).toContain("connect-src 'none'");

    // Must never contain raw `</script><script>alert` breakout!
    expect(exported!.html).not.toContain("</script><script>alert");
    expect(serializeSafeJsonForHtml({ x: "</script>&" })).toBe(
      '{"x":"\\u003c/script\\u003e\\u0026"}'
    );

    // Speaks standard MCP Apps (`ui://`) JSON-RPC 2.0 guest protocol AND standalone bindings
    expect(exported!.html).toContain('"ui/initialize"');
    expect(exported!.html).toContain('"ui/notifications/initialized"');
    expect(exported!.html).toContain('"ui/notifications/data-model-change"');
    expect(exported!.html).toContain('"ui/notifications/data-model-update"');

    runtime.dispose();
  });

  it("wasmhatch:connectors:v1: prunes connector components dynamically and executes Google Sheets commit + 1-click rollback, Google Picker handover, and Slack preview send", async () => {
    let googleConnected = false;
    let slackWebhookUrl = "";
    const permissions = new SessionPermissionStore();
    const gate = vi.fn(async () => "allow-once" as const);

    const sheetStore = new Map<string, string[][]>();
    const spreadsheetId = "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
    sheetStore.set(`${spreadsheetId}:Sheet1!A1:B2`, [
      ["Quarter", "ARR"],
      ["Q3", "3800000"]
    ]);

    const googleFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "GET" && url.includes(`/spreadsheets/${spreadsheetId}/values/`)) {
        return new Response(
          JSON.stringify({
            range: "Sheet1!A1:B2",
            values: sheetStore.get(`${spreadsheetId}:Sheet1!A1:B2`) ?? []
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (method === "PUT" && url.includes(`/spreadsheets/${spreadsheetId}/values/`)) {
        const parsed = JSON.parse(String(init?.body ?? "{}")) as { values: string[][] };
        sheetStore.set(`${spreadsheetId}:Sheet1!A1:B2`, parsed.values);
        const cellCount = parsed.values.reduce((sum, row) => sum + row.length, 0);
        return new Response(JSON.stringify({ updatedCells: cellCount }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
      return new Response("Not Found", { status: 404 });
    });

    const slackPosts: string[] = [];
    const slackFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      slackPosts.push(String(init?.body ?? ""));
      return new Response("ok", { status: 200 });
    });

    const runtime = new HatchlingA2uiRuntime({
      getWritePolicy: () => "careful",
      permissions,
      gate,
      google: {
        isConnected: () => googleConnected,
        getToken: async () => "ya29.test-token",
        requestFilePick: async () => [
          {
            id: spreadsheetId,
            name: "FY26 Forecast",
            mimeType: "application/vnd.google-apps.spreadsheet",
            kind: "spreadsheet"
          }
        ],
        fetchImpl: googleFetch as unknown as typeof fetch
      },
      slack: {
        getWebhookUrl: () => slackWebhookUrl,
        fetchImpl: slackFetch as unknown as typeof fetch
      }
    });

    // 1. When Google & Slack are disconnected, connector components are dynamically pruned from the compiler!
    const rejectedWhenDisconnected = runtime.applyWholeResponse(
      [
        "<a2ui>",
        'surface("disconnected_sheet")',
        `root = GoogleSheetRangeCard("${spreadsheetId}", "Sheet1!A1:B2", [["A", "B"]])`,
        "</a2ui>"
      ].join("\n"),
      "cloud"
    );
    expect(rejectedWhenDisconnected.errors.length).toBeGreaterThan(0);

    // 2. Once Google & Slack are connected, all 3 connector components compile cleanly!
    googleConnected = true;
    slackWebhookUrl = "https://hooks.slack.com/services/T001TEST/B002TEST/SecretToken123";

    const compiled = runtime.applyWholeResponse(
      [
        "<a2ui>",
        'surface("connected_connectors")',
        `sheetCard = GoogleSheetRangeCard("${spreadsheetId}", "Sheet1!A1:B2", [["Quarter", "ARR"], ["Q4", "4200000"]])`,
        'pickerCard = GooglePickerHandoverCard(reason="Pick Q4 sheet", targetPath="/picked")',
        'slackCard = SlackMessagePreviewCard("Q4 ARR hit *4.2M*!")',
        "root = Column([sheetCard, pickerCard, slackCard])",
        "</a2ui>"
      ].join("\n"),
      "cloud"
    );
    expect(compiled.errors).toEqual([]);
    const surface = runtime.renderer.getSurface("connected_connectors")!;
    expect(surface.componentsModel.get("sheetCard")?.catalog.id).toBe(
      WASMHATCH_CONNECTORS_CATALOG_ID
    );
    expect(surface.componentsModel.get("pickerCard")?.catalog.id).toBe(
      WASMHATCH_CONNECTORS_CATALOG_ID
    );
    expect(surface.componentsModel.get("slackCard")?.catalog.id).toBe(
      WASMHATCH_CONNECTORS_CATALOG_ID
    );

    // 3. Rejects passive / non-user-activated invocations over `callAgentFunction`
    await expect(
      runtime.callLocalRpc(
        "connected_connectors",
        "commitGoogleSheetValues",
        {
          spreadsheetId,
          range: "Sheet1!A1:B2",
          values: [["Quarter", "ARR"]]
        },
        { userActivated: false }
      )
    ).rejects.toThrow(/explicit user gesture/);

    // 4. User-activated `commitGoogleSheetValues` snapshots prior cells, passes Careful gate, writes new values, and rolls back in 1 click!
    const commitRes = await runtime.callLocalRpc<GoogleSheetCommitResult>(
      "connected_connectors",
      "commitGoogleSheetValues",
      {
        spreadsheetId,
        range: "Sheet1!A1:B2",
        values: [
          ["Quarter", "ARR"],
          ["Q4", "4200000"]
        ]
      },
      { userActivated: true }
    );
    expect(commitRes.status).toBe("updated");
    expect(commitRes.updatedCells).toBe(4);
    expect(commitRes.rollbackId).toMatch(/^sheet_rb_/);
    expect(sheetStore.get(`${spreadsheetId}:Sheet1!A1:B2`)).toEqual([
      ["Quarter", "ARR"],
      ["Q4", "4200000"]
    ]);

    const rollbackRes = await runtime.callLocalRpc<GoogleSheetRollbackResult>(
      "connected_connectors",
      "rollbackGoogleSheetValues",
      { rollbackId: commitRes.rollbackId },
      { userActivated: true }
    );
    expect(rollbackRes.status).toBe("reverted");
    expect(rollbackRes.range).toBe("Sheet1!A1:B2");
    expect(sheetStore.get(`${spreadsheetId}:Sheet1!A1:B2`)).toEqual([
      ["Quarter", "ARR"],
      ["Q3", "3800000"]
    ]);

    // 5. `pickGoogleDriveFiles` populates `/picked` on the live surface DataModel
    const pickedRes = await runtime.callLocalRpc<GooglePickerRpcResult>(
      "connected_connectors",
      "pickGoogleDriveFiles",
      { reason: "Pick Q4 sheet", targetPath: "/picked" },
      { userActivated: true }
    );
    expect(pickedRes.cancelled).toBe(false);
    expect(pickedRes.picked).toHaveLength(1);
    expect(surface.dataModel.get("/picked")).toMatchObject([
      { id: spreadsheetId, name: "FY26 Forecast" }
    ]);

    // 6. `sendSlackPreviewMessage` enforces length ceiling, runs Careful gate, and delivers without leaking webhook URL
    await expect(
      runtime.callLocalRpc(
        "connected_connectors",
        "sendSlackPreviewMessage",
        { text: "x".repeat(40_001) },
        { userActivated: true }
      )
    ).rejects.toThrow(/40,000/);

    const slackRes = await runtime.callLocalRpc<SlackPreviewSendResult>(
      "connected_connectors",
      "sendSlackPreviewMessage",
      { text: "Q4 ARR hit *4.2M*!" },
      { userActivated: true }
    );
    expect(slackRes).toMatchObject({ status: "sent", route: "webhook" });
    expect(slackPosts).toHaveLength(1);
    expect(JSON.stringify(slackRes)).not.toContain("SecretToken123");

    runtime.dispose();
  });
});