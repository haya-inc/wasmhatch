import {
  A2uiGenerator,
  CatalogConfig,
  ComponentPruningTransformer,
  FunctionPruningTransformer,
  StreamedAnswer,
  type AnswerPart,
  type A2uiRequestProcessor,
  type ErrorPart
} from "@a2ui/agent";
import type { ReactCatalogComponent } from "@a2ui/react";
import {
  ComponentModel,
  A2uiValidationError,
  MessageProcessor,
  RpcErrorCode,
  SurfaceModel,
  type A2uiMetadata,
  type ActionPayload,
  type Catalog
} from "@a2ui/web_core/v1_0";
import { hasCapability, type HatchlingCapability } from "../hatchling-capabilities";
import type { McpRawToolResult } from "../mcp-client";
import type { McpConnectedServer } from "../mcp-registry";
import {
  BASIC_CATALOG_ID,
  createWasmhatchBasicCatalog,
  NANO_CORE_COMPONENTS
} from "./basic-catalog-react";
import {
  createWasmhatchConnectorsCatalog,
  WASMHATCH_CONNECTORS_CATALOG_ID
} from "./connectors-catalog";
import { exportSurfaceAsUniversalMcpAppHtml, toExportFileName } from "./export-mcp-app";
import { A2uiInputLimitError, A2uiTextInputGuard, assertA2uiInput } from "./input-limits";
import {
  createWasmhatchMcpCatalog,
  MCP_CATALOG_ID,
  McpUiResourceCoordinator,
  type McpAppResourcePayload
} from "./mcp-catalog";
import {
  A2uiLocalRpcEngine,
  type A2uiHostBridge,
  type A2uiSurfaceRpcBridge,
  type LocalRpcCallOptions,
  withTrustedUserGesture
} from "./rpc-functions";
import {
  createWasmhatchTabularCatalog,
  WASMHATCH_TABULAR_CATALOG_ID
} from "./tabular-catalog";
import {
  createWasmhatchVegaChartCatalog,
  VEGACHART_V1_CATALOG_ID
} from "./vega-chart-catalog";
import {
  createWasmhatchWorkspaceCatalog,
  WASMHATCH_WORKSPACE_CATALOG_ID
} from "./workspace-catalog";

export {
  BASIC_CATALOG_ID,
  MCP_CATALOG_ID,
  VEGACHART_V1_CATALOG_ID,
  WASMHATCH_CONNECTORS_CATALOG_ID,
  WASMHATCH_TABULAR_CATALOG_ID,
  WASMHATCH_WORKSPACE_CATALOG_ID
};

const NANO_CORE_FUNCTIONS = [
  "required",
  "email",
  "numeric",
  "length",
  "formatString",
  "and",
  "or",
  "not"
];

export interface SerializedComponentSnapshot {
  id: string;
  type: string;
  properties: Record<string, unknown>;
  catalogId?: string;
  metadata?: A2uiMetadata;
}

export interface SerializedSurfaceSnapshot {
  surfaceId: string;
  catalogId?: string;
  protocolVersion: string;
  sendDataModel: boolean;
  rootId: string;
  theme?: unknown;
  metadata?: A2uiMetadata;
  dataModel: Record<string, unknown>;
  components: SerializedComponentSnapshot[];
  pinned?: boolean;
  dismissed?: boolean;
}

export type TurnAnswerPart =
  | { kind: "text"; text: string }
  | { kind: "surface"; surfaceId: string; title: string }
  | { kind: "error"; message: string; code?: string };

export interface SurfaceActionDispatch {
  action: ActionPayload;
  surfaceTitle: string;
  userActivated: boolean;
  /** Short plain-language label shown in the user bubble. */
  userLabel: string;
  /** Structured prompt payload sent to the model on this turn. */
  agentTask: string;
}

export interface CanvasSurfaceEntry {
  surfaceId: string;
  title: string;
  surface: SurfaceModel<ReactCatalogComponent>;
  rpcBridge: A2uiSurfaceRpcBridge;
  pinned: boolean;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function humanizeIdentifier(raw: string): string {
  const cleaned = raw
    .replace(/^canvas[_-]+/i, "")
    .replace(/^surface[_-]+/i, "")
    .replace(/[_-]+/g, " ")
    .trim();
  if (!cleaned || cleaned.toLowerCase() === "default" || cleaned.toLowerCase() === "main") {
    return "Interactive view";
  }
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

export function deriveSurfaceTitle(surface: SurfaceModel<ReactCatalogComponent>): string {
  const extTitle = surface.extensions?.title;
  if (typeof extTitle === "string" && extTitle.trim()) {
    return extTitle.trim().slice(0, 48);
  }
  for (const comp of surface.componentsModel.values) {
    if (comp.type === "Text" && typeof comp.properties?.text === "string") {
      const firstLine = comp.properties.text
        .split("\n")[0]
        .replace(/^#+\s*/, "")
        .replace(/[*_`~]/g, "")
        .trim();
      if (firstLine) {
        return firstLine.length > 42 ? `${firstLine.slice(0, 41)}…` : firstLine;
      }
    }
    if (typeof comp.properties?.title === "string" && comp.properties.title.trim()) {
      const candidate = comp.properties.title.trim();
      return candidate.length > 42 ? `${candidate.slice(0, 41)}…` : candidate;
    }
    if (
      comp.type === "VegaChart" &&
      isPlainRecord(comp.properties?.spec) &&
      typeof comp.properties.spec.title === "string" &&
      comp.properties.spec.title.trim()
    ) {
      const chartTitle = comp.properties.spec.title.trim();
      return chartTitle.length > 42 ? `${chartTitle.slice(0, 41)}…` : chartTitle;
    }
  }
  return humanizeIdentifier(surface.id);
}

function formatActionUserLabel(action: ActionPayload, surfaceTitle: string): string {
  if (typeof action.userMessage === "string" && action.userMessage.trim()) {
    return action.userMessage.trim();
  }
  const readableAction = humanizeIdentifier(action.name);
  return `${surfaceTitle}: ${readableAction}`;
}

function formatActionAgentTask(
  action: ActionPayload,
  surface: SurfaceModel<ReactCatalogComponent> | undefined,
  rendererDataModel: Record<string, unknown> | undefined
): string {
  const surfaceData = surface ? surface.dataModel.get("/") : undefined;
  const envelope: Record<string, unknown> = {
    a2uiAction: {
      name: action.name,
      surfaceId: action.surfaceId,
      sourceComponentId: action.sourceComponentId,
      timestamp: action.timestamp,
      context: action.context
    }
  };
  if (surface?.sendDataModel && rendererDataModel) {
    envelope.a2uiRendererDataModel = rendererDataModel;
  } else if (isPlainRecord(surfaceData) && Object.keys(surfaceData).length > 0) {
    envelope.surfaceDataModel = surfaceData;
  }
  return [
    `The user triggered the "${action.name}" action on interactive surface "${action.surfaceId}".`,
    "Inspect the submitted context and data model below, carry out the requested next step (calling tools if needed), and update the surface or reply concisely:",
    "```json",
    JSON.stringify(envelope, null, 2),
    "```"
  ].join("\n");
}

export function buildSelfRepairPrompt(errors: readonly ErrorPart[]): string {
  const details = errors
    .map((entry, idx) => `${idx + 1}. [${entry.error.code || "A2UI_ERROR"}] ${entry.error.message}`)
    .join("\n");
  return [
    "Your previous `<a2ui>` Express UI block failed compiler validation and was rejected by the renderer:",
    details,
    "",
    "Re-emit ONLY the corrected `<a2ui>...</a2ui>` block (plus a one-line confirmation if helpful), adhering strictly to the active catalogs' positional component signatures, `root = ...` entry point, and valid `$` data bindings."
  ].join("\n");
}

export interface HatchlingA2uiRuntimeOptions extends A2uiHostBridge {
  getLocale?: () => string;
  onAction?: (dispatch: SurfaceActionDispatch) => void | Promise<void>;
  onChange?: () => void;
}

interface OutboundRpcEnvelope {
  version?: string;
  callAgentFunction?: {
    surfaceId?: string;
    functionCallId?: string;
    callFunction?: Record<string, unknown>;
  };
}

export class HatchlingA2uiRuntime {
  readonly catalog: Catalog<ReactCatalogComponent>;
  readonly vegaChartCatalog: Catalog<ReactCatalogComponent>;
  readonly tabularCatalog: Catalog<ReactCatalogComponent>;
  readonly workspaceCatalog: Catalog<ReactCatalogComponent>;
  readonly mcpCatalog: Catalog<ReactCatalogComponent>;
  readonly connectorsCatalog: Catalog<ReactCatalogComponent>;
  readonly catalogs: readonly Catalog<ReactCatalogComponent>[];
  readonly rpcEngine: A2uiLocalRpcEngine;
  readonly mcpCoordinator: McpUiResourceCoordinator;
  readonly renderer: MessageProcessor<ReactCatalogComponent>;

  private readonly getLocale: () => string;
  private readonly hostBridge: A2uiHostBridge;
  private readonly onActionCallback?: (dispatch: SurfaceActionDispatch) => void | Promise<void>;
  private readonly onChangeCallback?: () => void;
  private readonly processorCache = new Map<string, A2uiRequestProcessor>();
  private readonly surfaceRpcBridges = new Map<string, A2uiSurfaceRpcBridge>();
  private readonly pendingRpcMeta = new Map<string, LocalRpcCallOptions>();
  private rpcCallCounter = 0;

  private readonly pinnedIds = new Set<string>();
  private readonly dismissedCanvasIds = new Set<string>();
  private readonly dataSubscriptions = new Map<string, { unsubscribe: () => void }>();
  private activeCanvasSurfaceId: string | null = null;
  private muteChanges = false;
  private disposed = false;

  constructor(options: HatchlingA2uiRuntimeOptions = {}) {
    this.getLocale = options.getLocale ?? (() => "en");
    this.hostBridge = options;
    this.onActionCallback = options.onAction;
    this.onChangeCallback = options.onChange;

    this.rpcEngine = new A2uiLocalRpcEngine(this.hostBridge, (surfaceId) =>
      this.renderer.getSurface(surfaceId)
    );
    this.mcpCoordinator = new McpUiResourceCoordinator();

    this.catalog = createWasmhatchBasicCatalog(() => this.getLocale());
    this.vegaChartCatalog = createWasmhatchVegaChartCatalog();
    this.tabularCatalog = createWasmhatchTabularCatalog(this.rpcEngine);
    this.workspaceCatalog = createWasmhatchWorkspaceCatalog(this.rpcEngine);
    this.mcpCatalog = createWasmhatchMcpCatalog(
      {
        canUseMcp: () => this.canUseCapability("mcp"),
        canUseArtifacts: () => this.canUseCapability("artifacts"),
        getLocale: () => this.getLocale(),
        getProcessor: () => this.renderer,
        getActiveMcpServers: () => this.hostBridge.getActiveMcpServers?.() ?? [],
        gateMcpToolCall: (toolLabel, args, readOnly, signal) =>
          readOnly
            ? Promise.resolve()
            : this.rpcEngine.gateExternalOperation(toolLabel, args, false, signal),
        onMcpAppResource: (appPayload) => {
          this.mountMcpAppSurface(appPayload);
        }
      },
      this.mcpCoordinator
    );
    this.connectorsCatalog = createWasmhatchConnectorsCatalog(this.rpcEngine);
    this.catalogs = [
      this.catalog,
      this.vegaChartCatalog,
      this.tabularCatalog,
      this.workspaceCatalog,
      this.mcpCatalog,
      this.connectorsCatalog
    ];

    this.renderer = new MessageProcessor<ReactCatalogComponent>(
      [...this.catalogs],
      (action) => this.handleSurfaceAction(action),
      {
        version: "1.0",
        defaultTimeoutMs: 15_000,
        outboundListener: (msg) => this.handleOutboundRpcMessage(msg as OutboundRpcEnvelope)
      }
    );

    // Both compiled model UI and MCP resources pass through this boundary
    // before web_core expands any validation issues or renderer operations.
    const processMessages = this.renderer.processMessages.bind(this.renderer);
    this.renderer.processMessages = (messages, processOptions) => {
      assertA2uiInput(messages);
      return processMessages(messages, processOptions);
    };

    this.renderer.onSurfaceCreated((surface) => {
      this.attachDataSubscription(surface);
      if (this.isInherentlyCanvas(surface)) {
        this.dismissedCanvasIds.delete(surface.id);
        this.activeCanvasSurfaceId = surface.id;
      }
      this.notifyChange();
    });

    this.renderer.onSurfaceDeleted((id) => {
      this.detachDataSubscription(id);
      this.surfaceRpcBridges.delete(id);
      this.pinnedIds.delete(id);
      this.dismissedCanvasIds.delete(id);
      if (this.activeCanvasSurfaceId === id) {
        this.activeCanvasSurfaceId = this.listCanvasSurfaces()[0]?.surfaceId ?? null;
      }
      this.notifyChange();
    });
  }

  get cloudProcessor(): A2uiRequestProcessor {
    return this.getProcessor("cloud");
  }

  get nanoProcessor(): A2uiRequestProcessor {
    return this.getProcessor("nano");
  }

  canUseCapability(capability: HatchlingCapability): boolean {
    const allowed = this.hostBridge.getCapabilities ? this.hostBridge.getCapabilities() : null;
    return hasCapability(allowed, capability);
  }

  private getProcessor(mode: "cloud" | "nano"): A2uiRequestProcessor {
    const canRead = this.canUseCapability("workspace.read");
    const canWrite = this.canUseCapability("workspace.write");
    const canScript = this.canUseCapability("workspace.script");
    const canMcp = this.canUseCapability("mcp");
    const canArtifacts = this.canUseCapability("artifacts");
    const googleConnected =
      this.canUseCapability("google") && (this.hostBridge.google?.isConnected() ?? false);
    const googlePickerAvailable =
      googleConnected && Boolean(this.hostBridge.google?.requestFilePick);
    const slackConnected =
      this.canUseCapability("slack") &&
      Boolean(
        this.hostBridge.slack?.getWebhookUrl?.()?.trim() ||
          this.hostBridge.slack?.getToken?.()?.trim()
      );
    const cacheKey = [
      mode,
      canRead ? 1 : 0,
      canWrite ? 1 : 0,
      canScript ? 1 : 0,
      canMcp ? 1 : 0,
      canArtifacts ? 1 : 0,
      googleConnected ? 1 : 0,
      googlePickerAvailable ? 1 : 0,
      slackConnected ? 1 : 0
    ].join(":");
    const existing = this.processorCache.get(cacheKey);
    if (existing) return existing;

    const capabilities = this.renderer.getRendererCapabilities({ versions: ["1.0"] });

    if (mode === "nano") {
      const nanoConfigs: CatalogConfig[] = [
        new CatalogConfig(this.catalog, [
          new ComponentPruningTransformer([...NANO_CORE_COMPONENTS]),
          new FunctionPruningTransformer(NANO_CORE_FUNCTIONS)
        ]),
        new CatalogConfig(this.vegaChartCatalog),
        new CatalogConfig(this.tabularCatalog, [
          new ComponentPruningTransformer(["DataGrid"]),
          new FunctionPruningTransformer(canRead ? ["loadWorkspaceTable"] : [])
        ]),
        new CatalogConfig(this.workspaceCatalog, [
          new ComponentPruningTransformer(canScript ? ["QuickJsWorkbench"] : []),
          new FunctionPruningTransformer(canScript ? ["runQuickJsTransform"] : [])
        ]),
        new CatalogConfig(this.mcpCatalog, [
          new ComponentPruningTransformer([]),
          new FunctionPruningTransformer([])
        ]),
        new CatalogConfig(this.connectorsCatalog, [
          new ComponentPruningTransformer([]),
          new FunctionPruningTransformer([])
        ])
      ];
      const processor = new A2uiGenerator(nanoConfigs).createProcessor(capabilities);
      this.processorCache.set(cacheKey, processor);
      return processor;
    }

    const tabularFns = ["exportSafeCsv", ...(canRead ? ["loadWorkspaceTable"] : [])];
    const cloudConfigs: CatalogConfig[] = [
      new CatalogConfig(this.catalog),
      new CatalogConfig(this.vegaChartCatalog),
      new CatalogConfig(this.tabularCatalog, [new FunctionPruningTransformer(tabularFns)])
    ];

    const workspaceComponents: string[] = [];
    const workspaceFns: string[] = [];
    if (canScript) {
      workspaceComponents.push("QuickJsWorkbench");
      workspaceFns.push("runQuickJsTransform");
    }
    if (canRead) {
      workspaceComponents.push("WorkspaceDiffCard", "WorkspaceFileCard");
      workspaceFns.push("previewWorkspaceDiff", "readWorkspaceFile", "exportWorkspacePatch");
    }
    if (canWrite) {
      workspaceFns.push("commitWorkspaceWrite");
    }
    cloudConfigs.push(
      new CatalogConfig(this.workspaceCatalog, [
        new ComponentPruningTransformer(workspaceComponents),
        new FunctionPruningTransformer(workspaceFns)
      ])
    );

    const mcpComponents = canMcp || canArtifacts ? ["McpApp"] : [];
    const mcpFns = [
      "transformData",
      "updateDataModel",
      "split",
      "regexCapture",
      ...(canMcp ? ["callMcpTool"] : [])
    ];
    cloudConfigs.push(
      new CatalogConfig(this.mcpCatalog, [
        new ComponentPruningTransformer(mcpComponents),
        new FunctionPruningTransformer(mcpFns)
      ])
    );

    const connectorComponents: string[] = [];
    const connectorFns: string[] = [];
    if (googleConnected) {
      connectorComponents.push("GoogleSheetRangeCard");
      connectorFns.push("commitGoogleSheetValues", "rollbackGoogleSheetValues");
      if (googlePickerAvailable) {
        connectorComponents.push("GooglePickerHandoverCard");
        connectorFns.push("pickGoogleDriveFiles");
      }
    }
    if (slackConnected) {
      connectorComponents.push("SlackMessagePreviewCard");
      connectorFns.push("sendSlackPreviewMessage");
    }
    cloudConfigs.push(
      new CatalogConfig(this.connectorsCatalog, [
        new ComponentPruningTransformer(connectorComponents),
        new FunctionPruningTransformer(connectorFns)
      ])
    );

    const processor = new A2uiGenerator(cloudConfigs).createProcessor(capabilities);
    this.processorCache.set(cacheKey, processor);
    return processor;
  }

  private async handleOutboundRpcMessage(msg: OutboundRpcEnvelope): Promise<void> {
    if (this.disposed || !msg?.callAgentFunction) return;
    const { surfaceId, functionCallId, callFunction } = msg.callAgentFunction;
    if (!functionCallId || !callFunction) return;

    const callOptions = this.pendingRpcMeta.get(functionCallId) ?? { userActivated: false };
    this.pendingRpcMeta.delete(functionCallId);

    const callName = String(callFunction["@call"] ?? callFunction.call ?? "");
    const rawArgs = isPlainRecord(callFunction.args) ? callFunction.args : {};
    const surface = surfaceId ? this.renderer.getSurface(surfaceId) : undefined;

    try {
      const value = await this.rpcEngine.executeCall(callName, rawArgs, surface, callOptions);
      this.renderer.rpc.handleAgentFunctionResponse({
        version: "1.0",
        agentFunctionResponse: {
          functionCallId,
          value
        }
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.renderer.rpc.handleAgentFunctionResponse({
        version: "1.0",
        agentFunctionResponse: {
          functionCallId,
          error: {
            code: RpcErrorCode.EXECUTION_ERROR,
            message
          }
        }
      });
    }
  }

  /**
   * Executes a deterministic local RPC call over `@a2ui/web_core` v1.0's
   * `callAgentFunction` / `agentFunctionResponse` channel in milliseconds,
   * with zero LLM round-trips.
   */
  async callLocalRpc<T = unknown>(
    surfaceId: string,
    callName: string,
    args: Record<string, unknown> = {},
    options: LocalRpcCallOptions = {}
  ): Promise<T> {
    this.rpcCallCounter += 1;
    const functionCallId = `local_rpc_${this.rpcCallCounter}`;
    const effectiveActivated = Boolean(options.userActivated);
    this.pendingRpcMeta.set(functionCallId, {
      ...options,
      userActivated: effectiveActivated
    });
    try {
      return await withTrustedUserGesture(effectiveActivated, () =>
        this.renderer.callAgentFunction<T>(
          surfaceId,
          {
            "@call": callName,
            args
          },
          {
            functionCallId,
            timeoutMs: options.timeoutMs ?? 15_000
          }
        )
      );
    } finally {
      this.pendingRpcMeta.delete(functionCallId);
    }
  }

  createSurfaceRpcBridge(surfaceId: string): A2uiSurfaceRpcBridge {
    const cached = this.surfaceRpcBridges.get(surfaceId);
    if (cached) return cached;
    const bridge: A2uiSurfaceRpcBridge = {
      surfaceId,
      callLocalRpc: <T = unknown>(
        callName: string,
        args: Record<string, unknown>,
        options?: LocalRpcCallOptions
      ) => this.callLocalRpc<T>(surfaceId, callName, args, options),
      canUseCapability: (capability) => this.canUseCapability(capability),
      sendFollowUpMessage: async (text, label) => {
        if (this.disposed || !this.onActionCallback) return;
        const surface = this.renderer.getSurface(surfaceId);
        const surfaceTitle =
          label || (surface ? deriveSurfaceTitle(surface) : humanizeIdentifier(surfaceId));
        await this.onActionCallback({
          action: {
            name: "mcp_app_message",
            surfaceId,
            sourceComponentId: "mcp_app",
            timestamp: new Date().toISOString(),
            context: { text }
          },
          surfaceTitle,
          userActivated: true,
          userLabel: `${surfaceTitle}: ${text.slice(0, 80)}`,
          agentTask: text
        });
      }
    };
    this.surfaceRpcBridges.set(surfaceId, bridge);
    return bridge;
  }

  private attachDataSubscription(surface: SurfaceModel<ReactCatalogComponent>): void {
    this.detachDataSubscription(surface.id);
    const sub = surface.dataModel.subscribe("/", () => {
      this.notifyChange();
    });
    this.dataSubscriptions.set(surface.id, sub);
  }

  private detachDataSubscription(surfaceId: string): void {
    const existing = this.dataSubscriptions.get(surfaceId);
    if (existing) {
      existing.unsubscribe();
      this.dataSubscriptions.delete(surfaceId);
    }
  }

  private notifyChange(): void {
    if (!this.disposed && !this.muteChanges) this.onChangeCallback?.();
  }

  private isInherentlyCanvas(surface: SurfaceModel<ReactCatalogComponent>): boolean {
    if (surface.id.startsWith("canvas_")) return true;
    return surface.extensions?.placement === "canvas";
  }

  private async handleSurfaceAction(action: ActionPayload): Promise<void> {
    if (this.disposed || !this.onActionCallback) return;
    const surface = this.renderer.getSurface(action.surfaceId);
    const surfaceTitle = surface ? deriveSurfaceTitle(surface) : humanizeIdentifier(action.surfaceId);
    const userActivated = action.metadata?.extensions?.userActivated !== false;
    let rendererDataModel: Record<string, unknown> | undefined;
    try {
      rendererDataModel = this.renderer.getRendererDataModel("1.0");
    } catch {
      rendererDataModel = undefined;
    }
    await this.onActionCallback({
      action,
      surfaceTitle,
      userActivated,
      userLabel: formatActionUserLabel(action, surfaceTitle),
      agentTask: formatActionAgentTask(action, surface, rendererDataModel)
    });
  }

  promptSnippet(mode: "cloud" | "nano"): string {
    return this.getProcessor(mode).promptSnippet;
  }

  getSurface(surfaceId: string): SurfaceModel<ReactCatalogComponent> | undefined {
    return this.renderer.getSurface(surfaceId);
  }

  getSurfaceTitle(surfaceId: string): string {
    const surface = this.renderer.getSurface(surfaceId);
    return surface ? deriveSurfaceTitle(surface) : humanizeIdentifier(surfaceId);
  }

  isCanvasSurface(surfaceId: string): boolean {
    const surface = this.renderer.getSurface(surfaceId);
    if (!surface) return false;
    if (this.pinnedIds.has(surfaceId)) return true;
    if (this.dismissedCanvasIds.has(surfaceId)) return false;
    return this.isInherentlyCanvas(surface);
  }

  isPinned(surfaceId: string): boolean {
    return this.pinnedIds.has(surfaceId);
  }

  listCanvasSurfaces(): CanvasSurfaceEntry[] {
    const entries: CanvasSurfaceEntry[] = [];
    for (const [surfaceId, surface] of this.renderer.getSurfaces().entries()) {
      if (!this.isCanvasSurface(surfaceId)) continue;
      entries.push({
        surfaceId,
        title: deriveSurfaceTitle(surface),
        surface,
        rpcBridge: this.createSurfaceRpcBridge(surfaceId),
        pinned: this.pinnedIds.has(surfaceId)
      });
    }
    return entries;
  }

  get activeCanvasId(): string | null {
    if (this.activeCanvasSurfaceId && this.isCanvasSurface(this.activeCanvasSurfaceId)) {
      return this.activeCanvasSurfaceId;
    }
    return this.listCanvasSurfaces()[0]?.surfaceId ?? null;
  }

  selectCanvasSurface(surfaceId: string): void {
    const surface = this.renderer.getSurface(surfaceId);
    if (!surface) return;
    if (!this.isCanvasSurface(surfaceId)) {
      this.pinnedIds.add(surfaceId);
      this.dismissedCanvasIds.delete(surfaceId);
    }
    this.activeCanvasSurfaceId = surfaceId;
    this.notifyChange();
  }

  pinSurface(surfaceId: string): void {
    if (!this.renderer.getSurface(surfaceId)) return;
    this.dismissedCanvasIds.delete(surfaceId);
    this.pinnedIds.add(surfaceId);
    this.activeCanvasSurfaceId = surfaceId;
    this.notifyChange();
  }

  closeCanvasSurface(surfaceId: string): void {
    const surface = this.renderer.getSurface(surfaceId);
    if (!surface) return;
    this.pinnedIds.delete(surfaceId);
    if (this.isInherentlyCanvas(surface)) {
      this.dismissedCanvasIds.add(surfaceId);
    }
    if (this.activeCanvasSurfaceId === surfaceId) {
      this.activeCanvasSurfaceId = this.listCanvasSurfaces()[0]?.surfaceId ?? null;
    }
    this.notifyChange();
  }

  openTurnStream(mode: "cloud" | "nano" = "cloud") {
    const processor = this.getProcessor(mode);
    const answer = new StreamedAnswer(processor, { renderer: this.renderer });
    const inputGuard = new A2uiTextInputGuard();
    let limitFailure: ErrorPart | null = null;

    const toTurnParts = (rawParts: readonly AnswerPart<ReactCatalogComponent>[]): TurnAnswerPart[] => {
      const normalized: TurnAnswerPart[] = [];
      for (const part of rawParts) {
        if (part.type === "text") {
          normalized.push({ kind: "text", text: part.text });
        } else if (part.type === "surface") {
          normalized.push({
            kind: "surface",
            surfaceId: part.surface.id,
            title: deriveSurfaceTitle(part.surface)
          });
        } else if (part.type === "error") {
          normalized.push({
            kind: "error",
            message: part.error.message,
            code: part.error.code
          });
        }
      }
      return normalized;
    };

    return {
      get isInBlock(): boolean {
        return limitFailure === null && answer.isInBlock;
      },
      feed: (chunk: string): TurnAnswerPart[] => {
        if (limitFailure) return toTurnParts([...answer.parts, limitFailure]);
        try {
          inputGuard.feed(chunk);
        } catch (error) {
          if (!(error instanceof A2uiInputLimitError)) throw error;
          limitFailure = { type: "error", error: new A2uiValidationError(error.message, undefined, error.code) };
          return toTurnParts([...answer.parts, limitFailure]);
        }
        answer.feed(chunk);
        return toTurnParts(answer.parts);
      },
      close: (): { parts: TurnAnswerPart[]; errors: ErrorPart[] } => {
        if (!limitFailure) answer.close();
        const parts = limitFailure ? [...answer.parts, limitFailure] : answer.parts;
        const errors = parts.filter((part): part is ErrorPart => part.type === "error");
        return {
          parts: toTurnParts(parts),
          errors
        };
      }
    };
  }

  applyWholeResponse(
    responseText: string,
    mode: "cloud" | "nano" = "nano"
  ): { parts: TurnAnswerPart[]; errors: ErrorPart[] } {
    const stream = this.openTurnStream(mode);
    if (responseText) stream.feed(responseText);
    return stream.close();
  }

  private buildSurfaceSnapshot(surface: SurfaceModel<ReactCatalogComponent>): SerializedSurfaceSnapshot {
    const rawData = surface.dataModel.get("/");
    const dataModel = isPlainRecord(rawData) ? structuredClone(rawData) : {};
    const components: SerializedComponentSnapshot[] = [];
    for (const comp of surface.componentsModel.values) {
      components.push({
        id: comp.id,
        type: comp.type,
        properties: isPlainRecord(comp.properties) ? structuredClone(comp.properties) : {},
        ...(comp.catalog?.id ? { catalogId: comp.catalog.id } : {}),
        ...(comp.metadata ? { metadata: structuredClone(comp.metadata) } : {})
      });
    }
    return {
      surfaceId: surface.id,
      ...(surface.defaultCatalog?.id ? { catalogId: surface.defaultCatalog.id } : {}),
      protocolVersion: surface.protocolVersion ?? "1.0",
      sendDataModel: surface.sendDataModel,
      rootId: surface.rootId || "root",
      ...(surface.theme !== undefined ? { theme: structuredClone(surface.theme) } : {}),
      ...(surface.metadata ? { metadata: structuredClone(surface.metadata) } : {}),
      dataModel,
      components,
      ...(this.pinnedIds.has(surface.id) ? { pinned: true } : {}),
      ...(this.dismissedCanvasIds.has(surface.id) ? { dismissed: true } : {})
    };
  }

  serializeSurface(surfaceId: string): SerializedSurfaceSnapshot | null {
    const surface = this.renderer.getSurface(surfaceId);
    return surface ? this.buildSurfaceSnapshot(surface) : null;
  }

  exportSurfaceHtml(surfaceId: string): { fileName: string; title: string; html: string } | null {
    const surface = this.renderer.getSurface(surfaceId);
    if (!surface) return null;
    const title = deriveSurfaceTitle(surface);
    const snapshot = this.buildSurfaceSnapshot(surface);
    const html = exportSurfaceAsUniversalMcpAppHtml(snapshot, {
      title,
      locale: this.getLocale()
    });
    return {
      fileName: toExportFileName(title),
      title,
      html
    };
  }

  mountMcpAppSurface(appPayload: McpAppResourcePayload, explicitSurfaceId?: string): string {
    assertA2uiInput(appPayload);
    const safeSlug = appPayload.toolName.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 32) || "app";
    const surfaceId = explicitSurfaceId || `canvas_mcp_${safeSlug}`;
    const existing = this.renderer.getSurface(surfaceId);
    const title = humanizeIdentifier(appPayload.toolName);

    if (!existing) {
      const availableCatalogs = new Map<string, Catalog<ReactCatalogComponent>>(
        this.catalogs.map((cat) => [cat.id, cat])
      );
      const surface = new SurfaceModel<ReactCatalogComponent>(
        surfaceId,
        this.mcpCatalog,
        availableCatalogs,
        undefined,
        true,
        undefined,
        "root",
        { extensions: { title, placement: "canvas" } },
        "1.0"
      );
      surface.dataModel.set("/", {
        mcpTool: {
          toolName: appPayload.toolName,
          toolInput: appPayload.toolInput,
          toolResult: appPayload.toolResult
        }
      });
      surface.componentsModel.addComponent(
        new ComponentModel(
          "root",
          "McpApp",
          {
            htmlContent: appPayload.html,
            title,
            resourceUri: appPayload.resourceUri,
            toolInput: appPayload.toolInput,
            toolResult: appPayload.toolResult,
            allowedTools: [appPayload.toolName],
            ...(appPayload.csp ? { csp: appPayload.csp } : {}),
            ...(appPayload.permissions ? { permissions: appPayload.permissions } : {})
          },
          this.mcpCatalog
        )
      );
      this.renderer.model.addSurface(surface);
    } else {
      existing.dataModel.set("/mcpTool", {
        toolName: appPayload.toolName,
        toolInput: appPayload.toolInput,
        toolResult: appPayload.toolResult
      });
      const rootComp = existing.componentsModel.get("root");
      if (rootComp && rootComp.type === "McpApp") {
        rootComp.properties = {
          ...rootComp.properties,
          htmlContent: appPayload.html,
          resourceUri: appPayload.resourceUri,
          toolInput: appPayload.toolInput,
          toolResult: appPayload.toolResult
        };
      }
      this.dismissedCanvasIds.delete(surfaceId);
      this.activeCanvasSurfaceId = surfaceId;
      this.notifyChange();
    }
    return surfaceId;
  }

  async ingestMcpToolResult(params: {
    server: McpConnectedServer;
    toolName: string;
    toolArgs: Record<string, unknown>;
    rawResult: McpRawToolResult;
    signal?: AbortSignal;
  }): Promise<{ surfaceIds: string[]; assistantNote: string | null }> {
    if (this.disposed || params.rawResult.isError) {
      return { surfaceIds: [], assistantNote: null };
    }
    assertA2uiInput(params.rawResult);
    const mountedIds = new Set<string>();
    const processed = await this.mcpCoordinator.processToolResultResources({
      server: params.server,
      toolName: params.toolName,
      toolArgs: params.toolArgs,
      rawResult: params.rawResult,
      processor: this.renderer,
      onMcpAppResource: (appPayload) => {
        const sid = this.mountMcpAppSurface(appPayload);
        mountedIds.add(sid);
      },
      signal: params.signal
    });
    for (const sid of processed.renderedSurfaceIds) {
      mountedIds.add(sid);
    }
    const surfaceIds = [...mountedIds];
    const assistantNote =
      surfaceIds.length > 0
        ? `[Rendered interactive UI for the user: ${surfaceIds.join(", ")}]`
        : null;
    return { surfaceIds, assistantNote };
  }

  serializeSurfaces(): SerializedSurfaceSnapshot[] {
    const snapshots: SerializedSurfaceSnapshot[] = [];
    for (const surface of this.renderer.getSurfaces().values()) {
      snapshots.push(this.buildSurfaceSnapshot(surface));
    }
    return snapshots;
  }

  restoreSurfaces(
    snapshots: readonly unknown[] | undefined,
    options: { silent?: boolean } = {}
  ): void {
    if (snapshots !== undefined) assertA2uiInput(snapshots);
    const prevMute = this.muteChanges;
    this.muteChanges = true;
    try {
      this.clear();
      if (!Array.isArray(snapshots) || snapshots.length === 0) return;

      const availableCatalogs = new Map<string, Catalog<ReactCatalogComponent>>(
        this.catalogs.map((cat) => [cat.id, cat])
      );

      for (const raw of snapshots) {
        if (!isPlainRecord(raw) || typeof raw.surfaceId !== "string" || !raw.surfaceId) continue;
        if (!Array.isArray(raw.components)) continue;
        try {
          const defaultCatalog =
            typeof raw.catalogId === "string"
              ? availableCatalogs.get(raw.catalogId)
              : undefined;
          const surface = new SurfaceModel<ReactCatalogComponent>(
            raw.surfaceId,
            defaultCatalog,
            availableCatalogs,
            raw.theme,
            Boolean(raw.sendDataModel),
            undefined,
            typeof raw.rootId === "string" && raw.rootId ? raw.rootId : "root",
            isPlainRecord(raw.metadata) ? (raw.metadata as A2uiMetadata) : undefined,
            typeof raw.protocolVersion === "string" && raw.protocolVersion ? raw.protocolVersion : "1.0"
          );
          if (isPlainRecord(raw.dataModel)) {
            surface.dataModel.set("/", structuredClone(raw.dataModel));
          }
          for (const rawComp of raw.components) {
            if (!isPlainRecord(rawComp) || typeof rawComp.id !== "string" || typeof rawComp.type !== "string") {
              continue;
            }
            const compCatalog =
              (typeof rawComp.catalogId === "string"
                ? availableCatalogs.get(rawComp.catalogId)
                : undefined) ??
              defaultCatalog ??
              this.catalogs.find((cat) => cat.components.has(rawComp.type as string)) ??
              this.catalog;
            const props = isPlainRecord(rawComp.properties) ? structuredClone(rawComp.properties) : {};
            const meta = isPlainRecord(rawComp.metadata) ? (structuredClone(rawComp.metadata) as A2uiMetadata) : undefined;
            surface.componentsModel.addComponent(
              new ComponentModel(rawComp.id, rawComp.type, props, compCatalog, meta)
            );
          }
          this.renderer.model.addSurface(surface);
          if (raw.pinned === true) this.pinnedIds.add(surface.id);
          if (raw.dismissed === true) this.dismissedCanvasIds.add(surface.id);
        } catch {
          // Corrupt or incompatible surface snapshots fail open rather than breaking page boot.
        }
      }
      this.activeCanvasSurfaceId = this.listCanvasSurfaces()[0]?.surfaceId ?? null;
    } finally {
      this.muteChanges = prevMute;
    }
    if (!options.silent) this.notifyChange();
  }

  clear(): void {
    this.pinnedIds.clear();
    this.dismissedCanvasIds.clear();
    this.surfaceRpcBridges.clear();
    this.mcpCoordinator.clear();
    this.activeCanvasSurfaceId = null;
    for (const id of [...this.renderer.getSurfaces().keys()]) {
      this.detachDataSubscription(id);
      this.renderer.model.deleteSurface(id);
    }
    this.notifyChange();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.pendingRpcMeta.clear();
    this.surfaceRpcBridges.clear();
    this.processorCache.clear();
    for (const id of [...this.dataSubscriptions.keys()]) {
      this.detachDataSubscription(id);
    }
    this.pinnedIds.clear();
    this.dismissedCanvasIds.clear();
    this.activeCanvasSurfaceId = null;
    this.renderer.model.dispose();
    this.renderer.dispose();
  }
}
