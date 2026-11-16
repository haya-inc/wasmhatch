import { createContext, useContext } from "react";
import type { DataContext, SurfaceModel } from "@a2ui/web_core/v1_0";
import type { ReactCatalogComponent } from "@a2ui/react";
import { downloadTextFile } from "../browser-download";
import { runBusinessScriptInWorker } from "../browser-script-runner";
import {
  executeBusinessScript,
  type BusinessScriptResult,
  type BusinessValue
} from "../business-script";
import type { PermissionGate, SessionPermissionStore } from "../chat-permissions";
import { CHAT_SCRIPT_MAX_INPUT_PATHS, CHAT_WRITE_MAX_BYTES, type AppliedWrite, type WritePolicy } from "../chat-tools";
import { createReadableDiff } from "../diff";
import { createGoogleConnectorExecutor } from "../google-connectors";
import type { PickedDriveFile } from "../google-picker";
import { hasCapability, type HatchlingCapability } from "../hatchling-capabilities";
import type { McpConnectedServer } from "../mcp-registry";
import { isProtectedAgentPath } from "../secrets";
import { createSlackApiExecutor, slackProxyBaseUrl } from "../slack-tools";
import { createSlackWebhookExecutor } from "../slack-webhook";
import { normalizeWorkspacePath, type WorkspaceStore } from "../workspace";

export interface BusinessScriptInputPayload {
  [key: string]: BusinessValue;
  args: BusinessValue;
  files: { path: string; content: string }[];
}
import {
  MAX_TABULAR_ROWS,
  normalizeTabularDataset,
  parseWorkspaceTabularFile,
  profileTabularDataset,
  serializeSafeCsv
} from "./tabular-utils";

const encoder = new TextEncoder();
const MAX_FILE_PREVIEW_BYTES = 32_768;
const DEFAULT_RPC_SCRIPT_TIMEOUT_MS = 1_200;
const MAX_RPC_SCRIPT_TIMEOUT_MS = 2_000;

let activeTrustedGestureOverride: boolean | null = null;

/**
 * Records whether the synchronous dispatch entry point came from a trusted
 * user event (`event.nativeEvent.isTrusted`) so `@a2ui/web_core` action
 * closures cannot bypass WasmHatch's user-activation check.
 */
export async function withTrustedUserGesture<T>(
  trusted: boolean,
  fn: () => T | Promise<T>
): Promise<T> {
  const prev = activeTrustedGestureOverride;
  activeTrustedGestureOverride = trusted;
  try {
    return await fn();
  } finally {
    activeTrustedGestureOverride = prev;
  }
}

export function resolveEffectiveUserActivation(
  explicitFlag: boolean | undefined,
  dataContext?: DataContext
): boolean {
  if (dataContext?.isPassiveEvaluation) return false;
  if (activeTrustedGestureOverride !== null) return activeTrustedGestureOverride;
  if (explicitFlag !== undefined) return explicitFlag;
  return Boolean(dataContext?.isUserActivated);
}

export interface A2uiAuditEntry {
  category: "tool" | "effect";
  outcome: "completed" | "failed" | "cancelled";
  summary: string;
  detail?: string;
  evidence?: Record<string, string | number | boolean>;
}

export type A2uiScriptRunner = (
  script: string,
  input: BusinessScriptInputPayload,
  options?: { timeoutMs?: number; signal?: AbortSignal }
) => Promise<BusinessScriptResult>;

export interface A2uiHostBridge {
  workspace?: WorkspaceStore;
  getCapabilities?: () => readonly string[] | null;
  getWritePolicy?: () => WritePolicy;
  permissions?: SessionPermissionStore;
  gate?: PermissionGate;
  threadId?: string;
  getThreadName?: () => string;
  runScript?: A2uiScriptRunner;
  google?: {
    isConnected: () => boolean;
    sensitiveEnabled?: boolean;
    getToken: (signal?: AbortSignal) => Promise<string>;
    requestFilePick?: (reason: string, signal?: AbortSignal) => Promise<PickedDriveFile[] | null>;
    fetchImpl?: typeof fetch;
  };
  slack?: {
    getWebhookUrl: () => string;
    getToken?: () => string;
    fetchImpl?: typeof fetch;
  };
  getActiveMcpServers?: () => readonly McpConnectedServer[];
  onWrite?: (path: string) => void;
  onAppliedWrite?: (write: AppliedWrite) => void;
  onDownload?: (fileName: string, content: string, mimeType?: string) => void;
  onAudit?: (entry: A2uiAuditEntry) => void;
}

export interface LocalRpcCallOptions {
  userActivated?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface QuickJsTransformOutput {
  result: BusinessValue;
  durationMs: number;
  appliedToPath: string | null;
  stale: boolean;
}

export interface WorkspaceDiffPreview {
  path: string;
  creates: boolean;
  unchanged: boolean;
  beforeBytes: number;
  afterBytes: number;
  diff: string;
}

export interface WorkspaceWriteResult {
  status: "applied" | "unchanged";
  path: string;
  creates: boolean;
  afterBytes: number;
  diff: string;
}

export interface WorkspaceFilePreview {
  path: string;
  content: string;
  totalLines: number;
  byteLength: number;
  truncated: boolean;
}

export interface LoadedWorkspaceTable {
  path: string;
  columns: { key: string; label: string; type: "number" | "boolean" | "text" }[];
  rows: Record<string, string | number | boolean | null>[];
  profile: ReturnType<typeof profileTabularDataset>;
  formulaWarningCount: number;
  totalRows: number;
  truncated: boolean;
}

export interface GoogleSheetCommitResult {
  status: "updated";
  spreadsheetId: string;
  range: string;
  updatedCells: number;
  rollbackId: string;
}

export interface GoogleSheetRollbackResult {
  status: "reverted";
  spreadsheetId: string;
  range: string;
  updatedCells: number;
}

export interface GooglePickerRpcResult {
  picked: PickedDriveFile[];
  cancelled: boolean;
}

export interface SlackPreviewSendResult {
  status: "sent";
  route: "bot" | "webhook";
  summary: string;
}

interface SheetRollbackSnapshot {
  spreadsheetId: string;
  range: string;
  previousValues: string[][];
}

const MAX_SHEET_ROLLBACKS = 50;
const SLACK_MAX_CHARS = 40_000;

function defaultScriptRunner(
  script: string,
  input: BusinessScriptInputPayload,
  options?: { timeoutMs?: number; signal?: AbortSignal }
): Promise<BusinessScriptResult> {
  if (typeof Worker !== "undefined" && typeof window !== "undefined") {
    return runBusinessScriptInWorker(script, input, options);
  }
  return executeBusinessScript(script, input, { timeoutMs: options?.timeoutMs });
}

function defaultDownloadHandler(fileName: string, content: string, mimeType?: string): void {
  if (typeof document !== "undefined") {
    downloadTextFile(fileName, content, mimeType);
  }
}

function normalizeJsonPointer(rawPath: string | undefined): string | null {
  if (typeof rawPath !== "string") return null;
  const trimmed = rawPath.trim();
  if (!trimmed) return null;
  const withoutDollar = trimmed.startsWith("$/")
    ? trimmed.slice(1)
    : trimmed.startsWith("$")
      ? `/${trimmed.slice(1)}`
      : trimmed;
  return withoutDollar.startsWith("/") ? withoutDollar : `/${withoutDollar}`;
}

function clampUtf8Preview(input: string, maxBytes: number): { content: string; truncated: boolean } {
  if (encoder.encode(input).byteLength <= maxBytes) return { content: input, truncated: false };
  let low = 0;
  let high = input.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (encoder.encode(input.slice(0, mid)).byteLength <= maxBytes) low = mid;
    else high = mid - 1;
  }
  if (
    low > 0 &&
    low < input.length &&
    input.charCodeAt(low - 1) >= 0xd800 &&
    input.charCodeAt(low - 1) <= 0xdbff &&
    input.charCodeAt(low) >= 0xdc00 &&
    input.charCodeAt(low) <= 0xdfff
  ) {
    low -= 1;
  }
  return { content: input.slice(0, low), truncated: true };
}

const DEFINES_MAIN_RE = /\bfunction\s+main\b|\b(?:const|let|var)\s+main\s*=/;
const FUNCTION_EXPR_START_RE = /^(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/;

/**
 * Normalizes QuickJS transform source into a function expression `(input) => ...`
 * as required by `executeBusinessScript`, supporting arrow functions,
 * `function main(input) { ... }`, statement bodies, and bare expressions.
 */
export function normalizeQuickJsSource(rawSource: string): string {
  const trimmed = rawSource.trim().replace(/;+\s*$/, "");
  if (!trimmed) {
    throw new Error("QuickJS script source cannot be empty.");
  }
  if (DEFINES_MAIN_RE.test(trimmed) && !/^function\s+main\b/.test(trimmed)) {
    return `(input) => {\n${rawSource}\nreturn main(input);\n}`;
  }
  if (FUNCTION_EXPR_START_RE.test(trimmed)) {
    return trimmed;
  }
  if (/\breturn\b/.test(trimmed) || trimmed.includes(";")) {
    return `(input) => {\n  const args = input.args;\n  const files = input.files;\n  ${rawSource}\n}`;
  }
  return `(input) => {\n  const args = input.args;\n  const files = input.files;\n  return (${trimmed});\n}`;
}

function assertCapability(
  bridge: A2uiHostBridge,
  capability: HatchlingCapability,
  operationLabel: string
): void {
  const allowed = bridge.getCapabilities ? bridge.getCapabilities() : null;
  if (!hasCapability(allowed, capability)) {
    throw new Error(
      `Capability '${capability}' is disabled for this hatchling; '${operationLabel}' is not permitted.`
    );
  }
}

function requireWorkspace(bridge: A2uiHostBridge, operationLabel: string): WorkspaceStore {
  if (!bridge.workspace) {
    throw new Error(`Workspace store is unavailable for '${operationLabel}'.`);
  }
  return bridge.workspace;
}

function requireSafeWorkspacePath(rawPath: unknown, operationLabel: string): string {
  if (typeof rawPath !== "string" || !rawPath.trim()) {
    throw new Error(`'${operationLabel}' requires a non-empty workspace path.`);
  }
  const normalized = normalizeWorkspacePath(rawPath);
  if (isProtectedAgentPath(normalized)) {
    throw new Error(`Protected workspace path cannot be accessed: ${normalized}`);
  }
  return normalized;
}

export class A2uiLocalRpcEngine {
  private readonly bridge: A2uiHostBridge;
  private readonly getSurface: (surfaceId: string) => SurfaceModel<ReactCatalogComponent> | undefined;
  private readonly targetPathSeq = new Map<string, number>();
  private readonly sheetRollbacks = new Map<string, SheetRollbackSnapshot>();
  private rollbackSeq = 0;

  constructor(
    bridge: A2uiHostBridge,
    getSurface: (surfaceId: string) => SurfaceModel<ReactCatalogComponent> | undefined
  ) {
    this.bridge = bridge;
    this.getSurface = getSurface;
  }

  async gateExternalOperation(
    toolName: string,
    previewPayload: Record<string, unknown>,
    creates: boolean,
    signal?: AbortSignal
  ): Promise<void> {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const policy = this.bridge.getWritePolicy?.() ?? "autonomous";
    if (policy !== "careful" || !this.bridge.gate) return;
    const permKey = `external:${toolName}`;
    if (this.bridge.permissions?.isAlwaysAllowed(permKey)) return;

    const rawPreview = JSON.stringify(previewPayload, null, 2) ?? "{}";
    const clipped =
      rawPreview.length > 8_192 ? `${rawPreview.slice(0, 8_192)}\n… (truncated)` : rawPreview;
    const diff = clipped
      .split("\n")
      .map((line) => `+ ${line}`)
      .join("\n");
    const threadName = this.bridge.getThreadName?.();
    const decision = await this.bridge.gate(
      {
        path: permKey,
        diff,
        creates,
        beforeBytes: 0,
        afterBytes: encoder.encode(rawPreview).byteLength,
        ...(this.bridge.threadId ? { threadId: this.bridge.threadId } : {}),
        ...(threadName ? { threadName } : {}),
        kind: "external"
      },
      { signal }
    );
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    this.bridge.permissions?.record(permKey, decision);
    if (decision === "reject") {
      this.bridge.onAudit?.({
        category: "effect",
        outcome: "cancelled",
        summary: `Rejected external surface action (${toolName})`,
        evidence: { tool: toolName, source: "a2ui" }
      });
      throw new Error(`The user rejected this external action (${toolName}).`);
    }
  }

  private nextSequence(surfaceId: string | undefined, targetPointer: string | null): number | null {
    if (!surfaceId || !targetPointer) return null;
    const key = `${surfaceId}::${targetPointer}`;
    const next = (this.targetPathSeq.get(key) ?? 0) + 1;
    this.targetPathSeq.set(key, next);
    return next;
  }

  private applyTargetDataIfCurrent(
    surface: SurfaceModel<ReactCatalogComponent> | undefined,
    targetPointer: string | null,
    expectedSeq: number | null,
    value: unknown
  ): { appliedToPath: string | null; stale: boolean } {
    if (!surface || !targetPointer) {
      return { appliedToPath: null, stale: false };
    }
    const key = `${surface.id}::${targetPointer}`;
    if (expectedSeq !== null && this.targetPathSeq.get(key) !== expectedSeq) {
      return { appliedToPath: null, stale: true };
    }
    surface.dataModel.set(targetPointer, value);
    return { appliedToPath: targetPointer, stale: false };
  }

  async executeCall(
    callName: string,
    rawArgs: Record<string, unknown>,
    surface: SurfaceModel<ReactCatalogComponent> | undefined,
    options: LocalRpcCallOptions = {}
  ): Promise<unknown> {
    switch (callName) {
      case "runQuickJsTransform":
        return this.runQuickJsTransform(rawArgs, surface, options);
      case "loadWorkspaceTable":
        return this.loadWorkspaceTable(rawArgs, surface);
      case "readWorkspaceFile":
        return this.readWorkspaceFile(rawArgs, surface);
      case "previewWorkspaceDiff":
        return this.previewWorkspaceDiff(rawArgs);
      case "commitWorkspaceWrite":
        return this.commitWorkspaceWrite(rawArgs, options);
      case "exportSafeCsv":
        return this.exportSafeCsv(rawArgs, options);
      case "exportWorkspacePatch":
        return this.exportWorkspacePatch(rawArgs, options);
      case "commitGoogleSheetValues":
        return this.commitGoogleSheetValues(rawArgs, options);
      case "rollbackGoogleSheetValues":
        return this.rollbackGoogleSheetValues(rawArgs, options);
      case "pickGoogleDriveFiles":
        return this.pickGoogleDriveFiles(rawArgs, surface, options);
      case "sendSlackPreviewMessage":
        return this.sendSlackPreviewMessage(rawArgs, options);
      default:
        throw new Error(`Unknown WasmHatch local RPC function '${callName}'.`);
    }
  }

  async runQuickJsTransform(
    rawArgs: Record<string, unknown>,
    surface: SurfaceModel<ReactCatalogComponent> | undefined,
    options: LocalRpcCallOptions = {}
  ): Promise<QuickJsTransformOutput> {
    assertCapability(this.bridge, "workspace.script", "runQuickJsTransform");
    const targetPointer = normalizeJsonPointer(
      typeof rawArgs.targetPath === "string" ? rawArgs.targetPath : undefined
    );
    const seq = this.nextSequence(surface?.id, targetPointer);

    let scriptSource = typeof rawArgs.script === "string" ? rawArgs.script : "";
    if (!scriptSource.trim() && typeof rawArgs.scriptPath === "string" && rawArgs.scriptPath.trim()) {
      assertCapability(this.bridge, "workspace.read", "runQuickJsTransform(scriptPath)");
      const workspace = requireWorkspace(this.bridge, "runQuickJsTransform");
      const safeScriptPath = requireSafeWorkspacePath(rawArgs.scriptPath, "runQuickJsTransform");
      scriptSource = await workspace.readFile(safeScriptPath);
    }
    const normalizedScript = normalizeQuickJsSource(scriptSource);

    const rawInputPaths = Array.isArray(rawArgs.inputPaths) ? rawArgs.inputPaths : [];
    if (rawInputPaths.length > CHAT_SCRIPT_MAX_INPUT_PATHS) {
      throw new Error(`inputPaths accepts at most ${CHAT_SCRIPT_MAX_INPUT_PATHS} workspace files.`);
    }
    const inputFiles: { path: string; content: string }[] = [];
    if (rawInputPaths.length > 0) {
      assertCapability(this.bridge, "workspace.read", "runQuickJsTransform(inputPaths)");
      const workspace = requireWorkspace(this.bridge, "runQuickJsTransform");
      for (const entry of rawInputPaths) {
        const safePath = requireSafeWorkspacePath(entry, "runQuickJsTransform");
        inputFiles.push({ path: safePath, content: await workspace.readFile(safePath) });
      }
    }

    const requestedTimeout =
      typeof options.timeoutMs === "number" && Number.isFinite(options.timeoutMs)
        ? options.timeoutMs
        : typeof rawArgs.timeoutMs === "number" && Number.isFinite(rawArgs.timeoutMs)
          ? rawArgs.timeoutMs
          : DEFAULT_RPC_SCRIPT_TIMEOUT_MS;
    const timeoutMs = Math.max(50, Math.min(MAX_RPC_SCRIPT_TIMEOUT_MS, Math.round(requestedTimeout)));

    const runner = this.bridge.runScript ?? defaultScriptRunner;
    const scriptResult = await runner(
      normalizedScript,
      {
        args: (rawArgs.args ?? null) as BusinessValue,
        files: inputFiles
      },
      { timeoutMs, signal: options.signal }
    );
    const durationMs = Math.max(1, Math.round(scriptResult.durationMs));
    const applied = this.applyTargetDataIfCurrent(surface, targetPointer, seq, scriptResult.output);

    return {
      result: scriptResult.output,
      durationMs,
      appliedToPath: applied.appliedToPath,
      stale: applied.stale
    };
  }

  async loadWorkspaceTable(
    rawArgs: Record<string, unknown>,
    surface: SurfaceModel<ReactCatalogComponent> | undefined
  ): Promise<LoadedWorkspaceTable> {
    assertCapability(this.bridge, "workspace.read", "loadWorkspaceTable");
    const workspace = requireWorkspace(this.bridge, "loadWorkspaceTable");
    const path = requireSafeWorkspacePath(rawArgs.path, "loadWorkspaceTable");
    const targetPointer = normalizeJsonPointer(
      typeof rawArgs.targetPath === "string" ? rawArgs.targetPath : undefined
    );
    const seq = this.nextSequence(surface?.id, targetPointer);

    const maxRows =
      typeof rawArgs.maxRows === "number" && Number.isFinite(rawArgs.maxRows)
        ? Math.max(1, Math.min(MAX_TABULAR_ROWS, Math.floor(rawArgs.maxRows)))
        : MAX_TABULAR_ROWS;

    const rawContent = await workspace.readFile(path);
    const dataset = parseWorkspaceTabularFile(path, rawContent, maxRows);
    const profile = profileTabularDataset(dataset);
    const rows = dataset.rows.map((row) => ({ ...row.cells }));

    const payload: LoadedWorkspaceTable = {
      path,
      columns: dataset.columns,
      rows,
      profile,
      formulaWarningCount: dataset.formulaWarnings.length,
      totalRows: dataset.totalRows,
      truncated: dataset.truncated
    };

    this.applyTargetDataIfCurrent(surface, targetPointer, seq, payload);
    return payload;
  }

  async readWorkspaceFile(
    rawArgs: Record<string, unknown>,
    surface: SurfaceModel<ReactCatalogComponent> | undefined
  ): Promise<WorkspaceFilePreview> {
    assertCapability(this.bridge, "workspace.read", "readWorkspaceFile");
    const workspace = requireWorkspace(this.bridge, "readWorkspaceFile");
    const path = requireSafeWorkspacePath(rawArgs.path, "readWorkspaceFile");
    const targetPointer = normalizeJsonPointer(
      typeof rawArgs.targetPath === "string" ? rawArgs.targetPath : undefined
    );
    const seq = this.nextSequence(surface?.id, targetPointer);

    const fullContent = await workspace.readFile(path);
    const byteLength = encoder.encode(fullContent).byteLength;
    const allLines = fullContent.split("\n");
    const maxLines =
      typeof rawArgs.maxLines === "number" && Number.isFinite(rawArgs.maxLines)
        ? Math.max(1, Math.min(500, Math.floor(rawArgs.maxLines)))
        : 120;
    const sliced = allLines.slice(0, maxLines).join("\n");
    const bounded = clampUtf8Preview(sliced, MAX_FILE_PREVIEW_BYTES);

    const preview: WorkspaceFilePreview = {
      path,
      content: bounded.content,
      totalLines: allLines.length,
      byteLength,
      truncated: bounded.truncated || allLines.length > maxLines
    };

    this.applyTargetDataIfCurrent(surface, targetPointer, seq, preview);
    return preview;
  }

  async previewWorkspaceDiff(rawArgs: Record<string, unknown>): Promise<WorkspaceDiffPreview> {
    assertCapability(this.bridge, "workspace.read", "previewWorkspaceDiff");
    const workspace = requireWorkspace(this.bridge, "previewWorkspaceDiff");
    const path = requireSafeWorkspacePath(rawArgs.path, "previewWorkspaceDiff");
    const proposedContent =
      typeof rawArgs.proposedContent === "string" ? rawArgs.proposedContent : "";

    let before = "";
    let creates = false;
    try {
      before = await workspace.readFile(path);
    } catch {
      creates = true;
    }

    const unchanged = !creates && before === proposedContent;
    const diff = unchanged
      ? `--- a/${path}\n+++ b/${path}\n(no changes)`
      : createReadableDiff(path, before, proposedContent);

    return {
      path,
      creates,
      unchanged,
      beforeBytes: encoder.encode(before).byteLength,
      afterBytes: encoder.encode(proposedContent).byteLength,
      diff
    };
  }

  async commitWorkspaceWrite(
    rawArgs: Record<string, unknown>,
    options: LocalRpcCallOptions = {}
  ): Promise<WorkspaceWriteResult> {
    if (!options.userActivated) {
      throw new Error(
        "commitWorkspaceWrite requires an explicit user gesture (userActivated: true)."
      );
    }
    assertCapability(this.bridge, "workspace.write", "commitWorkspaceWrite");
    const workspace = requireWorkspace(this.bridge, "commitWorkspaceWrite");
    const path = requireSafeWorkspacePath(rawArgs.path, "commitWorkspaceWrite");
    if (typeof rawArgs.content !== "string") {
      throw new Error("commitWorkspaceWrite requires a string 'content' argument.");
    }
    const content = rawArgs.content;
    const afterBytes = encoder.encode(content).byteLength;
    if (afterBytes > CHAT_WRITE_MAX_BYTES) {
      throw new Error(
        `Content exceeds the ${CHAT_WRITE_MAX_BYTES.toLocaleString()}-byte workspace write limit.`
      );
    }

    let before = "";
    let creates = false;
    try {
      before = await workspace.readFile(path);
    } catch {
      creates = true;
    }

    if (!creates && before === content) {
      return {
        status: "unchanged",
        path,
        creates: false,
        afterBytes,
        diff: `--- a/${path}\n+++ b/${path}\n(no changes)`
      };
    }

    const policy = this.bridge.getWritePolicy?.() ?? "autonomous";
    const diff = createReadableDiff(path, before, content);
    if (
      policy === "careful" &&
      this.bridge.gate &&
      !(this.bridge.permissions?.isAlwaysAllowed(path) ?? false)
    ) {
      const threadName = this.bridge.getThreadName?.();
      const decision = await this.bridge.gate(
        {
          path,
          diff,
          creates,
          beforeBytes: encoder.encode(before).byteLength,
          afterBytes,
          ...(this.bridge.threadId ? { threadId: this.bridge.threadId } : {}),
          ...(threadName ? { threadName } : {}),
          kind: "workspace"
        },
        { signal: options.signal }
      );
      this.bridge.permissions?.record(path, decision);
      if (decision === "reject") {
        this.bridge.onAudit?.({
          category: "effect",
          outcome: "cancelled",
          summary: `Rejected surface write to ${path}`,
          evidence: { path, source: "a2ui" }
        });
        throw new Error(`The user rejected writing ${path}.`);
      }
    }

    await workspace.writeFile(path, content);
    this.bridge.onWrite?.(path);
    this.bridge.onAppliedWrite?.({
      path,
      diff,
      creates,
      before,
      after: content,
      policy
    });
    this.bridge.onAudit?.({
      category: "effect",
      outcome: "completed",
      summary: `${creates ? "Created" : "Updated"} ${path} from interactive surface`,
      evidence: { path, bytes: afterBytes, policy, source: "a2ui" }
    });

    return {
      status: "applied",
      path,
      creates,
      afterBytes,
      diff
    };
  }

  async exportSafeCsv(
    rawArgs: Record<string, unknown>,
    options: LocalRpcCallOptions = {}
  ): Promise<{ fileName: string; rowCount: number; neutralizedFormulaCount: number }> {
    if (!options.userActivated) {
      throw new Error("exportSafeCsv requires an explicit user gesture (userActivated: true).");
    }
    const dataset = normalizeTabularDataset(rawArgs.rows, rawArgs.columns);
    const csvText = serializeSafeCsv(dataset.columns, dataset.rows, { neutralizeFormulas: true });
    const rawName =
      typeof rawArgs.fileName === "string" && rawArgs.fileName.trim()
        ? rawArgs.fileName.trim()
        : "export.csv";
    const fileName = rawName.toLowerCase().endsWith(".csv") ? rawName : `${rawName}.csv`;
    const download = this.bridge.onDownload ?? defaultDownloadHandler;
    download(fileName, csvText, "text/csv");

    return {
      fileName,
      rowCount: dataset.rows.length,
      neutralizedFormulaCount: dataset.formulaWarnings.length
    };
  }

  async exportWorkspacePatch(
    rawArgs: Record<string, unknown>,
    options: LocalRpcCallOptions = {}
  ): Promise<{ fileName: string; byteLength: number }> {
    if (!options.userActivated) {
      throw new Error(
        "exportWorkspacePatch requires an explicit user gesture (userActivated: true)."
      );
    }
    const path =
      typeof rawArgs.path === "string" && rawArgs.path.trim()
        ? normalizeWorkspacePath(rawArgs.path)
        : "changes";
    let diffText = typeof rawArgs.diff === "string" ? rawArgs.diff : "";
    if (!diffText && typeof rawArgs.proposedContent === "string") {
      const preview = await this.previewWorkspaceDiff({
        path,
        proposedContent: rawArgs.proposedContent
      });
      diffText = preview.diff;
    }
    const baseName = path.split("/").pop() || "changes";
    const rawFileName =
      typeof rawArgs.fileName === "string" && rawArgs.fileName.trim()
        ? rawArgs.fileName.trim()
        : `${baseName}.patch`;
    const fileName = rawFileName.endsWith(".patch") ? rawFileName : `${rawFileName}.patch`;
    const download = this.bridge.onDownload ?? defaultDownloadHandler;
    download(fileName, `${diffText}\n`, "text/plain");
    return {
      fileName,
      byteLength: encoder.encode(diffText).byteLength
    };
  }

  async commitGoogleSheetValues(
    rawArgs: Record<string, unknown>,
    options: LocalRpcCallOptions = {}
  ): Promise<GoogleSheetCommitResult> {
    if (!options.userActivated) {
      throw new Error(
        "commitGoogleSheetValues requires an explicit user gesture (userActivated: true)."
      );
    }
    assertCapability(this.bridge, "google", "commitGoogleSheetValues");
    if (!this.bridge.google?.isConnected()) {
      throw new Error("Google Workspace is not connected. Sign in to Google in the sidebar first.");
    }
    const spreadsheetId =
      typeof rawArgs.spreadsheetId === "string" ? rawArgs.spreadsheetId.trim() : "";
    const range = typeof rawArgs.range === "string" ? rawArgs.range.trim() : "";
    if (!spreadsheetId || !range) {
      throw new Error("commitGoogleSheetValues requires non-empty spreadsheetId and range.");
    }
    if (!Array.isArray(rawArgs.values) || rawArgs.values.length === 0) {
      throw new Error("commitGoogleSheetValues requires a non-empty 2D values array.");
    }
    const values: string[][] = rawArgs.values.map((row) => {
      if (!Array.isArray(row)) {
        throw new Error("commitGoogleSheetValues values must be a 2D array of rows.");
      }
      return row.map((cell) => (cell === null || cell === undefined ? "" : String(cell)));
    });

    await this.gateExternalOperation(
      "update_google_sheet_values",
      { spreadsheetId, range, values },
      false,
      options.signal
    );

    const googleExec = createGoogleConnectorExecutor(this.bridge.google.getToken, {
      fetchImpl: this.bridge.google.fetchImpl
    });

    // Read pre-write cell values so 1-click Rollback can restore the exact prior state.
    let priorRaw: string[][] = [];
    const readOutcome = await googleExec(
      "read_google_sheet_values",
      { spreadsheetId, range },
      { signal: options.signal }
    );
    if (!readOutcome.isError) {
      try {
        const parsed = JSON.parse(readOutcome.content) as { values?: unknown };
        if (Array.isArray(parsed.values)) {
          priorRaw = parsed.values.map((r) =>
            Array.isArray(r) ? r.map((c) => (c === null || c === undefined ? "" : String(c))) : []
          );
        }
      } catch {
        priorRaw = [];
      }
    }

    const rowHeight = Math.max(values.length, priorRaw.length);
    const colWidth = Math.max(
      ...values.map((r) => r.length),
      ...priorRaw.map((r) => r.length),
      1
    );
    const paddedPrevious: string[][] = Array.from({ length: rowHeight }, (_, rIdx) =>
      Array.from({ length: colWidth }, (__, cIdx) => priorRaw[rIdx]?.[cIdx] ?? "")
    );

    const writeOutcome = await googleExec(
      "update_google_sheet_values",
      { spreadsheetId, range, values },
      { signal: options.signal }
    );
    if (writeOutcome.isError) {
      this.bridge.onAudit?.({
        category: "effect",
        outcome: "failed",
        summary: `Failed updating Google Sheet ${spreadsheetId} (${range})`,
        evidence: { spreadsheetId, range, source: "a2ui" }
      });
      throw new Error(writeOutcome.content);
    }

    let updatedCells = values.reduce((sum, r) => sum + r.length, 0);
    try {
      const parsedWrite = JSON.parse(writeOutcome.content) as { updatedCells?: unknown };
      if (typeof parsedWrite.updatedCells === "number") {
        updatedCells = parsedWrite.updatedCells;
      }
    } catch {
      // Keep row*col count fallback.
    }

    this.rollbackSeq += 1;
    const rollbackId = `sheet_rb_${this.rollbackSeq}`;
    if (this.sheetRollbacks.size >= MAX_SHEET_ROLLBACKS) {
      const oldest = this.sheetRollbacks.keys().next().value;
      if (oldest !== undefined) this.sheetRollbacks.delete(oldest);
    }
    this.sheetRollbacks.set(rollbackId, {
      spreadsheetId,
      range,
      previousValues: paddedPrevious
    });

    this.bridge.onAudit?.({
      category: "effect",
      outcome: "completed",
      summary: `Updated Google Sheet ${spreadsheetId} (${range}) from interactive surface`,
      evidence: { spreadsheetId, range, updatedCells, source: "a2ui" }
    });

    return {
      status: "updated",
      spreadsheetId,
      range,
      updatedCells,
      rollbackId
    };
  }

  async rollbackGoogleSheetValues(
    rawArgs: Record<string, unknown>,
    options: LocalRpcCallOptions = {}
  ): Promise<GoogleSheetRollbackResult> {
    if (!options.userActivated) {
      throw new Error(
        "rollbackGoogleSheetValues requires an explicit user gesture (userActivated: true)."
      );
    }
    assertCapability(this.bridge, "google", "rollbackGoogleSheetValues");
    if (!this.bridge.google?.isConnected()) {
      throw new Error("Google Workspace is not connected.");
    }
    const rollbackId = typeof rawArgs.rollbackId === "string" ? rawArgs.rollbackId.trim() : "";
    const snapshot = this.sheetRollbacks.get(rollbackId);
    if (!snapshot) {
      throw new Error("Rollback snapshot expired or was already applied.");
    }

    const googleExec = createGoogleConnectorExecutor(this.bridge.google.getToken, {
      fetchImpl: this.bridge.google.fetchImpl
    });
    const restoreOutcome = await googleExec(
      "update_google_sheet_values",
      {
        spreadsheetId: snapshot.spreadsheetId,
        range: snapshot.range,
        values: snapshot.previousValues
      },
      { signal: options.signal }
    );
    if (restoreOutcome.isError) {
      throw new Error(restoreOutcome.content);
    }
    this.sheetRollbacks.delete(rollbackId);

    let updatedCells = snapshot.previousValues.reduce((sum, r) => sum + r.length, 0);
    try {
      const parsed = JSON.parse(restoreOutcome.content) as { updatedCells?: unknown };
      if (typeof parsed.updatedCells === "number") updatedCells = parsed.updatedCells;
    } catch {
      // Keep fallback.
    }

    this.bridge.onAudit?.({
      category: "effect",
      outcome: "cancelled",
      summary: `Rolled back Google Sheet ${snapshot.spreadsheetId} (${snapshot.range})`,
      evidence: { spreadsheetId: snapshot.spreadsheetId, range: snapshot.range, source: "a2ui" }
    });

    return {
      status: "reverted",
      spreadsheetId: snapshot.spreadsheetId,
      range: snapshot.range,
      updatedCells
    };
  }

  async pickGoogleDriveFiles(
    rawArgs: Record<string, unknown>,
    surface: SurfaceModel<ReactCatalogComponent> | undefined,
    options: LocalRpcCallOptions = {}
  ): Promise<GooglePickerRpcResult> {
    if (!options.userActivated) {
      throw new Error(
        "pickGoogleDriveFiles requires an explicit user gesture (userActivated: true)."
      );
    }
    assertCapability(this.bridge, "google", "pickGoogleDriveFiles");
    if (!this.bridge.google?.isConnected() || !this.bridge.google.requestFilePick) {
      throw new Error("Google Picker handover is not available in this session.");
    }
    const reason =
      typeof rawArgs.reason === "string" && rawArgs.reason.trim()
        ? rawArgs.reason.trim()
        : "Select Google Drive files to share with this hatchling.";
    const targetPointer = normalizeJsonPointer(
      typeof rawArgs.targetPath === "string" ? rawArgs.targetPath : undefined
    );
    const seq = this.nextSequence(surface?.id, targetPointer);

    const files = await this.bridge.google.requestFilePick(reason, options.signal);
    const result: GooglePickerRpcResult = {
      picked: files ? [...files] : [],
      cancelled: files === null
    };
    if (files !== null) {
      this.applyTargetDataIfCurrent(surface, targetPointer, seq, result.picked);
    }
    this.bridge.onAudit?.({
      category: "tool",
      outcome: files === null ? "cancelled" : "completed",
      summary:
        files === null
          ? "Declined Google Drive file handover"
          : `Handed over ${files.length} Google Drive file(s)`,
      evidence: { count: files?.length ?? 0, source: "a2ui" }
    });
    return result;
  }

  async sendSlackPreviewMessage(
    rawArgs: Record<string, unknown>,
    options: LocalRpcCallOptions = {}
  ): Promise<SlackPreviewSendResult> {
    if (!options.userActivated) {
      throw new Error(
        "sendSlackPreviewMessage requires an explicit user gesture (userActivated: true)."
      );
    }
    assertCapability(this.bridge, "slack", "sendSlackPreviewMessage");
    const text = typeof rawArgs.text === "string" ? rawArgs.text : "";
    if (!text.trim()) {
      throw new Error("Slack message text cannot be empty.");
    }
    if (text.length > SLACK_MAX_CHARS) {
      throw new Error(`Slack message exceeds ${SLACK_MAX_CHARS.toLocaleString()} characters.`);
    }
    const channel = typeof rawArgs.channel === "string" ? rawArgs.channel.trim() : "";
    const botToken = this.bridge.slack?.getToken?.()?.trim() ?? "";
    const webhookUrl = this.bridge.slack?.getWebhookUrl?.()?.trim() ?? "";

    if (channel && botToken) {
      await this.gateExternalOperation(
        "send_slack_channel_message",
        { channel, text },
        true,
        options.signal
      );
      const exec = createSlackApiExecutor(() => this.bridge.slack?.getToken?.() ?? "", {
        fetchImpl: this.bridge.slack?.fetchImpl,
        baseUrl: slackProxyBaseUrl()
      });
      const outcome = await exec("send_slack_channel_message", { channel, text }, { signal: options.signal });
      if (outcome.isError) {
        this.bridge.onAudit?.({
          category: "effect",
          outcome: "failed",
          summary: `Failed sending Slack message to ${channel}`,
          evidence: { channel, source: "a2ui" }
        });
        throw new Error(outcome.content);
      }
      this.bridge.onAudit?.({
        category: "effect",
        outcome: "completed",
        summary: `Sent Slack message to ${channel} from interactive surface`,
        evidence: { channel, chars: text.length, source: "a2ui" }
      });
      return { status: "sent", route: "bot", summary: outcome.content };
    }

    if (webhookUrl) {
      await this.gateExternalOperation("post_slack_message", { text }, true, options.signal);
      const exec = createSlackWebhookExecutor(() => this.bridge.slack?.getWebhookUrl() ?? "", {
        fetchImpl: this.bridge.slack?.fetchImpl
      });
      const outcome = await exec("post_slack_message", { text }, { signal: options.signal });
      if (outcome.isError) {
        this.bridge.onAudit?.({
          category: "effect",
          outcome: "failed",
          summary: "Failed posting Slack webhook message",
          evidence: { source: "a2ui" }
        });
        throw new Error(outcome.content);
      }
      this.bridge.onAudit?.({
        category: "effect",
        outcome: "completed",
        summary: "Posted Slack webhook message from interactive surface",
        evidence: { chars: text.length, source: "a2ui" }
      });
      return { status: "sent", route: "webhook", summary: outcome.content };
    }

    throw new Error("Slack is not connected. Connect an Incoming Webhook or Bot Token in the sidebar.");
  }

  getSurfaceById(surfaceId: string): SurfaceModel<ReactCatalogComponent> | undefined {
    return this.getSurface(surfaceId);
  }
}

export interface A2uiSurfaceRpcBridge {
  surfaceId: string;
  callLocalRpc: <T = unknown>(
    callName: string,
    args: Record<string, unknown>,
    options?: LocalRpcCallOptions
  ) => Promise<T>;
  canUseCapability: (capability: HatchlingCapability) => boolean;
  sendFollowUpMessage?: (text: string, label?: string) => void | Promise<void>;
}

export const A2uiSurfaceRpcContext = createContext<A2uiSurfaceRpcBridge | null>(null);

export function useA2uiSurfaceRpc(): A2uiSurfaceRpcBridge | null {
  return useContext(A2uiSurfaceRpcContext);
}
