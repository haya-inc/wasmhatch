/**
 * MCP Apps (`ext-apps` / `ui://`) JSON-RPC 2.0 host bridge and double-iframe
 * sandbox coordinator for `@a2ui/catalog-mcp` (`McpApp`).
 *
 * Security model:
 * - Zero-config fork-ready default: outer `<iframe sandbox="allow-scripts">`
 *   on `/a2ui-mcp-sandbox.html` (opaque `"null"` origin) + inner guest
 *   `<iframe sandbox="allow-scripts" srcdoc="...">` (second distinct opaque origin)
 *   with `allow-same-origin` unconditionally stripped and per-resource `<meta>` CSP.
 * - Optional isolated-origin upgrade: when `VITE_USERCONTENT_ORIGIN` (`https://...`)
 *   is configured, the outer proxy runs on that dedicated cross-origin domain and
 *   both host and proxy enforce strict `Origin` pinning.
 * - Origin verification uses the browser `Origin` API (`Origin.from(event)`) when
 *   available to pin opaque origins by identity, falling back to `event.source === expectedWindow`
 *   plus `new URL()` origin comparison (never comparing two `"null"` strings alone).
 * - Every incoming JSON-RPC payload is validated for depth (`<= 10`), byte size
 *   (`<= 64 KB`), and prototype-pollution keys (`__proto__`, `constructor`, `prototype`).
 */

import type { DataModel } from "@a2ui/web_core/v1_0";

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const encoder = new TextEncoder();

export const MAX_MCP_BRIDGE_DEPTH = 10;
export const MAX_MCP_BRIDGE_BYTES = 65_536;
export const MIN_MCP_APP_HEIGHT = 120;
export const MAX_MCP_APP_HEIGHT = 2_000;
export const DEFAULT_MCP_APP_HEIGHT = 360;
const MAX_MODEL_CONTEXT_CHARS = 8_192;

interface BrowserOriginLike {
  readonly opaque: boolean;
  isSameOrigin(other: BrowserOriginLike): boolean;
}

interface BrowserOriginConstructor {
  from(value: unknown): BrowserOriginLike;
  parse(serialized: string): BrowserOriginLike;
}

function getBrowserOriginApi(): BrowserOriginConstructor | null {
  const candidate = (globalThis as { Origin?: unknown }).Origin;
  if (
    candidate &&
    typeof candidate === "function" &&
    typeof (candidate as unknown as BrowserOriginConstructor).from === "function" &&
    typeof (candidate as unknown as BrowserOriginConstructor).parse === "function"
  ) {
    return candidate as unknown as BrowserOriginConstructor;
  }
  return null;
}

export interface McpAppCspConfig {
  connectDomains?: readonly string[];
  resourceDomains?: readonly string[];
  frameDomains?: readonly string[];
}

export interface McpAppPermissionsConfig {
  camera?: boolean;
  microphone?: boolean;
  geolocation?: boolean;
  clipboardWrite?: boolean;
}

export interface AllowedFunctionSchema {
  type?: string;
  required?: readonly string[];
  properties?: Record<
    string,
    {
      type?: string;
      enum?: readonly unknown[];
      minimum?: number;
      maximum?: number;
      maxLength?: number;
    }
  >;
  additionalProperties?: boolean;
}

export interface AllowedFunctionConfig {
  name: string;
  schema?: AllowedFunctionSchema;
}

export interface McpSandboxConfig {
  mode: "null-origin" | "isolated-origin";
  proxyUrl: string;
  targetOrigin: string;
  outerSandbox: string;
}

export function isSameHttpOrigin(originA: string, originB: string): boolean {
  if (!originA || !originB || originA === "null" || originB === "null") {
    return false;
  }
  try {
    const a = new URL(originA);
    const b = new URL(originB);
    return (
      (a.protocol === "https:" || a.protocol === "http:") &&
      a.origin === b.origin
    );
  } catch {
    return false;
  }
}

export function resolveMcpSandboxConfig(options: {
  usercontentOrigin?: string;
  hostOrigin?: string;
  baseUrl?: string;
} = {}): McpSandboxConfig {
  const env = (import.meta as { env?: Record<string, string | undefined> }).env;
  const rawUsercontent = (options.usercontentOrigin ?? env?.VITE_USERCONTENT_ORIGIN ?? "").trim();
  const hostOrigin =
    options.hostOrigin ??
    (typeof window !== "undefined" && window.location?.origin && window.location.origin !== "null"
      ? window.location.origin
      : "");
  const baseUrl = options.baseUrl ?? env?.BASE_URL ?? "/";
  const normalizedBase = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const hostParam =
    hostOrigin && (hostOrigin.startsWith("https://") || hostOrigin.startsWith("http://"))
      ? `?hostOrigin=${encodeURIComponent(hostOrigin)}`
      : "";

  if (rawUsercontent) {
    try {
      const parsed = new URL(rawUsercontent);
      if (parsed.protocol === "https:" && (!hostOrigin || !isSameHttpOrigin(parsed.origin, hostOrigin))) {
        return {
          mode: "isolated-origin",
          proxyUrl: `${parsed.origin}/a2ui-mcp-sandbox.html${hostParam}`,
          targetOrigin: parsed.origin,
          outerSandbox: "allow-scripts allow-same-origin"
        };
      }
    } catch {
      // Fall back to null-origin sandbox if VITE_USERCONTENT_ORIGIN is malformed.
    }
  }

  return {
    mode: "null-origin",
    proxyUrl: `${normalizedBase}a2ui-mcp-sandbox.html${hostParam}`,
    targetOrigin: "*",
    outerSandbox: "allow-scripts"
  };
}

export interface MessageEventLike {
  readonly source: unknown;
  readonly origin: string;
  readonly data: unknown;
}

export interface ProxyWindowLike {
  postMessage(message: unknown, targetOrigin: string): void;
}

/**
 * Creates a strict per-iframe origin + window-source validator.
 *
 * - Always verifies `event.source === expectedWindow`.
 * - Uses `Origin.from(event)` when supported to pin even opaque `"null"` origins
 *   to the exact tuple origin instance created by this sandboxed iframe.
 * - Never compares two `"null"` origin strings directly as proof of identity.
 */
export function createProxyOriginGuard(
  expectedWindow: unknown,
  sandboxConfig: Pick<McpSandboxConfig, "mode" | "targetOrigin">
): (event: MessageEventLike) => boolean {
  const OriginApi = getBrowserOriginApi();
  let pinnedOpaqueOrigin: BrowserOriginLike | null = null;

  return (event: MessageEventLike): boolean => {
    if (!expectedWindow || event.source !== expectedWindow) {
      return false;
    }

    if (OriginApi) {
      try {
        const incoming = OriginApi.from(event);
        if (sandboxConfig.mode === "isolated-origin") {
          const expected = OriginApi.parse(sandboxConfig.targetOrigin);
          return !incoming.opaque && expected.isSameOrigin(incoming);
        }
        if (!incoming.opaque) {
          return false;
        }
        if (!pinnedOpaqueOrigin) {
          pinnedOpaqueOrigin = incoming;
          return true;
        }
        return pinnedOpaqueOrigin.isSameOrigin(incoming);
      } catch {
        // Synthetic MessageEvents in unit tests may not be native platform Event instances;
        // fall through to explicit URL / source validation below.
      }
    }

    if (sandboxConfig.mode === "isolated-origin") {
      return isSameHttpOrigin(event.origin, sandboxConfig.targetOrigin);
    }

    // Null-origin sandbox mode: `event.source === expectedWindow` has already been verified above,
    // and the sandboxed proxy must report an opaque `"null"` origin.
    return event.origin === "null" || event.origin === "";
  };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === null || proto === Object.prototype;
}

function checkSafeStructure(value: unknown, depth: number): string | null {
  if (depth > MAX_MCP_BRIDGE_DEPTH) {
    return `Payload exceeds maximum nesting depth (${MAX_MCP_BRIDGE_DEPTH}).`;
  }
  if (value === null || value === undefined) return null;
  const t = typeof value;
  if (t === "string" || t === "number" || t === "boolean") {
    if (t === "number" && !Number.isFinite(value as number)) {
      return "Payload contains non-finite number.";
    }
    return null;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const err = checkSafeStructure(value[i], depth + 1);
      if (err) return err;
    }
    return null;
  }
  if (!isPlainRecord(value)) {
    return "Payload contains unsupported object prototype.";
  }
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEYS.has(key)) {
      return `Payload contains forbidden key "${key}".`;
    }
    const err = checkSafeStructure(value[key], depth + 1);
    if (err) return err;
  }
  return null;
}

export interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export function validateMcpJsonRpcPayload(
  raw: unknown,
  maxBytes = MAX_MCP_BRIDGE_BYTES
): { ok: true; message: JsonRpcMessage } | { ok: false; reason: string } {
  if (!isPlainRecord(raw)) {
    return { ok: false, reason: "Message must be a plain JSON object." };
  }
  if (raw.jsonrpc !== "2.0") {
    return { ok: false, reason: 'Message must declare jsonrpc: "2.0".' };
  }
  const hasMethod = typeof raw.method === "string" && raw.method.length > 0;
  const hasId = typeof raw.id === "string" || typeof raw.id === "number";
  if (!hasMethod && !hasId) {
    return { ok: false, reason: "JSON-RPC message must include method or id." };
  }
  if (raw.params !== undefined && !isPlainRecord(raw.params)) {
    return { ok: false, reason: "JSON-RPC params must be a plain object." };
  }
  const structureErr = checkSafeStructure(raw, 0);
  if (structureErr) {
    return { ok: false, reason: structureErr };
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(raw);
  } catch {
    return { ok: false, reason: "Payload is not JSON-serializable." };
  }
  if (encoder.encode(serialized).byteLength > maxBytes) {
    return { ok: false, reason: `Payload exceeds ${maxBytes}-byte limit.` };
  }
  return { ok: true, message: raw as unknown as JsonRpcMessage };
}

export function normalizeSafeJsonPointer(rawPath: string): string | null {
  if (typeof rawPath !== "string") return null;
  const trimmed = rawPath.trim();
  if (!trimmed) return null;
  const withoutDollar = trimmed.startsWith("$/")
    ? trimmed.slice(1)
    : trimmed.startsWith("$")
      ? `/${trimmed.slice(1)}`
      : trimmed;
  const pointer = withoutDollar.startsWith("/") ? withoutDollar : `/${withoutDollar}`;
  if (pointer === "/") return "/";
  const segments = pointer.slice(1).split("/");
  for (const rawSeg of segments) {
    const decoded = rawSeg.replace(/~1/g, "/").replace(/~0/g, "~");
    if (!decoded || FORBIDDEN_KEYS.has(decoded)) {
      return null;
    }
  }
  return pointer;
}

function subpathHasForbiddenSegment(subpath: string | undefined): boolean {
  if (!subpath) return false;
  return subpath
    .split("/")
    .filter(Boolean)
    .some((seg) => FORBIDDEN_KEYS.has(seg.replace(/~1/g, "/").replace(/~0/g, "~")));
}

export function normalizeDataPathsMap(
  rawPaths: Readonly<Record<string, string>> | readonly string[] | undefined
): Map<string, string> {
  const map = new Map<string, string>();
  if (!rawPaths) return map;
  if (Array.isArray(rawPaths)) {
    for (const raw of rawPaths) {
      if (typeof raw !== "string") continue;
      const ptr = normalizeSafeJsonPointer(raw);
      if (ptr) map.set(ptr, ptr);
    }
    return map;
  }
  for (const [key, raw] of Object.entries(rawPaths)) {
    if (!key || FORBIDDEN_KEYS.has(key) || typeof raw !== "string") continue;
    const ptr = normalizeSafeJsonPointer(raw);
    if (ptr) map.set(key, ptr);
  }
  return map;
}

export function normalizeAllowedFunctions(
  raw:
    | Readonly<Record<string, unknown>>
    | readonly AllowedFunctionConfig[]
    | undefined
): Map<string, AllowedFunctionConfig> {
  const map = new Map<string, AllowedFunctionConfig>();
  if (!raw) return map;
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (entry && typeof entry.name === "string" && entry.name) {
        map.set(entry.name, entry);
      }
    }
    return map;
  }
  for (const [name, schemaVal] of Object.entries(raw)) {
    if (!name || FORBIDDEN_KEYS.has(name)) continue;
    map.set(name, {
      name,
      schema: isPlainRecord(schemaVal) ? (schemaVal as AllowedFunctionSchema) : undefined
    });
  }
  return map;
}

export function validateAllowedFunctionArgs(
  args: Record<string, unknown>,
  schema: AllowedFunctionSchema | undefined
): string | null {
  if (!schema) return null;
  if (schema.required) {
    for (const req of schema.required) {
      if (!Object.prototype.hasOwnProperty.call(args, req) || args[req] === undefined) {
        return `Missing required argument "${req}".`;
      }
    }
  }
  const props = schema.properties ?? {};
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(args)) {
      if (!Object.prototype.hasOwnProperty.call(props, key)) {
        return `Unexpected argument "${key}".`;
      }
    }
  }
  for (const [key, propSchema] of Object.entries(props)) {
    if (!Object.prototype.hasOwnProperty.call(args, key) || args[key] === undefined) continue;
    const val = args[key];
    if (propSchema.type) {
      const actual =
        val === null ? "null" : Array.isArray(val) ? "array" : typeof val;
      if (propSchema.type === "integer") {
        if (typeof val !== "number" || !Number.isInteger(val)) {
          return `Argument "${key}" must be an integer.`;
        }
      } else if (actual !== propSchema.type) {
        return `Argument "${key}" must be of type ${propSchema.type}.`;
      }
    }
    if (propSchema.enum && !propSchema.enum.includes(val)) {
      return `Argument "${key}" is not one of the allowed enum values.`;
    }
    if (typeof val === "number") {
      if (propSchema.minimum !== undefined && val < propSchema.minimum) {
        return `Argument "${key}" must be >= ${propSchema.minimum}.`;
      }
      if (propSchema.maximum !== undefined && val > propSchema.maximum) {
        return `Argument "${key}" must be <= ${propSchema.maximum}.`;
      }
    }
    if (typeof val === "string" && propSchema.maxLength !== undefined && val.length > propSchema.maxLength) {
      return `Argument "${key}" exceeds maxLength ${propSchema.maxLength}.`;
    }
  }
  return null;
}

/**
 * Bidirectional A2UI `DataModel` <-> MCP App guest synchronization confined
 * strictly to declared `data.paths` (either `{ [key]: "/pointer" }` or `["/pointer"]`).
 */
export class McpAppDataModelSync {
  private readonly keyToPointer: Map<string, string>;
  private readonly pointerToKeys: Map<string, string[]>;
  private readonly subscriptions: Array<{ unsubscribe: () => void }> = [];
  private readonly lastSerialized = new Map<string, string>();
  private applyingGuestUpdate = false;

  constructor(
    private readonly dataModel: DataModel,
    rawPaths: Readonly<Record<string, string>> | readonly string[] | undefined,
    private readonly onOutboundUpdate: (payload: {
      data: Record<string, unknown>;
      changedKeys: string[];
    }) => void
  ) {
    this.keyToPointer = normalizeDataPathsMap(rawPaths);
    this.pointerToKeys = new Map();
    for (const [key, ptr] of this.keyToPointer.entries()) {
      const list = this.pointerToKeys.get(ptr) ?? [];
      list.push(key);
      this.pointerToKeys.set(ptr, list);
    }
  }

  get hasBindings(): boolean {
    return this.keyToPointer.size > 0;
  }

  get boundKeys(): string[] {
    return [...this.keyToPointer.keys()];
  }

  snapshot(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, ptr] of this.keyToPointer.entries()) {
      const val = this.dataModel.get(ptr);
      out[key] = val === undefined ? null : structuredClone(val);
    }
    return out;
  }

  start(): void {
    this.stop();
    for (const [key, ptr] of this.keyToPointer.entries()) {
      const initial = this.dataModel.get(ptr);
      this.lastSerialized.set(key, JSON.stringify(initial ?? null));
      const sub = this.dataModel.subscribe(ptr, () => {
        if (this.applyingGuestUpdate) return;
        const nextVal = this.dataModel.get(ptr);
        const nextJson = JSON.stringify(nextVal ?? null);
        if (this.lastSerialized.get(key) === nextJson) return;
        this.lastSerialized.set(key, nextJson);
        this.onOutboundUpdate({
          data: { [key]: nextVal === undefined ? null : structuredClone(nextVal) },
          changedKeys: [key]
        });
      });
      this.subscriptions.push(sub);
    }
  }

  private resolveTargetPointer(
    keyOrPath: string,
    subpath?: string
  ): { key: string; pointer: string } | null {
    if (subpathHasForbiddenSegment(subpath)) return null;
    const mappedPtr = this.keyToPointer.get(keyOrPath);
    if (mappedPtr) {
      if (!subpath) return { key: keyOrPath, pointer: mappedPtr };
      const cleanSub = subpath.startsWith("/") ? subpath : `/${subpath}`;
      const combined = mappedPtr === "/" ? cleanSub : `${mappedPtr}${cleanSub}`;
      const safeCombined = normalizeSafeJsonPointer(combined);
      return safeCombined ? { key: keyOrPath, pointer: safeCombined } : null;
    }

    // Also allow direct JSON pointer writes when that pointer is within a bound root pointer.
    const candidatePtr = normalizeSafeJsonPointer(keyOrPath);
    if (!candidatePtr) return null;
    for (const [boundKey, boundPtr] of this.keyToPointer.entries()) {
      if (
        (boundPtr === "/" && candidatePtr !== "/") ||
        candidatePtr === boundPtr ||
        candidatePtr.startsWith(`${boundPtr}/`)
      ) {
        return { key: boundKey, pointer: candidatePtr };
      }
    }
    return null;
  }

  applyGuestChange(params: Record<string, unknown>): { applied: string[]; rejected: string[] } {
    const applied: string[] = [];
    const rejected: string[] = [];

    const candidateWrites: Array<{ keyOrPath: string; subpath?: string; value: unknown }> = [];
    if (typeof params.key === "string" && "value" in params) {
      candidateWrites.push({
        keyOrPath: params.key,
        subpath: typeof params.subpath === "string" ? params.subpath : undefined,
        value: params.value
      });
    } else if (typeof params.path === "string" && "value" in params) {
      candidateWrites.push({ keyOrPath: params.path, value: params.value });
    }
    if (isPlainRecord(params.updates)) {
      for (const [k, v] of Object.entries(params.updates)) {
        candidateWrites.push({ keyOrPath: k, value: v });
      }
    }

    this.applyingGuestUpdate = true;
    try {
      for (const item of candidateWrites) {
        const resolved = this.resolveTargetPointer(item.keyOrPath, item.subpath);
        if (!resolved || checkSafeStructure(item.value, 0) !== null) {
          rejected.push(item.keyOrPath);
          continue;
        }
        const cloned =
          typeof item.value === "object" && item.value !== null
            ? structuredClone(item.value)
            : item.value;
        this.dataModel.set(resolved.pointer, cloned);
        const rootPtr = this.keyToPointer.get(resolved.key);
        if (rootPtr) {
          for (const siblingKey of this.pointerToKeys.get(rootPtr) ?? [resolved.key]) {
            this.lastSerialized.set(
              siblingKey,
              JSON.stringify(this.dataModel.get(rootPtr) ?? null)
            );
          }
        }
        applied.push(resolved.pointer);
      }
    } finally {
      this.applyingGuestUpdate = false;
    }

    return { applied, rejected };
  }

  stop(): void {
    for (const sub of this.subscriptions) {
      sub.unsubscribe();
    }
    this.subscriptions.length = 0;
    this.lastSerialized.clear();
  }
}

export interface McpAppHostBridgeOptions {
  componentId: string;
  resourceUri: string;
  html: string;
  sandboxConfig: McpSandboxConfig;
  proxyWindow: ProxyWindowLike;
  dataModel?: DataModel;
  dataPaths?: Readonly<Record<string, string>> | readonly string[];
  toolInput?: Record<string, unknown>;
  toolResult?: unknown;
  allowedTools?: readonly string[];
  allowedFunctions?: Readonly<Record<string, unknown>> | readonly AllowedFunctionConfig[];
  csp?: McpAppCspConfig;
  permissions?: McpAppPermissionsConfig;
  guestSandboxFlags?: string;
  locale?: string;
  theme?: "light" | "dark";
  callMcpTool?: (
    name: string,
    args: Record<string, unknown>,
    serverName?: string
  ) => Promise<unknown>;
  callCatalogFunction?: (name: string, args: Record<string, unknown>) => Promise<unknown> | unknown;
  onHeightChange?: (heightPx: number) => void;
  onDisplayModeChange?: (mode: "inline" | "fullscreen" | "pip") => void;
  onOpenLink?: (url: string) => boolean | Promise<boolean>;
  onMessage?: (text: string) => void | Promise<void>;
  onStatusChange?: (status: "booting" | "ready" | "error", errorMessage?: string) => void;
}

export class McpAppHostBridge {
  private readonly originGuard: (event: MessageEventLike) => boolean;
  private readonly dataSync: McpAppDataModelSync | null;
  private readonly allowedToolsSet: Set<string>;
  private readonly allowedFunctionsMap: Map<string, AllowedFunctionConfig>;
  private initialized = false;
  private disposed = false;

  constructor(private readonly options: McpAppHostBridgeOptions) {
    this.originGuard = createProxyOriginGuard(options.proxyWindow, options.sandboxConfig);
    this.allowedToolsSet = new Set(options.allowedTools ?? []);
    this.allowedFunctionsMap = normalizeAllowedFunctions(options.allowedFunctions);
    const syncCandidate =
      options.dataModel && options.dataPaths
        ? new McpAppDataModelSync(options.dataModel, options.dataPaths, (payload) => {
            if (!this.initialized || this.disposed) return;
            this.post({
              jsonrpc: "2.0",
              method: "ui/notifications/data-model-update",
              params: payload
            });
          })
        : null;
    this.dataSync = syncCandidate?.hasBindings ? syncCandidate : null;
  }

  private post(message: JsonRpcMessage): void {
    if (this.disposed) return;
    this.options.proxyWindow.postMessage(message, this.options.sandboxConfig.targetOrigin);
  }

  private replyResult(id: string | number, result: unknown): void {
    this.post({ jsonrpc: "2.0", id, result });
  }

  private replyError(id: string | number, code: number, message: string): void {
    this.post({ jsonrpc: "2.0", id, error: { code, message } });
  }

  /**
   * Processes an incoming `window` `"message"` event; ignores unrelated windows/origins.
   */
  async handleWindowMessage(event: MessageEventLike): Promise<boolean> {
    if (this.disposed || !this.originGuard(event)) {
      return false;
    }

    const validated = validateMcpJsonRpcPayload(event.data);
    if (!validated.ok) {
      return false;
    }

    const msg = validated.message;
    const method = msg.method;
    const params = msg.params ?? {};

    if (method === "ui/notifications/sandbox-proxy-ready") {
      this.post({
        jsonrpc: "2.0",
        method: "ui/notifications/sandbox-resource-ready",
        params: {
          html: this.options.html,
          ...(this.options.guestSandboxFlags ? { sandbox: this.options.guestSandboxFlags } : {}),
          ...(this.options.csp ? { csp: this.options.csp } : {}),
          ...(this.options.permissions ? { permissions: this.options.permissions } : {})
        }
      });
      return true;
    }

    if (method === "ui/initialize" && msg.id !== undefined) {
      this.replyResult(msg.id, {
        protocolVersion: "2025-06-18",
        hostInfo: { name: "WasmHatch", version: "1.0.0" },
        hostCapabilities: {
          openLinks: {},
          serverTools: { listChanged: false },
          logging: {},
          a2uiDataModel: {
            twoWay: Boolean(this.dataSync?.hasBindings),
            paths: this.dataSync?.boundKeys ?? []
          }
        },
        hostContext: {
          theme: this.options.theme ?? "light",
          locale: this.options.locale ?? "en",
          displayMode: "inline",
          resourceUri: this.options.resourceUri
        }
      });
      return true;
    }

    if (method === "ui/notifications/initialized") {
      this.initialized = true;
      this.options.onStatusChange?.("ready");
      if (this.dataSync?.hasBindings) {
        this.dataSync.start();
        this.post({
          jsonrpc: "2.0",
          method: "ui/notifications/data-model-update",
          params: {
            data: this.dataSync.snapshot(),
            changedKeys: this.dataSync.boundKeys
          }
        });
      }
      if (this.options.toolInput) {
        this.post({
          jsonrpc: "2.0",
          method: "ui/notifications/tool-input",
          params: { arguments: this.options.toolInput }
        });
      }
      if (this.options.toolResult !== undefined) {
        this.post({
          jsonrpc: "2.0",
          method: "ui/notifications/tool-result",
          params: isPlainRecord(this.options.toolResult)
            ? this.options.toolResult
            : { content: [{ type: "text", text: JSON.stringify(this.options.toolResult) }] }
        });
      }
      return true;
    }

    if (method === "ui/notifications/data-model-change") {
      this.dataSync?.applyGuestChange(params);
      return true;
    }

    if (method === "ui/notifications/size-changed") {
      const rawHeight = params.height;
      if (typeof rawHeight === "number" && Number.isFinite(rawHeight)) {
        const clamped = Math.max(
          MIN_MCP_APP_HEIGHT,
          Math.min(MAX_MCP_APP_HEIGHT, Math.round(rawHeight))
        );
        this.options.onHeightChange?.(clamped);
      }
      return true;
    }

    if (method === "ui/update-model-context") {
      if (this.options.dataModel) {
        const serialized = JSON.stringify(params).slice(0, MAX_MODEL_CONTEXT_CHARS);
        const safeId = this.options.componentId.replace(/[^A-Za-z0-9_-]/g, "_");
        this.options.dataModel.set(`/_mcpAppContext/${safeId}`, serialized);
      }
      if (msg.id !== undefined) {
        this.replyResult(msg.id, { updated: true });
      }
      return true;
    }

    if (method === "ui/request-display-mode" && msg.id !== undefined) {
      const requested = params.mode;
      const mode: "inline" | "fullscreen" | "pip" =
        requested === "fullscreen" || requested === "pip" ? requested : "inline";
      this.options.onDisplayModeChange?.(mode);
      this.replyResult(msg.id, { mode });
      return true;
    }

    if (method === "ui/open-link" && msg.id !== undefined) {
      const rawUrl = typeof params.url === "string" ? params.url.trim() : "";
      let validUrl: URL | null = null;
      try {
        const parsed = new URL(rawUrl);
        if (parsed.protocol === "https:" || parsed.protocol === "http:") {
          validUrl = parsed;
        }
      } catch {
        validUrl = null;
      }
      if (!validUrl) {
        this.replyError(msg.id, -32602, "Only http:// and https:// links may be opened.");
        return true;
      }
      const opened = this.options.onOpenLink ? await this.options.onOpenLink(validUrl.href) : false;
      this.replyResult(msg.id, { isError: !opened });
      return true;
    }

    if (method === "ui/message" && msg.id !== undefined) {
      const content = isPlainRecord(params.content) ? params.content : null;
      const text =
        typeof params.text === "string"
          ? params.text
          : content && typeof content.text === "string"
            ? content.text
            : "";
      if (!text.trim() || !this.options.onMessage) {
        this.replyError(msg.id, -32602, "Message content cannot be empty.");
        return true;
      }
      await this.options.onMessage(text.slice(0, 4_000));
      this.replyResult(msg.id, { isError: false });
      return true;
    }

    if (method === "tools/call" && msg.id !== undefined) {
      const toolName = typeof params.name === "string" ? params.name.trim() : "";
      const toolArgs = isPlainRecord(params.arguments) ? params.arguments : {};
      const serverName = typeof params.server === "string" ? params.server : undefined;
      if (!toolName || !this.allowedToolsSet.has(toolName)) {
        this.replyError(
          msg.id,
          -32601,
          `Tool "${toolName || "(empty)"}" is not permitted by this McpApp's allowedTools allowlist.`
        );
        return true;
      }
      if (!this.options.callMcpTool) {
        this.replyError(msg.id, -32603, "MCP tool bridge is not connected.");
        return true;
      }
      try {
        const result = await this.options.callMcpTool(toolName, toolArgs, serverName);
        this.replyResult(msg.id, result);
      } catch (err) {
        this.replyError(
          msg.id,
          -32603,
          err instanceof Error ? err.message : "MCP tool call failed."
        );
      }
      return true;
    }

    if (method === "ui/requests/function-call" && msg.id !== undefined) {
      const fnName =
        typeof params.call === "string"
          ? params.call.trim()
          : typeof params.name === "string"
            ? params.name.trim()
            : "";
      const fnArgs = isPlainRecord(params.args)
        ? params.args
        : isPlainRecord(params.arguments)
          ? params.arguments
          : {};
      const fnSpec = this.allowedFunctionsMap.get(fnName);
      if (!fnName || !fnSpec) {
        this.replyError(
          msg.id,
          -32601,
          `Function "${fnName || "(empty)"}" is not permitted by this McpApp's allowedFunctions allowlist.`
        );
        return true;
      }
      const validationErr = validateAllowedFunctionArgs(fnArgs, fnSpec.schema);
      if (validationErr) {
        this.replyError(msg.id, -32602, validationErr);
        return true;
      }
      if (!this.options.callCatalogFunction) {
        this.replyError(msg.id, -32603, "Catalog function invoker is unavailable.");
        return true;
      }
      try {
        const value = await this.options.callCatalogFunction(fnName, fnArgs);
        this.replyResult(msg.id, { status: "success", result: value, value });
      } catch (err) {
        this.replyError(
          msg.id,
          -32603,
          err instanceof Error ? err.message : "Function execution failed."
        );
      }
      return true;
    }

    if (msg.id !== undefined && method) {
      this.replyError(msg.id, -32601, `Unsupported MCP App method "${method}".`);
      return true;
    }

    return true;
  }

  pushToolResult(toolResult: unknown): void {
    if (!this.initialized || this.disposed) return;
    this.post({
      jsonrpc: "2.0",
      method: "ui/notifications/tool-result",
      params: isPlainRecord(toolResult)
        ? toolResult
        : { content: [{ type: "text", text: JSON.stringify(toolResult) }] }
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.dataSync?.stop();
  }
}